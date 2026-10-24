import { describe, expect, mock, test } from 'claude-code/testing'
import { COMPACT_INSTRUCTIONS, LEDGER_MARKER } from '../src/core/ledger.ts'
import { queuedCompaction } from '../src/claude/queued.ts'
import { stubHost } from './host.ts'

// 测试里由 $ 发起的压缩不带对话内容；外层放一个插件补上，模拟真实会话里引擎给的输入。
const withMessages = {
  name: 'engine-input',
  tier: 'prepend' as const,
  register(on: Parameters<import('claude-code').Register>[0]) {
    on('session.compact', ($, e, next) => next({ ...e, messages: [{ role: 'user', text: 'hello', toolUses: [] }] }))
  },
}

const row = (text: string) => ({ role: 'user' as const, text, toolUses: [] })

test('压缩结果里只保留最新的一份进度笔记', { plugins: [withMessages] }, async ($, on) => {
  const store = stubHost(on)
  on('session.compact', () => ({
    messages: [row(`${LEDGER_MARKER}\nold`), row('summary of the conversation')],
    tokensBefore: 300_000,
    tokensAfter: 20_000,
  }))
  const result = await $.session.compact({ instructions: 'x' })
  if (result.skip !== undefined) throw new Error(`skipped: ${result.skip}`)
  const ledgers = result.messages.filter(message => message.text.startsWith(LEDGER_MARKER))
  expect(ledgers).toHaveLength(1)
  expect(result.messages.at(-1)?.text).toStartWith(LEDGER_MARKER)
  expect(result.messages.at(-1)?.text).not.toContain('\nold')
  expect(store.get('log')).toEqual([expect.objectContaining({ event: 'compacted', session: 'test-session', tokensBefore: 300_000, tokensAfter: 20_000 })])
  expect(store.has('session:test-session')).toBe(true)
})

test('插件排队的 /compact 在压缩时以说明认出；作废时跳过；用户自己的 /compact 不算', () => {
  expect(queuedCompaction({ trigger: 'manual', instructions: COMPACT_INSTRUCTIONS }, true)).toBe('ours')
  expect(queuedCompaction({ trigger: 'manual', instructions: COMPACT_INSTRUCTIONS }, false)).toBe('stale')
  expect(queuedCompaction({ trigger: 'manual', instructions: 'keep the plan' }, true)).toBeNull()
  expect(queuedCompaction({ trigger: 'manual' }, true)).toBeNull()
  expect(queuedCompaction({ trigger: 'auto', instructions: COMPACT_INSTRUCTIONS }, true)).toBeNull()
})

test('一轮结束时记下最后一条回复，压缩后和笔记一起带回；子 agent 的一轮不算', { plugins: [withMessages] }, async ($, on) => {
  stubHost(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => ({ messages: [row('summary of the conversation')], tokensBefore: 300_000, tokensAfter: 20_000 }))
  await $.turn.complete({ reason: 'answer', answer: '要我按建议改吗？先回放验证。', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.complete({ reason: 'answer', answer: 'subagent report', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1' })
  const result = await $.session.compact({ instructions: 'x' })
  if (result.skip !== undefined) throw new Error(`skipped: ${result.skip}`)
  const ledger = result.messages.at(-1)?.text ?? ''
  expect(ledger).toStartWith(LEDGER_MARKER)
  expect(ledger).toEndWith('要我按建议改吗？先回放验证。')
  expect(ledger).not.toContain('subagent report')
})

describe('等用户空闲再压缩', () => {
  /** 一轮结束时会决定压缩的会话：已过允许线、刚做完一件事。返回压缩次数和日志。 */
  async function readyToCompact($: Parameters<Parameters<typeof test>[2]>[0], on: Parameters<import('claude-code').Register>[0]) {
    const clock = mock.clock(on)
    const store = stubHost(on, false)
    store.set('session:test-session', { native: { originalSetting: 1_000_000 }, updatedAt: 0 })
    const calls = { compact: 0 }
    on('session.usage', () => ({ value: { context: { tokens: 300_000, window: 1_000_000 } } }))
    on('turn.complete', () => ({ text: '' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('session.compact', () => {
      calls.compact += 1
      return { messages: [row('summary')], tokensBefore: 300_000, tokensAfter: 20_000 }
    })
    await $.tool.call({ tool: 'mcp__smartcompact__checkpoint', goal: 'g', milestone: true })
    await $.turn.complete({ reason: 'answer', answer: '要我按建议改吗？', durationMs: 1, isAborted: false, turnId: 't1' })
    const log = () => (store.get('log') as { event: string; action?: string; reason?: string }[]).filter(entry => entry.event === 'compacted')
    return { clock, calls, log }
  }

  test('空闲够了才压，只压一次', { plugins: [withMessages] }, async ($, on) => {
    const { clock, calls, log } = await readyToCompact($, on)
    await clock.advance(179_000)
    expect(calls.compact).toBe(0)
    await clock.advance(1_000)
    expect(calls.compact).toBe(1)
    expect(log()).toEqual([expect.objectContaining({ trigger: 'plugin', tokensBefore: 300_000 })])
  })

  // 用户回话和斜杠命令（不经过 prompt.submit、没有输入的文字）开始的一轮都要撤销。
  for (const [name, text] of [['用户回话', 'yes'], ['斜杠命令', '']]) {
    test(`等待期间开始了新的一轮就撤销：${name}`, { plugins: [withMessages] }, async ($, on) => {
      const { clock, calls, log } = await readyToCompact($, on)
      await $.turn.start({ text, turnId: 't2' })
      await clock.advance(180_000)
      expect(calls.compact).toBe(0)
      expect(log()).toEqual([expect.objectContaining({ action: 'cancelled', reason: 'new-turn' })])
    })
  }

  test('等待期间用户自己压缩过，到点不再压', { plugins: [withMessages] }, async ($, on) => {
    const { clock, calls, log } = await readyToCompact($, on)
    await $.session.compact({ instructions: 'keep the plan' })
    await clock.advance(180_000)
    expect(calls.compact).toBe(1)
    expect(log().at(-1)).toEqual(expect.objectContaining({ action: 'skipped', reason: 'compacted-meanwhile' }))
  })

  test('等待期间暂停了插件，到点不压', { plugins: [withMessages] }, async ($, on) => {
    const { clock, calls, log } = await readyToCompact($, on)
    await $.command.run({ command: 'smartcompact', args: 'pause' })
    await clock.advance(180_000)
    expect(calls.compact).toBe(0)
    expect(log()).toEqual([expect.objectContaining({ action: 'skipped', reason: 'paused' })])
  })
})
