// 两个决策函数：一轮结束时要不要主动压缩；一轮进行中原生自动压缩来问时放不放行。
// 读不到用量时一律不干预，按原生行为来。

import type { Lines } from './lines.ts'
import type { Params } from './params.ts'
import { type HardSignal, hardSignal, type MilestoneSource, type WorkState } from './signals.ts'

export type DecisionInput = {
  /** 当前上下文用量；undefined 表示读不到 */
  tokens: number | undefined
  lines: Lines
  work: WorkState
  /** 预计压缩后的大小（上次实测值，没有时用默认估计） */
  expectedAfterTokens: number
  paused: boolean
}

export type TurnEndDecision =
  | { action: 'none'; reason: 'paused' | 'no-reading' | 'below-line' }
  | { action: 'wait'; reason: HardSignal | 'insufficient-benefit' | 'waiting-for-milestone' }
  | { action: 'compact'; reason: MilestoneSource | 'past-grace' }

export type MidTurnDecision =
  | { action: 'allow'; reason: 'paused' | 'no-reading' | 'at-ceiling' | 'default' }
  | { action: 'veto'; reason: HardSignal | 'insufficient-benefit' }

function freesEnough(tokens: number, input: DecisionInput, params: Params): boolean {
  return tokens - input.expectedAfterTokens >= params.minFreedTokens
}

export function decideAtTurnEnd(input: DecisionInput, params: Params): TurnEndDecision {
  const { tokens, lines, work } = input
  if (input.paused) return { action: 'none', reason: 'paused' }
  if (tokens === undefined) return { action: 'none', reason: 'no-reading' }
  if (tokens < lines.allow) return { action: 'none', reason: 'below-line' }
  const hard = hardSignal(work, params)
  if (hard) return { action: 'wait', reason: hard }
  if (!freesEnough(tokens, input, params)) return { action: 'wait', reason: 'insufficient-benefit' }
  if (work.milestone) return { action: 'compact', reason: work.milestone }
  if (tokens >= lines.midTurn) return { action: 'compact', reason: 'past-grace' }
  return { action: 'wait', reason: 'waiting-for-milestone' }
}

/** 快到允许压缩线、本周期笔记没更新也没提醒过时，提醒模型更新笔记。 */
export function shouldNudge(
  input: { tokens: number | undefined; lines: Lines; notesUpdated: boolean; nudged: boolean; paused: boolean },
  params: Params,
): boolean {
  if (input.paused || input.notesUpdated || input.nudged || input.tokens === undefined) return false
  return input.tokens >= input.lines.allow * params.nudgeAtShare
}

export function decideMidTurn(input: DecisionInput, params: Params): MidTurnDecision {
  const { tokens, lines, work } = input
  if (input.paused) return { action: 'allow', reason: 'paused' }
  if (tokens === undefined) return { action: 'allow', reason: 'no-reading' }
  // 用量读数不含最新的工具结果，接近上限时留出余量，绝不挡住快满时的压缩。
  if (tokens >= lines.ceiling - params.ceilingMarginTokens) return { action: 'allow', reason: 'at-ceiling' }
  const hard = hardSignal(work, params)
  if (hard) return { action: 'veto', reason: hard }
  if (!freesEnough(tokens, input, params)) return { action: 'veto', reason: 'insufficient-benefit' }
  return { action: 'allow', reason: 'default' }
}
