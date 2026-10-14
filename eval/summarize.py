#!/usr/bin/env python3
"""汇总对照评测的结果（Codex、pi、Claude）：每次运行一行，再按组取平均。

用法：eval/summarize.py <运行名前缀>...（例如 day3-），读 ~/.smartcompact-eval/results/<运行名>.json

成本按各家价格比例折算成"缓存读取 token 当量"：
- Codex、pi（OpenAI）：缓存命中 1、未命中输入 10、写入缓存 10、输出 80；
- Claude（Anthropic，1 小时缓存）：缓存命中 1、未命中输入 10、写入缓存 20、输出 50。
"""
import glob
import json
import os
import sys

RESULTS = os.path.expanduser('~/.smartcompact-eval/results')
# 每家的 (未命中输入, 写入缓存, 输出) 相对缓存命中的倍数
PRICES = {'openai': (10, 10, 80), 'anthropic': (10, 20, 50)}


def load(prefixes: list[str]) -> list[dict]:
    runs = []
    for prefix in prefixes:
        for path in sorted(glob.glob(os.path.join(RESULTS, f'{prefix}*.json'))):
            runs.append(json.load(open(path, encoding='utf-8')))
    return runs


def row(run: dict) -> dict:
    total = run['usage']['total']
    cached, write = total['cachedInputTokens'], total.get('cacheWriteInputTokens', 0)
    uncached = total['inputTokens'] - cached - write
    fresh_price, write_price, output_price = PRICES['anthropic' if run.get('agent') == 'claude' else 'openai']
    hidden = run['acceptance']['hidden']
    contexts = [point['context'] for point in run['timeline'] if point['context']]
    return {
        'name': run['name'], 'arm': run['arm'], 'minutes': round(run['elapsed_s'] / 60, 1),
        'requests': run['usage']['requests'], 'input': total['inputTokens'], 'cached': cached, 'uncached': uncached,
        'output': total['outputTokens'], 'cost': cached + uncached * fresh_price + write * write_price + total['outputTokens'] * output_price,
        'max_context': max(contexts, default=0), 'compactions': len(run['usage']['compactions']),
        'tasks_done': sum(task['done'] for task in run['tasks']), 'tasks': len(run['tasks']),
        'nudges': sum(task['nudges'] for task in run['tasks']),
        'accepted': sum(task['accepted'] for task in hidden.values()), 'hidden_fail': sum(task['fail'] for task in hidden.values()),
        'recall': sum(sum(r['score'].values()) for r in run['recalls']), 'recall_total': sum(len(r['score']) for r in run['recalls']),
        'suite_fail': {name: suite['fail'] for name, suite in run['acceptance']['suites'].items() if suite['fail']},
    }


def main() -> None:
    rows = [row(run) for run in load(sys.argv[1:])]
    columns = ['name', 'minutes', 'requests', 'input', 'cached', 'output', 'cost', 'max_context', 'compactions',
               'tasks_done', 'nudges', 'accepted', 'recall', 'suite_fail']
    print('| ' + ' | '.join(columns) + ' |')
    print('|' + '---|' * len(columns))
    for r in rows:
        print('| ' + ' | '.join(str(r[c]) for c in columns) + ' |')
    print()
    means = {}
    for arm in ('baseline', 'plugin'):
        group = [r for r in rows if r['arm'] == arm]
        if group:
            means[arm] = {key: sum(r[key] for r in group) / len(group) for key in ('minutes', 'input', 'cost', 'max_context', 'compactions', 'accepted', 'recall')}
            print(arm, len(group), 'runs', json.dumps({k: round(v, 1) for k, v in means[arm].items()}))
    if len(means) == 2:
        for key in ('input', 'cost'):
            print(f'plugin vs baseline {key}: {means["plugin"][key] / means["baseline"][key] - 1:+.1%}')


main()
