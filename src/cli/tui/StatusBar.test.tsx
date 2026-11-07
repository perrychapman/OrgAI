import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBus } from './context'
import { StatusBar } from './StatusBar'
import { ESC_RE, Providers, env, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import { statusHint } from './keymap'
import { TUI_NOTICE_TTL_MS, type RunChip, type StatusBarProps, type StatusSummary, type TuiEnv } from './types'

const SUMMARY: StatusSummary = {
  projectName: 'Shop',
  runTag: 'R2',
  runTitle: 'Fix checkout',
  statusWord: 'Needs you',
  tone: 'warn',
  costText: '$0.42',
  needsYou: 2,
  liveRuns: 1,
  connection: 'live'
}

function frame(props: Partial<StatusBarProps> = {}, e: TuiEnv = env()): string {
  const all: StatusBarProps = { width: 120, summary: SUMMARY, hints: 'Tab focus  / commands', ...props }
  const r = render(
    <Providers env={e} bus={new InputBus()}>
      <StatusBar {...all} />
    </Providers>
  )
  const f = r.lastFrame() ?? ''
  r.unmount()
  return f
}

describe('StatusBar', () => {
  it('shows project, run, status word, cost, the needs-you count, live runs and the hints on one line', () => {
    const f = frame()
    expect(f.split('\n')).toHaveLength(1)
    expect(f).toBe('Shop · R2 Fix checkout · Needs you · $0.42 · 2 need you · 1 live   Tab focus  / commands')
  })

  it('shows the launch title first (orgai init, the assistants)', () => {
    expect(frame({ summary: { ...SUMMARY, title: 'Architect setup' } })).toMatch(/^Architect setup · Shop · R2/)
  })

  it('shows the connection state and the read-only reason', () => {
    expect(frame({ summary: { ...SUMMARY, connection: 'reconnecting' } })).toContain('Reconnecting')
    expect(frame({ summary: { ...SUMMARY, connection: 'gone' } })).toContain('Connection lost')
    expect(frame({ summary: { ...SUMMARY, connection: 'live' } })).not.toContain('Connect')
    expect(frame({ summary: { ...SUMMARY, readOnlyReason: 'Read-only: decide scope missing' } })).toContain('Read-only: decide scope missing')
    expect(frame({ summary: { ...SUMMARY, needsYou: 1 } })).toContain('1 needs you')
    expect(frame({ summary: { ...SUMMARY, needsYou: 0 } })).toContain('0 need you')
  })

  it('shows a fresh notice before the hint when there is room, and the hint alone once it expired', () => {
    const f = frame({ notice: { id: 1, text: 'Resolved in another window', at: 1000 }, now: () => 1000 })
    expect(f).toContain('Resolved in another window   Tab focus  / commands')
    const old = frame({ notice: { id: 1, text: 'Interrupting the run...', at: 1000 }, now: () => 1000 + TUI_NOTICE_TTL_MS })
    expect(old).not.toContain('Interrupting')
    expect(old).toContain('Tab focus')
  })

  it('re-renders by itself when a notice expires', async () => {
    let t = 0
    const r = render(
      <Providers env={env()} bus={new InputBus()}>
        <StatusBar width={140} summary={SUMMARY} hints="Tab focus" notice={{ id: 1, text: 'Interrupting the run...', at: 0 }} now={() => t} />
      </Providers>
    )
    expect(r.lastFrame()).toContain('Interrupting the run...')
    t = TUI_NOTICE_TTL_MS + 10
    await new Promise((res) => setTimeout(res, TUI_NOTICE_TTL_MS + 80))
    expect(r.lastFrame()).not.toContain('Interrupting')
    expect(r.lastFrame()).toContain('Tab focus')
    r.unmount()
  }, 10_000)

  it('keeps the danger notice, not the hint, when only one fits; the hint wins over a plain notice', () => {
    const hints = statusHint('composer', { readOnly: false, stopOnQuit: false })
    const narrow = { width: 62, hints, now: () => 0 }
    const danger = frame({ ...narrow, notice: { id: 1, text: 'Could not interrupt: the host refused it', tone: 'danger', at: 0 } })
    expect(danger).toContain('Could not interrupt: the host refused it')
    const plain = frame({ ...narrow, notice: { id: 1, text: 'Could not interrupt: the host refused it', at: 0 } })
    expect(plain).toContain('Enter sends')
    expect(plain).not.toContain('Could not interrupt')
  })

  it('cuts to the width, counting wide characters as two columns', () => {
    const f = frame({ width: 12, summary: { ...SUMMARY, projectName: '店舗プロジェクト' }, hints: '' })
    expect(textWidth(f)).toBeLessThanOrEqual(12)
    expect(f.endsWith('…')).toBe(true)
  })

  it('shrinks the run chips first, then drops lower-value segments; the hint survives and nothing is cut mid-word', () => {
    const chips: RunChip[] = [
      { tag: 'R1', runId: 'a', followed: true, needsYou: false },
      { tag: 'R2', runId: 'b', followed: false, needsYou: true },
      { tag: 'R3', runId: 'c', followed: false, needsYou: false },
      { tag: 'R4', runId: 'd', followed: false, needsYou: false }
    ]
    const summary: StatusSummary = { ...SUMMARY, runChips: chips, liveRuns: 4, runTitle: 'Fix the checkout flow for guests' }
    const hints = statusHint('composer', { readOnly: false, stopOnQuit: false })
    expect(hints).toBe('Enter sends · / commands · Alt+D decisions · Tab panes · Esc Esc interrupts · Ctrl+C twice quits')
    const at = (width: number): string => frame({ width, summary, hints })
    // Roomy: everything.
    const wide = at(190)
    expect(wide).toContain('R1* R2! R3 R4')
    expect(wide).toContain('Ctrl+C twice quits')
    // Tighter: the chips shrink before anything else is lost.
    const mid = at(wide.length - 3)
    expect(mid).toContain('R1* R2! +2')
    expect(mid).toContain('$0.42')
    expect(mid).toContain('Fix the checkout flow for guests')
    expect(mid).toContain('Ctrl+C twice quits')
    const mid2 = at(mid.length - 3)
    expect(mid2).toContain('4 live')
    expect(mid2).toContain('Ctrl+C twice quits')
    for (const width of [120, 100, 80, 70, 60]) {
      const f = at(width)
      expect(textWidth(f)).toBeLessThanOrEqual(width)
      expect(f).toContain('Enter sends')
      // The hint is cut only at separators: every item present is whole.
      const tail = f.slice(f.indexOf('Enter sends'))
      for (const item of tail.split(' · ')) expect(hints.split(' · ')).toContain(item.trim())
    }
    expect(at(100)).toContain('4 live')
    expect(at(60)).toContain('4 live')
  })

  it('cuts a long run title at a word boundary with an ellipsis', () => {
    const summary: StatusSummary = { ...SUMMARY, runTitle: 'Fix the checkout flow for guests', costText: undefined }
    const f = frame({ width: 90, summary, hints: 'Tab focus  / commands' })
    expect(f).toMatch(/R2 Fix the checkout flow… · Needs you/)
    expect(f).toContain('Tab focus')
  })

  it('uses colour only when on, and plain words without glyphs for a screen reader', async () => {
    await withInkColor(() => {
      expect(frame({}, env())).toMatch(ESC_RE)
      expect(frame({ summary: { ...SUMMARY, connection: 'gone' } }, env({ color: false }))).not.toMatch(ESC_RE)
    })
    const sr = frame({}, env({ screenReader: true }))
    expect(sr).toBe('Shop, R2 Fix checkout, Needs you, $0.42, 2 need you, 1 live. Tab focus  / commands')
    expect(frame({}, env({ unicode: false }))).toContain('Shop | R2')
  })

  it('R2-M1: a warn notice (the first Ctrl+C) shows at every width from 70 down to 20, with or without run chips', () => {
    const text = 'Press Ctrl+C again to quit'
    const chips: RunChip[] = Array.from({ length: 8 }, (_, i) => ({ tag: `R${i + 1}`, runId: `r${i}`, followed: i === 0, needsYou: i < 5 }))
    const summary = { ...SUMMARY, projectName: 'Demo', runTag: 'R1', runTitle: 'Mockdeep-tree Build the report', statusWord: 'Needs you', needsYou: 5, liveRuns: 8, runChips: chips }
    for (let width = 70; width >= 20; width -= 5) {
      const f = frame({ width, summary, notice: { id: 1, text, tone: 'warn', at: 1000 }, now: () => 1000 })
      expect(textWidth(f), `width ${width}`).toBeLessThanOrEqual(width)
      const visible = width >= text.length ? text : text.slice(0, Math.max(1, width - 4))
      expect(f, `width ${width}`).toContain(visible)
    }
  })

  it('a notice that the screen reader already ends with a stop is not followed by a second one (R2-L4)', () => {
    const f = frame({ width: 120, summary: SUMMARY, notice: { id: 1, text: 'Opened R1: it needs you. /new starts a new run.', at: 1000 }, now: () => 1000 }, env({ screenReader: true }))
    expect(f).toContain('/new starts a new run. Tab focus')
    expect(f).not.toContain('..')
  })

  it('no "0 need you" before a project or a run exists (onboarding, R2-L5)', () => {
    const bare: StatusSummary = { needsYou: 0, liveRuns: 0, connection: 'live' }
    expect(frame({ summary: bare })).not.toContain('need you')
    expect(frame({ summary: { ...bare, needsYou: 2 } })).toContain('2 need you')
  })

  it('survives width 0 and 1', () => {
    expect(frame({ width: 0 })).toBe('')
    expect(textWidth(frame({ width: 1 }))).toBeLessThanOrEqual(1)
  })
})
