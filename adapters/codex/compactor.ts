// 后台压缩进程：node compactor.ts <会话 ID>。由 Stop hook 启动，等会话空闲后通过共享后台服务发起压缩。
// 共享后台服务不可用时（codex exec、或用户选了不用后台服务）只记日志，Codex 按原生规则压缩。

import { fileURLToPath } from 'node:url'
import { DaemonClient } from './daemon.ts'
import { appendLog, loadSession, saveSession } from './store.ts'

const POLL_MS = 1_000
/** 最多等会话空闲这么久；hook 据此判断请求是否已失效 */
export const MAX_WAIT_MS = 10 * 60_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(threadId: string): Promise<void> {
  let client: DaemonClient | undefined
  try {
    client = await DaemonClient.connect()
    const deadline = Date.now() + MAX_WAIT_MS
    while (Date.now() < deadline) {
      const read = await client.request('thread/read', { threadId })
      const status = (read.thread as { status?: { type?: string } } | undefined)?.status?.type
      if (status === 'idle') {
        // 等待期间用户可能又跑了几轮，按最近一轮结束时的判断再确认一次，情况变了就取消。
        if (!loadSession(threadId).compactWanted) {
          appendLog(threadId, { event: 'compacted', action: 'cancelled', trigger: 'plugin' })
          saveSession(threadId, { ...loadSession(threadId), compactRequestedAt: undefined })
          return
        }
        await client.request('thread/compact/start', { threadId })
        appendLog(threadId, { event: 'compacted', action: 'requested', trigger: 'plugin' })
        return
      }
      if (status === 'notLoaded' || status === 'systemError') throw new Error(`thread status ${status}`)
      await sleep(POLL_MS)
    }
    throw new Error('waited too long for the thread to become idle')
  } catch (error) {
    appendLog(threadId, { event: 'compacted', action: 'failed', trigger: 'plugin', detail: String(error) })
    saveSession(threadId, { ...loadSession(threadId), compactRequestedAt: undefined })
  } finally {
    client?.close()
  }
}

const threadId = process.argv[1] === fileURLToPath(import.meta.url) ? process.argv[2] : undefined
if (threadId) await main(threadId)
