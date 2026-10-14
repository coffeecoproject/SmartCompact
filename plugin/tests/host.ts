// 集成测试共用的宿主模拟：时钟、插件存储、会话 ID。测试环境里这些没有实现。

import type { On } from 'claude-code'

export function stubHost(on: On): Map<string, unknown> {
  const store = new Map<string, unknown>()
  on('clock.now', () => ({ value: 0 }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  return store
}
