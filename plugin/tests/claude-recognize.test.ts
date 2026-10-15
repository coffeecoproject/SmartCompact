import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_LEDGER } from '../src/core/ledger.ts'
import { recognize, taskCompleted, taskCreated, type ToolOutcome } from '../src/claude/recognize.ts'
import { staleRecordKeys } from '../src/claude/record.ts'

const bash = (command: string, isError = false, text = ''): ToolOutcome => ({ tool: 'Bash', input: { command }, isError, text })
const kinds = (outcome: ToolOutcome) => recognize(outcome, EMPTY_LEDGER).signals.map(signal => JSON.stringify(signal))

describe('提交', () => {
  test('看命令结果确认提交成功', () => {
    const result = recognize(bash('git commit -m "feat: login"', false, '[main 1a2b3c4] feat: login\n 1 file changed'), EMPTY_LEDGER)
    expect(result.signals).toContainEqual({ kind: 'commit' })
    expect(result.ledger.facts.lastCommit).toEqual({ summary: '[main 1a2b3c4] feat: login' })
  })

  test('没有那一行输出也算，记下命令；各种写法都认', () => {
    const quiet = "git add src/a.ts && git commit -q -F - <<'EOF'\nfeat: login\nEOF\ngit log --oneline -1"
    const result = recognize(bash(quiet, false, '1a2b3c4 feat: login'), EMPTY_LEDGER)
    expect(result.signals).toContainEqual({ kind: 'commit' })
    expect(result.ledger.facts.lastCommit).toEqual({ summary: quiet })
    expect(kinds(bash('cd app && git -C repo commit -qm x'))).toContain(JSON.stringify({ kind: 'commit' }))
    expect(kinds(bash('pnpm test 2>&1 | grep fail; git add a.ts && git commit -qm x'))).toContain(JSON.stringify({ kind: 'commit' }))
  })

  test('只是提到提交、命令报错或演练的，不算', () => {
    expect(kinds(bash('echo "git commit"', false, 'git commit'))).not.toContain(JSON.stringify({ kind: 'commit' }))
    expect(kinds(bash('git commit --dry-run', false, '[main 1a2b3c4] x'))).not.toContain(JSON.stringify({ kind: 'commit' }))
    expect(kinds(bash('git commit -m x', true, 'nothing to commit'))).not.toContain(JSON.stringify({ kind: 'commit' }))
  })
})

describe('测试与构建', () => {
  test('按命令结果区分通过和失败', () => {
    expect(recognize(bash('npm test'), EMPTY_LEDGER).signals).toContainEqual({ kind: 'tests', passed: true })
    expect(recognize(bash('pytest -q', true), EMPTY_LEDGER).signals).toContainEqual({ kind: 'tests', passed: false })
    expect(recognize(bash('pnpm run build', true), EMPTY_LEDGER).signals).toContainEqual({ kind: 'build', passed: false })
    expect(recognize(bash('node --test test/'), EMPTY_LEDGER).signals).toContainEqual({ kind: 'tests', passed: true })
  })

  test('包管理器命令带参数或子脚本也算测试', () => {
    for (const command of ['corepack pnpm --filter @app/core test', 'pnpm -C packages/core test:unit', 'cd app && npm run test -- --watch=false', 'yarn workspace web test; echo done']) {
      expect(recognize(bash(command), EMPTY_LEDGER).signals).toContainEqual({ kind: 'tests', passed: true })
    }
    for (const command of ['pnpm add -D test-utils', 'npm run testing']) {
      expect(kinds(bash(command))).not.toContain(JSON.stringify({ kind: 'tests', passed: true }))
    }
  })

  test('吞掉退出码的写法不当作结果', () => {
    const signals = recognize(bash('npm test || true'), EMPTY_LEDGER).signals
    expect(signals).toEqual([{ kind: 'tool-result', isError: false }])
  })

  test('接管道又没开 pipefail 时不当作结果，开了才算', () => {
    expect(recognize(bash('pnpm --filter core test 2>&1 | tail -20'), EMPTY_LEDGER).signals).toEqual([{ kind: 'tool-result', isError: false }])
    expect(recognize(bash('tsc --noEmit | head'), EMPTY_LEDGER).signals).toEqual([{ kind: 'tool-result', isError: false }])
    expect(recognize(bash('set -o pipefail; pnpm test | tail -5', true), EMPTY_LEDGER).signals).toContainEqual({ kind: 'tests', passed: false })
  })

  test('测试结果记进笔记', () => {
    expect(recognize(bash('go test ./...', true), EMPTY_LEDGER).ledger.facts.lastTest).toEqual({ command: 'go test ./...', passed: false })
  })
})

describe('文件与任务', () => {
  test('成功的编辑记下文件，失败的不记', () => {
    const edit = (isError: boolean): ToolOutcome => ({ tool: 'Edit', input: { file_path: 'src/a.ts' }, isError, text: '' })
    expect(recognize(edit(false), EMPTY_LEDGER).ledger.facts.filesChanged).toEqual(['src/a.ts'])
    expect(recognize(edit(true), EMPTY_LEDGER).ledger.facts.filesChanged).toEqual([])
  })

  test('每次工具调用都带一个成功或失败信号', () => {
    expect(recognize({ tool: 'Read', input: {}, isError: true, text: '' }, EMPTY_LEDGER).signals).toEqual([{ kind: 'tool-result', isError: true }])
  })

  test('TodoWrite 的进行中任务和 TaskCreated / TaskCompleted 更新进行中列表', () => {
    const todos = { todos: [{ content: '写测试', status: 'in_progress' }, { content: '发布', status: 'pending' }] }
    expect(recognize({ tool: 'TodoWrite', input: todos, isError: false, text: '' }, EMPTY_LEDGER).ledger.facts.tasksInProgress).toEqual(['写测试'])
    const created = taskCreated(taskCreated(EMPTY_LEDGER, 'A'), 'B')
    expect(taskCompleted(created, 'A').facts.tasksInProgress).toEqual(['B'])
  })
})

describe('会话记录', () => {
  test('超出上限时按最近更新时间保留', () => {
    const records = [{ key: 'a', updatedAt: 1 }, { key: 'b', updatedAt: 3 }, { key: 'c', updatedAt: 2 }]
    expect(staleRecordKeys(records, 2)).toEqual(['a'])
    expect(staleRecordKeys(records, 5)).toEqual([])
  })
})

describe('读文件', () => {
  test('Read 成功时记下路径，失败不记', () => {
    expect(recognize({ tool: 'Read', input: { file_path: 'src/a.ts' }, isError: false, text: '' }, EMPTY_LEDGER).read).toBe('src/a.ts')
    expect(recognize({ tool: 'Read', input: { file_path: 'src/a.ts' }, isError: true, text: '' }, EMPTY_LEDGER).read).toBeUndefined()
    expect(recognize(bash('cat src/a.ts'), EMPTY_LEDGER).read).toBeUndefined()
  })
})
