// 会话开始时记下的原生压缩线，用于成本估算的对比。插件不调整它。

export type NativeSetup = {
  /** 原生压缩线的设定值（窗口，或用户自己设置的 CLAUDE_CODE_AUTO_COMPACT_WINDOW） */
  originalSetting: number
}

export function parseNative(raw: unknown): NativeSetup | null {
  if (!raw || typeof raw !== 'object') return null
  const native = raw as Partial<NativeSetup>
  if (typeof native.originalSetting !== 'number' || !Number.isFinite(native.originalSetting)) return null
  return { originalSetting: native.originalSetting }
}
