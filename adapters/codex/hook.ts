// SmartCompact 的 Codex hook 入口：node hook.ts <事件名>，事件 JSON 从标准输入读入。
// Codex 不能安静地推迟一轮中间的压缩，所以插件只做三件事：
// - 一轮结束（Stop）时按 core 的规则判断，需要压缩就启动后台进程，等会话空闲后通过共享后台服务发起压缩；
// - 压缩后补回进度笔记（SessionStart(compact)，没来得及时在下一条用户消息补）；
// - 从会话记录里识别信号、记进度笔记。
// 任何异常都只记日志、不输出，等于插件不存在。

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyCommand } from '../../plugin/src/core/commands.ts'
import { decideAtTurnEnd } from '../../plugin/src/core/decide.ts'
import { recordFileChanged, recordLastReply, renderLedger } from '../../plugin/src/core/ledger.ts'
import type { Lines } from '../../plugin/src/core/lines.ts'
import { resolveParams } from '../../plugin/src/core/params.ts'
import { planCompaction } from '../../plugin/src/core/pending.ts'
import type { Signal } from '../../plugin/src/core/signals.ts'
import { expectedAfterTokens, growthSinceMilestone, withCompaction, withSample, withSignals } from '../../plugin/src/core/state.ts'
import { pricesFor } from '../../plugin/src/core/usage.ts'
import { compactorAlive } from './compactor.ts'
import { readRollout } from './rollout.ts'
import { appendLog, type CodexSession, loadSession, nativeAutoCompactLimit, saveSession } from './store.ts'

/** Codex 压缩后通常剩 2 万左右（实测 18k–20k） */
const CODEX_AFTER_TOKENS = 25_000
/** 摘要长度粗估，用于压缩开销 */
const CODEX_SUMMARY_TOKENS = 3_000

/** 没设置时用默认值；0 也是合法的设置。 */
const number = (name: string): number | undefined => (process.env[name]?.trim() ? Number(process.env[name]) : undefined)

export const params = () =>
  resolveParams({
    allowLineTokens: number('SMARTCOMPACT_ALLOW_LINE'),
    minFreedTokens: number('SMARTCOMPACT_MIN_FREED'),
    compactIdleSeconds: number('SMARTCOMPACT_IDLE_SECONDS'),
    defaultAfterTokens: CODEX_AFTER_TOKENS,
  })

/** 上限是 Codex 原生的自动压缩线。 */
export function linesFor(window: number | undefined): Lines {
  return { allow: params().allowLineTokens, ceiling: nativeAutoCompactLimit() ?? Math.round((window ?? 272_000) * 0.9) }
}

type Payload = {
  session_id?: string
  transcript_path?: string | null
  source?: string
  trigger?: string
  model?: string
  /** Stop 带的这一轮最后一条回复 */
  last_assistant_message?: string | null
}

const contextOutput = (event: string, text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })

/** 读会话记录里新增的部分：命令结果和改过的文件变成信号，最新的上下文大小计入成本估算。 */
function absorbRollout(session: CodexSession, payload: Payload): { session: CodexSession; window?: number } {
  if (!payload.transcript_path) return { session }
  const delta = readRollout(payload.transcript_path, session.rolloutOffset)
  let { state } = session
  // 先记读数：阶段节点按一轮结束时的用量记位置（会话记录里命令和读数的先后对不上）。
  const { ceiling } = linesFor(delta.window)
  for (const tokens of delta.tokens) state = withSample(state, tokens, ceiling, pricesFor(payload.model ?? 'openai'))
  let ledger = state.ledger
  const signals: Signal[] = []
  for (const step of delta.steps) {
    if (step.kind === 'files') {
      for (const file of step.paths) ledger = recordFileChanged(ledger, file)
      signals.push({ kind: 'file-changed' })
      continue
    }
    const isError = step.exitCode !== undefined && step.exitCode !== 0
    signals.push({ kind: 'tool-result', isError })
    const classified = classifyCommand(step.command, isError, step.output, ledger)
    signals.push(...classified.signals)
    ledger = classified.ledger
  }
  state = withSignals({ ...state, ledger }, signals)
  return { session: { ...session, state, rolloutOffset: delta.offset }, window: delta.window }
}

