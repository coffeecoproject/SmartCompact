// Codex 版的会话记录：每个会话一个 JSON 文件，决策日志追加写入。都放在 $CODEX_HOME/smartcompact/ 下。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { INITIAL_SESSION_STATE, parseState, type DecisionLogEntry, type SessionState } from '../../plugin/src/core/state.ts'

export const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')
const dataDir = (): string => join(codexHome(), 'smartcompact')

export type CodexSession = {
  state: SessionState
  /** 会话记录文件已处理到的字节位置 */
  rolloutOffset: number
  /** 压缩后还没补回进度笔记 */
  ledgerPending: boolean
  /** 插件请求压缩的时间（毫秒）；还没看到压缩发生时有值 */
  compactRequestedAt?: number
  /** 最近一轮结束时的判断是否仍是"应该压缩"；后台进程发起压缩前据此再确认一次 */
  compactWanted: boolean
}

const sessionFile = (sessionId: string): string => join(dataDir(), 'sessions', `${sessionId}.json`)

export function loadSession(sessionId: string): CodexSession {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')) as Partial<CodexSession>
    return {
      state: parseState(raw.state),
      rolloutOffset: typeof raw.rolloutOffset === 'number' ? raw.rolloutOffset : 0,
      ledgerPending: raw.ledgerPending === true,
      compactRequestedAt: typeof raw.compactRequestedAt === 'number' ? raw.compactRequestedAt : undefined,
      compactWanted: raw.compactWanted === true,
    }
  } catch {
    return { state: INITIAL_SESSION_STATE, rolloutOffset: 0, ledgerPending: false, compactWanted: false }
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
