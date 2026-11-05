import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { OrgTreePane, treePrefixes } from './OrgTreePane'
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

function mount(props: Partial<OrgTreePaneProps> = {}, e: TuiEnv = env()) {
  const bus = new InputBus()
  const all: OrgTreePaneProps = { width: 60, height: 20, focused: false, rows: ROWS, ...props }
  const r = render(
    <Providers env={e} bus={bus}>
      <OrgTreePane {...all} />
    </Providers>
  )
  const rerender = (p: Partial<OrgTreePaneProps>): void =>
    r.rerender(
      <Providers env={e} bus={bus}>
        <OrgTreePane {...all} {...p} />
      </Providers>
    )
  return { ...r, bus, rerender }
}

const lines = (frame: string | undefined): string[] => (frame ?? '').split('\n')

describe('OrgTreePane', () => {
  it('renders the title, rows with role, state word, cost and activity, and the earlier group', () => {
    const r = mount()
    const out = lines(r.lastFrame())
    expect(out[0]).toBe('Agents (4)')
    const root = out.find((l) => l.includes('orchestrator'))!
    expect(root).toContain('Working')
    expect(root).not.toContain('(orchestrator)')
    expect(root.trimEnd().endsWith('$1.20')).toBe(true)
    const dev = out.find((l) => l.includes('dev-1') && l.includes('(Developer)'))!
    expect(dev).toContain('├─')
    expect(out.some((l) => l.includes('dev-1 is reading files'))).toBe(true)
    expect(out.find((l) => l.includes('dev-2'))).toContain('└─')
    expect(out.find((l) => l.includes('dev-2'))).toContain('Finished')
    const header = out.findIndex((l) => l.includes('Earlier sessions'))
    expect(header).toBeGreaterThan(out.findIndex((l) => l.includes('dev-2')))
    expect(out.findIndex((l) => l.includes('old-1'))).toBeGreaterThan(header)
    r.unmount()
  })

  it('drops the activity lines when the height does not allow them', () => {
    const r = mount({ height: 6 })
    const out = lines(r.lastFrame())
    expect(out.length).toBeLessThanOrEqual(6)
    expect(out.some((l) => l.includes('is reading files'))).toBe(false)
    expect(out.some((l) => l.includes('dev-2'))).toBe(true)
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
      expect(out).toContain('Working')
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

  it('marks the last sibling with the last-branch glyph', () => {
    const prefixes = treePrefixes(
      [row('a', { depth: 0 }), row('b', { depth: 1 }), row('c', { depth: 2 }), row('d', { depth: 1 })],
      env()
    )
    expect(prefixes).toEqual(['', '├─ ', '  └─ ', '└─ '])
  })
})
