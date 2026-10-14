"""各 agent 评测脚本共用的部分：读一天的任务、准备工作目录、记忆题打分、验收。

一天的任务放在一个目录里（默认 ~/.smartcompact-eval/tasks/day），不随仓库发布：
- tasks.json：
  - project：base（~/.smartcompact-eval/tasks/ 下的基准副本目录名，含依赖）、build（验收前的构建命令）、
    hidden（隐藏验收测试：file 测试文件、dir 放到工作目录下哪里、dest 相对 dir 的文件名、command 运行命令）、
    suites（名字 → 原有测试的运行命令，输出按 node --test 的 spec 格式统计）；
  - intro（第一条消息的开头）、nudge（没写完时的催促语）；
  - rounds：每轮 tasks（id、prompt）和 recall（prompt、answers：题号 → 答案里必须出现的词）。
- hidden/：隐藏验收测试，测试名以任务 ID 加空格开头。
"""
import json
import os
import re
import shutil
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.expanduser('~/.smartcompact-eval')
RESULTS = os.path.join(EVAL, 'results')
DAY = os.path.join(EVAL, 'tasks', 'day')
MAX_NUDGES = 4


def load_day(path: str = DAY, rounds: int | None = None) -> dict:
    """rounds 只取前几轮；不填为全部。"""
    day = json.load(open(os.path.join(path, 'tasks.json'), encoding='utf-8'))
    return {**day, 'rounds': day['rounds'][:rounds]}


def prepare_workspace(day: dict, name: str) -> str:
    """从基准副本完整复制一份（APFS 写时复制，含依赖）。"""
    work = os.path.join(EVAL, 'runs', name)
    os.makedirs(RESULTS, exist_ok=True)
    subprocess.run(['cp', '-cR', os.path.join(EVAL, 'tasks', day['project']['base']), work], check=True)
    return work


def git(work: str, *args: str) -> str:
    return subprocess.run(['git', '-C', work, *args], capture_output=True, text=True).stdout.strip()


def task_done(text: str) -> bool:
    lines = text.strip().splitlines()
    return bool(lines) and lines[-1].strip() == 'TASK_DONE'


def score_recall(text: str, answers: dict) -> dict:
    lines = {m.group(1): m.group(2) for m in re.finditer(r'^\s*(\d+)[.、)]\s*(.*)$', text, re.M)}
    return {q: all(word.lower() in lines.get(q, '').lower() for word in words) for q, words in answers.items()}


def _hidden_test(work: str, test: dict, pattern: str) -> dict:
    command = [*test['command'], f'--test-name-pattern={pattern}', test['dest']]
    out = subprocess.run(command, cwd=os.path.join(work, test['dir']), capture_output=True, text=True).stdout
    count = lambda key: int((re.search(rf'^# {key} (\d+)', out, re.M) or [0, 0])[1])
    return {'pass': count('pass'), 'fail': count('fail'), 'failed': re.findall(r'^not ok \d+ - (.*)$', out, re.M)}


def acceptance(work: str, day: dict, day_path: str = DAY) -> dict:
    """按最终代码构建，跑隐藏测试（逐个任务）和原有测试。"""
    project = day['project']
    build = subprocess.run(project['build'], cwd=work, capture_output=True, text=True)
    for test in project['hidden']:
        shutil.copy(os.path.join(day_path, 'hidden', test['file']), os.path.join(work, test['dir'], test['dest']))
    hidden = {}
    for task in (task for round_ in day['rounds'] for task in round_['tasks']):
        runs = [_hidden_test(work, test, f'^{task["id"]} ') for test in project['hidden']]
        total = {'pass': sum(r['pass'] for r in runs), 'fail': sum(r['fail'] for r in runs), 'failed': [n for r in runs for n in r['failed']]}
        hidden[task['id']] = {**total, 'accepted': total['pass'] > 0 and total['fail'] == 0}
    for test in project['hidden']:
        os.remove(os.path.join(work, test['dir'], test['dest']))
    suites = {}
    for name, command in project['suites'].items():
        out = subprocess.run(command, cwd=work, capture_output=True, text=True).stdout
        count = lambda key: int((re.search(rf'^ℹ {key} (\d+)', out, re.M) or [0, 0])[1])
        suites[name] = {'tests': count('tests'), 'pass': count('pass'), 'fail': count('fail'),
                        'failed': sorted(set(re.findall(r'^✖ (.*?)(?: \([\d.]+ms\))?$', out, re.M)) - {'failing tests:'})}
    return {'build_exit': build.returncode, 'hidden': hidden, 'suites': suites}


def run_day(day: dict, work: str, run_turn, last_text, context, on_task, log=print) -> tuple[list, list]:
    """按轮发任务：最后一行没写 TASK_DONE 就催；每轮结束问记忆题。

    run_turn(text) 跑完一轮对话；last_text() 返回最近一条回复；context() 返回当前上下文大小；
    on_task(id) 在每个任务或记忆题开始前调用，用于给记录打标签。
    """
    tasks, recalls = [], []
    for number, round_ in enumerate(day['rounds'], 1):
        for task in round_['tasks']:
            on_task(task['id'])
            started, head_before = time.time(), git(work, 'rev-parse', 'HEAD')
            run_turn((day['intro'] + '\n\n' if not tasks else '') + task['prompt'])
            nudges = 0
            while not task_done(last_text()) and nudges < MAX_NUDGES:
                nudges += 1
                run_turn(day['nudge'])
            tasks.append({'id': task['id'], 'elapsed_s': round(time.time() - started), 'nudges': nudges,
                          'done': task_done(last_text()), 'context_at_end': context(),
                          'commits': git(work, 'log', '--oneline', f'{head_before}..HEAD').splitlines()})
            log(json.dumps(tasks[-1], ensure_ascii=False))
        on_task(f'recall-{number}')
        context_before = context()
        run_turn(round_['recall']['prompt'])
        recalls.append({'round': number, 'context_before': context_before, 'answer': last_text(),
                        'score': score_recall(last_text(), round_['recall']['answers'])})
        log(json.dumps({'recall': number, 'score': recalls[-1]['score']}, ensure_ascii=False))
    return tasks, recalls
