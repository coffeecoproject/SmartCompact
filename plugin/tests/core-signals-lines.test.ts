import { describe, expect, test } from 'claude-code/testing'
import { MIN_NATIVE_SETTING, nativeSettingFor, planLines } from '../src/core/lines.ts'
import { DEFAULT_PARAMS, resolveParams } from '../src/core/params.ts'
import { type Signal, afterCompaction, applySignal, hardSignal, INITIAL_WORK_STATE } from '../src/core/signals.ts'

const run = (signals: Signal[]) => signals.reduce(applySignal, INITIAL_WORK_STATE)

describe('信号', () => {
  test('提交、测试通过、任务完成、checkpoint 声明完成都是阶段节点', () => {
    expect(run([{ kind: 'commit' }]).milestone).toBe('commit')
    expect(run([{ kind: 'tests', passed: true }]).milestone).toBe('tests-passed')
    expect(run([{ kind: 'task-completed' }]).milestone).toBe('task-completed')
    expect(run([{ kind: 'checkpoint', milestone: true }]).milestone).toBe('checkpoint')
    expect(run([{ kind: 'checkpoint', milestone: false }]).milestone).toBeNull()
  })

  test('测试失败成为硬信号，再次通过后解除', () => {
    const failed = run([{ kind: 'tests', passed: false }])
    expect(hardSignal(failed, DEFAULT_PARAMS)).toBe('tests-failing')
    expect(hardSignal(applySignal(failed, { kind: 'tests', passed: true }), DEFAULT_PARAMS)).toBeNull()
  })

  test('连续报错达到上限才算硬信号，一次成功就清零', () => {
    const errors = run([{ kind: 'tool-result', isError: true }, { kind: 'tool-result', isError: true }])
    expect(hardSignal(errors, DEFAULT_PARAMS)).toBeNull()
    const streak = applySignal(errors, { kind: 'tool-result', isError: true })
    expect(hardSignal(streak, DEFAULT_PARAMS)).toBe('error-streak')
    expect(applySignal(streak, { kind: 'tool-result', isError: false }).errorStreak).toBe(0)
  })

  test('压缩后清空阶段节点，仍然成立的失败保留', () => {
    const state = afterCompaction(run([{ kind: 'commit' }, { kind: 'build', passed: false }]))
    expect(state.milestone).toBeNull()
    expect(state.buildFailing).toBe(true)
  })
})

describe('三条线', () => {
  test('1M 窗口：L=200k，M=260k，C=967k，并调整原生压缩线', () => {
    const lines = planLines(1_000_000, DEFAULT_PARAMS)
    expect(lines).toEqual({ allow: 200_000, midTurn: 260_000, ceiling: 967_000, adjustsNative: true })
    expect(nativeSettingFor(lines, DEFAULT_PARAMS)).toBe(293_000)
  })

  test('200k 窗口放不下兜底线时不调整原生压缩线', () => {
    expect(planLines(200_000, DEFAULT_PARAMS)).toEqual({ allow: 200_000, midTurn: 167_000, ceiling: 167_000, adjustsNative: false })
  })

  test('L 很小时，M 与写入的设定值都按原生允许的最小值算', () => {
    const small = resolveParams({ allowLineTokens: 40_000 })
    const lines = planLines(1_000_000, small)
    expect(lines.midTurn).toBe(MIN_NATIVE_SETTING - small.nativeBufferTokens)
    expect(nativeSettingFor(lines, small)).toBe(MIN_NATIVE_SETTING)
  })

  test('不合法的参数覆盖沿用默认值', () => {
    const params = resolveParams({ allowLineTokens: -1, graceFactor: 0.5, minFreedTokens: 'x', errorStreakLimit: 5 })
    expect(params.allowLineTokens).toBe(DEFAULT_PARAMS.allowLineTokens)
    expect(params.graceFactor).toBe(DEFAULT_PARAMS.graceFactor)
    expect(params.minFreedTokens).toBe(DEFAULT_PARAMS.minFreedTokens)
    expect(params.errorStreakLimit).toBe(5)
  })
})
