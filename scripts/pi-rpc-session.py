#!/usr/bin/env python3
"""用 pi 的 RPC 模式跑一个会话，依次发送消息，打印工具调用、回复、压缩和扩展通知。

用法：scripts/pi-rpc-session.py <步骤文件.json>

步骤文件：
{
  "args": ["--no-extensions", "-e", "./adapters/pi/index.ts", ...],   // 额外的 pi 参数
  "steps": [
    {"send": "消息内容", "settle": 5},   // 发送后等 agent_settled，再等 settle 秒（给插件发起的压缩留时间）
    ...
  ]
}

只用于本地测试，会消耗模型额度。
"""
import json
import subprocess
import sys
import threading
import time

spec = json.load(open(sys.argv[1], encoding='utf-8'))
proc = subprocess.Popen(['pi', '--mode', 'rpc', *spec.get('args', [])], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, bufsize=1)
settled = 0
lock = threading.Condition()


def show(event: dict) -> None:
    kind = event.get('type')
    if kind == 'tool_execution_start':
        print(f"  TOOL {event.get('toolName')} {json.dumps(event.get('args'), ensure_ascii=False)[:100]}")
    elif kind == 'tool_execution_end' and event.get('isError'):
        print(f"  TOOL-ERROR {event.get('toolName')}")
    elif kind == 'message_end' and event.get('message', {}).get('role') == 'assistant':
        text = ''.join(b.get('text', '') for b in event['message'].get('content', []) if b.get('type') == 'text').strip()
        if text:
            print(f"  A: {text[:300]}")
    elif kind in ('compaction_start', 'compaction_end'):
        print(f"  {kind.upper()} {json.dumps({k: v for k, v in event.items() if k != 'type'}, ensure_ascii=False)[:200]}")
    elif kind == 'extension_ui_request' and event.get('method') == 'notify':
        print(f"  NOTIFY {event.get('message')}")
    elif kind == 'extension_error':
        print(f"  EXTENSION-ERROR {event}")
    elif kind == 'response' and not event.get('success'):
        print(f"  ERROR {event}")


def reader() -> None:
    global settled
    for line in proc.stdout:  # type: ignore[union-attr]
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print('RAW', line.rstrip()[:200])
            continue
        show(event)
        with lock:
            if event.get('type') == 'agent_settled' or (event.get('type') == 'response' and event.get('command') == 'prompt' and event.get('data', {}).get('handled')):
                settled += 1
            lock.notify_all()


threading.Thread(target=reader, daemon=True).start()
time.sleep(3)
for index, step in enumerate(spec['steps'], 1):
    print(f"===== 第 {index} 步：{step['send'][:80]}")
    with lock:
        expected = settled + 1
    proc.stdin.write(json.dumps({'type': 'prompt', 'message': step['send']}) + '\n')  # type: ignore[union-attr]
    proc.stdin.flush()  # type: ignore[union-attr]
    with lock:
        lock.wait_for(lambda: settled >= expected, timeout=step.get('timeout', step.get('wait', 600)))
    time.sleep(step.get('settle', 3))

proc.stdin.close()  # type: ignore[union-attr]
time.sleep(2)
proc.kill()
print('===== 结束')
