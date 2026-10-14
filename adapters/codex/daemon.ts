// Codex 共享后台服务的最小客户端：Unix 套接字上的 WebSocket（标准 HTTP Upgrade）+ JSON-RPC。只用 Node 内置模块。

import { randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { codexHome } from './store.ts'

export const daemonSocket = (): string => join(codexHome(), 'app-server-control', 'app-server-control.sock')

export class DaemonClient {
  private buffer = Buffer.alloc(0)
  private nextId = 0
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>()
  private readonly socket: Socket

  private constructor(socket: Socket) {
    this.socket = socket
  }

  static async connect(path = daemonSocket()): Promise<DaemonClient> {
    const socket = createConnection(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const key = randomBytes(16).toString('base64')
    socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    const client = new DaemonClient(socket)
    await client.handshake()
    socket.on('data', chunk => client.receive(chunk))
    await client.request('initialize', { clientInfo: { name: 'smartcompact', title: 'SmartCompact', version: '0.1.0' } })
    client.send({ method: 'initialized', params: {} })
    return client
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        this.socket.off('data', onData)
        const head = this.buffer.subarray(0, end).toString()
        this.buffer = this.buffer.subarray(end + 4)
        if (head.split('\r\n')[0]?.includes(' 101 ')) resolve()
        else reject(new Error(`daemon handshake failed: ${head.split('\r\n')[0]}`))
      }
      this.socket.on('data', onData)
      this.socket.once('error', reject)
    })
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0] ?? 0
      let length = (this.buffer[1] ?? 0) & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.buffer.length < offset + length) return
      const payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      const opcode = first & 0x0f
      if (opcode === 0x9) this.frame(payload, 0xa)
      if (opcode !== 0x1) continue
      const message = JSON.parse(payload.toString()) as Record<string, unknown>
      const id = message.id
      if (typeof id === 'number' && ('result' in message || 'error' in message)) {
        this.pending.get(id)?.(message)
        this.pending.delete(id)
      }
    }
  }

  private frame(payload: Buffer, opcode: number): void {
    const mask = randomBytes(4)
    const length = payload.length
    const header =
      length < 126
        ? Buffer.from([0x80 | opcode, 0x80 | length])
        : length < 65536
          ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), Buffer.from([length >> 8, length & 0xff])])
          : (() => {
              const extended = Buffer.alloc(8)
              extended.writeBigUInt64BE(BigInt(length))
              return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), extended])
            })()
    const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  private send(message: Record<string, unknown>): void {
    this.frame(Buffer.from(JSON.stringify(message)), 0x1)
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, message => {
        clearTimeout(timer)
        if ('error' in message) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolve((message.result ?? {}) as Record<string, unknown>)
      })
      this.send({ method, id, params })
    })
  }

  close(): void {
    this.socket.destroy()
  }
}
