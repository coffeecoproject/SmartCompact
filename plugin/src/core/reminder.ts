// 用户发消息前要不要附一句用户看不到的提醒。两种提醒的文字、判断、状态和日志都在这里，适配层只负责注入。

import { decideAtTurnEnd, shouldNudge, shouldRemindMilestone } from './decide.ts'
import type { Lines } from './lines.ts'
import type { Params } from './params.ts'
import { type DecisionLogEntry, expectedAfterTokens, type SessionState } from './state.ts'

/** 快到允许压缩线时提醒模型更新笔记。 */
export const checkpointNudge = (tokens: number, tool: string): string =>
  `SmartCompact: the context is at about ${Math.round(tokens / 1000)}k tokens and will be compacted at the next finished piece of work. ` +
  `If decisions, user requirements or progress are not yet recorded, call ${tool} briefly; if a piece of work was just finished, set milestone: true. ` +
  'If the user is waiting for an answer, answer first.'

/** 超过允许线、在等做完一件事时，提醒模型做完一步就标完成。 */
export const milestoneReminder = (tokens: number, tool: string): string =>
  `SmartCompact: the context is at about ${Math.round(tokens / 1000)}k tokens and will be compacted once a piece of work is finished. ` +
  `When you finish a step (a fix, a subtask, a passing test run), call ${tool} with milestone: true, even without a commit; ` +
  'do not mark unfinished work as done. If the user is waiting for an answer, answer first.'

export type PromptReminder = { text: string; state: SessionState; log: Omit<DecisionLogEntry, 'at' | 'session'> }

/**
 * 超过允许线、在等做完一件事时，提醒模型做完一步就标完成；否则快到允许线、笔记没更新时，提醒记笔记。
 * 两种都算本周期提醒过，不重复提醒记笔记。不需要提醒时返回 undefined。
 */
export function promptReminder(
  state: SessionState,
  tokens: number | undefined,
  lines: Lines,
  params: Params,
  tool: string,
): PromptReminder | undefined {
  if (tokens === undefined) return undefined
  // 用户发下一条消息前状态没变，判断和上一轮结束时一样。
  const waiting = decideAtTurnEnd(
    { tokens, lines, work: state.work, expectedAfterTokens: expectedAfterTokens(state, params.defaultAfterTokens), paused: state.paused },
    params,
  )
  if (shouldRemindMilestone(waiting, tokens, state.remindedAtTokens, params)) {
    return {
      text: milestoneReminder(tokens, tool),
      state: { ...state, nudged: true, remindedAtTokens: tokens },
      log: { event: 'reminder', action: 'milestone', reason: waiting.reason, tokens },
    }
  }
  if (shouldNudge({ tokens, lines, notesUpdated: state.notesUpdated, nudged: state.nudged, paused: state.paused }, params)) {
    return {
      text: checkpointNudge(tokens, tool),
      state: { ...state, nudged: true },
      log: { event: 'reminder', action: 'nudge', reason: 'notes-not-updated', tokens },
    }
  }
  return undefined
}
