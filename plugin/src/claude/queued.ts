// 无界面会话里插件排队执行的 /compact：它不经过本插件的 command.run hook，到压缩时才能认出。

import { COMPACT_INSTRUCTIONS } from '../core/ledger.ts'

/** 排队时 /compact 带的参数：对话里会显示出来，所以只放一个标记，完整说明在压缩时换进去。 */
export const QUEUED_COMPACT_ARGS = 'by SmartCompact'

/** 摘要要按完整说明写，不能拿到标记本身；插件的 hook 出错退回时也一样。 */
export function withFullInstructions<T extends { instructions?: string }>(e: T): T {
  return e.instructions === QUEUED_COMPACT_ARGS ? { ...e, instructions: COMPACT_INSTRUCTIONS } : e
}

/**
 * 一次压缩是不是插件排的 /compact：以手动触发、参数是这个标记认出。
 * 排队之后压缩过或用户发了新消息，排队标记已清掉，这次就是作废的（stale）。
 */
export function queuedCompaction(e: { trigger: string; instructions?: string }, stillQueued: boolean): 'ours' | 'stale' | null {
  if (e.trigger !== 'manual' || e.instructions !== QUEUED_COMPACT_ARGS) return null
  return stillQueued ? 'ours' : 'stale'
}
