// SmartCompact mod 入口：把 Claude Code 的事件接到 core 的决策上。
// 碰 $ 的逻辑都在这个文件里；识别、决策和排版在 src/ 下，不碰 $。
// 每个会拦截的 hook 都带 .catch：插件出错时退回原生行为。

import type { EngineInterface, Register } from 'claude-code'
import { decideAtTurnEnd, shouldNudge } from '../src/core/decide.ts'
import { applyCheckpoint, CHECKPOINT_INPUT_SCHEMA, COMPACT_INSTRUCTIONS, isLedgerText, parseCheckpoint, renderLedger } from '../src/core/ledger.ts'
import type { Lines } from '../src/core/lines.ts'
import { type Params, resolveParams } from '../src/core/params.ts'
import { countDecisions, renderReport } from '../src/core/report.ts'
import { pricesFor } from '../src/core/usage.ts'
import {
  type DecisionLogEntry,
  expectedAfterTokens,
  growthSinceMilestone,
  parseState,
  type SessionState,
  withCompaction,
  withSample,
  withSignals,
} from '../src/core/state.ts'
import type { NativeSetup } from '../src/claude/native.ts'
import { recognize, taskCompleted, taskCreated } from '../src/claude/recognize.ts'
import { parseRecord, RECORD_PREFIX, type SessionRecord, staleRecordKeys } from '../src/claude/record.ts'

const CHECKPOINT_TOOL = 'mcp__smartcompact__checkpoint'
const LOG_KEY = 'log'
const LOG_LIMIT = 1_000
const COMPACT_DELAY_MS = 500
const CLAUDE_PRICES = pricesFor('anthropic')

const CHECKPOINT_DESCRIPTION =
  'Record a short progress note that survives context compaction: the goal, decisions made, where the work stands, and what is next. ' +
  'Call it after finishing a piece of work (set milestone: true) or after an important decision. Keep it brief; do not call it for trivial steps.'

const nudgeText = (tokens: number): string =>
  `SmartCompact: the context is at about ${Math.round(tokens / 1000)}k tokens and will be compacted at the next finished piece of work. ` +
  `If decisions or progress are not yet recorded, call ${CHECKPOINT_TOOL} briefly. If the user is waiting for an answer, answer first.`

let params: Params = resolveParams()
/** 一轮结束后排队等待执行的压缩；用户发新消息时作废。 */
let pendingCompaction: object | null = null
/** 插件自己发起的压缩不经过本插件的 session.compact hook，笔记在下一条消息时补回。 */
let ledgerToAttach: string | null = null
/** 无界面会话里改为排队执行 /compact，等空闲才运行；期间压缩过或用户发了新消息就作废。 */
let queuedCompaction = false
/** 排队的 /compact 正在运行：它的压缩以 manual 触发经过本插件的 hook，据此认出是插件发起的。 */
let runningQueued = false

async function loadRecord($: EngineInterface): Promise<SessionRecord> {
  return parseRecord(await $.store.get(`${RECORD_PREFIX}${await $.session.id()}`))
}

async function saveRecord($: EngineInterface, record: Omit<SessionRecord, 'updatedAt'>): Promise<void> {
  await $.store.set(`${RECORD_PREFIX}${await $.session.id()}`, { ...record, updatedAt: await $.clock.now() })
}

async function loadSession($: EngineInterface): Promise<SessionState> {
  return parseState((await loadRecord($)).state)
}

async function saveSession($: EngineInterface, state: SessionState): Promise<void> {
  await saveRecord($, { ...(await loadRecord($)), state })
}

async function loadLines($: EngineInterface): Promise<Lines | null> {
  const { native } = await loadRecord($)
  return native ? { allow: params.allowLineTokens, ceiling: native.originalSetting - params.nativeBufferTokens } : null
}

/** 只保留最近 RECORD_LIMIT 个会话的记录。 */
async function pruneRecords($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(RECORD_PREFIX))
  const records = await Promise.all(keys.map(async key => ({ key, updatedAt: parseRecord(await $.store.get(key)).updatedAt })))
  for (const key of staleRecordKeys(records)) await $.store.delete(key)
}

async function log($: EngineInterface, entry: Omit<DecisionLogEntry, 'at' | 'session'>): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  const previous = await $.store.get(LOG_KEY)
  const entries = Array.isArray(previous) ? previous : []
  await $.store.set(LOG_KEY, [...entries, { at, session: await $.session.id(), ...entry }].slice(-LOG_LIMIT))
}

