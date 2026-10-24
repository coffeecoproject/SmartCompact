// SmartCompact 的 pi 扩展：把 pi 的事件接到 core 的决策上。
// - 插件在 agent_settled（不会再自动继续时）挑做完一件事的时机主动压缩；等不到就交给 pi 原生压缩。
// - 上限 = 窗口 − pi 默认预留。用户把 reserveTokens 调大、让原生压缩提前时，
//   插件在提前的那个点按工作状态决定是否取消，最晚到上限放行。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { decideAtTurnEnd, decideMidTurn } from '../../plugin/src/core/decide.ts'
import {
  applyCheckpoint,
  CHECKPOINT_DESCRIPTION,
  CHECKPOINT_INPUT_SCHEMA,
  COMPACT_INSTRUCTIONS,
  parseCheckpoint,
  recordLastReply,
  renderLedger,
} from '../../plugin/src/core/ledger.ts'
import type { Lines } from '../../plugin/src/core/lines.ts'
import { resolveParams } from '../../plugin/src/core/params.ts'
import { planCompaction, staleCompaction } from '../../plugin/src/core/pending.ts'
import { promptReminder } from '../../plugin/src/core/reminder.ts'
import { countDecisions, renderReport } from '../../plugin/src/core/report.ts'
import {
  checkpointLog,
  cycleReads,
  type DecisionLogEntry,
  expectedAfterTokens,
  growthSinceMilestone,
  INITIAL_SESSION_STATE,
  parseState,
  type SessionState,
  withCompaction,
  withRead,
  withSample,
  withSignals,
} from '../../plugin/src/core/state.ts'
import { pricesFor } from '../../plugin/src/core/usage.ts'
import { recognizePi } from './recognize.ts'

const STATE_ENTRY = 'smartcompact-state'
const LOG_ENTRY = 'smartcompact-log'
const LEDGER_MESSAGE = 'smartcompact-ledger'
const REMINDER_MESSAGE = 'smartcompact-reminder'
const CHECKPOINT_TOOL = 'smartcompact_checkpoint'
/** pi 内置的默认 reserveTokens，即不配置时原生压缩点离满窗的距离 */
const PI_DEFAULT_RESERVE = 16_384
/** 压缩后除了保留的最近内容，还有系统提示、工具和摘要，粗估这么多 */
const PI_AFTER_OVERHEAD = 10_000

const field = CHECKPOINT_INPUT_SCHEMA.properties

/** 没设置时用默认值；0 也是合法的设置。 */
const flagNumber = (value: unknown): number | undefined => (typeof value === 'string' && value.trim() ? Number(value) : undefined)

