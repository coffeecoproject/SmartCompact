#!/usr/bin/env python3
"""按事件日志重新给记忆题打分：eval/recall-from-log.py <运行名>... [--day 任务目录]

评测脚本记下的回答依赖"按轮次对应"。机器很忙时，插件排队的 /compact 晚开始，旧版脚本会把压缩的空结果当成记忆题的回答
（eval/run-claude.py 已修正）。这里不靠轮次：日志里每条"编号. 答案"形式的回复按顺序对应一轮记忆题，数量不等于轮数时报出来。
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from day import DAY, RESULTS, load_day, score_recall  # noqa: E402

ANSWER_LINE = re.compile(r'^\s*\d+[.、)]\s*\S', re.M)


def answers_in_log(name: str) -> list[str]:
    texts = []
    for line in open(os.path.join(RESULTS, f'{name}.events.jsonl'), encoding='utf-8'):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('type') != 'assistant':
            continue
        text = ''.join(b.get('text', '') for b in event['message'].get('content', []) if b.get('type') == 'text')
        if len(ANSWER_LINE.findall(text)) >= 5 and len(text) < 1500:
            texts.append(text)
    return texts


parser = argparse.ArgumentParser()
parser.add_argument('names', nargs='+')
parser.add_argument('--day', default=DAY)
args = parser.parse_args()
rounds = load_day(args.day)['rounds']
for name in args.names:
    texts = answers_in_log(name)
    if len(texts) != len(rounds):
        print(f'{name}: 找到 {len(texts)} 条编号回答，轮数是 {len(rounds)}，需要人工核对')
        continue
    scores = [sum(score_recall(text, round_['recall']['answers']).values()) for text, round_ in zip(texts, rounds)]
    recorded = [sum(r['score'].values()) for r in json.load(open(os.path.join(RESULTS, f'{name}.json'), encoding='utf-8'))['recalls']]
    print(f'{name}: 日志 {scores} = {sum(scores)}；原记录 {recorded} = {sum(recorded)}')
