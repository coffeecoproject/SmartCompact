#!/usr/bin/env python3
"""按桌面 App 的方式（stream-json 输入输出、无界面）跑一个 Claude 会话，依次发送消息。

用法：scripts/headless-session.py <步骤文件.json>

步骤文件：
{
  "args": ["--model", "haiku", "--plugin-dir", "./plugin", ...],   // 额外的 claude 参数
  "steps": [
    {"send": "消息内容", "settle": 5},   // 发送后等本轮结束，再等 settle 秒（给排队的压缩留时间）
    ...
  ]
}

输出每轮的工具调用、回复摘要和压缩事件。只用于本地测试，会消耗模型额度。
"""
import json
import subprocess
import sys
import threading
import time

spec = json.load(open(sys.argv[1], encoding='utf-8'))
cmd = ['claude', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', *spec.get('args', [])]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

events: list[dict] = []
results = 0
lock = threading.Condition()


def reader() -> None:
    global results
    for line in proc.stdout:  # type: ignore[union-attr]
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print('RAW', line.rstrip()[:200])
            continue
        with lock:
            events.append(event)
            if event.get('type') == 'result':
                results += 1
            lock.notify_all()
        show(event)


def show(event: dict) -> None:
    kind, sub = event.get('type'), event.get('subtype')
    if kind == 'assistant':
        for block in event.get('message', {}).get('content', []):
            if block.get('type') == 'tool_use':
                print(f"  TOOL {block['name']} {json.dumps(block.get('input'), ensure_ascii=False)[:100]}")
            elif block.get('type') == 'text' and block['text'].strip():
                print(f"  A: {block['text'].strip()[:300]}")
    elif kind == 'system' and sub not in ('init', 'hook_started', 'hook_response'):
        print(f"  SYS {sub} {str(event.get('compact_metadata') or event.get('content') or '')[:200]}")
    elif kind == 'result':
        print(f"  RESULT {event.get('subtype')} turns={event.get('num_turns')} {str(event.get('result'))[:300]}")
    elif kind == 'user' and isinstance(event.get('message', {}).get('content'), str):
        print(f"  USER-ROW {event['message']['content'][:150]}")


threading.Thread(target=reader, daemon=True).start()

for index, step in enumerate(spec['steps'], 1):
    print(f"===== 第 {index} 步：{step['send'][:80]}")
    with lock:
        expected = results + 1
    proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': step['send']}}) + '\n')  # type: ignore[union-attr]
    proc.stdin.flush()  # type: ignore[union-attr]
    with lock:
        lock.wait_for(lambda: results >= expected, timeout=step.get('timeout', 600))
    time.sleep(step.get('settle', 3))

proc.stdin.close()  # type: ignore[union-attr]
try:
    proc.wait(timeout=60)
except subprocess.TimeoutExpired:
    proc.kill()
print('===== 结束，事件数', len(events))
