// 会话开始时记下的原生压缩线。三条线每次按当前参数现算，参数改了立即生效；暂停时据此恢复原值。

export type NativeSetup = {
  /** 插件调整之前的压缩线设定值 */
  originalSetting: number
  /** 插件调整之前 CLAUDE_CODE_AUTO_COMPACT_WINDOW 的值，没设置时为 null */
  originalEnv: string | null
}

export function parseNative(raw: unknown): NativeSetup | null {
  if (!raw || typeof raw !== 'object') return null
  const native = raw as Partial<NativeSetup>
  if (typeof native.originalSetting !== 'number' || !Number.isFinite(native.originalSetting)) return null
  if (native.originalEnv !== null && typeof native.originalEnv !== 'string') return null
  return native as NativeSetup
}
