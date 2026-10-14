// 成本估算：把实际上下文和"没有插件时会是多大"逐次对比，并扣掉压缩本身的开销。
// 单位都是"缓存读取 token"：每次调用的成本 ≈ 当时的上下文大小。

/** 压缩摘要的输出价、压缩后新前缀的缓存写入价，各相当于缓存读取价的多少倍。 */
export type Prices = { outputOverCacheRead: number; cacheWriteOverCacheRead: number }

// Anthropic：缓存读取 0.1、1 小时缓存写入 2、输出 5（以输入价为 1）。
const ANTHROPIC: Prices = Object.freeze({ outputOverCacheRead: 50, cacheWriteOverCacheRead: 20 })
// OpenAI：缓存读取 0.1、写入不加价 1、输出 8。
const OPENAI: Prices = Object.freeze({ outputOverCacheRead: 80, cacheWriteOverCacheRead: 10 })

/**
 * 按模型选价格比例，传入供应商名和模型名（例如 "github-copilot gpt-5"）。
 * 不认识的按 Anthropic 算，压缩开销估得偏高、结论偏保守。
 */
export function pricesFor(model: string): Prices {
  return /openai|codex|gpt|\bo[134]\b/i.test(model) ? OPENAI : ANTHROPIC
}

export type UsageTally = {
  /** 计入的读数次数 */
  samples: number
  /** 实际上下文之和 */
  sumTokens: number
  /** 没有插件时上下文之和 */
  sumBaseline: number
  /** 本插件压缩累计腾出的空间：没有插件时的上下文 = 实际 + freed */
  freed: number
  /** 压缩本身的开销之和 */
  overhead: number
  lastTokens?: number
  /** 刚压缩完、还没读到压缩后大小时，记下压缩前大小和摘要长度 */
  pending?: { before: number; summary: number }
}

export const EMPTY_TALLY: UsageTally = Object.freeze({ samples: 0, sumTokens: 0, sumBaseline: 0, freed: 0, overhead: 0 })

export function recordCompaction(tally: UsageTally, before: number, summary: number): UsageTally {
  return { ...tally, pending: { before, summary } }
}

/**
 * 记一次用量读数。同一次调用可能读到多次（并行的工具调用），和上一次相同的读数不重复计入。
 * @param ceiling 原生压缩点：没有插件时上下文超过它，原生也会压缩
 */
export function recordSample(tally: UsageTally, tokens: number, ceiling: number, prices: Prices): UsageTally {
  if (tokens === tally.lastTokens) return tally
  let { freed, overhead } = tally
  if (tally.pending) {
    const { before, summary } = tally.pending
    freed += Math.max(0, before - tokens)
    overhead += before + prices.outputOverCacheRead * summary + prices.cacheWriteOverCacheRead * tokens
  }
  // 没有插件时，涨过原生压缩点也会被压缩，之后两边大小相近。
  if (tokens + freed > ceiling) freed = 0
  return {
    samples: tally.samples + 1,
    sumTokens: tally.sumTokens + tokens,
    sumBaseline: tally.sumBaseline + tokens + freed,
    freed,
    overhead,
    lastTokens: tokens,
  }
}

/** 估算节省的比例：1 − (实际 + 压缩开销) / 没有插件时。没有读数时为 undefined。 */
export function savingsRatio(tally: UsageTally): number | undefined {
  if (tally.sumBaseline <= 0) return undefined
  return 1 - (tally.sumTokens + tally.overhead) / tally.sumBaseline
}
