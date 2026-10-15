// 把 Claude Code 的工具调用结果翻译成 core 的信号和笔记事实。只做识别，不碰 $。

import { classifyCommand } from '../core/commands.ts'
import { type Ledger, recordFileChanged, recordTasksInProgress } from '../core/ledger.ts'
import type { Signal } from '../core/signals.ts'

export type ToolOutcome = {
  tool: string
  input: Readonly<Record<string, unknown>>
  isError: boolean
  /** 模型读到的结果文本 */
  text: string
}

export type Recognized = { signals: Signal[]; ledger: Ledger; /** 读了哪个文件 */ read?: string }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

export function recognize(outcome: ToolOutcome, ledger: Ledger): Recognized {
  const signals: Signal[] = [{ kind: 'tool-result', isError: outcome.isError }]
  let next = ledger

  if (EDIT_TOOLS.has(outcome.tool) && !outcome.isError) {
    const path = text(outcome.input.file_path) ?? text(outcome.input.notebook_path)
    if (path) next = recordFileChanged(next, path)
  }

  if (outcome.tool === 'TodoWrite' && Array.isArray(outcome.input.todos)) {
    const inProgress = outcome.input.todos.flatMap(todo =>
      todo && typeof todo === 'object' && todo.status === 'in_progress' && text(todo.content) ? [todo.content as string] : [],
    )
    next = recordTasksInProgress(next, inProgress)
  }

  const read = outcome.tool === 'Read' && !outcome.isError ? text(outcome.input.file_path) : undefined

  const command = outcome.tool === 'Bash' ? text(outcome.input.command) : undefined
  if (command) {
    const classified = classifyCommand(command, outcome.isError, outcome.text, next)
    signals.push(...classified.signals)
    next = classified.ledger
  }

  return { signals, ledger: next, read }
}

/** 任务开始和完成（经典 TaskCreated / TaskCompleted 事件）对进行中任务列表的影响。 */
export function taskCreated(ledger: Ledger, subject: string): Ledger {
  return recordTasksInProgress(ledger, [...ledger.facts.tasksInProgress.filter(task => task !== subject), subject])
}

export function taskCompleted(ledger: Ledger, subject: string): Ledger {
  return recordTasksInProgress(ledger, ledger.facts.tasksInProgress.filter(task => task !== subject))
}
