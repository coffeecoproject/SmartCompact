# SmartCompact

[English](https://github.com/coffeecoproject/SmartCompact/blob/main/README.md) · **中文**

[![npm](https://img.shields.io/npm/v/smartcompact)](https://www.npmjs.com/package/smartcompact)
[![GitHub stars](https://img.shields.io/github/stars/coffeecoproject/SmartCompact?style=social)](https://github.com/coffeecoproject/SmartCompact/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE)

**SmartCompact 让编程 agent 的长会话早点压缩，挑在做完一件事之后的停顿处。** 在 18～60 个连续开发任务上，成本降低 **7%～44%**，隐藏验收测试没有损失，会话越长省得越多。最长的一组（60 个任务，原生组上下文到 82 万～96 万）里，很早之前随口提到的细节，180 道记忆题少答对 6 道（[测试报告](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/TEST-REPORT.md)）。

agent 每发一次请求，都要把整段上下文重新读一遍，上下文越长，每一步越贵。原生的自动压缩要等到快满了才触发（Claude Code 接近 100 万，Codex 可以配到 80 万），而且不看时机，常常发生在一件事做到一半的时候。SmartCompact 支持 Claude Code（终端和桌面 App）、[Pi](https://github.com/earendil-works/pi) 和 Codex 命令行：

- **挑对时机压缩。** 上下文超过**允许压缩线**（默认 20 万）以后，只要上次压缩以来做完过一件事（一次提交、测试通过、任务完成），就在这一轮结束时压缩。
- **不在做到一半时压缩。** 只在一轮结束时判断，从不在一轮中间主动压缩；测试失败、构建失败、连续报错或后台任务还在跑时先等着。
- **有兜底。** 一直等不到合适时机、上下文超过**宽限线**（允许压缩线 × 1.3）时，在一轮结束时压缩。
- **用进度笔记接上。** 改过的文件、最近的提交和测试结果、记下的决定，压缩后补回给模型。
- **不做白费的压缩。** 预计腾不出足够空间时不压缩，避免刚压缩完又压缩。

## 实验结果

同一个代码库、连续 18～30 个开发任务（后面的任务会修改前面任务的结果），每个平台装与不装各跑 3 次。验收由脚本跑模型看不到的隐藏测试；每轮结束问几道记忆题，包括很早之前随口提到的细节。

| 平台（模型） | 原生压缩点 | 成本 | 任务验收 | 记忆题 |
|---|---|---|---|---|
| Codex（gpt-6-astra） | 80 万 | **−19%** | 两组都 18/18 | 两组都 54/54 |
| Pi（gpt-5.5） | 约 25.6 万 | −11%～−22% | 两组都 18/18 | 原生 51/54，插件 53/54 |
| Claude Code（Haiku 5.5，30 个任务） | 接近 100 万 | −7%（波动较大） | 两组都 30/30 | 两组都 90/90 |
| Claude Code（Haiku 5.5，60 个任务） | 接近 100 万 | **−44%** | 原生 59～60/60，插件 60/60 | 原生 180/180，插件 174/180 |

成本按各家价格比例折算成"缓存读取 token 当量"。原生压缩得越晚、会话涨得越快，省得越多；会话没超过 20 万时插件不起作用，也没有额外开销。压缩后模型要多花一些请求重新熟悉代码，这部分已计入上面的成本。样本小，只用了一个代码库和一种任务类型；方法、数据和局限见[测试报告](https://github.com/coffeecoproject/SmartCompact/blob/main/docs/TEST-REPORT.md)。

## 安装

**Claude Code**（2.1.295 及以上）

```
/plugin marketplace add coffeecoproject/SmartCompact
/plugin install smartcompact@smartcompact
```

装好后新开会话生效。插件会把原生自动压缩线调到宽限线附近，`/smartcompact pause` 可以让当前会话恢复原生行为。

**Pi**

```
pi install npm:smartcompact
```

Pi 默认配置下，插件在一轮结束（`agent_settled`）时挑刚做完一件事的时机压缩。如果你把 `reserveTokens` 调大、让 Pi 的原生压缩提前，插件会在那个点按工作状态决定是否推迟。

**Codex 命令行**（0.162 及以上，Node.js 22.18 及以上）

```bash
git clone https://github.com/coffeecoproject/SmartCompact.git
cd SmartCompact
node scripts/codex.ts install
```

安装脚本只在 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）末尾写入一段带标记的 hook 配置，改之前备份原文件。下次启动 Codex 时按提示信任这 4 个 hook。升级 Node 或移动仓库后重新运行一次 install。

Codex 的 hook 不能推迟一轮中间的压缩，所以插件在一轮结束时判断，需要压缩就通过 Codex 的共享后台服务（交互界面默认会用它）在会话空闲时发起。`codex exec` 默认不走共享后台服务，Codex App（ChatGPT.app）目前走不了，这时插件只补回进度笔记，压缩仍按 Codex 原生规则。想给它们也加个兜底，可以在 `config.toml` 顶部加上 Codex 自带的 `model_post_turn_compact_threshold_percent`：上下文超过可用窗口的这个百分比时，在一轮结束后压缩（窗口 87.2 万时设 31，约 26 万；详见测试报告）。

## 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| 允许压缩线 | 200000 | 超过它、做完过一件事后，在一轮结束时压缩 |
| 宽限倍数 | 1.3 | 超过 允许压缩线 × 倍数 时不再等刚做完一件事 |
| 最少腾出空间 | 60000 | 预计腾出的空间少于它时不压缩 |

- Claude Code：插件配置项 `allowLineTokens`、`graceFactor`、`minFreedTokens`，留空用默认值。
- Pi：命令行开关 `--smartcompact-allow-line`、`--smartcompact-grace`、`--smartcompact-min-freed`。
- Codex：环境变量 `SMARTCOMPACT_ALLOW_LINE`、`SMARTCOMPACT_GRACE`、`SMARTCOMPACT_MIN_FREED`。

## 查看效果

- Claude Code 和 Pi：`/smartcompact`（或 `/smartcompact report`）查看三条线、识别到的阶段节点和成本估算；`/smartcompact pause` / `resume` 暂停或恢复当前会话。模型还可以调用 `checkpoint` 工具记下决定，压缩后和进度笔记一起补回。
- Codex：`node adapters/codex/report.ts <会话 ID>`，记录在 `~/.codex/smartcompact/`。

## 常见问题

**怎么判断"做完一件事"？** 靠识别 agent 执行的命令。看的是上次压缩以来有没有做完过一件事，不要求正好在这一轮：一轮结束本身就是停顿点，非要等下一次提交，多半只是多花钱。提交只要真的执行了 `git commit` 且工具调用没报错就算；测试命令接了管道（`| tail`）又没开 `pipefail` 时退出码不可信，不算测试结果。

**压缩后模型会不会忘事？** 随口提到的细节有时会丢。进度笔记只记文件、提交、测试和模型主动记下的决定。用户在对话里随口交代的细节，靠压缩时要求摘要原样保留用户说过的具体信息。Pi 上这样做明显减少了丢失，但不能保证不丢。

**Claude Code 上有什么要注意的？** 插件的兜底压缩点和它调整后的原生压缩点接近；长时间认不出刚做完一件事时，原生压缩仍可能在一轮中间触发。插件是通过在会话里设置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 来调整原生压缩点的，从这个会话里启动的进程会继承它：agent 运行的 `claude -p` 或脚本里启动的 Claude，也会在 26 万左右压缩。需要的话，启动这类进程前去掉这个变量。

**怎么卸载？**

- Claude Code：`/plugin uninstall smartcompact@smartcompact`。
- Pi：`pi remove npm:smartcompact`。
- Codex：在仓库目录里运行 `node scripts/codex.ts uninstall`。

## 开发

```bash
sh scripts/check.sh
```

运行结构校验、core 依赖边界检查和全部测试。目录：

- `plugin/`：Claude Code 插件；`plugin/src/core/` 是和平台无关的决策、信号、进度笔记和成本估算，其他适配都复用它。
- `adapters/pi/`、`adapters/codex/`：Pi 和 Codex 的适配。
- `eval/`：对照评测脚本（Claude、Pi、Codex 各一个），任务格式见 `eval/day.py`；评测用的题目和隐藏测试来自内部项目，没有放进仓库。
- `DESIGN.md`：设计说明；`docs/TEST-REPORT.md`：测试报告。

## 许可证

MIT，见 [LICENSE](https://github.com/coffeecoproject/SmartCompact/blob/main/LICENSE)。
