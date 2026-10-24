// 后台压缩进程：node compactor.ts <会话 ID>。由 Stop hook 启动，等用户空闲一会儿、会话也空闲后通过共享后台服务发起压缩。
// 共享后台服务不可用时（codex exec、或用户选了不用后台服务）只记日志，Codex 按原生规则压缩。

import { fileURLToPath } from 'node:url'
import { staleCompaction } from '../../plugin/src/core/pending.ts'
import { DaemonClient } from './daemon.ts'
import { appendLog, type CodexSession, loadSession, saveSession } from './store.ts'

const POLL_MS = 1_000
/** 到了可以压缩的时间后，最多再等会话空闲这么久 */
export const MAX_WAIT_MS = 10 * 60_000

/** 后台进程是否可能还在等；它意外退出时记录会一直挂着，超过它最长的等待时间就当作失效，允许重新启动。 */
export function compactorAlive(session: CodexSession, now: number): boolean {
  if (session.compactorStartedAt === undefined) return false
  return now < Math.max(session.compactorStartedAt, session.compactPending?.notBefore ?? 0) + MAX_WAIT_MS + 60_000
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(threadId: string): Promise<void> {
  let client: DaemonClient | undefined
  try {
    client = await DaemonClient.connect()
    for (;;) {
      const session = loadSession(threadId)
      const pending = session.compactPending
      // 最近一轮结束时判断不再需要压缩，或用户发了新消息：这次作废，下一轮结束时重新判断。撤销的一方记日志。
      if (!pending) {
        saveSession(threadId, { ...session, compactorStartedAt: undefined })
        return
      }
      // 等待期间用户自己 /compact 或原生压缩过了，也不再压。
      const stale = staleCompaction(pending, session.state, threadId)
      if (stale) {
        appendLog(threadId, { event: 'compacted', action: 'skipped', reason: stale, trigger: 'plugin' })
        saveSession(threadId, { ...session, compactPending: undefined, compactorStartedAt: undefined })
        return
      }
      const now = Date.now()
      if (now > pending.notBefore + MAX_WAIT_MS) throw new Error('waited too long for the thread to become idle')
      if (now >= pending.notBefore) {
        const read = await client.request('thread/read', { threadId })
        const status = (read.thread as { status?: { type?: string } } | undefined)?.status?.type
        if (status === 'idle') {
          saveSession(threadId, { ...loadSession(threadId), compactPending: undefined, compactorStartedAt: undefined, compactRequestedAt: Date.now() })
          await client.request('thread/compact/start', { threadId })
          appendLog(threadId, { event: 'compacted', action: 'requested', trigger: 'plugin' })
          return
        }
        if (status === 'notLoaded' || status === 'systemError') throw new Error(`thread status ${status}`)
      }
      await sleep(POLL_MS)
    }
  } catch (error) {
    appendLog(threadId, { event: 'compacted', action: 'failed', trigger: 'plugin', detail: String(error) })
    saveSession(threadId, { ...loadSession(threadId), compactPending: undefined, compactorStartedAt: undefined, compactRequestedAt: undefined })
  } finally {
    client?.close()
  }
}

const threadId = process.argv[1] === fileURLToPath(import.meta.url) ? process.argv[2] : undefined
if (threadId) await main(threadId)