export default function smartCompact(pi: ExtensionAPI) {
  pi.registerFlag('smartcompact-allow-line', { description: 'SmartCompact 允许压缩线（token）', type: 'string' })
  pi.registerFlag('smartcompact-min-freed', { description: 'SmartCompact 最少腾出空间（token）', type: 'string' })
  pi.registerFlag('smartcompact-idle-seconds', { description: 'SmartCompact 决定压缩后等用户空闲多少秒', type: 'string' })

  let state: SessionState = INITIAL_SESSION_STATE
  let saved = ''
  /** 插件自己发起的压缩在 pi 里同样是 manual，据此和用户的 /compact 区分。 */
  let ours = false
  /** 这次运行给用户的最后一段文字；运行正常结束时记进笔记，压缩后原样带回。 */
  let lastReply = ''
  /** 一轮结束后等用户空闲再执行的压缩；用户发新消息、换会话或退出时作废，到点时再核对会话现状。 */
  let idleCompaction: ReturnType<typeof setTimeout> | undefined
  /** 当前模型的 reserveTokens 和 keepRecentTokens；读设置文件有开销，按会话和模型缓存。 */
  let compaction: { reserve: number; keepRecent: number } | undefined

  const compactionSettings = (ctx: ExtensionContext) => {
    if (!compaction) {
      // 和 pi 自己一样：项目未被信任时不读项目目录下的设置。
      const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings(ctx.model)
      compaction = { reserve: settings.reserveTokens, keepRecent: settings.keepRecentTokens }
    }
    return compaction
  }

  // pi 的基础占用比 Claude 小得多：压缩后的大小按 pi 保留的最近内容估算，而不是用 core 的默认值。
  const params = (ctx: ExtensionContext) =>
    resolveParams({
      allowLineTokens: flagNumber(pi.getFlag('smartcompact-allow-line')),
      minFreedTokens: flagNumber(pi.getFlag('smartcompact-min-freed')),
      compactIdleSeconds: flagNumber(pi.getFlag('smartcompact-idle-seconds')),
      defaultAfterTokens: compactionSettings(ctx).keepRecent + PI_AFTER_OVERHEAD,
    })

  const lines = (ctx: ExtensionContext): Lines | null => {
    const usage = ctx.getContextUsage()
    if (!usage) return null
    const { reserve } = compactionSettings(ctx)
    return { allow: params(ctx).allowLineTokens, ceiling: usage.contextWindow - Math.min(reserve, PI_DEFAULT_RESERVE) }
  }

  const tokensOf = (ctx: ExtensionContext): number | undefined => ctx.getContextUsage()?.tokens ?? undefined

  // 成本估算对比的是"没有插件时"：pi 原生会在它配置的压缩点（窗口 − reserveTokens）压缩，而不是等到真正的极限。
  const sample = (ctx: ExtensionContext, current: Lines | null) => {
    const tokens = tokensOf(ctx)
    const window = ctx.getContextUsage()?.contextWindow
    const model = `${ctx.model?.provider ?? ''} ${ctx.model?.id ?? ''}`
    if (tokens !== undefined && current && window) state = withSample(state, tokens, window - compactionSettings(ctx).reserve, pricesFor(model))
    return tokens
  }

  // 状态变了才写一条，避免会话文件膨胀。
  const persist = () => {
    const json = JSON.stringify(state)
    if (json === saved) return
    saved = json
    pi.appendEntry(STATE_ENTRY, state)
  }

  const log = (entry: Omit<DecisionLogEntry, 'at' | 'session'>) => pi.appendEntry(LOG_ENTRY, { at: new Date().toISOString(), ...entry })

  /** 撤销还在等用户空闲的压缩；返回是否真的撤销了。 */
  const cancelIdleCompaction = (): boolean => {
    if (!idleCompaction) return false
    clearTimeout(idleCompaction)
    idleCompaction = undefined
    return true
  }

  const report = (ctx: ExtensionContext): string => {
    const current = lines(ctx)
    if (!current) return 'SmartCompact 尚未读到上下文用量。'
    const entries = ctx.sessionManager
      .getBranch()
      .flatMap(entry => (entry.type === 'custom' && entry.customType === LOG_ENTRY ? [entry.data as DecisionLogEntry] : []))
    return renderReport({ state, lines: current, tokens: tokensOf(ctx), counts: countDecisions(entries) })
  }

  pi.on('session_start', async (_event, ctx) => {
    // 恢复当前分支上最后一次保存的状态。
    const last = ctx.sessionManager
      .getBranch()
      .filter(entry => entry.type === 'custom' && entry.customType === STATE_ENTRY)
      .at(-1)
    state = parseState(last && last.type === 'custom' ? last.data : undefined)
    saved = JSON.stringify(state)
    ours = false
    compaction = undefined
    cancelIdleCompaction()
  })

  pi.on('model_select', async () => {
    compaction = undefined
  })

  pi.registerTool({
    name: CHECKPOINT_TOOL,
    label: 'Checkpoint',
    description: CHECKPOINT_DESCRIPTION,
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: field.goal.description })),
      requirements: Type.Optional(Type.Array(Type.String(), { description: field.requirements.description })),
      decisions: Type.Optional(Type.Array(Type.String(), { description: field.decisions.description })),
      next: Type.Optional(Type.String({ description: field.next.description })),
      current: Type.Optional(Type.String({ description: field.current.description })),
      milestone: Type.Optional(Type.Boolean({ description: field.milestone.description })),
    }),
    async execute(_toolCallId, input) {
      const parsed = parseCheckpoint(input)
      if (!parsed.ok) return { content: [{ type: 'text', text: `Not recorded: ${parsed.error}` }], details: {} }
      const ledger = applyCheckpoint(state.ledger, parsed.value)
      state = withSignals({ ...state, ledger, notesUpdated: true }, [{ kind: 'checkpoint', milestone: parsed.value.milestone === true }])
      persist()
      log(checkpointLog(parsed.value, ledger))
      return { content: [{ type: 'text', text: 'Recorded. Continue with the work.' }], details: {} }
    },
  })

  pi.registerCommand('smartcompact', {
    description: 'SmartCompact：report 查看效果，pause / resume 暂停或恢复',
    handler: async (args, ctx) => {
      const action = args.trim() || 'report'
      if (action === 'pause' || action === 'resume') {
        state = { ...state, paused: action === 'pause' }
        persist()
        ctx.ui.notify(action === 'pause' ? 'SmartCompact 已暂停：本会话不再干预压缩。' : 'SmartCompact 已恢复。', 'info')
        return
      }
      ctx.ui.notify(action === 'report' ? report(ctx) : '用法：/smartcompact [report|pause|resume]', 'info')
    },
  })

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === CHECKPOINT_TOOL) return
    sample(ctx, lines(ctx))
    const text = event.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
    const { signals, ledger, read } = recognizePi({ toolName: event.toolName, input: event.input, isError: event.isError, text }, state.ledger)
    state = withSignals({ ...state, ledger }, signals)
    if (read) state = withRead(state, read)
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    // 等待期间来了新消息，说明还在进行，这次不压，等下一次停顿。
    if (cancelIdleCompaction()) log({ event: 'compacted', action: 'cancelled', reason: 'new-turn', trigger: 'plugin' })
    const current = lines(ctx)
    const reminder = current && promptReminder(state, tokensOf(ctx), current, params(ctx), CHECKPOINT_TOOL)
    if (!reminder) return
    state = reminder.state
    persist()
    log(reminder.log)
    return { message: { customType: REMINDER_MESSAGE, content: reminder.text, display: false } }
  })

  pi.on('agent_end', async event => {
    const reply = event.messages.findLast(message => message.role === 'assistant')
    lastReply =
      reply && 'content' in reply && Array.isArray(reply.content)
        ? reply.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
        : ''
  })

  // agent_settled：pi 不会再自动继续，此时压缩不会打断工作。被用户打断的运行不压缩，也不记回复。
  pi.on('agent_settled', async (event, ctx) => {
    if (event.aborted) return
    state = { ...state, ledger: recordLastReply(state.ledger, lastReply) }
    const current = lines(ctx)
    if (!current) {
      persist()
      return
    }
    const tokens = sample(ctx, current)
    persist()
    const decision = decideAtTurnEnd(
      { tokens, lines: current, work: state.work, expectedAfterTokens: expectedAfterTokens(state, params(ctx).defaultAfterTokens), paused: state.paused },
      params(ctx),
    )
    const sinceMilestoneTokens = decision.action === 'compact' ? growthSinceMilestone(state.work, tokens) : undefined
    if (decision.action !== 'none') log({ event: 'turn-end', action: decision.action, reason: decision.reason, tokens, sinceMilestoneTokens })
    if (decision.action !== 'compact') return
    // 等用户空闲一会儿再压：还在讨论时不打断，用户也不用等压缩完才得到回复。
    cancelIdleCompaction()
    const pending = planCompaction(ctx.sessionManager.getSessionId(), state, Date.now(), params(ctx))
    idleCompaction = setTimeout(() => {
      idleCompaction = undefined
      // 新的运行会先经过 before_agent_start 撤销；到点还不空闲的是 pi 自己在重试、恢复或处理排队的消息，这次不压，下一次停顿时重新判断。
      // 等待期间用户可能自己 /compact、原生压缩过或暂停了插件，这些也都不经过 before_agent_start。
      const stale = !ctx.isIdle() || ctx.hasPendingMessages() ? 'busy' : staleCompaction(pending, state, ctx.sessionManager.getSessionId())
      if (stale) {
        log({ event: 'compacted', action: 'skipped', reason: stale, trigger: 'plugin' })
        return
      }
      ours = true
      ctx.compact({
        customInstructions: COMPACT_INSTRUCTIONS,
        onError: error => {
          ours = false
          log({ event: 'compacted', action: 'failed', trigger: 'plugin', detail: error.message })
        },
      })
    }, pending.notBefore - Date.now())
    // 等待中的压缩不拦着 pi 退出（比如 -p 模式跑完就该结束）。
    idleCompaction.unref?.()
  })

  // 计时器拿着旧会话的 ctx，换会话或退出时必须清掉。
  pi.on('session_shutdown', async () => {
    cancelIdleCompaction()
  })

  pi.on('session_before_compact', async (event, ctx) => {
    // 只在原生按阈值压缩时判断；上下文溢出的恢复压缩和用户的 /compact 一律放行。
    if (event.reason !== 'threshold') return
    const current = lines(ctx)
    if (!current) return
    const tokens = sample(ctx, current)
    const decision = decideMidTurn(
      { tokens, lines: current, work: state.work, expectedAfterTokens: expectedAfterTokens(state, params(ctx).defaultAfterTokens), paused: state.paused },
      params(ctx),
    )
    log({ event: 'mid-turn', action: decision.action, reason: decision.reason, tokens })
    if (decision.action === 'veto') return { cancel: true }
  })

  pi.on('session_compact', async (event, ctx) => {
    const fromPlugin = event.reason === 'manual' && ours
    ours = false
    const summaryTokens = Math.round(event.compactionEntry.summary.length / 4)
    const reads = cycleReads(state)
    // 原生按阈值的压缩、溢出恢复和用户的 /compact，没有插件时也会发生；只有插件发起的压缩计入节省。
    state = withCompaction(state, event.compactionEntry.tokensBefore, summaryTokens, fromPlugin)
    persist()
    log({ event: 'compacted', trigger: fromPlugin ? 'plugin' : event.reason === 'threshold' ? 'auto' : event.reason, tokensBefore: event.compactionEntry.tokensBefore, ...reads })
    pi.sendMessage(
      { customType: LEDGER_MESSAGE, content: renderLedger(state.ledger, params(ctx).ledgerMaxChars), display: false },
      { deliverAs: ctx.isIdle() ? 'nextTurn' : 'steer' },
    )
  })

  pi.on('session_compact_failed', async () => {
    ours = false
  })
}
