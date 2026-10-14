# SmartCompact

**English** · [中文](https://github.com/coffeecoproject/SmartCompact/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/smartcompact)](https://www.npmjs.com/package/smartcompact)
[![GitHub stars](https://img.shields.io/github/stars/coffeecoproject/SmartCompact?style=social)](https://github.com/coffeecoproject/SmartCompact/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE)

**SmartCompact lets long coding-agent sessions compact earlier, right after a piece of work is finished.** On 18–30 consecutive coding tasks it cut cost by **7–22%**, with no loss in hidden acceptance tests or recall questions ([test report](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/TEST-REPORT.md), in Chinese).

Every request re-reads the whole context, so a long context makes every step expensive. Native auto-compaction waits until the context is nearly full (close to 1M tokens in Claude Code, up to 800k in Codex if configured), and it ignores timing, so it often lands in the middle of a task. SmartCompact works with Claude Code (CLI and desktop app), [Pi](https://github.com/earendil-works/pi) and the Codex CLI:

- **Compact at the right moment.** Once the context passes the **allow line** (200k tokens by default), it waits for a piece of work to finish: a commit, tests passing, a task completed.
- **Never in the middle of work.** It does not compact on its own mid-task, nor while tests or the build are failing, errors keep repeating, or a background job is running.
- **A fallback.** If no good moment comes and the context passes the **grace line** (allow line × 1.3), it compacts at the end of a turn.
- **A progress ledger bridges the gap.** Files changed, the latest commit and test result, and decisions the agent recorded are handed back to the model after compaction.
- **No pointless compactions.** It skips compaction when it would not free enough space.

## Results

The same codebase and 18–30 consecutive development tasks, where later tasks change the results of earlier ones; each platform run 3 times with and 3 times without SmartCompact. Acceptance is graded by hidden tests the model never sees; after each round the model answers recall questions, including details mentioned in passing much earlier.

| Platform (model) | Native compaction | Cost | Tasks accepted | Recall |
|---|---|---|---|---|
| Codex (gpt-6-astra) | 800k | **−19%** | 18/18 both | 54/54 both |
| Pi (gpt-5.5) | about 256k | −11% to −22% | 18/18 both | native 51/54, SmartCompact 53/54 |
| Claude Code (Haiku 5.5, 30 tasks) | close to 1M | −7% (noisy) | 30/30 both | 90/90 both |

Cost is converted to cached-input-token equivalents using each provider's price ratios. The later native compaction kicks in and the faster a session grows, the more it saves. Below 200k SmartCompact does nothing, so it costs nothing either. After a compaction the model spends extra requests getting familiar with the code again; that is included in the cost above. These are small samples on one codebase and one kind of task; the [report](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/TEST-REPORT.md) has the method, the data and the limitations.

## Install

**Claude Code** (2.1.295 or later)

```
/plugin marketplace add coffeecoproject/SmartCompact
/plugin install smartcompact@smartcompact
```

It takes effect in new sessions. The plugin moves the native auto-compaction to about the grace line; `/smartcompact pause` returns the current session to native behavior.

**Pi**

```
pi install npm:smartcompact
```

With Pi's default settings, SmartCompact compacts at a finished piece of work when a turn ends (`agent_settled`). If you raise `reserveTokens` so that Pi's native compaction comes earlier, SmartCompact decides at that point whether to postpone it, based on the state of the work.

**Codex CLI** (0.162 or later, Node.js 22.18 or later)

```bash
git clone https://github.com/coffeecoproject/SmartCompact.git
cd SmartCompact
node scripts/codex.ts install
```

The script only appends one marked block of hooks to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), backing up the file first. Trust the 4 hooks when Codex asks on its next start. Run install again after upgrading Node or moving the repository.

Codex hooks cannot postpone a compaction in the middle of a turn, so SmartCompact decides when a turn ends and, if it should compact, starts the compaction through Codex's shared background server once the session is idle (the interactive UI uses it by default). `codex exec` and the Codex App (ChatGPT.app) do not use the shared server by default; there SmartCompact only hands back the progress ledger, and compaction follows Codex's native rules.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Allow line | 200000 | Above it, compact right after a piece of work is finished |
| Grace factor | 1.3 | Above allow line × factor, stop waiting for a finished piece of work |
| Minimum freed | 60000 | Skip compaction if it is expected to free less than this |

- Claude Code: the plugin options `allowLineTokens`, `graceFactor` and `minFreedTokens`; leave them empty for the defaults.
- Pi: the flags `--smartcompact-allow-line`, `--smartcompact-grace` and `--smartcompact-min-freed`.
- Codex: the environment variables `SMARTCOMPACT_ALLOW_LINE`, `SMARTCOMPACT_GRACE` and `SMARTCOMPACT_MIN_FREED`.

## Seeing what it did

- Claude Code and Pi: `/smartcompact` (or `/smartcompact report`) shows the three lines, the finished-work signals it saw and a cost estimate; `/smartcompact pause` and `resume` turn it off and on for the session. The model can also call a `checkpoint` tool to record decisions, which come back with the ledger after compaction.
- Codex: `node adapters/codex/report.ts <session ID>`; records are kept in `~/.codex/smartcompact/`.

## FAQ

**How does it know a piece of work is finished?** From the commands the agent runs. A commit counts if `git commit` actually ran and the tool call did not fail. A test command piped into something else (`| tail`) without `pipefail` does not count, since its exit code cannot be trusted.

**Will the model forget things after compaction?** The ledger only records files, commits, tests and decisions the model chose to record. Details the user mentions in passing are kept by asking the compaction summary to keep every specific fact the user stated. On Pi this clearly reduced losses, but it is not a guarantee.

**Anything specific to Claude Code?** SmartCompact's fallback point is close to the native compaction point it moves. If it cannot recognize a finished piece of work for a long time, native compaction may still fire mid-turn.

**How do I remove it?**

- Claude Code: `/plugin uninstall smartcompact@smartcompact`.
- Pi: `pi remove npm:smartcompact`.
- Codex: `node scripts/codex.ts uninstall` in the repository.

## Development

```bash
sh scripts/check.sh
```

This runs the structure checks, the core dependency boundary check and all tests. Layout:

- `plugin/`: the Claude Code plugin. `plugin/src/core/` holds the platform-independent decisions, signals, ledger and cost estimate that every adapter reuses.
- `adapters/pi/`, `adapters/codex/`: the Pi and Codex adapters.
- `eval/`: the A/B evaluation scripts (one each for Claude, Pi and Codex); the task format is described in `eval/day.py`. The tasks and hidden tests come from an internal project and are not published.
- `DESIGN.md`: design notes; `docs/TEST-REPORT.md`: the test report (both in Chinese).

## License

MIT. See [LICENSE](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE).
