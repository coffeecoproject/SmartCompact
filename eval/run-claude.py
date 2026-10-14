#!/usr/bin/env python3
"""用 Claude Code（无界面流式模式，与桌面 App 同一条路）在一个会话里连续做一天的多轮任务，记录 token、压缩、验收和记忆题结果。

用法：eval/run-claude.py <组名 baseline|plugin> <运行名> [--model haiku] [--day 任务目录] [--rounds N]

- 只读项目自己的配置（--setting-sources project,local），不加载用户的全局说明、插件和 MCP；两组相同。
- plugin 组用 --plugin-dir 只在本次会话加载 SmartCompact（默认参数），不安装到用户的 Claude。
- 跳过权限确认，命令以当前用户身份在复制出来的工作目录里执行，没有沙箱。
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
from day import DAY, EVAL, RESULTS, ROOT, acceptance, git, load_day, prepare_workspace, run_day  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('arm', choices=['baseline', 'plugin'])
parser.add_argument('name')
parser.add_argument('--model', default='haiku')
parser.add_argument('--day', default=DAY)
parser.add_argument('--rounds', type=int, help='只做前几轮，不填为全部')
args = parser.parse_args()
day = load_day(args.day, args.rounds)

work = prepare_workspace(day, args.name)
base_commit = git(work, 'rev-parse', 'HEAD')
empty_mcp = os.path.join(EVAL, 'empty-mcp.json')
json.dump({'mcpServers': {}}, open(empty_mcp, 'w'))
cmd = ['claude', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', args.model,
       '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', empty_mcp, '--dangerously-skip-permissions']
if args.arm == 'plugin':
    cmd += ['--plugin-dir', os.path.join(ROOT, 'plugin')]

log = open(os.path.join(RESULTS, f'{args.name}.events.jsonl'), 'w', encoding='utf-8')
proc = subprocess.Popen(cmd, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
lock = threading.Condition()
state = {'results': 0, 'compacting': False, 'boundaries': 0, 'last_text': '', 'context': 0, 'task': None, 'model': None}
usage = {'timeline': [], 'compactions': [], 'turns': {'input_tokens': 0, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 0}}
# 消息 ID → 它在 timeline 里的记录，用于上下文曲线。流里的单条消息不带最终输出量，总量以每轮结束的 result 事件为准
messages: dict[str, dict] = {}
started = time.time()


def on_event(event: dict) -> None:
    kind, sub = event.get('type'), event.get('subtype')
    if kind == 'assistant':
        message = event.get('message', {})
        text = ''.join(b.get('text', '') for b in message.get('content', []) if b.get('type') == 'text')
        if text.strip():
            state['last_text'] = text
        u = message.get('usage') or {}
        fresh, read, write, out = (u.get(k, 0) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'))
        entry = messages.get(message.get('id'))
        if entry is None:
            entry = messages[message.get('id')] = {'t': round(time.time() - started, 1), 'task': state['task']}
            usage['timeline'].append(entry)
        entry.update(context=fresh + read + write, fresh=fresh, cached=read, cache_write=write, output=out)
        state['context'] = fresh + read + write
        state['model'] = message.get('model') or state['model']
    elif kind == 'system' and sub == 'status':
        state['compacting'] = event.get('status') == 'compacting'
    elif kind == 'system' and sub == 'compact_boundary':
        state['compacting'] = False
        state['boundaries'] += 1
        metadata = event.get('compact_metadata') or {}
        usage['compactions'].append({'t': round(time.time() - started, 1), 'task': state['task'], 'before': metadata.get('pre_tokens', state['context']),
                                     'trigger': metadata.get('trigger')})
    elif kind == 'result':
        state['results'] += 1
        for key in usage['turns']:
            usage['turns'][key] += (event.get('usage') or {}).get(key, 0) or 0


def reader() -> None:
    for line in proc.stdout:  # type: ignore[union-attr]
        log.write(line)
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        with lock:
            on_event(event)
            lock.notify_all()


def run_turn(text: str) -> None:
    with lock:
        expected = state['results'] + 1
    proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n')  # type: ignore[union-attr]
    proc.stdin.flush()  # type: ignore[union-attr]
    with lock:
        lock.wait_for(lambda: state['results'] >= expected, timeout=3 * 3600)
    # 插件在一轮结束后排队执行 /compact：等一会儿，压缩开始了就等它结束，再留几秒给它的结果事件
    with lock:
        boundaries = state['boundaries']
        lock.wait_for(lambda: state['compacting'] or state['boundaries'] > boundaries, timeout=15)
        lock.wait_for(lambda: not state['compacting'], timeout=900)
        compacted = state['boundaries'] > boundaries
    if compacted:
        time.sleep(5)


threading.Thread(target=reader, daemon=True).start()
tasks, recalls = run_day(day, work, run_turn, lambda: state['last_text'], lambda: state['context'],
                         lambda task: state.update(task=task), lambda line: print(line, flush=True))
elapsed = time.time() - started
proc.stdin.close()  # type: ignore[union-attr]
try:
    proc.wait(timeout=60)
except subprocess.TimeoutExpired:
    proc.kill()

turns = usage['turns']
total = {'inputTokens': turns['input_tokens'] + turns['cache_read_input_tokens'] + turns['cache_creation_input_tokens'],
         'cachedInputTokens': turns['cache_read_input_tokens'], 'cacheWriteInputTokens': turns['cache_creation_input_tokens'],
         'outputTokens': turns['output_tokens']}
requests = len(usage['timeline'])
result = {
    'agent': 'claude', 'model': state['model'], 'arm': args.arm, 'name': args.name, 'elapsed_s': round(elapsed), 'tasks': tasks,
    'recalls': recalls, 'usage': {'requests': requests, 'total': total, 'compactions': usage['compactions']},
    'timeline': usage['timeline'], 'acceptance': acceptance(work, day, args.day),
    'commits': git(work, 'log', '--oneline', f'{base_commit}..HEAD').splitlines(),
}
json.dump(result, open(os.path.join(RESULTS, f'{args.name}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({'elapsed_s': result['elapsed_s'], 'requests': requests, 'total': total,
                  'compactions': [(c['task'], c['trigger'], c['before']) for c in usage['compactions']],
                  'recall': [sum(r['score'].values()) for r in recalls],
                  'hidden': {k: v['accepted'] for k, v in result['acceptance']['hidden'].items()}}, ensure_ascii=False))
