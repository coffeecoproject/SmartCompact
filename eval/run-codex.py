#!/usr/bin/env python3
"""用 Codex（经隔离环境的共享后台服务）在一个会话里连续做一天的多轮任务，记录 token、压缩、验收和记忆题结果。

用法：eval/run-codex.py <组名 baseline|plugin> <运行名> [--day 任务目录] [--rounds N]

- baseline 用 ~/.smartcompact-eval/codex-home-baseline（不装插件），plugin 用 ~/.smartcompact-eval/codex-home（装了 SmartCompact hook）。
  两个环境的模型设置都与用户的 ~/.codex/config.toml 一致，各自的后台服务需要先启动。
  hook 由后台服务拉起，插件参数要在启动 plugin 组的后台服务时用环境变量给：至少 SMARTCOMPACT_IDLE_SECONDS=0。
  评测里下一条任务紧接着发，模拟的是做完一件事后用户已经停顿过；不设的话插件要等用户空闲 3 分钟，永远压不了。
- 沙箱为 workspace-write，另把 .git 设为可写以便提交。
- 结果写到 ~/.smartcompact-eval/results/<运行名>.json。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from day import DAY, EVAL, RESULTS, acceptance, git, load_day, prepare_workspace, run_day  # noqa: E402

HOMES = {'baseline': os.path.join(EVAL, 'codex-home-baseline'), 'plugin': os.path.join(EVAL, 'codex-home')}

parser = argparse.ArgumentParser()
parser.add_argument('arm', choices=['baseline', 'plugin'])
parser.add_argument('name')
parser.add_argument('--day', default=DAY)
parser.add_argument('--rounds', type=int, help='只做前几轮，不填为全部')
args = parser.parse_args()
day = load_day(args.day, args.rounds)

os.environ['CODEX_HOME'] = HOMES[args.arm]
from appserver_client import Client  # noqa: E402  按 CODEX_HOME 连对应环境的后台服务

work = prepare_workspace(day, args.name)
base_commit = git(work, 'rev-parse', 'HEAD')
log = open(os.path.join(RESULTS, f'{args.name}.events.jsonl'), 'w', encoding='utf-8')
client = Client('eval')
thread_id = client.request('thread/start', {
    'cwd': work, 'approvalPolicy': 'never', 'sandbox': 'workspace-write',
    'config': {'sandbox_workspace_write': {'writable_roots': [os.path.join(work, '.git')]}},
})['thread']['id']
print('thread', thread_id, flush=True)

usage = {'requests': 0, 'total': None, 'timeline': [], 'compactions': []}
current = {'task': None, 'last_text': '', 'context': 0}
started = time.time()


def on_note(note: dict) -> None:
    log.write(json.dumps(note, ensure_ascii=False) + '\n')
    method, params = note['method'], note.get('params', {})
    item = params.get('item') or {}
    if method == 'thread/tokenUsage/updated':
        token_usage = params.get('tokenUsage') or {}
        last = token_usage.get('last') or {}
        usage['requests'] += 1
        usage['total'] = token_usage.get('total')
        current['context'] = last.get('inputTokens') or current['context']
        usage['timeline'].append({'t': round(time.time() - started, 1), 'task': current['task'], 'context': last.get('inputTokens'),
                                  'cached': last.get('cachedInputTokens'), 'output': last.get('outputTokens')})
    elif method == 'item/completed' and item.get('type') == 'agentMessage':
        current['last_text'] = item.get('text') or ''
    elif method == 'item/completed' and item.get('type') == 'contextCompaction':
        usage['compactions'].append({'t': round(time.time() - started, 1), 'task': current['task'], 'before': current['context']})


def wait_turn(timeout: float) -> None:
    while True:
        note = client.notes.get(timeout=timeout)
        on_note(note)
        if note['method'] == 'turn/completed':
            return


def run_turn(text: str) -> None:
    client.request('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': text}]})
    wait_turn(3 * 3600)
    # 插件可能在本轮结束后发起压缩：等一会儿，有压缩就等它完成
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            note = client.notes.get(timeout=1)
        except Exception:
            continue
        on_note(note)
        if note['method'] == 'turn/started':
            wait_turn(1800)
            break


tasks, recalls = run_day(day, work, run_turn, lambda: current['last_text'], lambda: current['context'],
                         lambda task: current.update(task=task), lambda line: print(line, flush=True))
elapsed = time.time() - started
client.ws.sock.close()

plugin_log = []
if args.arm == 'plugin':
    log_file = os.path.join(HOMES['plugin'], 'smartcompact', 'log.jsonl')
    if os.path.exists(log_file):
        plugin_log = [json.loads(line) for line in open(log_file, encoding='utf-8') if thread_id in line]

result = {
    'agent': 'codex', 'arm': args.arm, 'name': args.name, 'thread': thread_id, 'elapsed_s': round(elapsed), 'tasks': tasks,
    'recalls': recalls, 'usage': {k: v for k, v in usage.items() if k != 'timeline'}, 'timeline': usage['timeline'],
    'plugin_log': plugin_log, 'acceptance': acceptance(work, day, args.day),
    'commits': git(work, 'log', '--oneline', f'{base_commit}..HEAD').splitlines(),
}
json.dump(result, open(os.path.join(RESULTS, f'{args.name}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({'elapsed_s': result['elapsed_s'], 'requests': usage['requests'], 'total': usage['total'],
                  'compactions': len(usage['compactions']), 'recall': [sum(r['score'].values()) for r in recalls],
                  'hidden': {k: v['accepted'] for k, v in result['acceptance']['hidden'].items()}}, ensure_ascii=False))
