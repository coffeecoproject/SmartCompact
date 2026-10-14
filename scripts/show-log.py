#!/usr/bin/env python3
"""打印 SmartCompact 的决策日志（插件存储里的 log）。用法：scripts/show-log.py [最近条数]"""
import glob, json, os, sys

files = sorted(glob.glob(os.path.expanduser('~/.claude/plugins/store/smartcompact_*.json')), key=os.path.getmtime)
if not files:
    sys.exit('没有找到 SmartCompact 的插件存储')
entries = json.load(open(files[-1], encoding='utf-8')).get('log', [])
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 50
print(files[-1])
for entry in entries[-limit:]:
    head = f"{entry.get('at', '')[11:19]} {entry.get('event', ''):<10}"
    rest = {k: v for k, v in entry.items() if k not in ('at', 'event')}
    print(head, json.dumps(rest, ensure_ascii=False))
