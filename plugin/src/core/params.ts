// 决策用到的全部参数。规则里不写死数字，试用后按数据校准，也可由用户配置覆盖。

export type Params = {
  /** 允许压缩线 L：一轮结束时超过它才考虑压缩 */
  allowLineTokens: number
  /** 轮中兜底线 M = L × graceFactor */
  graceFactor: number
  /** 一次压缩至少要腾出的空间，不够就不压，防止连续压缩 */
  minFreedTokens: number
  /** 还没实测到压缩后大小时，用这个估计值 */
  defaultAfterTokens: number
  /** 原生触发点 ≈ 压缩线设定值 − 这个值（实测约 33k） */
  nativeBufferTokens: number
  /** 用量读数可能落后于最新的工具结果，接近上限时留出的余量 */
  ceilingMarginTokens: number
  /** 连续报错多少次算硬信号 */
  errorStreakLimit: number
  /** 进度笔记的最大字符数 */
  ledgerMaxChars: number
  /** 用量到 L × 这个比例、笔记又没更新时，提醒模型记一下 */
  nudgeAtShare: number
}

export const DEFAULT_PARAMS: Params = Object.freeze({
  allowLineTokens: 200_000,
  graceFactor: 1.3,
  minFreedTokens: 60_000,
  defaultAfterTokens: 50_000,
  nativeBufferTokens: 33_000,
  ceilingMarginTokens: 50_000,
  errorStreakLimit: 3,
  ledgerMaxChars: 6_000,
  nudgeAtShare: 0.85,
})

const MINIMUMS: Record<keyof Params, number> = {
  allowLineTokens: 1,
  graceFactor: 1,
  minFreedTokens: 0,
  defaultAfterTokens: 0,
  nativeBufferTokens: 0,
  ceilingMarginTokens: 0,
  errorStreakLimit: 1,
  ledgerMaxChars: 200,
  nudgeAtShare: 0,
}

/** 用户覆盖的值逐项校验，不合法的项沿用默认值。 */
export function resolveParams(overrides: Readonly<Record<string, unknown>> = {}): Params {
  const resolved = { ...DEFAULT_PARAMS }
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof Params)[]) {
    const value = overrides[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= MINIMUMS[key]) resolved[key] = value
  }
  return resolved
}
