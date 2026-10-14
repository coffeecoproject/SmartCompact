// 三条线：允许压缩线 L、轮中兜底线 M、上限 C（原生压缩点）。

import type { Params } from './params.ts'

export type Lines = {
  allow: number
  midTurn: number
  ceiling: number
  /** false 表示窗口本身放不下 L 和 M，插件不调整原生压缩线，只负责进度笔记 */
  adjustsNative: boolean
}

/** CLAUDE_CODE_AUTO_COMPACT_WINDOW 允许的最小值 */
export const MIN_NATIVE_SETTING = 100_000

/**
 * @param nativeSettingTokens 插件调整之前，原生压缩线的设定值（窗口或用户自己的配置）
 */
export function planLines(nativeSettingTokens: number, params: Params): Lines {
  const ceiling = nativeSettingTokens - params.nativeBufferTokens
  const allow = params.allowLineTokens
  // 原生压缩线设定值有下限，M 不会低于它对应的触发点，否则算出的 M 与原生实际行为不符。
  const midTurn = Math.max(Math.round(allow * params.graceFactor), MIN_NATIVE_SETTING - params.nativeBufferTokens)
  if (midTurn >= ceiling) return { allow, midTurn: ceiling, ceiling, adjustsNative: false }
  return { allow, midTurn, ceiling, adjustsNative: true }
}

/** 让原生自动压缩从 M 开始尝试，需要写入的压缩线设定值。 */
export function nativeSettingFor(lines: Lines, params: Params): number {
  return lines.midTurn + params.nativeBufferTokens
}
