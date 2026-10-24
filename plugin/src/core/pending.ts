// 一轮结束时决定压缩后，等用户空闲一会儿再执行。等待期间会话可能已经变了，到点时用这里的核对决定还压不压；
// 三个平台都用它，不再逐个事件去撤销。用户发新消息时撤销是另一回事（还在讨论），由适配层在收到消息时处理。

import type { Params } from './params.ts'
import type { SessionState } from './state.ts'

export type PendingCompaction = {
  /** 决定压缩时的会话 ID */
  session: string
  /** 决定压缩时已经压缩过的次数；到点时变了，说明期间已经压缩过 */
  compactions: number
  /** 不早于这个时间（毫秒）执行 */
  notBefore: number
}

export type StaleReason = 'session-changed' | 'compacted-meanwhile' | 'paused'

export const planCompaction = (session: string, state: SessionState, now: number, params: Params): PendingCompaction => ({
  session,
  compactions: state.compactions,
  notBefore: now + params.compactIdleSeconds * 1_000,
})

/** 到点时核对：换了会话（如 /clear）、期间已经压缩过（用户的 /compact 或原生压缩）、或暂停了，这次就不压。 */
export function staleCompaction(pending: PendingCompaction, state: SessionState, session: string): StaleReason | undefined {
  if (session !== pending.session) return 'session-changed'
  if (state.compactions !== pending.compactions) return 'compacted-meanwhile'
  if (state.paused) return 'paused'
  return undefined
}
