"""Codex 共享后台服务的最小客户端：Unix 套接字上的 WebSocket + JSON-RPC。"""
import base64
import json
import os
import queue
import socket
import struct
import threading
import time

SOCKET = os.path.join(os.environ.get('CODEX_HOME', os.path.expanduser('~/.codex')), 'app-server-control', 'app-server-control.sock')


class WebSocket:
    """Unix 套接字上的最小 WebSocket 客户端（标准 HTTP Upgrade 握手，文本帧）。"""

    def __init__(self, path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                           f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        response = b''
        while b'\r\n\r\n' not in response:
            response += self.sock.recv(1)
        if b' 101 ' not in response.split(b'\r\n')[0]:
            raise RuntimeError(response.decode(errors='replace'))

    def _exact(self, size: int) -> bytes:
        data = b''
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                raise EOFError
            data += chunk
        return data

    def send_text(self, text: str, opcode: int = 0x1) -> None:
        payload = text.encode()
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack('>H', length)
        else:
            header += bytes([0x80 | 127]) + struct.pack('>Q', length)
        mask = os.urandom(4)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_text(self) -> str:
        message = b''
        while True:
            first, second = self._exact(2)
            opcode, length = first & 0x0F, second & 0x7F
            if length == 126:
                length = struct.unpack('>H', self._exact(2))[0]
            elif length == 127:
                length = struct.unpack('>Q', self._exact(8))[0]
            payload = self._exact(length)
            if opcode == 0x9:  # ping
                self.send_text(payload.decode(errors='replace'), opcode=0xA)
                continue
            if opcode == 0x8:
                raise EOFError
            message += payload
            if first & 0x80:
                return message.decode()


class Client:
    def __init__(self, name: str):
        self.name = name
        self.ws = WebSocket(SOCKET)
        self.next_id = 0
        self.responses: dict[int, dict] = {}
        self.notes: 'queue.Queue[dict]' = queue.Queue()
        self.lock = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()
        self.request('initialize', {'clientInfo': {'name': f'smartcompact_{name}', 'title': 'SmartCompact test', 'version': '0.0.0'}})
        self.send({'method': 'initialized', 'params': {}})

    def _read(self) -> None:
        while True:
            try:
                line = self.ws.recv_text()
            except (EOFError, OSError):
                return
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print(f'[{self.name}] RAW', line[:200])
                continue
            if 'id' in message and ('result' in message or 'error' in message):
                with self.lock:
                    self.responses[message['id']] = message
                    self.lock.notify_all()
            elif 'method' in message:
                self.notes.put(message)

    def send(self, message: dict) -> None:
        self.ws.send_text(json.dumps(message))

    def request(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        self.next_id += 1
        request_id = self.next_id
        self.send({'method': method, 'id': request_id, 'params': params or {}})
        with self.lock:
            self.lock.wait_for(lambda: request_id in self.responses, timeout=timeout)
        response = self.responses.get(request_id, {'error': 'timeout'})
        if 'error' in response:
            print(f'[{self.name}] {method} ERROR {response["error"]}')
        return response.get('result', {})

    def wait_for(self, predicate, timeout: float = 600) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                note = self.notes.get(timeout=1)
            except queue.Empty:
                continue
            describe(self.name, note)
            if predicate(note):
                return note
        print(f'[{self.name}] wait timeout')
        return None


def describe(name: str, note: dict) -> None:
    method, params = note['method'], note.get('params', {})
    item = params.get('item') or {}
    if method in ('item/completed', 'item/started') and item.get('type') in ('agentMessage', 'contextCompaction', 'commandExecution'):
        detail = item.get('text') or item.get('command') or ''
        print(f'  [{name}] {method} {item.get("type")} {str(detail)[:100]}')
    elif method in ('turn/started', 'turn/completed', 'thread/compacted', 'error'):
        turn = params.get('turn') or {}
        print(f'  [{name}] {method} status={turn.get("status")} error={turn.get("error")}')
    elif method == 'thread/tokenUsage/updated':
        usage = params.get('tokenUsage') or {}
        last = usage.get('last') or {}
        print(f'  [{name}] tokenUsage last.inputTokens={last.get("inputTokens")} window={usage.get("modelContextWindow")}')
