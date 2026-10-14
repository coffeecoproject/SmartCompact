// 把 pi 的工具结果翻译成 core 的信号和笔记事实。

import { classifyCommand } from '../../plugin/src/core/commands.ts'
import { type Ledger, recordFileChanged } from '../../plugin/src/core/ledger.ts'
import type { Signal } from '../../plugin/src/core/signals.ts'

export type PiToolOutcome = {
  toolName: string
  input: Readonly<Record<string, unknown>>
  isError: boolean
  /** 结果里的文本内容 */
  text: string
}

const EDIT_TOOLS = new Set(['edit', 'write'])

export function recognizePi(outcome: PiToolOutcome, ledger: Ledger): { signals: Signal[]; ledger: Ledger } {
  const signals: Signal[] = [{ kind: 'tool-result', isError: outcome.isError }]
  let next = ledger
  const { path, command } = outcome.input
  if (EDIT_TOOLS.has(outcome.toolName) && !outcome.isError && typeof path === 'string' && path) {
    next = recordFileChanged(next, path)
  }
  if (outcome.toolName === 'bash' && typeof command === 'string' && command) {
    const classified = classifyCommand(command, outcome.isError, outcome.text, next)
    signals.push(...classified.signals)
    next = classified.ledger
  }
  return { signals, ledger: next }
}
