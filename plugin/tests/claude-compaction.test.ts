import { expect, test } from 'claude-code/testing'
import { COMPACT_INSTRUCTIONS, LEDGER_MARKER } from '../src/core/ledger.ts'
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

test('插件排队的 /compact 轮到时已作废就跳过；用户自己的 /compact 照常运行', async ($, on) => {
  const store = stubHost(on)
  let ran = 0
  on('command.run', { command: 'compact' }, () => {
    ran += 1
    return { text: 'compacted' }
  })
  const stale = await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
  expect(stale.text).toContain('skipped')
  expect(ran).toBe(0)
  expect(store.get('log')).toEqual([expect.objectContaining({ event: 'compacted', action: 'skipped', detail: 'stale' })])
  const own = await $.command.run({ command: 'compact', args: 'keep the plan' })
  expect(own.text).toBe('compacted')
  expect(ran).toBe(1)
})
