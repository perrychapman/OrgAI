import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { OrgTreePane, clipMiddle, rowLine, treePrefixes } from './OrgTreePane'
import type { TeamMessageRow } from './collaboration'
import { ESC_RE, Providers, env, key, press, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { OrgTreeRow, OrgTreePaneProps, TuiEnv } from './types'

const row = (id: string, over: Partial<OrgTreeRow> = {}): OrgTreeRow => ({
  id,
  runId: 'r1',
  depth: 1,
  label: id,
  role: 'Developer',
  state: 'thinking',
  stateWord: 'Working',
  activity: `${id} is reading files`,
  costText: '$0.10',
  isRoot: false,
  ...over
})

const ROWS: OrgTreeRow[] = [
  row('root', { depth: 0, label: 'orchestrator', role: 'orchestrator', isRoot: true, costText: '$1.20' }),
  row('dev-1', { label: 'dev-1' }),
  row('dev-2', { label: 'dev-2', state: 'done', stateWord: 'Finished' }),
  row('old-1', { label: 'old-1', earlier: true, depth: 1, state: 'done', stateWord: 'Finished' })
]

type MotionProps = OrgTreePaneProps & { animated?: boolean; messages?: TeamMessageRow[]; compact?: boolean; teamSize?: number }

function mount(props: Partial<MotionProps> = {}, e: TuiEnv = env()) {
  const bus = new InputBus()
  const all: MotionProps = { width: 60, height: 20, focused: false, rows: ROWS, ...props }
  const r = render(
    <Providers env={e} bus={bus}>
      <OrgTreePane {...all} />
    </Providers>
  )
  const rerender = (p: Partial<MotionProps>): void =>
    r.rerender(
      <Providers env={e} bus={bus}>
        <OrgTreePane {...all} {...p} />
      </Providers>
    )
  return { ...r, bus, rerender }
}

const lines = (frame: string | undefined): string[] => (frame ?? '').split('\n')

it('gives sidebar agents separate name/status lines with breathing room', () => {
  const r = mount({ compact: true, teamSize: 2, width: 42, height: 12, rows: [
    row('root', { depth: 0, label: 'Orchestrator', activity: '', state: 'idle', stateWord: 'Idle' }),
    row('builder', { label: 'Implementer', activity: '', state: 'idle', stateWord: 'Available' })
  ] })
  const out = lines(r.lastFrame())
  const root = out.findIndex(line => line.includes('Orchestrator'))
  const builder = out.findIndex(line => line.includes('Implementer'))
  expect(out[root]).not.toContain('Idle')
  expect(out[root + 1]).toContain('Idle')
  expect(builder - root).toBe(3)
  expect(out[builder + 1]).toContain('Available')
  r.unmount()
})

it('keeps multiple decisions and conflicts visible in a compact unfocused roster', () => {
  const item = { kind: 'row' as const, prefix: '', row: row('builder', { waiting: 3, worktreeChip: 'conflict', state: 'waiting', stateWord: 'Needs you' }) }
  const text = rowLine(item, false, false, 42, env(), 0, false, false, true).map(seg => seg.text).join('')
  expect(text).toContain('! 3')
  expect(text).toContain('conflict')
})

describe('OrgTreePane chips in screen-reader mode (review M2)', () => {
  const chipRows = [
    row('root', { depth: 0, label: 'orchestrator', role: 'orchestrator', isRoot: true, waiting: 1, worktreeChip: '1f' }),
    row('dev-1', { label: 'dev-1', waiting: 3, worktreeChip: '2f' })
  ]

  it('reads the waiting and worktree chips as words', () => {
    const f = mount({ rows: chipRows, width: 100 }, env({ screenReader: true })).lastFrame() ?? ''
    expect(f).toContain('1 decision open')
    expect(f).toContain('1 file changed')
    expect(f).toContain('3 decisions open')
    expect(f).toContain('2 files changed')
    expect(f).not.toMatch(/! \d|\b\df\b/)
  })

  it('keeps the short chips without a screen reader', () => {
    const f = mount({ rows: chipRows, width: 100 }, env()).lastFrame() ?? ''
    expect(f).toContain('! 3')
    expect(f).toContain('2f')
  })
})

describe('OrgTreePane', () => {
  it('renders the title, one line per row with role, state word and cost, the selected activity once, and the earlier group', () => {
    const r = mount()
    const out = lines(r.lastFrame())
    expect(out[0]).toBe('Agents 4 • 2 working')
    const root = out.find((l) => l.includes('orchestrator'))!
    expect(root).toContain('root is reading files')
    expect(root).not.toContain('(orchestrator)')
    expect(root.trimEnd().endsWith('$1.20')).toBe(true)
    const dev = out.find((l) => l.includes('dev-1') && l.includes('(Developer)'))!
    expect(dev).toContain('├─')
    // Every working row carries its activity, with no duplicate selected-agent footer.
    expect(out.filter((l) => l.includes('is reading files'))).toHaveLength(2)
    expect(out.some((l) => l.includes('orchestrator: root is reading files'))).toBe(false)
    const rowAt = (id: string): number => out.findIndex((l) => l.includes(id))
    expect(rowAt('dev-2') - rowAt('dev-1')).toBe(1)
    expect(out.find((l) => l.includes('dev-2'))).toContain('└─')
    expect(out.find((l) => l.includes('dev-2'))).toContain('Finished')
    const header = out.findIndex((l) => l.includes('Earlier sessions'))
    expect(header).toBeGreaterThan(out.findIndex((l) => l.includes('dev-2')))
    expect(out.findIndex((l) => l.includes('old-1'))).toBeGreaterThan(header)
    r.unmount()
  })

  it('drops the footer line when the height does not allow it', () => {
    const r = mount({ height: 3 })
    const out = lines(r.lastFrame())
    expect(out.length).toBeLessThanOrEqual(3)
    expect(out.some((l) => l.includes('orchestrator:'))).toBe(false)
    r.unmount()
  })

  it('cuts every line to the width, counting wide characters as two columns', () => {
    const wide = [row('w', { depth: 0, label: '開発者エージェント長い名前', role: '開発者', costText: '$0.05' })]
    const r = mount({ rows: wide, width: 20 })
    for (const l of lines(r.lastFrame())) expect(textWidth(l)).toBeLessThanOrEqual(20)
    expect(r.lastFrame()).toContain('…')
    r.unmount()
  })

  it('moves the selection only while focused and keeps it visible in a short window', () => {
    const many = [row('root', { depth: 0, isRoot: true }), ...Array.from({ length: 30 }, (_, i) => row(`a${i}`))]
    const onSelect = vi.fn()
    const r = mount({ rows: many, height: 6, onSelect, focused: false })
    expect(press(r.bus, 'tree', key('down'))).toEqual([false])
    expect(onSelect).not.toHaveBeenCalled()
    r.rerender({ focused: true })
    press(r.bus, 'tree', key('down'), key('down'))
    expect(onSelect).toHaveBeenLastCalledWith('a1')
    press(r.bus, 'tree', key('end'))
    expect(onSelect).toHaveBeenLastCalledWith('a29')
    r.rerender({ focused: true })
    expect(r.lastFrame()).toContain('> ')
    expect(r.lastFrame()).toContain('a29')
    press(r.bus, 'tree', key('home'))
    expect(onSelect).toHaveBeenLastCalledWith('root')
    press(r.bus, 'tree', key('pagedown'))
    const last = onSelect.mock.calls[onSelect.mock.calls.length - 1][0] as string
    expect(last).not.toBe('root')
    // Not a navigation key: not consumed.
    expect(r.bus.dispatch({ type: 'key', name: 'char', ch: 'x', ctrl: false, alt: false, shift: false, raw: 'x' }, 'tree')).toBe(false)
    r.unmount()
  })

  it('uses ASCII glyphs and no colour codes without Unicode or colour, and plain words for a screen reader', async () => {
    await withInkColor(() => {
      const colored = mount({}, env())
      expect(colored.lastFrame()).toMatch(ESC_RE)
      colored.unmount()
      const plain = mount({}, env({ color: false, unicode: false }))
      expect(plain.lastFrame()).not.toMatch(ESC_RE)
      expect(plain.lastFrame()).toContain('|-')
      expect(plain.lastFrame()).toContain('`-')
      expect(plain.lastFrame()).not.toContain('├')
      plain.unmount()
      const sr = mount({}, env({ screenReader: true }))
      const out = sr.lastFrame() ?? ''
      expect(out).not.toMatch(/[├└●✓]/)
      expect(out).not.toContain('|-')
      expect(out).toContain('root is reading files')
      sr.unmount()
    })
  })

  it('shows an empty state and survives width or height 0 and 1', () => {
    const r = mount({ rows: [] })
    expect(r.lastFrame()).toContain('No agents yet')
    r.unmount()
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [0, 5],
      [5, 0],
      [1, 3]
    ]) {
      const t = mount({ width, height, focused: true })
      press(t.bus, 'tree', key('down'), key('end'))
      t.unmount()
    }
  })

  it('cuts a narrow row role first, then the handle in the middle (its end stays); the state word stays whole', () => {
    const long = row('mock-lead-report-2', { role: 'Reporter', label: 'mock-lead-report-2', state: 'waiting', stateWord: 'Needs you', activity: '' })
    const wide = lines(mount({ rows: [long], width: 60 }).lastFrame())
    expect(wide[1]).toContain('(Reporter)')
    const mid = lines(mount({ rows: [long], width: 45 }).lastFrame())[1]
    expect(mid).not.toContain('(Reporter)')
    expect(mid).toContain('mock-lead-report-2')
    const narrow = lines(mount({ rows: [long], width: 34 }).lastFrame())[1]
    expect(narrow).toContain('Needs you')
    expect(narrow).toMatch(/mock.*…ort-2/)
    expect(textWidth(narrow)).toBeLessThanOrEqual(34)
    expect(clipMiddle('mock-lead-report-1', 14, '…')).toBe('mock-lea…ort-1')
    expect(clipMiddle('short', 14, '…')).toBe('short')
  })

  it('drops a role that the label already carries (roleShown false)', () => {
    const r = mount({ rows: [row('implementer-1', { depth: 0, role: 'Implementer', roleShown: false })] })
    expect(lines(r.lastFrame())[1]).not.toContain('(Implementer)')
    r.unmount()
  })

  it('shows chips and the group row with its expander, cost and failed count', () => {
    const rows = [
      row('root', { depth: 0, isRoot: true }),
      row('w', { waiting: 2, worktreeChip: '3f', stateWord: 'Needs you', state: 'waiting' }),
      row('group:r1:root', { kind: 'group', label: '2 done', role: '', stateWord: '(1 failed)', state: 'done', count: 2, groupKey: 'root', members: ['a', 'b'], costText: '$0.08', activity: 'a, b' })
    ]
    const out = lines(mount({ rows }).lastFrame())
    expect(out.find((l) => l.includes('Needs you'))).toMatch(/! 2 3f/)
    const g = out.find((l) => l.includes('2 done'))!
    expect(g).toContain('(1 failed)')
    expect(g.trimEnd()).toMatch(/\$0\.08 >$/)
    expect(out[0]).toBe('Agents 4 • 1 working • ! 2')
  })

  it('caps the indent at four levels and counts the rest', () => {
    const deep = Array.from({ length: 7 }, (_, d) => row(`a${d}`, { depth: d }))
    const p = treePrefixes(deep, env())
    expect(p[4]).toBe('      └─ ')
    expect(p[5]).toBe('      +1 └─ ')
    expect(p[6]).toBe('      +2 └─ ')
    expect(treePrefixes(deep, env({ screenReader: true }))[6]).toBe('        +2 ')
  })

  it('keys: Right / Enter expand a group, Left collapses, h toggles the fold, Enter on a waiting row asks for its card', () => {
    const rows = [
      row('root', { depth: 0, isRoot: true, activity: '' }),
      row('w', { waiting: 1, state: 'waiting', stateWord: 'Needs you' }),
      row('group:r1:root', { kind: 'group', label: '1 done', role: '', stateWord: '', state: 'done', count: 1, groupKey: 'root', members: ['x'] })
    ]
    const h = { onExpand: vi.fn(), onCollapse: vi.fn(), onToggleFold: vi.fn(), onFocusCard: vi.fn(), onActivate: vi.fn(), onNotice: vi.fn(), onSelect: vi.fn() }
    const r = mount({ rows, focused: true, ...h })
    // The first row that needs you is selected when nothing was chosen.
    press(r.bus, 'tree', key('enter'))
    expect(h.onFocusCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }))
    press(r.bus, 'tree', key('down'), key('right'))
    expect(h.onExpand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'group' }))
    press(r.bus, 'tree', key('enter'))
    expect(h.onExpand).toHaveBeenCalledTimes(2)
    press(r.bus, 'tree', key('up'), key('left'))
    expect(h.onCollapse).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }))
    press(r.bus, 'tree', key('up'), key('enter'))
    expect(h.onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'root' }))
    press(r.bus, 'tree', { type: 'key', name: 'char', ch: 'h', ctrl: false, alt: false, shift: false, raw: 'h' })
    expect(h.onToggleFold).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('n and N walk the agents that need you, wrapping; none says so', () => {
    const rows = [
      row('root', { depth: 0, isRoot: true }),
      row('a', { waiting: 1 }),
      row('b'),
      row('c', { waiting: 1 })
    ]
    const ch = (c: string) => ({ type: 'key', name: 'char', ch: c, ctrl: false, alt: false, shift: c === 'N', raw: c }) as const
    const onSelect = vi.fn()
    const r = mount({ rows, focused: true, onSelect })
    // Selected: a (first waiting). n -> c, n -> a (wraps), N -> c (wraps back).
    press(r.bus, 'tree', ch('n'))
    expect(onSelect).toHaveBeenLastCalledWith('c')
    press(r.bus, 'tree', ch('n'))
    expect(onSelect).toHaveBeenLastCalledWith('a')
    press(r.bus, 'tree', ch('N'))
    expect(onSelect).toHaveBeenLastCalledWith('c')
    r.unmount()
    const onNotice = vi.fn()
    const calm = mount({ rows: [row('root', { depth: 0 })], focused: true, onNotice })
    press(calm.bus, 'tree', ch('n'))
    expect(onNotice).toHaveBeenCalledWith('Nothing needs you.')
    calm.unmount()
  })

  it('shows the plan chip and how many waiting agents are scrolled out of view', () => {
    const many = [row('root', { depth: 0 }), ...Array.from({ length: 12 }, (_, i) => row(`a${i}`)), row('z', { waiting: 1, state: 'waiting' })]
    const r = mount({ rows: many, height: 5, width: 70, planChip: 'Plan 2/5', selectedId: 'root' })
    const title = lines(r.lastFrame())[0]
    expect(title).toContain('Plan 2/5')
    expect(title).toContain('! 1 off screen')
    r.unmount()
  })

  it('marks the last sibling with the last-branch glyph', () => {
    const prefixes = treePrefixes(
      [row('a', { depth: 0 }), row('b', { depth: 1 }), row('c', { depth: 2 }), row('d', { depth: 1 })],
      env()
    )
    expect(prefixes).toEqual(['', '├─ ', '  └─ ', '└─ '])
  })

  it('uses a spinner and shimmer only for current agents doing active work', async () => {
    await withInkColor(async () => {
      const live = row('live', { state: 'thinking', stateWord: 'Working' })
      const old = row('old', { earlier: true, state: 'thinking', stateWord: 'Working' })
      const waiting = row('waiting', { state: 'waiting', stateWord: 'Waiting' })
      const r = mount({ rows: [live, old, waiting] }, env())
      const before = r.lastFrame() ?? ''
      expect(before).toContain('⠋')
      expect(before).toContain('●')
      expect(before).toContain('!')
      r.rerender({ animated: false })
      const still = r.lastFrame() ?? ''
      expect(still).toContain('●')
      expect(still).not.toContain('⠋')
      r.unmount()
    })
  })

  it('shimmers only the live activity, not the static agent label', () => {
    const active = row('active', { depth: 0, state: 'thinking', stateWord: 'Working', activity: 'Reading files' })
    const item = { kind: 'row' as const, row: active, prefix: '' }
    const live = rowLine(item, false, false, 60, env(), 0, true)
    const shimmer = (segment: unknown): boolean => Boolean((segment as { shimmer?: boolean }).shimmer)
    expect(shimmer(live.find((segment) => segment.text === 'Reading files'))).toBe(true)
    expect(shimmer(live.find((segment) => segment.text === 'active'))).toBe(false)

    const idle = rowLine({ ...item, row: { ...active, state: 'idle', stateWord: 'Idle' } }, false, false, 60, env(), 0, true)
    expect(shimmer(idle.find((segment) => segment.text === 'Idle'))).toBe(false)

    const tool = rowLine({ ...item, row: { ...active, state: 'tool', stateWord: 'Using a tool' } }, false, false, 60, env(), 0, true)
    expect(shimmer(tool.find((segment) => segment.text === 'Reading files'))).toBe(true)
  })

  it('keeps active row bodies and labels within narrow widths', () => {
    const r = mount({ width: 12, height: 8, rows: [row('active', { depth: 0, label: 'long-agent-name', activity: 'reading a lot', state: 'tool' })] }, env({ color: false }))
    for (const line of lines(r.lastFrame())) expect(textWidth(line)).toBeLessThanOrEqual(12)
    expect(r.lastFrame()).toContain('long-agent')
    r.unmount()
  })

  it('shows only the newest two real message previews when the pane has room', () => {
    const messages: TeamMessageRow[] = [
      { key: 'm1', runId: 'r1', fromId: 'a', toId: 'b', fromLabel: 'a', toLabel: 'b', text: 'old preview', at: 1 },
      { key: 'm2', runId: 'r1', fromId: 'b', toId: 'a', fromLabel: 'b', toLabel: 'a', text: 'latest preview', at: 2 },
      { key: 'm3', runId: 'r1', fromId: 'a', toId: null, fromLabel: 'a', toLabel: 'you', text: 'newest preview', at: 3 }
    ]
    const r = mount({ rows: [row('a', { depth: 0, state: 'thinking' }), row('b', { state: 'idle', stateWord: 'Idle', activity: '' })], messages, width: 80, height: 12 }, env({ color: false }))
    const out = r.lastFrame() ?? ''
    expect(out).toContain('latest preview')
    expect(out).toContain('newest preview')
    expect(out).not.toContain('old preview')
    r.unmount()
  })

  it('highlights message participants briefly without changing the state word contract', () => {
    const active = row('a', { depth: 0, state: 'thinking', stateWord: 'Thinking', activity: 'Reading files' })
    const item = { kind: 'row' as const, row: active, prefix: '' }
    const highlighted = rowLine(item, false, false, 60, env(), 0, true, true)
    expect(highlighted.find((segment) => segment.text === 'a')?.tone).toBe('identity')
    expect(highlighted.find((segment) => segment.text?.includes('Reading files'))?.shimmer).toBe(true)
    const traffic = rowLine({ ...item, row: { ...active, traffic: true } }, false, false, 60, env(), 0, true, true)
    expect(traffic.find((segment) => segment.text === ' ↔')?.tone).toBe('message')
  })
})
