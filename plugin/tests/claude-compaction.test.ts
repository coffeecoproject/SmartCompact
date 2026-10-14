import { expect, test } from 'claude-code/testing'
import { LEDGER_MARKER } from '../src/core/ledger.ts'
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
