import { describe, expect, test } from 'claude-code/testing'
import { shouldNudge } from '../src/core/decide.ts'
import { planLines } from '../src/core/lines.ts'
import { DEFAULT_PARAMS } from '../src/core/params.ts'
import { countDecisions, renderReport } from '../src/core/report.ts'
import { INITIAL_SESSION_STATE, withCompaction, withSample, withSignals } from '../src/core/state.ts'
import { EMPTY_TALLY, pricesFor, recordCompaction, recordSample, savingsRatio } from '../src/core/usage.ts'

const CEILING = 967_000
const PRICES = pricesFor('anthropic')

describe('成本估算', () => {
  test('压缩后，没有插件时的上下文 = 实际 + 腾出的空间，并扣掉压缩开销', () => {
    let tally = recordSample(EMPTY_TALLY, 200_000, CEILING, PRICES)
    tally = recordCompaction(tally, 200_000, 3_000)
    tally = recordSample(tally, 50_000, CEILING, PRICES)
    tally = recordSample(tally, 60_000, CEILING, PRICES)
    expect(tally.freed).toBe(150_000)
    expect(tally.sumTokens).toBe(310_000)
    expect(tally.sumBaseline).toBe(200_000 + 200_000 + 210_000)
    // 压缩开销 = 读一遍 200k + 摘要 3k × 50 + 新前缀 50k × 20
    expect(tally.overhead).toBe(200_000 + 150_000 + 1_000_000)
  })

  test('压缩后用得越久，节省越多；刚压缩完时可能是负的', () => {
    let tally = recordCompaction(recordSample(EMPTY_TALLY, 300_000, CEILING, PRICES), 300_000, 3_000)
    tally = recordSample(tally, 50_000, CEILING, PRICES)
    expect(savingsRatio(tally)).toBeLessThan(0)
    for (let tokens = 52_000; tokens < 250_000; tokens += 2_000) tally = recordSample(tally, tokens, CEILING, PRICES)
    expect(savingsRatio(tally)).toBeGreaterThan(0.3)
  })

  test('相同读数不重复计入；没有插件时涨过原生压缩点也会被压缩', () => {
    let tally = recordSample(EMPTY_TALLY, 100_000, CEILING, PRICES)
    expect(recordSample(tally, 100_000, CEILING, PRICES)).toBe(tally)
    tally = { ...tally, freed: 900_000 }
    expect(recordSample(tally, 100_000 + 1, CEILING, PRICES).freed).toBe(0)
    expect(savingsRatio(EMPTY_TALLY)).toBeUndefined()
  })

  test('按供应商选价格比例', () => {
    expect(pricesFor('anthropic')).toEqual({ outputOverCacheRead: 50, cacheWriteOverCacheRead: 20 })
    expect(pricesFor('openai-codex')).toEqual({ outputOverCacheRead: 80, cacheWriteOverCacheRead: 10 })
    expect(pricesFor('github-copilot gpt-5')).toEqual(pricesFor('openai'))
    expect(pricesFor('github-copilot claude-sonnet-5')).toEqual(pricesFor('anthropic'))
  })
})

describe('会话状态', () => {
  test('信号计数只数阶段节点和后台任务', () => {
    const state = withSignals(INITIAL_SESSION_STATE, [
      { kind: 'commit' },
      { kind: 'tests', passed: false },
      { kind: 'tests', passed: true },
      { kind: 'tool-result', isError: false },
      { kind: 'background', running: 2 },
      { kind: 'background', running: 0 },
    ])
    expect(state.seen).toEqual({ commit: 1, 'tests-passed': 1, 'task-completed': 0, checkpoint: 0, background: 1 })
    expect(state.work.milestone).toBe('tests-passed')
  })

  test('压缩后的第一次读数记为实测的压缩后大小，并清空本周期标记', () => {
    let state = withSignals({ ...INITIAL_SESSION_STATE, notesUpdated: true, nudged: true }, [{ kind: 'commit' }])
    state = withCompaction(state, 200_000, 3_000)
    expect(state.work.milestone).toBeNull()
    expect(state.notesUpdated).toBe(false)
    expect(state.nudged).toBe(false)
    state = withSample(state, 48_000, CEILING, PRICES)
    expect(state.measuredAfterTokens).toBe(48_000)
    expect(withSample(state, 52_000, CEILING, PRICES).measuredAfterTokens).toBe(48_000)
  })

  test('手动压缩不计入插件带来的节省', () => {
    const state = withCompaction(INITIAL_SESSION_STATE, 200_000, 3_000, false)
    expect(state.compactions).toBe(1)
    expect(state.usage.pending).toBeUndefined()
  })
})

describe('提醒更新笔记', () => {
  const lines = planLines(1_000_000, DEFAULT_PARAMS)
  const base = { lines, notesUpdated: false, nudged: false, paused: false }
  test('快到允许压缩线时提醒一次', () => {
    expect(shouldNudge({ ...base, tokens: 170_000 }, DEFAULT_PARAMS)).toBe(true)
    expect(shouldNudge({ ...base, tokens: 160_000 }, DEFAULT_PARAMS)).toBe(false)
  })
  test('已提醒、已更新、暂停或读不到用量时不提醒', () => {
    expect(shouldNudge({ ...base, tokens: 190_000, nudged: true }, DEFAULT_PARAMS)).toBe(false)
    expect(shouldNudge({ ...base, tokens: 190_000, notesUpdated: true }, DEFAULT_PARAMS)).toBe(false)
    expect(shouldNudge({ ...base, tokens: 190_000, paused: true }, DEFAULT_PARAMS)).toBe(false)
    expect(shouldNudge({ ...base, tokens: undefined }, DEFAULT_PARAMS)).toBe(false)
  })
})

describe('报告', () => {
  test('按事件和动作统计决策', () => {
    expect(
      countDecisions([
        { at: '', event: 'compacted', trigger: 'plugin' },
        { at: '', event: 'compacted', trigger: 'auto' },
        { at: '', event: 'mid-turn', action: 'veto' },
        { at: '', event: 'mid-turn', action: 'veto' },
        { at: '', event: 'compacted', action: 'failed', trigger: 'plugin' },
      ]),
    ).toEqual({ 'compacted:plugin': 1, 'compacted:auto': 1, 'mid-turn:veto': 2, 'compacted:failed': 1 })
  })

  test('报告包含三条线、信号次数和成本估算', () => {
    const text = renderReport({
      state: { ...INITIAL_SESSION_STATE, compactions: 2 },
      lines: planLines(1_000_000, DEFAULT_PARAMS),
      tokens: 120_000,
      counts: { 'compacted:plugin': 2 },
    })
    expect(text).toContain('允许压缩线 200k')
    expect(text).toContain('插件压缩 2')
    expect(text).toContain('任务完成 0')
    expect(text).toContain('还没有读数')
  })

  test('刚压缩完估算为负时说明原因', () => {
    let usage = recordCompaction(recordSample(EMPTY_TALLY, 300_000, CEILING, PRICES), 300_000, 3_000)
    usage = recordSample(usage, 50_000, CEILING, PRICES)
    const text = renderReport({ state: { ...INITIAL_SESSION_STATE, usage }, lines: planLines(1_000_000, DEFAULT_PARAMS), tokens: 50_000, counts: {} })
    expect(text).toContain('继续使用后会转正')
  })
})