/** 读当前用量并计入成本估算；压缩后到下一次调用前读不到。 */
async function sample($: EngineInterface, state: SessionState, lines: Lines | null): Promise<{ tokens?: number; state: SessionState }> {
  const tokens = (await $.session.usage()).context.tokens
  if (tokens === undefined || !lines) return { tokens, state }
  return { tokens, state: withSample(state, tokens, lines.ceiling, CLAUDE_PRICES) }
}

async function compactNow($: EngineInterface, ticket: object): Promise<void> {
  if (pendingCompaction !== ticket) return
  pendingCompaction = null
  try {
    const done = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (done.skip !== undefined) {
      await log($, { event: 'compacted', action: 'skipped', trigger: 'plugin', detail: done.skip })
      return
    }
    const state = withCompaction(await loadSession($), done.tokensBefore ?? 0, done.tokensAfter ?? 0)
    await saveSession($, state)
    ledgerToAttach = renderLedger(state.ledger, params.ledgerMaxChars)
    await log($, { event: 'compacted', trigger: 'plugin', tokensBefore: done.tokensBefore, tokensAfter: done.tokensAfter })
  } catch (error) {
    // 无界面会话（桌面 App、SDK、-p）暂不支持直接压缩，改为排队执行 /compact，等会话空闲时运行。
    if (String(error).includes('headless')) {
      try {
        queuedCompaction = true
        await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
        await log($, { event: 'compacted', action: 'queued', trigger: 'plugin' })
        return
      } catch (queueError) {
        queuedCompaction = false
        error = queueError
      }
    }
    // 一轮进行中调用会被拒，比如用户在等待期间发了消息：放弃这次，下一轮再判断。
    await log($, { event: 'compacted', action: 'failed', trigger: 'plugin', detail: String(error) })
  }
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const action = args.trim() || 'report'
  const state = await loadSession($)
  if (action === 'pause' || action === 'resume') {
    const paused = action === 'pause'
    await saveSession($, { ...state, paused })
    return paused ? 'SmartCompact 已暂停：本会话不再主动压缩。' : 'SmartCompact 已恢复。'
  }
  if (action !== 'report') return '用法：/smartcompact [report|pause|resume]'
  const lines = await loadLines($)
  if (!lines) return 'SmartCompact 尚未完成初始化。'
  const entries = await $.store.get(LOG_KEY)
  const session = await $.session.id()
  return renderReport({
    state,
    lines,
    tokens: (await $.session.usage()).context.tokens,
    counts: countDecisions((Array.isArray(entries) ? entries : []).filter(entry => entry?.session === session)),
  })
}

