// 无界面会话里插件排队执行的 /compact：它不经过本插件的 command.run hook，到压缩时才能认出。

import { COMPACT_INSTRUCTIONS } from '../core/ledger.ts'

/**
 * 一次压缩是不是插件排的 /compact：以手动触发、压缩说明与插件的一致认出。
 * 排队之后压缩过或用户发了新消息，排队标记已清掉，这次就是作废的（stale）。
 */
export function queuedCompaction(e: { trigger: string; instructions?: string }, stillQueued: boolean): 'ours' | 'stale' | null {
  if (e.trigger !== 'manual' || e.instructions !== COMPACT_INSTRUCTIONS) return null
  return stillQueued ? 'ours' : 'stale'
}
