// 移除旧版安装方式留下的 hook：node scripts/codex.ts uninstall
// 0.1.2 之前，Codex 通过本脚本把 hook 写进 $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）里带标记的一段；
// 现在改为 Codex 插件（codex plugin add smartcompact@smartcompact），旧的这段要删掉，否则 hook 会运行两遍。
// 只删标记段，改之前备份原文件。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexHome } from '../adapters/codex/store.ts'

const BEGIN = '# >>> SmartCompact（由 scripts/codex.ts 管理，卸载：node scripts/codex.ts uninstall）'
const END = '# <<< SmartCompact'

/** 去掉已有的标记段（连同它前面的空行）。 */
const withoutBlock = (text: string): string =>
  text.replace(new RegExp(`\\n*${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`), '\n')

function main(action: string | undefined): void {
  if (action !== 'uninstall') {
    console.log('用法：node scripts/codex.ts uninstall\n安装请用 Codex 插件：codex plugin marketplace add coffeecoproject/SmartCompact && codex plugin add smartcompact@smartcompact')
    process.exitCode = 1
    return
  }
  const file = join(codexHome(), 'config.toml')
  const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!original.includes(BEGIN)) {
    console.log(`${file} 里没有旧版 SmartCompact 的 hook，无需处理。`)
    return
  }
  copyFileSync(file, `${file}.smartcompact-backup`)
  writeFileSync(file, `${withoutBlock(original).trimEnd()}\n`)
  console.log(`已从 ${file} 移除旧版 SmartCompact 的 hook（原文件备份为 config.toml.smartcompact-backup）。`)
}

main(process.argv[2])
