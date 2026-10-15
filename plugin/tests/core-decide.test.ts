import { describe, expect, test } from 'claude-code/testing'
import { type DecisionInput, decideAtTurnEnd, decideMidTurn } from '../src/core/decide.ts'
import { DEFAULT_PARAMS, resolveParams } from '../src/core/params.ts'
import { INITIAL_WORK_STATE, type WorkState } from '../src/core/signals.ts'

const params = DEFAULT_PARAMS
// 1M 窗口：L=200k，C=967k
const lines = { allow: 200_000, ceiling: 967_000 }
const input = (tokens: number | undefined, work: Partial<WorkState> = {}, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  tokens,
  lines,
  work: { ...INITIAL_WORK_STATE, ...work },
  expectedAfterTokens: 50_000,
  paused: false,
  ...extra,
})

describe('一轮结束时', () => {
  test('低于允许压缩线不压缩', () => {
    expect(decideAtTurnEnd(input(150_000, { milestone: 'commit' }), params)).toEqual({ action: 'none', reason: 'below-line' })
  })

  test('暂停或读不到用量时不干预', () => {
    expect(decideAtTurnEnd(input(300_000, {}, { paused: true }), params).reason).toBe('paused')
    expect(decideAtTurnEnd(input(undefined), params).reason).toBe('no-reading')
  })

  test('有阶段节点时压缩', () => {
    expect(decideAtTurnEnd(input(210_000, { milestone: 'tests-passed' }), params)).toEqual({ action: 'compact', reason: 'tests-passed' })
  })

  test('先提交、后测试失败时等待，不因残留的阶段节点压缩', () => {
    expect(decideAtTurnEnd(input(210_000, { milestone: 'commit', testsFailing: true }), params)).toEqual({ action: 'wait', reason: 'tests-failing' })
  })

  test('连续报错时等待', () => {
    expect(decideAtTurnEnd(input(210_000, { milestone: 'commit', errorStreak: 3 }), params).reason).toBe('error-streak')
  })

  test('做完一件事之后又改了文件，等下一件事做完', () => {
    expect(decideAtTurnEnd(input(320_000, { milestone: 'checkpoint', changedSinceMilestone: true }), params)).toEqual({
      action: 'wait',
      reason: 'changed-since-milestone',
    })
  })

  test('没有阶段节点时一直等待，不设插件自己的兜底，交给原生在上限处压缩', () => {
    expect(decideAtTurnEnd(input(230_000), params)).toEqual({ action: 'wait', reason: 'waiting-for-milestone' })
    expect(decideAtTurnEnd(input(600_000), params)).toEqual({ action: 'wait', reason: 'waiting-for-milestone' })
  })

  test('腾不出足够空间时等待，防止连续压缩', () => {
    // 第 0 步实测的情况：线约 67k、压缩后约 51k，每读一个文件就压缩一次
    const low = resolveParams({ allowLineTokens: 67_000 })
    const thrash = { ...input(75_000, { milestone: 'commit' }), lines: { ...lines, allow: 67_000 }, expectedAfterTokens: 51_000 }
    expect(decideAtTurnEnd(thrash, low)).toEqual({ action: 'wait', reason: 'insufficient-benefit' })
  })
})

describe('一轮进行中', () => {
  test('默认放行', () => {
    expect(decideMidTurn(input(270_000), params)).toEqual({ action: 'allow', reason: 'default' })
  })

  test('做到一半时否决', () => {
    expect(decideMidTurn(input(270_000, { testsFailing: true }), params)).toEqual({ action: 'veto', reason: 'tests-failing' })
  })

  test('接近上限时即使做到一半也放行', () => {
    expect(decideMidTurn(input(920_000, { testsFailing: true }), params)).toEqual({ action: 'allow', reason: 'at-ceiling' })
  })

  test('腾不出足够空间时否决', () => {
    expect(decideMidTurn({ ...input(270_000), expectedAfterTokens: 230_000 }, params)).toEqual({ action: 'veto', reason: 'insufficient-benefit' })
  })

  test('暂停或读不到用量时放行', () => {
    expect(decideMidTurn(input(270_000, { testsFailing: true }, { paused: true }), params).action).toBe('allow')
    expect(decideMidTurn(input(undefined, { testsFailing: true }), params).action).toBe('allow')
  })
})
