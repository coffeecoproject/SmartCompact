// Codex 版的会话记录：每个会话一个 JSON 文件，决策日志追加写入。都放在 $CODEX_HOME/smartcompact/ 下。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PendingCompaction } from '../../plugin/src/core/pending.ts'
import { INITIAL_SESSION_STATE, parseState, type DecisionLogEntry, type SessionState } from '../../plugin/src/core/state.ts'

export const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')
const dataDir = (): string => join(codexHome(), 'smartcompact')

export type CodexSession = {
  state: SessionState
  /** 会话记录文件已处理到的字节位置 */
  rolloutOffset: number
  /** 压缩后还没补回进度笔记 */
  ledgerPending: boolean
  /** 最近一轮结束时决定的、还在等用户空闲的压缩；判断变了或用户发了新消息就清掉 */
  compactPending?: PendingCompaction
  /** 后台压缩进程启动的时间（毫秒）；进程退出时清掉 */
  compactorStartedAt?: number
  /** 后台进程真正发起压缩的时间（毫秒）；看到压缩发生时清掉，据此认出插件发起的压缩 */
  compactRequestedAt?: number
}

const isPending = (value: unknown): value is PendingCompaction => {
  const pending = value as Partial<PendingCompaction> | undefined
  return typeof pending?.session === 'string' && typeof pending.compactions === 'number' && typeof pending.notBefore === 'number'
}

const sessionFile = (sessionId: string): string => join(dataDir(), 'sessions', `${sessionId}.json`)

export function loadSession(sessionId: string): CodexSession {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')) as Partial<CodexSession>
    return {
      state: parseState(raw.state),
      rolloutOffset: typeof raw.rolloutOffset === 'number' ? raw.rolloutOffset : 0,
      ledgerPending: raw.ledgerPending === true,
      compactPending: isPending(raw.compactPending) ? raw.compactPending : undefined,
      compactorStartedAt: typeof raw.compactorStartedAt === 'number' ? raw.compactorStartedAt : undefined,
      compactRequestedAt: typeof raw.compactRequestedAt === 'number' ? raw.compactRequestedAt : undefined,
    }
  } catch {
    return { state: INITIAL_SESSION_STATE, rolloutOffset: 0, ledgerPending: false }
  }
}

export function saveSession(sessionId: string, session: CodexSession): void {
  mkdirSync(join(dataDir(), 'sessions'), { recursive: true })
  writeFileSync(sessionFile(sessionId), JSON.stringify(session))
}

export function appendLog(sessionId: string, entry: Omit<DecisionLogEntry, 'at' | 'session'>): void {
  mkdirSync(dataDir(), { recursive: true })
  appendFileSync(join(dataDir(), 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), session: sessionId, ...entry })}\n`)
}

export function readLog(): DecisionLogEntry[] {
  const file = join(dataDir(), 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as DecisionLogEntry]
      } catch {
        return []
      }
    })
}

/** 从 Codex 配置里读原生自动压缩线；读不到时为 undefined。 */
export function nativeAutoCompactLimit(): number | undefined {
  try {
    const config = readFileSync(join(codexHome(), 'config.toml'), 'utf8')
    const match = /^\s*model_auto_compact_token_limit\s*=\s*(\d+)/m.exec(config)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}
