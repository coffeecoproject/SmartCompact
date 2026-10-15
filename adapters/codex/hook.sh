#!/bin/sh
# Codex 插件的 hook 入口：node hook.ts <事件>。
# 插件会被复制到 Codex 的缓存目录，没法写死 Node 的路径；这里找一个能直接运行 TypeScript 的 Node（22.18 及以上）。
# 依次试 SMARTCOMPACT_NODE、PATH 里的 node、nvm 装的各个版本（从新到旧）、Homebrew。都不行就什么都不做、退出码 0，不影响 Codex。
dir=$(cd "$(dirname "$0")" && pwd)
ok='const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
for node in "$SMARTCOMPACT_NODE" "$(command -v node 2>/dev/null)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV) /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$node" ] && [ -x "$node" ] || continue
  if "$node" -e "$ok" 2>/dev/null; then
    exec "$node" "$dir/hook.ts" "$@"
  fi
done
exit 0
