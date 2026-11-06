import { describe, expect, it } from 'vitest'
import { summary } from '../testing/fakeContext'
import { textWidth } from './panes/text'
import { runPickLines, runPickRows } from './runPick'
import { cleanLine } from './slashCommands'
import { helpKeyLines, KEYMAP, paneHint, statusHint } from './keymap'
import { waitingWords, worktreeChipWords } from './selectors'
import { usageText } from './usageText'
import type { TuiState } from './types'
import { applyRecord, createInitialState, setActiveRun } from './state'
import { project, record } from '../testing/fakeContext'

describe('runPickLines (L2)', () => {
  const rows = (title: string) => runPickRows([summary('run1', { status: 'finished', startedAt: 1, title })])

  it('cuts CJK and emoji titles by columns, never past the width', () => {
    for (const title of ['日本語のタイトルがとても長いです日本語のタイトル', '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀']) {
      for (const width of [20, 31, 40]) {
        const [line] = runPickLines(rows(title), 0, width)
        expect(textWidth(line)).toBeLessThanOrEqual(width)
        expect(line.endsWith('…')).toBe(true)
      }
    }
  })

  it('uses the ASCII ellipsis when asked and leaves a short line alone', () => {
    const [cut] = runPickLines(rows('a long title that does not fit in the width'), 0, 30, undefined, '...')
    expect(cut.endsWith('...')).toBe(true)
    expect(textWidth(cut)).toBeLessThanOrEqual(30)
    const [short] = runPickLines(rows('Short'), 0, 80)
    expect(short).toContain('Short')
    expect(short).not.toContain('…')
  })
})

describe('cleanLine (L3)', () => {
  it('never splits a surrogate pair when it cuts', () => {
    const out = cleanLine('🚀'.repeat(10), 5)
    expect(out).toBe('🚀🚀🚀🚀…')
    expect([...out].every((c) => c.length === 1 || c.codePointAt(0)! > 0xffff)).toBe(true)
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('leaves a text of exactly max code points whole', () => {
    expect(cleanLine('🚀'.repeat(5), 5)).toBe('🚀🚀🚀🚀🚀')
  })
})

describe('chip words (M2)', () => {
  it('reads decisions and files in words with singular forms', () => {
    expect(waitingWords(1)).toBe('1 decision open')
    expect(waitingWords(3)).toBe('3 decisions open')
    expect(worktreeChipWords('1f')).toBe('1 file changed')
    expect(worktreeChipWords('12f')).toBe('12 files changed')
    expect(worktreeChipWords('conflict')).toBe('conflict')
  })
})

describe('hints (L6)', () => {
  it('paneHint and statusHint take a separator', () => {
    expect(paneHint('tree', 'agent', 5, undefined, ' | ')).not.toContain('·')
    expect(paneHint('tree', 'agent', 5, undefined, ' | ')).toContain(' | ')
    const env = { unicode: false, screenReader: false, dumbTerminal: false }
    expect(statusHint('composer', { readOnly: false, stopOnQuit: false, env })).not.toContain('·')
    expect(statusHint('composer', { readOnly: false, stopOnQuit: false })).toContain('·')
  })

  it('the global m line names the panes it works in', () => {
    const m = KEYMAP.find((k) => k.scope === 'global' && k.keys === 'm')!
    expect(m.label).toContain('In the tree, transcript, plan or worktrees')
    expect(helpKeyLines().join('\n')).toContain('In the tree, transcript, plan or worktrees')
  })
})

describe('usageText table width (M3)', () => {
  it('aligns columns by terminal width for CJK and emoji names', () => {
    let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }) }
    const agent = (id: string, name: string) => ({ id, roleId: null, roleSlug: id, name, parentId: id === 'root' ? null : 'root', spawnToolUseId: null, state: 'done', activity: '', inputTokens: 10, outputTokens: 5, costUsd: 0.01, startedAt: 1 })
    const agents = { root: agent('root', 'Orchestrator'), a: agent('a', '日本語'), b: agent('b', '🚀🚀') }
    s = applyRecord(s, { ...record(summary('run1', { status: 'finished' })), agents: agents as never })
    s = setActiveRun(s, 'run1')
    const lines = usageText(s).split('\n')
    const at = lines.findIndex((l) => l.trim() === 'By agent')
    const table = lines.slice(at + 1, at + 5).filter((l) => l.trim())
    // Every row ends at the same column, so the right-aligned last column lines up by terminal width.
    const widths = new Set(table.map((l) => textWidth(l)))
    expect(widths.size).toBe(1)
  })
})
