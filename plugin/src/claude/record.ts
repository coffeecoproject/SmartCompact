// 每个会话一条记录，按会话 ID 存在插件存储里，关掉再恢复同一个会话时能读回。

import { type NativeSetup, parseNative } from './native.ts'

export const RECORD_PREFIX = 'session:'
/** 只保留最近这么多个会话的记录 */
export const RECORD_LIMIT = 30

export type SessionRecord = {
  /** core 的 SessionState，由 parseState 校验 */
  state: unknown
  native: NativeSetup | null
  updatedAt: number
}

export function parseRecord(raw: unknown): SessionRecord {
  const record = raw && typeof raw === 'object' ? (raw as Partial<SessionRecord>) : {}
  return {
    state: record.state,
    native: parseNative(record.native),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
}

/** 超出上限时，按最近更新时间保留，返回要删除的键。 */
export function staleRecordKeys(records: readonly { key: string; updatedAt: number }[], limit = RECORD_LIMIT): string[] {
  return [...records]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(limit)
    .map(record => record.key)
}
