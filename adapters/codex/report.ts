// 查看 SmartCompact 在某个 Codex 会话里的效果：node report.ts <会话 ID>

import { countDecisions, renderReport } from '../../plugin/src/core/report.ts'
import { linesFor } from './hook.ts'
import { loadSession, readLog } from './store.ts'

const sessionId = process.argv[2]
if (!sessionId) {
  console.log('用法：node adapters/codex/report.ts <会话 ID>')
} else {
  const { state } = loadSession(sessionId)
  const entries = readLog().filter(entry => entry.session === sessionId)
  console.log(renderReport({ state, lines: linesFor(undefined), tokens: state.usage.lastTokens, counts: countDecisions(entries) }))
}
