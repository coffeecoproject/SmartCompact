#!/usr/bin/env python3
"""用 pi（RPC 模式）在一个会话里连续做一天的多轮任务，记录 token、压缩、验收和记忆题结果。

用法：eval/run-pi.py <组名 baseline|plugin> <运行名> [--model openai-codex/gpt-5.5] [--day 任务目录] [--rounds N]

- 模型默认与用户 pi 设置一致（openai-codex / gpt-5.5，思考强度用 pi 默认）。
- 两组都不加载用户装的其他扩展；plugin 组只加载 SmartCompact 的 pi 扩展（默认参数）。
- pi 没有沙箱，命令以当前用户身份在工作目录里执行。
- 结果写到 ~/.smartcompact-eval/results/<运行名>.json。
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from day import DAY, RESULTS, ROOT, acceptance, git, load_day, prepare_workspace, run_day  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('arm', choices=['baseline', 'plugin'])
parser.add_argument('name')
parser.add_argument('--model', default='openai-codex/gpt-5.5')
parser.add_argument('--day', default=DAY)
parser.add_argument('--rounds', type=int, help='只做前几轮，不填为全部')
args = parser.parse_args()
day = load_day(args.day, args.rounds)

work = prepare_workspace(day, args.name)
base_commit = git(work, 'rev-parse', 'HEAD')
pi_args = ['pi', '--mode', 'rpc', '--no-extensions', '--no-session', '--model', args.model]
if args.arm == 'plugin':
    # 评测里下一条任务紧接着发，模拟的是做完一件事后用户已经停顿过：不等用户空闲，否则插件永远压不了。
    pi_args += ['-e', os.path.join(ROOT, 'adapters', 'pi', 'index.ts'), '--smartcompact-idle-seconds', '0']

log = open(os.path.join(RESULTS, f'{args.name}.events.jsonl'), 'w', encoding='utf-8')
proc = subprocess.Popen(pi_args, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
lock = threading.Condition()
state = {'settled': 0, 'compacting': False, 'last_text': '', 'context': 0, 'task': None, 'stats': None}
usage = {'requests': 0, 'input': 0, 'cache_read': 0, 'cache_write': 0, 'output': 0, 'timeline': [], 'compactions': []}
started = time.time()


def on_event(event: dict) -> None:
    kind = event.get('type')
    if kind == 'message_end' and event.get('message', {}).get('role') == 'assistant':
        message = event['message']
        u = message.get('usage') or {}
        fresh, read, write, out = (u.get(k, 0) or 0 for k in ('input', 'cacheRead', 'cacheWrite', 'output'))
        usage['requests'] += 1
        usage['input'] += fresh
        usage['cache_read'] += read
        usage['cache_write'] += write
        usage['output'] += out
        state['context'] = fresh + read + write
        # 与 Codex 的记录同一形状：context 是这次请求的全部输入，cached 是命中缓存的部分
        usage['timeline'].append({'t': round(time.time() - started, 1), 'task': state['task'], 'context': state['context'],
                                  'cached': read, 'output': out})
        state['last_text'] = ''.join(b.get('text', '') for b in message.get('content', []) if b.get('type') == 'text')
    elif kind == 'compaction_start':
        state['compacting'] = True
    elif kind == 'compaction_end':
        state['compacting'] = False
        usage['compactions'].append({'t': round(time.time() - started, 1), 'task': state['task'], 'before': state['context'],
                                     'reason': event.get('reason'), 'status': event.get('status', 'completed' if not event.get('aborted') else 'aborted')})
    elif kind == 'response' and event.get('command') == 'get_session_stats':
        state['stats'] = event.get('data')


def reader() -> None:
    for line in proc.stdout:  # type: ignore[union-attr]
        log.write(line)
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        with lock:
            on_event(event)
            if event.get('type') == 'agent_settled':
                state['settled'] += 1
            lock.notify_all()


def send(message: dict) -> None:
    proc.stdin.write(json.dumps(message) + '\n')  # type: ignore[union-attr]
    proc.stdin.flush()  # type: ignore[union-attr]


def run_turn(text: str) -> None:
    with lock:
        expected = state['settled'] + 1
    send({'type': 'prompt', 'message': text})
    with lock:
        lock.wait_for(lambda: state['settled'] >= expected, timeout=3 * 3600)
    # 插件可能在 agent_settled 后发起压缩，等它完成再继续
    time.sleep(5)
    with lock:
        lock.wait_for(lambda: not state['compacting'], timeout=900)


threading.Thread(target=reader, daemon=True).start()
time.sleep(3)
tasks, recalls = run_day(day, work, run_turn, lambda: state['last_text'], lambda: state['context'],
                         lambda task: state.update(task=task), lambda line: print(line, flush=True))
elapsed = time.time() - started
send({'type': 'get_session_stats'})
time.sleep(3)
proc.stdin.close()  # type: ignore[union-attr]
time.sleep(2)
proc.kill()

total = {'inputTokens': usage['input'] + usage['cache_read'] + usage['cache_write'], 'cachedInputTokens': usage['cache_read'],
         'cacheWriteInputTokens': usage['cache_write'], 'outputTokens': usage['output']}
result = {
    'agent': 'pi', 'model': args.model, 'arm': args.arm, 'name': args.name, 'elapsed_s': round(elapsed), 'tasks': tasks, 'recalls': recalls,
    'usage': {'requests': usage['requests'], 'total': total, 'compactions': usage['compactions']}, 'timeline': usage['timeline'],
    'session_stats': state['stats'], 'acceptance': acceptance(work, day, args.day),
    'commits': git(work, 'log', '--oneline', f'{base_commit}..HEAD').splitlines(),
}
json.dump(result, open(os.path.join(RESULTS, f'{args.name}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({'elapsed_s': result['elapsed_s'], 'requests': usage['requests'], 'total': total,
                  'compactions': [(c['task'], c['reason'], c['status'], c['before']) for c in usage['compactions']],
                  'recall': [sum(r['score'].values()) for r in recalls],
                  'hidden': {k: v['accepted'] for k, v in result['acceptance']['hidden'].items()}}, ensure_ascii=False))
