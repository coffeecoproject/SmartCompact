// 从 Codex 的会话记录文件里增量读取：当前上下文大小、跑过的命令及退出码、改过的文件、是否发生了压缩。
// hook 的输入里没有 token 数，PostToolUse 也没有退出码，这些都只在会话记录里有。

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export type RolloutCommand = { command: string; exitCode: number | undefined; output: string }

export type RolloutDelta = {
  /** 新的已处理到的字节位置（只算完整的行） */
  offset: number
  /** 每次请求的上下文大小，按时间顺序 */
  tokens: number[]
  window?: number
  commands: RolloutCommand[]
  files: string[]
  compacted: boolean
}

const commandText = (value: unknown): string =>
  Array.isArray(value) ? String(value.at(-1) ?? '') : typeof value === 'string' ? value : ''

export function readRollout(path: string, offset: number): RolloutDelta {
  const delta: RolloutDelta = { offset, tokens: [], commands: [], files: [], compacted: false }
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size <= offset) return delta
    const buffer = Buffer.alloc(size - offset)
    readSync(fd, buffer, 0, buffer.length, offset)
    const end = buffer.lastIndexOf(0x0a)
    if (end === -1) return delta
    delta.offset = offset + end + 1
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue
      let record: { type?: string; payload?: Record<string, any> }
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const payload = record.payload ?? {}
      if (record.type === 'compacted') delta.compacted = true
      if (record.type !== 'event_msg') continue
      if (payload.type === 'token_count') {
        const tokens = payload.info?.last_token_usage?.input_tokens
        if (typeof tokens === 'number' && tokens > 0) delta.tokens.push(tokens)
        if (typeof payload.info?.model_context_window === 'number') delta.window = payload.info.model_context_window
      }
      if (payload.type !== 'item_completed') continue
      const item = payload.item ?? {}
      if (item.type === 'CommandExecution') {
        delta.commands.push({
          command: commandText(item.command),
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined,
          output: String(item.formatted_output ?? item.aggregated_output ?? item.stdout ?? ''),
        })
      }
      if (item.type === 'FileChange' && item.status !== 'failed' && item.changes && typeof item.changes === 'object') {
        delta.files.push(...Object.keys(item.changes))
      }
    }
    return delta
  } finally {
    closeSync(fd)
  }
}
