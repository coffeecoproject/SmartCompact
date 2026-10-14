// 会话状态与决策日志的数据格式。读写由适配层负责，core 只定义格式。

import { EMPTY_LEDGER, type Ledger } from './ledger.ts'
import { afterCompaction, applySignal, INITIAL_WORK_STATE, milestoneOf, type MilestoneSource, type Signal, type WorkState } from './signals.ts'
import { EMPTY_TALLY, type Prices, recordCompaction, recordSample, type UsageTally } from './usage.ts'

export type SignalsSeen = Record<MilestoneSource | 'background', number>

export type SessionState = {
  work: WorkState
  ledger: Ledger
  /** 最近一次实测的压缩后大小 */
  measuredAfterTokens?: number
  compactions: number
  paused: boolean
  /** 自上次压缩以来，模型是否通过 checkpoint 更新过笔记 */
  notesUpdated: boolean
  /** 自上次压缩以来，是否提醒过模型更新笔记 */
  nudged: boolean
  /** 各种信号出现过的次数，用于确认识别是否生效 */
  seen: SignalsSeen
  usage: UsageTally
}

export const INITIAL_SESSION_STATE: SessionState = Object.freeze({
  work: INITIAL_WORK_STATE,
  ledger: EMPTY_LEDGER,
  compactions: 0,
  paused: false,
  notesUpdated: false,
  nudged: false,
  seen: Object.freeze({ commit: 0, 'tests-passed': 0, 'task-completed': 0, checkpoint: 0, background: 0 }),
  usage: EMPTY_TALLY,
}) as SessionState

/** 读回的状态结构不对时，从初始状态开始。 */
export function parseState(raw: unknown): SessionState {
  if (!raw || typeof raw !== 'object') return INITIAL_SESSION_STATE
  const state = raw as Partial<SessionState>
  if (!state.work || !state.ledger || !state.seen || !state.usage) return INITIAL_SESSION_STATE
  return state as SessionState
}

export function expectedAfterTokens(state: SessionState, defaultAfterTokens: number): number {
  return state.measuredAfterTokens ?? defaultAfterTokens
}

/** 应用信号，同时更新信号计数。 */
export function withSignals(state: SessionState, signals: readonly Signal[]): SessionState {
  const seen = { ...state.seen }
  for (const signal of signals) {
    const milestone = milestoneOf(signal)
    if (milestone) seen[milestone] += 1
    if (signal.kind === 'background' && signal.running > 0) seen.background += 1
  }
  return { ...state, work: signals.reduce(applySignal, state.work), seen }
}

/** 记一次用量读数：压缩后的第一次读数同时记为实测的压缩后大小。 */
export function withSample(state: SessionState, tokens: number, ceiling: number, prices: Prices): SessionState {
  const measured = state.usage.pending ? { measuredAfterTokens: tokens } : {}
  return { ...state, ...measured, usage: recordSample(state.usage, tokens, ceiling, prices) }
}

/**
 * 一次压缩完成：清空阶段节点和本周期的笔记标记，等待读到压缩后大小。
 * @param attributed 是否算作插件带来的压缩；用户手动 /compact 没有插件时也会发生，不计入节省
 */
export function withCompaction(state: SessionState, before: number, summary: number, attributed = true): SessionState {
  return {
    ...state,
    work: afterCompaction(state.work),
    compactions: state.compactions + 1,
    notesUpdated: false,
    nudged: false,
    usage: attributed ? recordCompaction(state.usage, before, summary) : state.usage,
  }
}

export type DecisionLogEntry = {
  at: string
  /** 会话 ID，报告据此只统计当前会话 */
  session?: string
  event: 'setup' | 'turn-end' | 'mid-turn' | 'compacted' | 'checkpoint' | 'error'
  action?: string
  reason?: string
  tokens?: number
  tokensBefore?: number
  tokensAfter?: number
  trigger?: string
  detail?: string
}
