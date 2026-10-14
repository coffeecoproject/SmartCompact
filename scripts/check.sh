#!/bin/sh
# 本地检查：插件结构校验、core 依赖边界、自动测试。
set -eu
cd "$(dirname "$0")/.."

# core 不引用平台代码，也不碰 $，保证以后接其他 agent 时可以整体拿出来。
bad=$(grep -nE "from +'[^.]|from +'\.\./|\\\$\." plugin/src/core/*.ts || true)
if [ -n "$bad" ]; then
  echo "core 依赖边界被破坏："
  echo "$bad"
  exit 1
fi
echo "core 依赖边界：通过"

# Codex 适配由 Node 直接运行 TypeScript（只去掉类型），用到不支持的写法时这里会失败。
for module in adapters/codex/*.ts; do
  node -e "import('./$module')" </dev/null >/dev/null || { echo "无法加载：$module"; exit 1; }
done
echo "Codex 适配模块加载：通过"

claude plugin validate ./plugin
claude plugin test ./plugin
