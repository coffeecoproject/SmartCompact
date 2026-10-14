import { describe, expect, test } from 'claude-code/testing'
import {
  applyCheckpoint,
  EMPTY_LEDGER,
  isLedgerText,
  LEDGER_MARKER,
  parseCheckpoint,
  recordCommit,
  recordFileChanged,
  recordTest,
  renderLedger,
} from '../src/core/ledger.ts'
import { expectedAfterTokens, INITIAL_SESSION_STATE, parseState } from '../src/core/state.ts'

describe('checkpoint 输入校验', () => {
  test('接受合法输入', () => {
    expect(parseCheckpoint({ goal: '迁移登录模块', decisions: ['保留旧接口'], milestone: true })).toEqual({
      ok: true,
      value: { goal: '迁移登录模块', decisions: ['保留旧接口'], milestone: true },
    })
  })

  test('拒绝空内容和错误类型', () => {
    expect(parseCheckpoint({}).ok).toBe(false)
    expect(parseCheckpoint({ milestone: true }).ok).toBe(false)
    expect(parseCheckpoint({ goal: '  ' }).ok).toBe(false)
    expect(parseCheckpoint({ decisions: 'a' }).ok).toBe(false)
    expect(parseCheckpoint(null).ok).toBe(false)
  })
})

describe('进度笔记', () => {
  test('checkpoint 覆盖目标和下一步，决定去重追加', () => {
    const first = applyCheckpoint(EMPTY_LEDGER, { goal: 'A', decisions: ['d1'], next: 'n1' })
    const second = applyCheckpoint(first, { decisions: ['d1', 'd2'], next: 'n2' })
    expect(second.notes).toEqual({ goal: 'A', decisions: ['d1', 'd2'], next: 'n2', current: undefined })
  })

  test('改过的文件去重，最近的排在最后', () => {
    const ledger = ['a.ts', 'b.ts', 'a.ts'].reduce(recordFileChanged, EMPTY_LEDGER)
    expect(ledger.facts.filesChanged).toEqual(['b.ts', 'a.ts'])
  })

  test('排版带来源标识，程序事实和模型补充都在', () => {
    let ledger = applyCheckpoint(EMPTY_LEDGER, { goal: '迁移登录模块', next: '补测试' })
    ledger = recordTest(recordCommit(recordFileChanged(ledger, 'src/login.ts'), 'feat: login'), 'npm test', false)
    const text = renderLedger(ledger, 6_000)
    expect(text).toStartWith(LEDGER_MARKER)
    expect(text).toContain('not a message from the user')
    expect(text).toContain('迁移登录模块')
    expect(text).toContain('src/login.ts')
    expect(text).toContain('tests FAILED: npm test')
    expect(isLedgerText(text)).toBe(true)
    expect(isLedgerText('hello')).toBe(false)
  })

  test('超长时截断', () => {
    const ledger = applyCheckpoint(EMPTY_LEDGER, { goal: 'x'.repeat(900), current: 'y'.repeat(900) })
    const text = renderLedger(ledger, 500)
    expect(text.length).toBeLessThanOrEqual(500)
    expect(text).toEndWith('…(truncated)')
  })
})

describe('会话状态', () => {
  test('结构不对时从初始状态开始', () => {
    expect(parseState(undefined)).toBe(INITIAL_SESSION_STATE)
    expect(parseState({ compactions: 1 })).toBe(INITIAL_SESSION_STATE)
    expect(parseState({ ...INITIAL_SESSION_STATE, compactions: 2 }).compactions).toBe(2)
  })

  test('没有实测值时用默认的压缩后大小', () => {
    expect(expectedAfterTokens(INITIAL_SESSION_STATE, 50_000)).toBe(50_000)
    expect(expectedAfterTokens({ ...INITIAL_SESSION_STATE, measuredAfterTokens: 42_000 }, 50_000)).toBe(42_000)
  })
})
