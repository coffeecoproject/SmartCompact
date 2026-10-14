import { expect, test } from 'claude-code/testing'
import { stubHost } from './host.ts'


test('checkpoint 工具记录笔记，输入不合法时说明原因', async ($, on) => {
  const store = stubHost(on)
  const ok = await $.tool.call({ tool: 'mcp__smartcompact__checkpoint', goal: '迁移登录模块', milestone: true })
  expect(ok.result).toBe('Recorded. Continue with the work.')
  const bad = await $.tool.call({ tool: 'mcp__smartcompact__checkpoint', milestone: true })
  expect(String(bad.result)).toStartWith('Not recorded:')
  expect(store.get('log')).toEqual([expect.objectContaining({ event: 'checkpoint', action: 'milestone' })])
})

test('/smartcompact 未知参数给出用法，未初始化时给出提示', async ($, on) => {
  stubHost(on)
  const unknown = await $.command.run({ command: 'smartcompact', args: 'xyz' })
  expect(unknown.text).toContain('用法')
  const report = await $.command.run({ command: 'smartcompact', args: '' })
  expect(report.text).toContain('尚未完成初始化')
})