function onStop(sessionId: string, payload: Payload): void {
  const absorbed = absorbRollout(loadSession(sessionId), payload)
  let session = absorbed.session
  session = { ...session, state: { ...session.state, ledger: recordLastReply(session.state.ledger, payload.last_assistant_message ?? '') } }
  const lines = linesFor(absorbed.window)
  const current = params()
  const decision = decideAtTurnEnd(
    {
      tokens: session.state.usage.lastTokens,
      lines,
      work: session.state.work,
      expectedAfterTokens: expectedAfterTokens(session.state, current.defaultAfterTokens),
      paused: session.state.paused,
    },
    current,
  )
  const tokens = session.state.usage.lastTokens
  const sinceMilestoneTokens = decision.action === 'compact' ? growthSinceMilestone(session.state.work, tokens) : undefined
  if (decision.action !== 'none') appendLog(sessionId, { event: 'turn-end', action: decision.action, reason: decision.reason, tokens, sinceMilestoneTokens })
  // 要压缩就等用户空闲一会儿再压：还在讨论时不打断。判断变了就撤销还在等的那次。
  const alive = compactorAlive(session, Date.now())
  session = { ...session, compactPending: decision.action === 'compact' ? planCompaction(sessionId, session.state, Date.now(), current) : undefined }
  if (decision.action === 'compact' && !alive) {
    // 一轮还没结束时发起压缩会中断这一轮，所以交给后台进程等会话空闲后再发。
    const compactor = join(dirname(fileURLToPath(import.meta.url)), 'compactor.ts')
    spawn(process.execPath, [compactor, sessionId], { detached: true, stdio: 'ignore', env: process.env }).unref()
    session = { ...session, compactorStartedAt: Date.now() }
  }
  saveSession(sessionId, session)
}

function onPostCompact(sessionId: string, payload: Payload): void {
  // 先读进会话记录里新增的部分，压缩前大小才是最新的（一轮中间的自动压缩发生在上次 Stop 之后）。
  const { session } = absorbRollout(loadSession(sessionId), payload)
  const ours = session.compactRequestedAt !== undefined && payload.trigger === 'manual'
  const before = session.state.usage.lastTokens ?? 0
  // 插件发起的压缩计入节省；Codex 原生的自动压缩和用户的 /compact 没有插件时也会发生。
  const state = withCompaction(session.state, before, CODEX_SUMMARY_TOKENS, ours)
  appendLog(sessionId, { event: 'compacted', trigger: ours ? 'plugin' : payload.trigger === 'auto' ? 'auto' : 'manual', tokensBefore: before })
  // 还在等的那次不在这里撤销：后台进程到点核对时会发现已经压缩过。
  saveSession(sessionId, { ...session, state, compactRequestedAt: undefined, ledgerPending: true })
}

/** 用户发了新消息：还在讨论，撤销等着的压缩，下一轮结束时重新判断。 */
function onUserPrompt(sessionId: string): void {
  const session = loadSession(sessionId)
  if (!session.compactPending) return
  saveSession(sessionId, { ...session, compactPending: undefined })
  appendLog(sessionId, { event: 'compacted', action: 'cancelled', reason: 'new-turn', trigger: 'plugin' })
}

/** 补回进度笔记：压缩后第一次有机会注入时输出一次。 */
function attachLedger(sessionId: string, event: string): void {
  const session = loadSession(sessionId)
  if (!session.ledgerPending) return
  process.stdout.write(contextOutput(event, renderLedger(session.state.ledger, params().ledgerMaxChars)))
  saveSession(sessionId, { ...session, ledgerPending: false })
}

function main(): void {
  const event = process.argv[2] ?? ''
  const payload = JSON.parse(readFileSync(0, 'utf8') || '{}') as Payload
  const sessionId = payload.session_id
  if (!sessionId) return
  try {
    if (event === 'Stop') onStop(sessionId, payload)
    else if (event === 'PostCompact') onPostCompact(sessionId, payload)
    else if (event === 'SessionStart' && payload.source === 'compact') attachLedger(sessionId, 'SessionStart')
    else if (event === 'UserPromptSubmit') {
      onUserPrompt(sessionId)
      attachLedger(sessionId, 'UserPromptSubmit')
    }
  } catch (error) {
    appendLog(sessionId, { event: 'error', reason: event, detail: String(error) })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch {
    // 读不到输入等异常：不输出任何内容，Codex 按原样继续
  }
}
