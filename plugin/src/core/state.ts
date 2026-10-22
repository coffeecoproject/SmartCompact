// 会话状态与决策日志的数据格式。读写由适配层负责，core 只定义格式。

import { type CheckpointInput, EMPTY_LEDGER, type Ledger } from './ledger.ts'
import { afterCompaction, applySignal, INITIAL_WORK_STATE, milestoneOf, type MilestoneSource, type Signal, type WorkState } from './signals.ts'
import { EMPTY_TALLY, type Prices, recordCompaction, recordSample, type UsageTally } from './usage.ts'

export type SignalsSeen = Record<MilestoneSource, number>

export type SessionState = {
  work: WorkState
  ledger: Ledger
  /** 最近一次实测的压缩后大小 */
  measuredAfterTokens?: number
  compactions: number
  paused: boolean
  /** 自上次压缩以来，模型是否通过 checkpoint 更新过笔记 */
  notesUpdated: boolean
  /** 自上次压缩以来，是否提醒过模型（记笔记或标完成）；提醒过就不再提醒记笔记 */
  nudged: boolean
  /** 本周期最近一次提醒模型标完成时的用量 */
  remindedAtTokens?: number
  /** 各种信号出现过的次数，用于确认识别是否生效 */
  seen: SignalsSeen
  usage: UsageTally
  /** 读文件的统计；平台认不出读文件时没有这一项 */
  reads?: ReadStats
}

/** 用来看压缩后要花多少次读取重新熟悉代码。 */
export type ReadStats = {
  /** 上次压缩之前读过或改过的文件 */
  known: string[]
  /** 上次压缩以来读过的文件 */
  current: string[]
  /** 上次压缩以来读文件的次数 */
  reads: number
  /** 其中读的是压缩前已经看过的文件 */
  rereads: number
}

const MAX_KNOWN_FILES = 300

export const INITIAL_SESSION_STATE: SessionState = Object.freeze({
  work: INITIAL_WORK_STATE,
  ledger: EMPTY_LEDGER,
  compactions: 0,
  paused: false,
  notesUpdated: false,
  nudged: false,
  seen: Object.freeze({ commit: 0, 'tests-passed': 0, 'task-completed': 0, checkpoint: 0 }),
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

/** 应用信号，同时更新信号计数；出现阶段节点时记下当时的上下文用量（最近一次读数）。 */
export function withSignals(state: SessionState, signals: readonly Signal[]): SessionState {
  const seen = { ...state.seen }
  let work = signals.reduce(applySignal, state.work)
  for (const signal of signals) {
    const milestone = milestoneOf(signal)
    if (milestone) seen[milestone] += 1
  }
  if (signals.some(signal => milestoneOf(signal))) work = { ...work, milestoneTokens: state.usage.lastTokens }
  return { ...state, work, seen }
}

/** 最近的阶段节点之后上下文又涨了多少；没有记录时为 undefined。 */
export function growthSinceMilestone(work: WorkState, tokens: number | undefined): number | undefined {
  return tokens === undefined || work.milestoneTokens === undefined ? undefined : tokens - work.milestoneTokens
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
  const reads = state.reads && {
    known: [...new Set([...state.reads.known, ...state.reads.current, ...state.ledger.facts.filesChanged])].slice(-MAX_KNOWN_FILES),
    current: [],
    reads: 0,
    rereads: 0,
  }
  return {
    ...state,
    ...(reads && { reads }),
    work: afterCompaction(state.work),
    compactions: state.compactions + 1,
    notesUpdated: false,
    nudged: false,
    remindedAtTokens: undefined,
    usage: attributed ? recordCompaction(state.usage, before, summary) : state.usage,
  }
}

/** 记一次读文件：读的是上次压缩前看过的文件就算重读。 */
export function withRead(state: SessionState, path: string): SessionState {
  const stats = state.reads ?? { known: [], current: [], reads: 0, rereads: 0 }
  return {
    ...state,
    reads: {
      known: stats.known,
      current: [...stats.current.filter(file => file !== path), path].slice(-MAX_KNOWN_FILES),
      reads: stats.reads + 1,
      rereads: stats.rereads + (stats.known.includes(path) ? 1 : 0),
    },
  }
}

/** 压缩时记进日志的本周期读文件次数；平台认不出读文件时为空。 */
export function cycleReads(state: SessionState): Pick<DecisionLogEntry, 'reads' | 'rereads'> {
  return state.reads ? { reads: state.reads.reads, rereads: state.reads.rereads } : {}
}

/** checkpoint 的日志：有没有标完成、用户要求有几条。 */
export function checkpointLog(input: CheckpointInput, ledger: Ledger): Omit<DecisionLogEntry, 'at' | 'session'> {
  const requirements = ledger.notes.requirements?.length ?? 0
  return {
    event: 'checkpoint',
    action: input.milestone ? 'milestone' : 'note',
    ...(requirements ? { requirements } : {}),
  }
}

export type DecisionLogEntry = {
  at: string
  /** 会话 ID，报告据此只统计当前会话 */
  session?: string
  event: 'setup' | 'turn-end' | 'mid-turn' | 'compacted' | 'checkpoint' | 'reminder' | 'error'
  action?: string
  reason?: string
  tokens?: number
  tokensBefore?: number
  tokensAfter?: number
  /** 决定压缩时，距离最近的阶段节点上下文涨了多少 */
  sinceMilestoneTokens?: number
  /** 压缩时：上次压缩以来读文件的次数，以及其中重读压缩前看过的文件的次数 */
  reads?: number
  rereads?: number
  /** checkpoint 之后用户要求的条数 */
  requirements?: number
  trigger?: string
  detail?: string
}
