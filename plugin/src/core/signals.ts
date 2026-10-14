// 信号词表与工作状态。适配层把平台事件翻译成这里的信号，core 不认识任何平台的工具名。

import type { Params } from './params.ts'

export type Signal =
  | { kind: 'commit' }
  | { kind: 'tests'; passed: boolean }
  | { kind: 'build'; passed: boolean }
  | { kind: 'task-completed' }
  | { kind: 'checkpoint'; milestone: boolean }
  | { kind: 'tool-result'; isError: boolean }
  | { kind: 'background'; running: number }

export type MilestoneSource = 'commit' | 'tests-passed' | 'task-completed' | 'checkpoint'

export type HardSignal = 'tests-failing' | 'build-failing' | 'error-streak' | 'background-running'

export type WorkState = {
  /** 自上次压缩以来最近的阶段节点 */
  milestone: MilestoneSource | null
  testsFailing: boolean
  buildFailing: boolean
  errorStreak: number
  backgroundRunning: number
}

export const INITIAL_WORK_STATE: WorkState = Object.freeze({
  milestone: null,
  testsFailing: false,
  buildFailing: false,
  errorStreak: 0,
  backgroundRunning: 0,
})

/** 这个信号代表哪种阶段节点，不是阶段节点时为 null。 */
export function milestoneOf(signal: Signal): MilestoneSource | null {
  switch (signal.kind) {
    case 'commit':
      return 'commit'
    case 'tests':
      return signal.passed ? 'tests-passed' : null
    case 'task-completed':
      return 'task-completed'
    case 'checkpoint':
      return signal.milestone ? 'checkpoint' : null
    default:
      return null
  }
}

export function applySignal(state: WorkState, signal: Signal): WorkState {
  const next = { ...state, milestone: milestoneOf(signal) ?? state.milestone }
  switch (signal.kind) {
    case 'tests':
      return { ...next, testsFailing: !signal.passed }
    case 'build':
      return { ...next, buildFailing: !signal.passed }
    case 'tool-result':
      return { ...next, errorStreak: signal.isError ? state.errorStreak + 1 : 0 }
    case 'background':
      return { ...next, backgroundRunning: Math.max(0, signal.running) }
    default:
      return next
  }
}

/** 压缩后清空阶段节点；失败、后台任务这些仍然成立的事实保留。 */
export function afterCompaction(state: WorkState): WorkState {
  return { ...state, milestone: null }
}

/** 表明工作做到一半的硬信号，没有则返回 null。 */
export function hardSignal(state: WorkState, params: Params): HardSignal | null {
  if (state.testsFailing) return 'tests-failing'
  if (state.buildFailing) return 'build-failing'
  if (state.errorStreak >= params.errorStreakLimit) return 'error-streak'
  if (state.backgroundRunning > 0) return 'background-running'
  return null
}