export const register: Register = (on, options) => {
  params = resolveParams(options as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      // 记下原生压缩线，用于成本估算的对比；插件不调整它。
      const record = await loadRecord($)
      if (!record.native) {
        const { context } = await $.session.usage({ breakdown: 'summary' })
        const native: NativeSetup = { originalSetting: context.breakdown?.rawMaxTokens ?? context.window }
        await saveRecord($, { ...record, native })
        await pruneRecords($)
      }
      await $.tool.register({ name: 'checkpoint', description: CHECKPOINT_DESCRIPTION, inputSchema: CHECKPOINT_INPUT_SCHEMA, isDeferred: false })
      await $.command.register({ name: 'smartcompact', description: 'SmartCompact：report 查看效果，pause / resume 暂停或恢复', argumentHint: '[report|pause|resume]' })
      await log($, { event: 'setup', detail: JSON.stringify({ lines: await loadLines($) }) })
    } catch (error) {
      await log($, { event: 'error', reason: 'session.start', detail: String(error) })
    }
    return result
  })

  on('command.run', { command: 'smartcompact' }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(() => ({
    text: 'SmartCompact 命令执行失败。',
  }))

  on('tool.call', { tool: CHECKPOINT_TOOL }, async ($, e) => {
    const parsed = parseCheckpoint(e)
    if (!parsed.ok) return { result: `Not recorded: ${parsed.error}` }
    const state = await loadSession($)
    const updated = withSignals({ ...state, ledger: applyCheckpoint(state.ledger, parsed.value), notesUpdated: true }, [
      { kind: 'checkpoint', milestone: parsed.value.milestone === true },
    ])
    await saveSession($, updated)
    await log($, { event: 'checkpoint', action: parsed.value.milestone ? 'milestone' : 'note' })
    return { result: 'Recorded. Continue with the work.' }
  }).catch(() => ({ result: 'Not recorded: SmartCompact failed to save the note.' }))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      // 子 agent 的工具调用不影响主会话的上下文；checkpoint 由上面的 hook 处理。
      if (e.agentId || ran.deny !== undefined || e.tool === CHECKPOINT_TOOL) return ran
      const lines = await loadLines($)
      const { state } = await sample($, await loadSession($), lines)
      const outcome = { tool: e.tool, input: e as unknown as Record<string, unknown>, isError: ran.isError === true, text: ran.text ?? '' }
      const { signals, ledger } = recognize(outcome, state.ledger)
      await saveSession($, withSignals({ ...state, ledger }, signals))
    } catch {
      // 识别失败只影响判断，不影响工具调用本身
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.TaskCreated', async ($, e, next) => {
    const state = await loadSession($)
    await saveSession($, { ...state, ledger: taskCreated(state.ledger, e.task_subject) })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.TaskCompleted', async ($, e, next) => {
    const state = await loadSession($)
    await saveSession($, withSignals({ ...state, ledger: taskCompleted(state.ledger, e.task_subject) }, [{ kind: 'task-completed' }]))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    pendingCompaction = null
    queuedCompaction = false
    const context = [...(e.context ?? [])]
    if (ledgerToAttach) {
      context.push(ledgerToAttach)
      ledgerToAttach = null
    }
    const lines = await loadLines($)
    const state = await loadSession($)
    const tokens = (await $.session.usage()).context.tokens
    if (lines && shouldNudge({ tokens, lines, notesUpdated: state.notesUpdated, nudged: state.nudged, paused: state.paused }, params)) {
      context.push(nudgeText(tokens ?? 0))
      await saveSession($, { ...state, nudged: true })
    }
    return next(context.length ? { ...e, context } : e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      // 被用户打断或出错结束的一轮不压缩。
      if (e.reason !== 'answer') return result
      const lines = await loadLines($)
      if (!lines) return result
      const { tokens, state } = await sample($, await loadSession($), lines)
      await saveSession($, state)
      const decision = decideAtTurnEnd(
        { tokens, lines, work: state.work, expectedAfterTokens: expectedAfterTokens(state, params.defaultAfterTokens), paused: state.paused },
        params,
      )
      const sinceMilestoneTokens = decision.action === 'compact' ? growthSinceMilestone(state.work, tokens) : undefined
      if (decision.action !== 'none') await log($, { event: 'turn-end', action: decision.action, reason: decision.reason, tokens, sinceMilestoneTokens })
      if (decision.action === 'compact') {
        const ticket = {}
        pendingCompaction = ticket
        // 本轮还在收尾时调用会被拒，稍等再压缩。
        $.clock.after(COMPACT_DELAY_MS, () => compactNow($, ticket))
      }
    } catch (error) {
      await log($, { event: 'error', reason: 'turn.complete', detail: String(error) })
    }
    return result
  })

  // 排队的 /compact 轮到时已经作废就不再压缩，以压缩说明认出是插件排的。
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    if (e.args !== COMPACT_INSTRUCTIONS) return next(e)
    if (!queuedCompaction) {
      await log($, { event: 'compacted', action: 'skipped', trigger: 'plugin', detail: 'stale' })
      return { text: 'SmartCompact: skipped a queued compaction that is no longer needed.' }
    }
    queuedCompaction = false
    runningQueued = true
    try {
      return await next(e)
    } finally {
      runningQueued = false
    }
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    // 子 agent 自己的压缩和提前计算的摘要不干预；原生自动压缩只在快满时发生，一律放行，压缩后补回笔记。
    if (e.agentId || e.trigger === 'precompute') return next(e)
    let state = await loadSession($)
    const ours = e.trigger === 'manual' && runningQueued
    if (!ours) queuedCompaction = false
    const result = await next(e)
    if (result.skip !== undefined) return result
    state = withCompaction(state, result.tokensBefore ?? 0, result.tokensAfter ?? 0, e.trigger !== 'manual' || ours)
    await saveSession($, state)
    const trigger = ours ? 'plugin-queued' : e.trigger
    await log($, { event: 'compacted', trigger, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter })
    // 只保留最新的一份笔记。
    const ledger = { role: 'user' as const, text: renderLedger(state.ledger, params.ledgerMaxChars), toolUses: [] }
    return { ...result, messages: [...result.messages.filter(message => !isLedgerText(message.text)), ledger] }
  }).catch(($, e, next) => next(e))
}
