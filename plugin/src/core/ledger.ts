// 进度笔记：程序自动记录的事实 + 模型通过 checkpoint 补充的内容。
// core 只负责内容和排版，怎么补回上下文由适配层决定。

export type LedgerFacts = {
  filesChanged: string[]
  lastTest?: { command: string; passed: boolean }
  lastBuild?: { command: string; passed: boolean }
  lastCommit?: { summary: string }
  tasksInProgress: string[]
}

export type LedgerNotes = {
  goal?: string
  /** 用户交代的要求和具体信息；单独存、只追加，再记一次的挪到最后，超过上限才丢最旧的。旧版本存下的笔记没有这一项 */
  requirements?: string[]
  decisions: string[]
  next?: string
  current?: string
}

export type Ledger = { facts: LedgerFacts; notes: LedgerNotes }

export const EMPTY_LEDGER: Ledger = Object.freeze({
  facts: Object.freeze({ filesChanged: [], tasksInProgress: [] }),
  notes: Object.freeze({ decisions: [] }),
}) as Ledger

/** 笔记文本的开头，适配层据此认出上一次放入的笔记并替换。 */
export const LEDGER_MARKER = '[SmartCompact progress ledger]'

/**
 * 插件发起压缩时给摘要的说明。用户顺口交代的具体信息（人名、日期、编号）当下代码用不到，
 * 摘要最容易丢，进度笔记也不记，所以要明确要求原样保留。
 */
export const COMPACT_INSTRUCTIONS =
  'Preserve the current goal, decisions and their reasons, unfinished work, failed attempts, and exact file paths. ' +
  'Also keep every specific fact the user stated, verbatim, even if the current work does not need it: ' +
  'names of people and customers, dates and time windows, ticket or ID numbers, and constraints. ' +
  'A SmartCompact progress ledger is attached after the summary; do not restate it.'

const MAX_FILES = 30
const MAX_DECISIONS = 30
const MAX_FIELD_CHARS = 1_000
/** 用户要求只追加，超过这么多条才丢最旧的 */
const MAX_REQUIREMENTS = 30

export function recordFileChanged(ledger: Ledger, path: string): Ledger {
  const files = [...ledger.facts.filesChanged.filter(file => file !== path), path].slice(-MAX_FILES)
  return { ...ledger, facts: { ...ledger.facts, filesChanged: files } }
}

export function recordTest(ledger: Ledger, command: string, passed: boolean): Ledger {
  return { ...ledger, facts: { ...ledger.facts, lastTest: { command, passed } } }
}

export function recordBuild(ledger: Ledger, command: string, passed: boolean): Ledger {
  return { ...ledger, facts: { ...ledger.facts, lastBuild: { command, passed } } }
}

export function recordCommit(ledger: Ledger, summary: string): Ledger {
  return { ...ledger, facts: { ...ledger.facts, lastCommit: { summary } } }
}

export function recordTasksInProgress(ledger: Ledger, tasks: readonly string[]): Ledger {
  return { ...ledger, facts: { ...ledger.facts, tasksInProgress: [...tasks] } }
}

export type CheckpointInput = {
  goal?: string
  requirements?: string[]
  decisions?: string[]
  next?: string
  current?: string
  /** 模型声明刚完成一块工作 */
  milestone?: boolean
}

/** checkpoint 工具的说明，适配层注册工具时使用。 */
export const CHECKPOINT_DESCRIPTION =
  'Record a short progress note that survives context compaction: the goal, requirements and specific facts the user stated, decisions made, ' +
  'where the work stands, and what is next. ' +
  'Call it after finishing a piece of work (set milestone: true), after an important decision, or when the user states a requirement or a specific fact. ' +
  'Keep it brief; do not call it for trivial steps.'

/** checkpoint 工具的输入 schema，适配层注册工具时使用。 */
export const CHECKPOINT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'The overall goal of the current work.' },
    requirements: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Facts and requirements the user stated for this session: names of people and customers, dates, ticket or ID numbers, constraints, ' +
        'things to avoid. One per item, with the context needed to use it later (such as which task it belongs to), in the user\'s words ' +
        'where possible; record them when the user states them. Not for progress, task status or commit IDs; those go in current and decisions. ' +
        'Items are added to the list and only the oldest are dropped when it gets long. If the user changes one, record the new version; ' +
        'the later one wins. Long-term preferences belong in your own memory, not here.',
    },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made since the last checkpoint.' },
    next: { type: 'string', description: 'What to do next.' },
    current: { type: 'string', description: 'Where the work stands right now.' },
    milestone: { type: 'boolean', description: 'True when a piece of work was just finished.' },
  },
  additionalProperties: false,
} as const

