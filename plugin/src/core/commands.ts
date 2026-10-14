// shell 命令结果的识别：提交、测试、构建。各平台的 shell 工具名不同，但命令和输出的规则相同。

import { type Ledger, recordBuild, recordCommit, recordTest } from './ledger.ts'
import type { Signal } from './signals.ts'

// 吞掉退出码的写法（`npm test || true`）看不出真实结果，不当作测试或构建结果。
const SWALLOWS_EXIT = /\|\|\s*(true|:)\b|;\s*(true|exit\s+0)\s*$/
// 接了管道（`npm test | tail`）又没开 pipefail 时，退出码是最后一个命令的，同样看不出真实结果。
const PIPE = /(^|[^|])\|(?!\|)/
const PIPEFAIL = /\bpipefail\b/

// 真的在执行 git commit：一段命令以它开头（不是 `echo "git commit"` 这类只是提到它的）。
// 不再核对提交是否真的成功：插件只在一轮结束、且超过允许压缩线时才压缩，误认一次失败的提交代价很小，
// 而核对规则（看输出、看退出码）会漏掉模型的各种写法（`-q`、提交后接 `git log`、前面连着接管道的测试）。
const COMMIT = /(^|&&|;|\n)\s*git(\s+-[Cc]\s+\S+)*\s+commit\b/
// git commit 正常输出 "[分支 短哈希] 提交说明"，有就记进笔记，没有就记命令
const COMMIT_OUTPUT = /^\[[^\]\n]+ [0-9a-f]{7,40}\][^\n]*/m

const TEST =
  /\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\s(run\s+)?test(:[\w:-]+)?(?=[\s;&|)]|$)|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bmvn\b.*\btest\b|\bgradlew?\b.*\btest\b|\bdotnet\s+test\b|\bswift\s+test\b|\bxcodebuild\b.*\btest\b|\bphpunit\b|\brspec\b|\bclaude\s+plugin\s+test\b|\bnode\s+--test\b/

const BUILD =
  /\btsc\b|\b(npm|pnpm|yarn|bun)\s+run\s+(build|typecheck|check)\b|\bcargo\s+(build|check)\b|\bgo\s+(build|vet)\b|\bxcodebuild\b|\bmake\b|\bgradlew?\b.*\b(build|assemble)\b/

/**
 * @param isError 命令是否以非零退出码结束
 * @param output 命令输出
 */
export function classifyCommand(command: string, isError: boolean, output: string, ledger: Ledger): { signals: Signal[]; ledger: Ledger } {
  const signals: Signal[] = []
  let next = ledger
  if (COMMIT.test(command) && !isError && !/--dry-run\b/.test(command)) {
    signals.push({ kind: 'commit' })
    next = recordCommit(next, COMMIT_OUTPUT.exec(output)?.[0] ?? command.slice(0, 200))
  }
  if (!SWALLOWS_EXIT.test(command) && !(PIPE.test(command) && !PIPEFAIL.test(command))) {
    const passed = !isError
    if (TEST.test(command)) {
      signals.push({ kind: 'tests', passed })
      next = recordTest(next, command.slice(0, 200), passed)
    } else if (BUILD.test(command)) {
      signals.push({ kind: 'build', passed })
      next = recordBuild(next, command.slice(0, 200), passed)
    }
  }
  return { signals, ledger: next }
}
