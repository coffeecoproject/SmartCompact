// /smartcompact report 的内容：当前状态、决策次数、信号次数、成本估算。只排版，不读写。

import type { Lines } from './lines.ts'
import type { DecisionLogEntry, SessionState } from './state.ts'
import { savingsRatio } from './usage.ts'

export type DecisionCounts = Record<string, number>

/** 按"事件:动作"统计决策日志，例如 compacted:plugin、mid-turn:veto。 */
export function countDecisions(entries: readonly DecisionLogEntry[]): DecisionCounts {
  const counts: DecisionCounts = {}
  for (const entry of entries) {
    const key = entry.event === 'compacted' ? `compacted:${entry.action ?? entry.trigger ?? ''}` : `${entry.event}:${entry.action ?? ''}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const k = (tokens: number | undefined): string => (tokens === undefined ? '—' : `${Math.round(tokens / 1000)}k`)

export function renderReport(input: {
  state: SessionState
  lines: Lines
  tokens: number | undefined
  counts: DecisionCounts
}): string {
  const { state, lines, tokens, counts } = input
  const ratio = savingsRatio(state.usage)
  const seen = state.seen
  return [
    `SmartCompact${state.paused ? '（已暂停）' : ''}`,
    `- 当前用量 ${k(tokens)}；允许压缩线 ${k(lines.allow)}，兜底线 ${k(lines.midTurn)}，上限 ${k(lines.ceiling)}${lines.adjustsNative ? '' : '（原生压缩线未调整）'}`,
    `- 本会话压缩 ${state.compactions} 次；最近一次压缩后约 ${k(state.measuredAfterTokens)}`,
    `- 本会话决策：插件压缩 ${(counts['compacted:plugin'] ?? 0) + (counts['compacted:plugin-queued'] ?? 0)}，自动压缩放行 ${counts['compacted:auto'] ?? 0}，手动压缩 ${counts['compacted:manual'] ?? 0}，轮中否决 ${counts['mid-turn:veto'] ?? 0}，轮末等待 ${counts['turn-end:wait'] ?? 0}`,
    `- 信号：提交 ${seen.commit}，测试通过 ${seen['tests-passed']}，任务完成 ${seen['task-completed']}，checkpoint 完成 ${seen.checkpoint}，后台任务 ${seen.background}`,
    `- 当前状态：${state.work.milestone ? `已到阶段节点（${state.work.milestone}）` : '等待阶段节点'}${state.work.testsFailing ? '，测试失败中' : ''}${state.work.buildFailing ? '，构建失败中' : ''}`,
    ratio === undefined
      ? '- 成本估算：还没有读数'
      : `- 成本估算：上下文成本约节省 ${Math.round(ratio * 100)}%（${state.usage.samples} 次读数，已扣除压缩本身的开销；对比的是没有插件、一直涨到原生压缩点的情况）${
          ratio < 0 ? '。刚压缩完时压缩开销还没赚回来，继续使用后会转正' : ''
        }`,
  ].join('\n')
}
