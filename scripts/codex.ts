// 在 Codex 配置里安装或卸载 SmartCompact 的 hook：node scripts/codex.ts install|uninstall
// 只改 $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）里带标记的一段，改之前备份原文件。
// 装好后第一次启动 Codex 时，按提示信任这几个 hook。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHome } from '../adapters/codex/store.ts'

const BEGIN = '# >>> SmartCompact（由 scripts/codex.ts 管理，卸载：node scripts/codex.ts uninstall）'
const END = '# <<< SmartCompact'
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'codex', 'hook.ts')

/** Stop 时判断并发起压缩；PostCompact 记账；压缩后在 SessionStart(compact) 或下一条消息补回进度笔记。 */
function block(): string {
  // 用当前 Node 的绝对路径：Codex 启动 hook 时不一定带着用户 shell 的 PATH。升级 Node 后重新安装一次。
  const command = (event: string) => JSON.stringify(`'${process.execPath}' '${HOOK}' ${event}`)
  return [
    BEGIN,
    '[[hooks.Stop]]', '[[hooks.Stop.hooks]]', 'type = "command"', `command = ${command('Stop')}`, '',
    '[[hooks.PostCompact]]', '[[hooks.PostCompact.hooks]]', 'type = "command"', `command = ${command('PostCompact')}`, '',
    '[[hooks.SessionStart]]', 'matcher = "compact"', '[[hooks.SessionStart.hooks]]', 'type = "command"', `command = ${command('SessionStart')}`, '',
    '[[hooks.UserPromptSubmit]]', '[[hooks.UserPromptSubmit.hooks]]', 'type = "command"', `command = ${command('UserPromptSubmit')}`,
    END,
  ].join('\n')
}

/** 去掉已有的标记段（连同它前面的空行）。 */
const withoutBlock = (text: string): string =>
  text.replace(new RegExp(`\\n*${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`), '\n')

function main(action: string | undefined): void {
  const file = join(codexHome(), 'config.toml')
  if (action !== 'install' && action !== 'uninstall') {
    console.log('用法：node scripts/codex.ts install|uninstall')
    process.exitCode = 1
    return
  }
  const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (action === 'uninstall' && !original.includes(BEGIN)) {
    console.log(`${file} 里没有 SmartCompact 的配置，无需卸载。`)
    return
  }
  const rest = withoutBlock(original).trimEnd()
  const next = action === 'install' ? `${rest ? `${rest}\n\n` : ''}${block()}\n` : `${rest}\n`
  mkdirSync(dirname(file), { recursive: true })
  if (original) copyFileSync(file, `${file}.smartcompact-backup`)
  writeFileSync(file, next)
  console.log(action === 'install'
    ? `已写入 ${file}（原文件备份为 config.toml.smartcompact-backup）。\n下次启动 Codex 时，按提示信任 SmartCompact 的 4 个 hook。`
    : `已从 ${file} 移除 SmartCompact 的 hook（原文件备份为 config.toml.smartcompact-backup）。`)
}

main(process.argv[2])
