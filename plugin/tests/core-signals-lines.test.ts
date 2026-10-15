import { describe, expect, test } from 'claude-code/testing'
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

  test('失败之后又做完一件事，失败不再挡着压缩', () => {
    const committed = run([{ kind: 'tests', passed: false }, { kind: 'build', passed: false }, { kind: 'commit' }])
    expect(committed.milestone).toBe('commit')
    expect(hardSignal(committed, DEFAULT_PARAMS)).toBeNull()
    expect(hardSignal(run([{ kind: 'tests', passed: false }, { kind: 'checkpoint', milestone: false }]), DEFAULT_PARAMS)).toBe('tests-failing')
  })

  test('做完一件事之后又改文件，这个阶段节点不再算数；再做完一件事又算数', () => {
    const changed = run([{ kind: 'commit' }, { kind: 'file-changed' }])
    expect(changed.milestone).toBe('commit')
    expect(changed.changedSinceMilestone).toBe(true)
    expect(applySignal(changed, { kind: 'tests', passed: true }).changedSinceMilestone).toBe(false)
    expect(applySignal(changed, { kind: 'checkpoint', milestone: false }).changedSinceMilestone).toBe(true)
    expect(afterCompaction(changed).changedSinceMilestone).toBe(false)
  })

  test('先改文件再做完一件事，阶段节点照常算数', () => {
    expect(run([{ kind: 'file-changed' }, { kind: 'commit' }]).changedSinceMilestone).toBe(false)
    expect(run([{ kind: 'file-changed' }]).changedSinceMilestone).toBe(false)
  })

  test('压缩后清空阶段节点，仍然成立的失败保留', () => {
    const state = afterCompaction(run([{ kind: 'commit' }, { kind: 'build', passed: false }]))
    expect(state.milestone).toBeNull()
    expect(state.buildFailing).toBe(true)
  })
})

describe('参数', () => {
  test('不合法的参数覆盖沿用默认值', () => {
    const params = resolveParams({ allowLineTokens: -1, minFreedTokens: 'x', errorStreakLimit: 5 })
    expect(params.allowLineTokens).toBe(DEFAULT_PARAMS.allowLineTokens)
    expect(params.minFreedTokens).toBe(DEFAULT_PARAMS.minFreedTokens)
    expect(params.errorStreakLimit).toBe(5)
  })
})
