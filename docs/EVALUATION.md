# SmartCompact evaluation

How SmartCompact was tested and what it changed. This is the English summary of the A/B runs; the full report, including platform-by-platform functional tests and every issue found along the way, is in [TEST-REPORT.md](TEST-REPORT.md) (Chinese).

## Summary

| Platform (model) | Tasks | Native compaction | Cost | Hidden acceptance tests | Recall questions |
|---|---|---|---|---|---|
| Codex CLI (gpt-6-astra) | 18 | 800k | **-19%** | 18/18 both | 54/54 both |
| Pi (gpt-5.5) | 18 | about 256k | -11% to -22% | 18/18 both | native 51/54, SmartCompact 53/54 |
| Claude Code (Haiku 5.5) | 30 | close to 1M | -7% (noisy) | 30/30 both | 90/90 both |
| Claude Code (Haiku 5.5) | 60 | close to 1M | **-44%** | native 179/180, SmartCompact 180/180 | native 180/180, SmartCompact 174/180 |

Each cell compares 3 runs without SmartCompact against 3 runs with it (default settings of the version tested: allow line 200k, grace factor 1.3, minimum freed 60k; see [Changes since](#changes-since-the-evaluation) for 0.1.3). The longer the session grows past 200k, the more it saves; below 200k SmartCompact does nothing.

## Method

**Codebase and tasks.** A production TypeScript monorepo (three of its packages). The tasks and hidden tests use its internal APIs, so they are not published; the harness is in [`eval/`](../eval) and the task format is described in `eval/day.py`.

- One session does all tasks in order. Later tasks change the behavior of earlier ones, so the agent has to remember and revise its own work.
- Each task asks the agent to implement, add tests, run tests and commit.
- After each round of 6 tasks, the agent answers 6 recall questions without looking at files. Some ask about details mentioned in passing much earlier: a ticket number, a customer, who was on call, a deployment window.
- 18 tasks (3 rounds) for Codex and Pi; 30 and then 60 tasks for Claude Code, because Claude's native compaction sits close to 1M and 18 tasks barely reached 220k.

**Acceptance.** After the session, a script builds the code and runs hidden acceptance tests the agent never saw, task by task, plus the packages' existing test suites. Before any A/B run, another agent implemented every task from the prompts alone to confirm the tasks were doable and the hidden tests were correct. For the 60-task set it also checked the reverse: on code that had only finished the first 30 tasks, every task from 31 to 60 had failing hidden tests. All 60-task acceptance runs were repeated afterwards on an idle machine (three tasks have timing-sensitive tests); the results matched.

**Arms.** Both arms use the same model, settings and isolation; only SmartCompact differs.

- Codex: the user's own Codex settings (gpt-6-astra, reasoning xhigh, 872k window, auto-compaction at 800k), each arm in an isolated Codex home.
- Pi: the user's Pi settings (openai-codex / gpt-5.5, 272k window, native compaction around 256k), other Pi extensions disabled in both arms.
- Claude Code: headless stream-json mode (the same path the desktop app uses), Haiku 5.5, project settings only (`--setting-sources project,local`, no MCP servers); the plugin arm loads SmartCompact with `--plugin-dir` for that session only.

**Cost.** Token usage is converted to cache-read-token equivalents with each provider's price ratios:

- OpenAI (Codex, Pi): cached input 1, uncached input 10, output 80.
- Anthropic (Claude, 1-hour cache): cached input 1, uncached input 10, cache write 20, output 50.

This is an estimate of API cost. Subscription plans may count usage differently.

## Results

### Claude Code, 60 tasks

| | Without | With SmartCompact | Difference |
|---|---|---|---|
| Cost (millions, per run) | 289.1 / 239.3 / 227.9 | 149.6 / 136.2 / 137.9 | **-44%** on average; the ranges do not overlap |
| Input tokens (average) | 205M | 85M | -59% |
| Peak context | 820k-960k | 213k-218k | |
| Compactions | 0 (never reached native compaction) | 7 / 6 / 6, all started by SmartCompact at 202k-218k | |
| Requests | 532 / 483 / 446 | 685 / 603 / 631 | +31% |
| Hidden acceptance (tasks) | 59 / 60 / 60 | 60 / 60 / 60 | no loss |
| Recall questions | 60 / 60 / 60 | 56 / 60 / 58 | 6 of 180 missed |

- Without SmartCompact, every late request re-reads most of a context approaching 1M tokens. With it, the context drops to a few tens of thousands after each compaction and climbs back to about 200k.
- After each compaction the model spends about 30% more requests getting familiar with the code again and rewrites its cache. That is included in the cost above.
- All 6 missed recall questions asked about details mentioned in passing long before and unrelated to the code (a ticket number, the person on call, a customer, a city, an auditor, who raised a request). In every case the model said it did not remember; it did not make anything up. One of the three runs got all 60 right. No code-related question (error codes, option names, defaults) was missed.
- Run times are not comparable: the plugin runs overlapped with heavy unrelated work on the same machine. Cost and token counts do not depend on speed.

### Claude Code, 30 tasks

| | Without | With SmartCompact | Difference |
|---|---|---|---|
| Cost (millions, per run) | 52.5 / 49.7 / 43.6 | 42.7 / 40.8 / 51.8 | -7% on average |
| Input tokens (average) | 35.6M | 30.0M | -16% |
| Peak context | 280k-310k | 203k-207k | |
| Compactions | 0 | 1 / 1 / 2, after commits just past 200k | |
| Acceptance / recall | 30/30 / 90/90 | 30/30 / 90/90 | same |

The session only grew to about 300k, so there was little to save and the run-to-run spread is large. The 60-task set was added for this reason.

### Codex CLI, 18 tasks

| | Without (average of 3) | With SmartCompact (average of 3) | Difference |
|---|---|---|---|
| Cost | 43.9M | 35.7M | **-19%** |
| Cost in rounds 2-3 (where SmartCompact acts) | 34.1M | 24.3M | -29% |
| Input tokens | 31.6M | 23.5M | -26% |
| Peak context | 403k | 207k | |
| Compactions | 0 | 2, right after commits just past 200k | |
| Acceptance / recall | 18/18 / 54/54 | 18/18 / 54/54 | same |

Per-run cost ranges did not overlap (39.9M-49.4M vs 32.5M-38.5M). In rounds 2-3 the plugin arm made more requests after compaction (134 vs 88 on average) and had about 30% more uncached input; that is included.

### Pi, 18 tasks

| | Without | With SmartCompact (first version) | With SmartCompact (after fix) |
|---|---|---|---|
| Cost (millions, per run) | 43.5 / 40.2 / 44.4 | 37.9 / 38.6 / 38.0 | 34.9 / 29.3 / 36.2 |
| Versus without | | -11% | -22% |
| Recall questions | 17 / 17 / 17 | 16 / 16 / 17 | 17 / 18 / 18 |
| Acceptance | 18/18 | 18/18 | 18/18 |

Both arms lost incidental details after compaction, because Pi's compaction summary drops them. The fix asked the compaction summary to keep every specific fact the user stated, verbatim; it reduced the losses but did not remove them. The runs after the fix ran alone rather than alongside five others, so part of the difference comes from run conditions; hence the -11% to -22% range.

## Changes since the evaluation

Real use in the Claude Code desktop app (13 sessions over about 17 hours, version 0.1.0) showed two problems, and 0.1.3 changed the rules:

- **Background tasks blocked compaction.** A running background task (a monitor, a background command) counted as unfinished work, so SmartCompact neither compacted nor let native compaction through until the context was near full. In the desktop app such tasks often run for hours; four sessions grew to 430k-920k. Background tasks no longer count.
- **A fixed fallback cut long tasks short.** Versions up to 0.1.2 moved Claude's native compaction to about 260k and also compacted there without a finished piece of work. When a turn crossed 260k, native compaction fired in the middle of it (3 times). A long stretch without a finished piece of work usually means one large task, which is when a large context helps. 0.1.3 removed the fallback and no longer touches the native compaction point: SmartCompact compacts only after finished work past 200k, and otherwise the platform's native compaction applies as without the plugin.

The A/B results above still apply: in the Claude and Codex runs every SmartCompact compaction followed a finished piece of work (at 202k-218k on Claude), so the fallback never fired. On Pi the fallback was Pi's own native compaction point, where Pi still compacts.

## What these results do not show

- One codebase and one kind of task (feature work in a TypeScript monorepo).
- Claude Code was tested with Haiku only, not Sonnet or Opus.
- Three runs per arm; run-to-run variation is real, especially in shorter sessions.
- Non-coding sessions (writing, research, data analysis) were not tested.
- Cost is estimated from API price ratios, not measured on a bill or a subscription's usage limits.

## Issues found during evaluation

- **Commit recognition.** Haiku often committed with `git commit -q` or chained commands, so the first versions missed most commits. The rule is now: a command segment that starts with `git commit` ran, the tool call did not fail, and it is not `--dry-run`. Replaying 121 real commits from four runs, all were recognized with no false positives.
- **Test commands.** `pnpm --filter <pkg> test` was not recognized as a test, and `test | tail` reported the exit code of `tail`. Tests with arguments are now recognized, and piped commands without `pipefail` are not treated as results.
- **Inherited environment variable.** SmartCompact moves Claude's native compaction point through `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; a harness started from a session with SmartCompact installed inherited it. The harness now removes it and the affected run was discarded. Since 0.1.3 SmartCompact no longer sets the variable.
- **Harness scoring.** Under heavy machine load, the harness took the result of SmartCompact's queued `/compact` as the answer to the next message, so three recall rounds were scored 0. The harness now skips compaction results, and all runs were rescored from their event logs with `eval/recall-from-log.py` (the table above uses the rescored values; runs without the problem were unchanged).
