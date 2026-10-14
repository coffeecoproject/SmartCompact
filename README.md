# SmartCompact

**English summary.** SmartCompact makes long coding-agent sessions compact *earlier, at the right moment* — once the context is past a threshold (200k tokens by default) and a piece of work has just been finished, typically a commit. Every request re-reads the whole context, so keeping it smaller saves money; picking the moment right after a commit avoids interrupting work. It never compacts in the middle of a task by itself. It works with Claude Code (CLI and desktop app), [pi](https://github.com/earendil-works/pi) and the Codex CLI. In controlled A/B runs (18–30 consecutive coding tasks, 3 runs per arm) it cut cost by 7–22% with no loss in hidden acceptance tests or recall questions. Details: [docs/TEST-REPORT.md](docs/TEST-REPORT.md) (Chinese).

---

让长会话早点、挑对时机压缩：降低成本，同时不损失结果。

## 为什么

agent 每发一次请求，都要把整段上下文重新读一遍。上下文越长，每一步越贵。原生的自动压缩通常要等到快满了才触发（Claude Code 接近 100 万，Codex 可以配到 80 万），在那之前每一步都在为很长的上下文付钱；而且原生压缩不看时机，常常发生在一件事做到一半的时候。

SmartCompact 的做法：

- 上下文超过**允许压缩线**（默认 20 万）以后，等到**刚做完一件事**（一次提交、测试刚通过、任务完成）再压缩。
- 不在一件事做到一半时主动压缩；测试失败、构建失败、连续报错或后台任务还在跑时也不压缩。
- 一直等不到合适时机、上下文超过**宽限线**（允许压缩线 × 1.3）时，在一轮结束时压缩，作为兜底。
- 压缩前后用一份**进度笔记**接上：改过的文件、最近的提交和测试结果、记下的决定，压缩后补回给模型。
- 预计腾不出足够空间时不压缩，避免刚压缩完又压缩。

## 效果

同一个代码库、连续 18～30 个开发任务（后面的任务会修改前面任务的结果），每个平台装与不装各跑 3 次。验收由脚本跑模型看不到的隐藏测试；每轮结束问几道记忆题，包括很早之前随口提到的细节。

| 平台（模型） | 原生压缩点 | 成本 | 任务验收 | 记忆题 |
|---|---|---|---|---|
| Codex（gpt-6-astra） | 80 万 | **−19%** | 两组都 18/18 | 两组都 54/54 |
| pi（gpt-5.5） | 约 25.6 万 | −11%～−22% | 两组都 18/18 | 原生 51/54，插件 53/54 |
| Claude Code（Haiku 5.5，30 题） | 接近 100 万 | −7%（波动较大） | 两组都 30/30 | 两组都 90/90 |

成本按各家价格比例折算成"缓存读取 token 当量"。规律：原生压缩得越晚、会话涨得越快，省得越多；会话没超过 20 万时插件不起作用，也没有坏处。完整方法、数据、代价和局限见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)。

## 安装

### Claude Code（终端和桌面 App）

需要 Claude Code ≥ 2.1.295。

```
/plugin marketplace add coffeecoproject/SmartCompact
/plugin install smartcompact@smartcompact
```

装好后新开会话生效。插件会把原生自动压缩线调到宽限线附近，`/smartcompact pause` 可以让当前会话恢复原生行为。

### pi

```bash
pi install git:github.com/coffeecoproject/SmartCompact
```

pi 默认配置下，插件在一轮结束（`agent_settled`）时挑阶段节点主动压缩。如果你把 `reserveTokens` 调大、让 pi 的原生压缩提前，插件会在那个点按工作状态决定是否推迟。

### Codex 命令行

需要 Node ≥ 22.18（直接运行 TypeScript）和 Codex CLI ≥ 0.162。

```bash
git clone https://github.com/coffeecoproject/SmartCompact.git
cd SmartCompact
node scripts/codex.ts install
```

安装脚本只在 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）末尾写入一段带标记的 hook 配置，改之前备份原文件；`node scripts/codex.ts uninstall` 移除。下次启动 Codex 时按提示信任这 4 个 hook。升级 Node 或移动仓库后重新运行一次 install。

Codex 的 hook 不能推迟一轮中间的压缩，所以插件在一轮结束时判断，需要压缩就通过 Codex 的共享后台服务（交互界面默认会用它）在会话空闲时发起。`codex exec` 和 Codex App（ChatGPT.app）默认不走共享后台服务，这时插件只补回进度笔记，压缩仍按 Codex 原生规则。

## 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| 允许压缩线 | 200000 | 超过它且刚做完一件事时压缩 |
| 宽限倍数 | 1.3 | 超过 允许压缩线 × 倍数 时不再等阶段节点 |
| 最少腾出空间 | 60000 | 预计腾出的空间少于它时不压缩 |

- Claude Code：安装插件时的配置项（`allowLineTokens`、`graceFactor`、`minFreedTokens`），留空用默认值。
- pi：命令行开关 `--smartcompact-allow-line`、`--smartcompact-grace`、`--smartcompact-min-freed`。
- Codex：环境变量 `SMARTCOMPACT_ALLOW_LINE`、`SMARTCOMPACT_GRACE`、`SMARTCOMPACT_MIN_FREED`。

## 查看效果

- Claude Code 和 pi：`/smartcompact`（或 `/smartcompact report`）查看三条线、阶段节点计数和成本估算；`/smartcompact pause` / `resume` 暂停或恢复。Claude Code 和 pi 里模型还可以调用 checkpoint 工具记下决定，压缩后一起补回。
- Codex：`node adapters/codex/report.ts <会话 ID>`，记录在 `~/.codex/smartcompact/`。

## 局限

- 判断"刚做完一件事"靠识别命令：提交只要真的执行了 `git commit` 且没报错就算；测试命令接了管道（`| tail`）又没开 `pipefail` 时退出码不可信，不算测试结果。
- 进度笔记只记文件、提交、测试和模型主动记下的决定。用户在对话里随口交代的细节靠压缩时的说明要求摘要保留，pi 上能明显减少丢失，但不能保证不丢。
- Claude Code 上，插件的兜底压缩点和它调整后的原生压缩点接近；长时间认不出阶段节点时，可能由原生压缩在一轮中间触发。
- 评测只用了一个代码库和一种任务类型，Claude 只测了 Haiku。

## 开发

```bash
sh scripts/check.sh
```

结构校验、core 依赖边界检查和全部测试。目录：

- `plugin/`：Claude Code 插件；`plugin/src/core/` 是和平台无关的决策、信号、进度笔记和成本估算，其他适配都复用它。
- `adapters/pi/`、`adapters/codex/`：pi 和 Codex 的适配。
- `eval/`：对照评测脚本（Claude、pi、Codex 各一个），任务格式见 `eval/day.py`；评测用的题目和隐藏测试涉及内部项目，没有放进仓库。
- `DESIGN.md`：设计说明；`docs/TEST-REPORT.md`：测试报告。

## 许可证

[MIT](LICENSE)