export type CheckpointParse = { ok: true; value: CheckpointInput } | { ok: false; error: string }

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const clip = (value: string): string => value.trim().slice(0, MAX_FIELD_CHARS)

export function parseCheckpoint(raw: unknown): CheckpointParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'input must be an object' }
  const input = raw as Record<string, unknown>
  const value: CheckpointInput = {}
  for (const key of ['goal', 'next', 'current'] as const) {
    const field = input[key]
    if (field === undefined) continue
    if (!text(field)) return { ok: false, error: `${key} must be a non-empty string` }
    value[key] = clip(field)
  }
  for (const key of ['requirements', 'decisions'] as const) {
    const field = input[key]
    if (field === undefined) continue
    if (!Array.isArray(field) || !field.every(text)) return { ok: false, error: `${key} must be an array of non-empty strings` }
    value[key] = field.map(clip)
  }
  if (input.milestone !== undefined) {
    if (typeof input.milestone !== 'boolean') return { ok: false, error: 'milestone must be a boolean' }
    value.milestone = input.milestone
  }
  if (!value.goal && !value.next && !value.current && !value.decisions?.length && !value.requirements?.length) {
    return { ok: false, error: 'record at least one of goal, requirements, decisions, next, current' }
  }
  return { ok: true, value }
}

export function applyCheckpoint(ledger: Ledger, input: CheckpointInput): Ledger {
  const decisions = [...ledger.notes.decisions, ...(input.decisions ?? [])]
  // 再记一次的要求挪到最后：用户刚重申过，不该因为最早写进去而先被丢掉。
  const added = input.requirements ?? []
  const requirements = [...(ledger.notes.requirements ?? []).filter(requirement => !added.includes(requirement)), ...added]
  return {
    ...ledger,
    notes: {
      goal: input.goal ?? ledger.notes.goal,
      requirements: [...new Set(requirements)].slice(-MAX_REQUIREMENTS),
      next: input.next ?? ledger.notes.next,
      current: input.current ?? ledger.notes.current,
      decisions: [...new Set(decisions)].slice(-MAX_DECISIONS),
    },
  }
}

type Kept = { requirements: readonly string[]; decisions: readonly string[]; files: readonly string[] }

/** 排版成补回上下文的文本，超长时先丢最旧的决定、再丢最早改过的文件、最后才丢最旧的用户要求，仍超长才截断。 */
export function renderLedger(ledger: Ledger, maxChars: number): string {
  let kept: Kept = { requirements: ledger.notes.requirements ?? [], decisions: ledger.notes.decisions, files: ledger.facts.filesChanged }
  let rendered = layoutLedger(ledger, kept)
  while (rendered.length > maxChars) {
    const key = (['decisions', 'files', 'requirements'] as const).find(k => kept[k].length)
    if (!key) break
    kept = { ...kept, [key]: kept[key].slice(1) }
    rendered = layoutLedger(ledger, kept)
  }
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, maxChars - 20)}\n…(truncated)`
}

function layoutLedger({ facts, notes }: Ledger, { requirements, decisions, files }: Kept): string {
  const lines = [
    LEDGER_MARKER,
    'Generated by the SmartCompact plugin to keep continuity across compaction. It is not a message from the user.',
  ]
  const section = (title: string, body: (string | undefined)[]) => {
    const rows = body.filter((row): row is string => Boolean(row))
    if (rows.length) lines.push('', `## ${title}`, ...rows)
  }
  const omitted = (dropped: number, what: string) => (dropped ? `- …(${dropped} earlier ${what} omitted)` : undefined)
  section('Goal', [notes.goal])
  section('User requirements', [
    omitted((notes.requirements?.length ?? 0) - requirements.length, 'requirements'),
    ...requirements.map(requirement => `- ${requirement}`),
  ])
  section('Current state', [notes.current])
  section('Next', [notes.next])
  section('Latest results', [
    facts.lastTest && `- tests ${facts.lastTest.passed ? 'passed' : 'FAILED'}: ${facts.lastTest.command}`,
    facts.lastBuild && `- build ${facts.lastBuild.passed ? 'passed' : 'FAILED'}: ${facts.lastBuild.command}`,
    facts.lastCommit && `- last commit: ${facts.lastCommit.summary}`,
  ])
  section('Tasks in progress', facts.tasksInProgress.map(task => `- ${task}`))
  section('Decisions', [omitted(notes.decisions.length - decisions.length, 'decisions'), ...decisions.map(decision => `- ${decision}`)])
  section('Files changed', [omitted(facts.filesChanged.length - files.length, 'files'), ...files.map(file => `- ${file}`)])
  return lines.join('\n')
}

export function isLedgerText(value: string): boolean {
  return value.startsWith(LEDGER_MARKER)
}
