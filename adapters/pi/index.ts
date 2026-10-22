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
  renderLedger,
} from '../../plugin/src/core/ledger.ts'
import type { Lines } from '../../plugin/src/core/lines.ts'
import { resolveParams } from '../../plugin/src/core/params.ts'
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

export default function smartCompact(pi: ExtensionAPI) {
  pi.registerFlag('smartcompact-allow-line', { description: 'SmartCompact 允许压缩线（token）', type: 'string' })
  pi.registerFlag('smartcompact-min-freed', { description: 'SmartCompact 最少腾出空间（token）', type: 'string' })

  let state: SessionState = INITIAL_SESSION_STATE
  let saved = ''
  /** 插件自己发起的压缩在 pi 里同样是 manual，据此和用户的 /compact 区分。 */
  let ours = false
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
      allowLineTokens: Number(pi.getFlag('smartcompact-allow-line')) || undefined,
      minFreedTokens: Number(pi.getFlag('smartcompact-min-freed')) || undefined,
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
    const current = lines(ctx)
    const reminder = current && promptReminder(state, tokensOf(ctx), current, params(ctx), CHECKPOINT_TOOL)
    if (!reminder) return
    state = reminder.state
    persist()
    log(reminder.log)
    return { message: { customType: REMINDER_MESSAGE, content: reminder.text, display: false } }
  })

  // agent_settled：pi 不会再自动继续，此时压缩不会打断工作。
  pi.on('agent_settled', async (_event, ctx) => {
    const current = lines(ctx)
    if (!current) return
    const tokens = sample(ctx, current)
    persist()
    const decision = decideAtTurnEnd(
      { tokens, lines: current, work: state.work, expectedAfterTokens: expectedAfterTokens(state, params(ctx).defaultAfterTokens), paused: state.paused },
      params(ctx),
    )
    const sinceMilestoneTokens = decision.action === 'compact' ? growthSinceMilestone(state.work, tokens) : undefined
    if (decision.action !== 'none') log({ event: 'turn-end', action: decision.action, reason: decision.reason, tokens, sinceMilestoneTokens })
    if (decision.action !== 'compact' || !ctx.isIdle() || ctx.hasPendingMessages()) return
    ours = true
    ctx.compact({
      customInstructions: COMPACT_INSTRUCTIONS,
      onError: error => {
        ours = false
        log({ event: 'compacted', action: 'failed', trigger: 'plugin', detail: error.message })
      },
    })
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
