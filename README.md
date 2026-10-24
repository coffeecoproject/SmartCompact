# SmartCompact

**English** · [中文](https://github.com/coffeecoproject/SmartCompact/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/smartcompact)](https://www.npmjs.com/package/smartcompact)
[![GitHub stars](https://img.shields.io/github/stars/coffeecoproject/SmartCompact?style=social)](https://github.com/coffeecoproject/SmartCompact/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE)

<p align="center"><a href="https://github.com/coffeecoproject/SmartCompact/raw/main/docs/media/smartcompact-en.mp4"><img src="https://raw.githubusercontent.com/coffeecoproject/SmartCompact/main/docs/media/cover-en.jpg" alt="SmartCompact in 90 seconds (video)" width="100%"></a></p>
<p align="center"><sub>▶ Watch the 90-second explainer (click the image to play)</sub></p>

**SmartCompact lets long coding-agent sessions compact earlier, at a pause after a piece of work is finished.** On 18–60 consecutive coding tasks it cut cost by **7–44%** with no loss in hidden acceptance tests; the longer the session, the more it saves. In the longest runs (60 tasks, native sessions reaching 820k–960k tokens) the model missed 6 of 180 recall questions about details mentioned in passing much earlier ([how it was tested](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/EVALUATION.md)).

Every request re-reads the whole context, so a long context makes every step expensive. Native auto-compaction waits until the context is nearly full (close to 1M tokens in Claude Code, up to 800k in Codex if configured), and it ignores timing, so it often lands in the middle of a task. SmartCompact works with Claude Code (CLI and desktop app), [Pi](https://github.com/earendil-works/pi) and the Codex CLI:

- **Compact at a good moment.** Once the context passes the **allow line** (200k tokens by default), it compacts when a turn ends, if a piece of work has been finished since the last compaction (a commit, tests passing, a task completed) and no file has been changed since.
- **Never in the middle of work.** It only decides when a turn ends, never mid-turn, and it waits while tests or the build are failing or errors keep repeating. It also waits until you have been idle for 3 minutes, so a back-and-forth discussion is not cut off.
- **No limit of its own.** If no piece of work gets finished, the agent is usually deep in one large task, which is when a large context pays off. SmartCompact leaves it alone, and the platform's native compaction applies as it would without the plugin.
- **A progress ledger bridges the gap.** Files changed, the latest commit and test result, the user requirements and decisions the agent recorded, and the agent's last reply are handed back to the model after compaction.
- **No pointless compactions.** It skips compaction when it would not free enough space.

## Results

The same codebase and 18–30 consecutive development tasks, where later tasks change the results of earlier ones; each platform run 3 times with and 3 times without SmartCompact. Acceptance is graded by hidden tests the model never sees; after each round the model answers recall questions, including details mentioned in passing much earlier.

| Platform (model) | Native compaction | Cost | Tasks accepted | Recall |
|---|---|---|---|---|
| Codex (gpt-6-astra) | 800k | **−19%** | 18/18 both | 54/54 both |
| Pi (gpt-5.5) | about 256k | −11% to −22% | 18/18 both | native 51/54, SmartCompact 53/54 |
| Claude Code (Haiku 5.5, 30 tasks) | close to 1M | −7% (noisy) | 30/30 both | 90/90 both |
| Claude Code (Haiku 5.5, 60 tasks) | close to 1M | **−44%** | native 59–60/60, SmartCompact 60/60 | native 180/180, SmartCompact 174/180 |

Cost is converted to cached-input-token equivalents using each provider's price ratios. The later native compaction kicks in and the faster a session grows, the more it saves. Below 200k SmartCompact does nothing, so it costs nothing either. After a compaction the model spends extra requests getting familiar with the code again; that is included in the cost above. These are small samples on one codebase and one kind of task; the [evaluation](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/EVALUATION.md) has the method, the data and the limitations.

## Install

**Claude Code** (2.1.295 or later)

```
/plugin marketplace add coffeecoproject/SmartCompact
/plugin install smartcompact@smartcompact
```

It takes effect in new sessions. `/smartcompact pause` turns it off for the current session.

**Pi**

```
pi install npm:smartcompact
```

With Pi's default settings, SmartCompact compacts at a finished piece of work when a turn ends (`agent_settled`). If you raise `reserveTokens` so that Pi's native compaction comes earlier, SmartCompact decides at that point whether to postpone it, based on the state of the work.

**Codex CLI** (0.162 or later, Node.js 22.18 or later)

```bash
codex plugin marketplace add coffeecoproject/SmartCompact
codex plugin add smartcompact@smartcompact
```

Trust the plugin's 4 hooks when Codex asks on its next start. The hooks find a Node.js 22.18+ on their own (`PATH`, nvm, Homebrew; or set `SMARTCOMPACT_NODE`); without one they do nothing. To update, run `codex plugin marketplace upgrade smartcompact` and then the `codex plugin add` command again. If you installed an earlier version with `node scripts/codex.ts install`, run `node scripts/codex.ts uninstall` in that clone once, so the hooks do not run twice.

Codex hooks cannot postpone a compaction in the middle of a turn, so SmartCompact decides when a turn ends and, if it should compact, starts the compaction through Codex's shared background server once the session is idle (the interactive UI uses it by default). `codex exec` does not use the shared server by default, and the Codex App (ChatGPT.app) currently cannot; there SmartCompact only hands back the progress ledger, and compaction follows Codex's native rules. If you want compaction to come earlier there, add Codex's own `model_post_turn_compact_threshold_percent` at the top of `config.toml`: it compacts after a turn ends once the context passes that percentage of the usable window (31 is about 260k for an 872k window; see the test report).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Allow line | 200000 | Above it, compact when a turn ends once a piece of work has been finished |
| Minimum freed | 60000 | Skip compaction if it is expected to free less than this |
| Idle wait | 180 | After deciding to compact, wait until you have been idle this many seconds; a new message or command cancels it |

- Claude Code: the plugin options `allowLineTokens`, `minFreedTokens` and `compactIdleSeconds`; leave them empty for the defaults.
- Pi: the flags `--smartcompact-allow-line`, `--smartcompact-min-freed` and `--smartcompact-idle-seconds`.
- Codex: the environment variables `SMARTCOMPACT_ALLOW_LINE`, `SMARTCOMPACT_MIN_FREED` and `SMARTCOMPACT_IDLE_SECONDS`.

## Seeing what it did

- Claude Code and Pi: `/smartcompact` (or `/smartcompact report`) shows the allow line, the native compaction point, the finished-work signals it saw and a cost estimate; `/smartcompact pause` and `resume` turn it off and on for the session. The model can also call a `checkpoint` tool to record the user's requirements and decisions, which come back with the ledger after compaction.
- Codex: `node ~/.codex/plugins/cache/smartcompact/smartcompact/<version>/adapters/codex/report.ts <session ID>` (Node.js 22.18+); records are kept in `~/.codex/smartcompact/`.

## FAQ

**How does it know a piece of work is finished?** From the commands the agent runs. Any finished piece of work since the last compaction counts, not only one in the current turn: the end of a turn is already a pause, so waiting for the next commit would mostly just cost more. Once files are changed again after it, the next piece of work has started, and SmartCompact waits for that one to finish. A commit counts if `git commit` actually ran and the tool call did not fail. A test command piped into something else (`| tail`) without `pipefail` does not count, since its exit code cannot be trusted.

**Will the model forget things after compaction?** Sometimes, for details mentioned in passing. The ledger only records files, commits, tests and the requirements and decisions the model chose to record; user requirements have their own section, so later notes do not push them out, and only the oldest are dropped once there are more than 30. Details the user mentions in passing are kept by asking the compaction summary to keep every specific fact the user stated. On Pi this clearly reduced losses, but it is not a guarantee.

**Does it change Claude Code's own settings?** No. Native auto-compaction stays where it is (close to 1M). Versions up to 0.1.2 moved it to about 260k by setting `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the session (which child processes inherited) and also compacted there without a finished piece of work. 0.1.3 removed both: a long task is no longer cut off at a fixed size. A session opened on 0.1.2 or earlier keeps the old setting until you start a new one.

**Does it help with a smaller context window?** Only when native compaction comes well after 200k. With a 200k window, native compaction comes first (about 167k in Claude Code) and SmartCompact never acts. On Codex's default 272k window, native compaction is at about 245k, which leaves only 200k–245k for SmartCompact, so it saves little unless `model_auto_compact_token_limit` is set higher. The allow line can be lowered (`allowLineTokens`, `--smartcompact-allow-line`, `SMARTCOMPACT_ALLOW_LINE`), but lower lines have not been evaluated.

**How do I remove it?**

- Claude Code: `/plugin uninstall smartcompact@smartcompact`.
- Pi: `pi remove npm:smartcompact`.
- Codex: `codex plugin remove smartcompact@smartcompact`.

## Development

```bash
sh scripts/check.sh
```

This runs the structure checks, the core dependency boundary check and all tests. Layout:

- `plugin/`: the Claude Code plugin. `plugin/src/core/` holds the platform-independent decisions, signals, ledger and cost estimate that every adapter reuses.
- `adapters/pi/`, `adapters/codex/`: the Pi and Codex adapters.
- `eval/`: the A/B evaluation scripts (one each for Claude, Pi and Codex); the task format is described in `eval/day.py`. The tasks and hidden tests come from an internal project and are not published.
- `docs/EVALUATION.md`: how the A/B runs were done and their results. `DESIGN.md`: design notes and `docs/TEST-REPORT.md`: the full test report (both in Chinese).

## License

MIT. See [LICENSE](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE).
