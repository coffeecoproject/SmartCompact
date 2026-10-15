# SmartCompact for Claude Code

SmartCompact compacts long Claude Code sessions earlier, at a pause after a piece of work is finished, so every later request re-reads a smaller context. Once the context passes 200k tokens, it compacts at the end of a turn if a commit, passing tests or a completed task happened since the last compaction. It waits while tests or the build are failing, errors repeat or a background job is running, and falls back to compacting at the end of a turn past about 260k. A short progress ledger (files changed, latest commit and test result, recorded decisions) is handed back to the model after compaction.

In a 60-task A/B run on Claude Haiku it cut estimated cost by 44% with no loss in hidden acceptance tests; the model missed 6 of 180 recall questions about details mentioned in passing long before. Method and data: [docs/EVALUATION.md](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/EVALUATION.md).

## What it runs, reads and writes

Everything runs locally inside Claude Code. **The plugin makes no network requests and starts no processes.**

- **Hooks** (one module, `hooks/register.ts`): session start, prompt submit, tool calls, task created/completed, stop, turn complete and compaction.
- **Reads**: the session's token usage; the tool name, input and success of each tool call, to recognize work: file paths from Edit/Write, Bash command text (to recognize `git commit` and test or build commands, and whether they failed), the `[branch hash] message` line from a commit's output, TodoWrite items and task events. It does not read file contents, and nothing it reads leaves the machine.
- **Writes**:
  - the plugin's own storage (`$.store`): per-session state and the progress ledger (file paths, the latest commit line, the latest test command and result, in-progress task names, notes recorded with the `checkpoint` tool) and a short decision log. Old session records are pruned automatically.
  - the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for the session, to move Claude Code's native auto-compaction close to the fallback line. Processes started from the session (for example `claude -p`) inherit it.
- **Actions**: compacts the session (or queues `/compact` in headless sessions) when the rules above say so; registers a `checkpoint` tool and a `/smartcompact` command.

## Use

- Install: `/plugin marketplace add coffeecoproject/SmartCompact`, then `/plugin install smartcompact@smartcompact`. It takes effect in new sessions.
- `/smartcompact` (or `/smartcompact report`) shows the lines, recognized milestones and a cost estimate; `/smartcompact pause` and `/smartcompact resume` turn it off and on for the session.
- Settings (optional, empty means default): `allowLineTokens` (200000), `graceFactor` (1.3), `minFreedTokens` (60000).
- Remove: `/plugin uninstall smartcompact@smartcompact`.

Full documentation, Pi and Codex versions: https://github.com/coffeecoproject/SmartCompact

License: MIT.
