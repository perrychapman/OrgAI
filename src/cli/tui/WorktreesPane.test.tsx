import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { WorktreesPane } from './WorktreesPane'
import { ESC_RE, Providers, char, env, key, press, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { TuiEnv, WorktreeRow, WorktreesPaneProps } from './types'

const wt = (agentId: string, over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  agentId,
  runId: 'r1',
  label: agentId,
  branch: `worktree-agent-${agentId}`,
  status: 'active',
  changedFiles: 3,
  mergeTarget: 'main',
  ...over
})

const ROWS = [
  wt('a1'),
  wt('a2', { status: 'conflict', changedFiles: 1, mergeTarget: 'parent' }),
  wt('a3', { status: 'merged' }),
  wt('a4', { status: 'waiting-children' })
]

function mount(props: Partial<WorktreesPaneProps> = {}, e: TuiEnv = env()) {
  const bus = new InputBus()
  let current: WorktreesPaneProps = { width: 80, height: 8, focused: false, rows: ROWS, ...props }
  const tree = (p: WorktreesPaneProps) => (
    <Providers env={e} bus={bus}>
      <WorktreesPane {...p} />
    </Providers>
  )
  const out = render(tree(current))
  const rerender = (p: Partial<WorktreesPaneProps>): void => {
    current = { ...current, ...p }
    out.rerender(tree(current))
  }
  return { ...out, bus, rerender }
}

const lines = (f: string | undefined): string[] => (f ?? '').split('\n')

describe('WorktreesPane', () => {
  it('shows branch, agent, status words, file counts and merge targets', () => {
    const t = mount()
    const out = lines(t.lastFrame())
    expect(out[0]).toContain('Worktrees (4)')
    const a2 = out.find((l) => l.includes('worktree-agent-a2'))!
    expect(a2).toContain('conflict')
    expect(a2.trimEnd().endsWith('1 file → parent')).toBe(true)
    expect(out.find((l) => l.includes('worktree-agent-a1'))!.trimEnd().endsWith('3 files → main')).toBe(true)
    expect(out.find((l) => l.includes('a3'))).toContain('merged')
    expect(out.find((l) => l.includes('a4'))).toContain('waiting for reports')
    t.unmount()
  })

  it('shows the empty state', () => {
    const t = mount({ rows: [] })
    expect(t.lastFrame()).toContain('No agent worktrees')
    t.unmount()
  })

  it('selects with Up/Down and opens the diff with v or Enter, only while focused', () => {
    const onViewDiff = vi.fn()
    const t = mount({ onViewDiff })
    expect(press(t.bus, 'worktrees', char('v'))).toEqual([false])
    t.rerender({ focused: true })
    press(t.bus, 'worktrees', key('down'), char('v'))
    expect(onViewDiff).toHaveBeenLastCalledWith(ROWS[1])
    press(t.bus, 'worktrees', key('end'), key('enter'))
    expect(onViewDiff).toHaveBeenLastCalledWith(ROWS[3])
    press(t.bus, 'worktrees', key('up'), key('enter'))
    expect(onViewDiff).toHaveBeenLastCalledWith(ROWS[2])
    t.rerender({})
    expect(lines(t.lastFrame()).find((l) => l.includes('a3'))!.startsWith('>')).toBe(true)
    expect(press(t.bus, 'worktrees', char('x'))).toEqual([false])
    t.unmount()
  })

  it('cuts to the width, ASCII arrows and no colour when asked, plain words for a screen reader', async () => {
    const t = mount({ rows: [wt('w', { branch: 'ブランチ'.repeat(10), label: '名前' })], width: 30 })
    for (const l of lines(t.lastFrame())) expect(textWidth(l)).toBeLessThanOrEqual(30)
    t.unmount()
    await withInkColor(() => {
      const c = mount({}, env())
      expect(c.lastFrame()).toMatch(ESC_RE)
      c.unmount()
      const plain = mount({}, env({ unicode: false, color: false }))
      expect(plain.lastFrame()).not.toMatch(ESC_RE)
      expect(plain.lastFrame()).toContain('3 files -> main')
      plain.unmount()
    })
    const sr = mount({}, env({ screenReader: true }))
    expect(sr.lastFrame()).toContain('3 files into main')
    sr.unmount()
  })

  it('survives width or height 0 and 1', () => {
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [0, 3],
      [3, 0]
    ]) {
      const t = mount({ width, height, focused: true })
      press(t.bus, 'worktrees', key('down'), key('enter'))
      t.unmount()
    }
  })
})
