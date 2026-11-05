import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBus } from './context'
import { StatusBar } from './StatusBar'
import { ESC_RE, Providers, env, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { StatusBarProps, StatusSummary, TuiEnv } from './types'

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

  it('shows the connection state and the read-only reason', () => {
    expect(frame({ summary: { ...SUMMARY, connection: 'reconnecting' } })).toContain('Reconnecting')
    expect(frame({ summary: { ...SUMMARY, connection: 'gone' } })).toContain('Connection lost')
    expect(frame({ summary: { ...SUMMARY, connection: 'live' } })).not.toContain('Connect')
    expect(frame({ summary: { ...SUMMARY, readOnlyReason: 'Read-only: decide scope missing' } })).toContain('Read-only: decide scope missing')
    expect(frame({ summary: { ...SUMMARY, needsYou: 1 } })).toContain('1 needs you')
    expect(frame({ summary: { ...SUMMARY, needsYou: 0 } })).toContain('0 need you')
  })

  it('shows the notice instead of the hints', () => {
    const f = frame({ notice: { id: 1, text: 'Resolved in another window', at: 0 } })
    expect(f).toContain('Resolved in another window')
    expect(f).not.toContain('Tab focus')
  })

  it('cuts to the width, counting wide characters as two columns', () => {
    const f = frame({ width: 30, summary: { ...SUMMARY, projectName: '店舗プロジェクト' } })
    expect(textWidth(f)).toBeLessThanOrEqual(30)
    expect(f.endsWith('…')).toBe(true)
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

  it('survives width 0 and 1', () => {
    expect(frame({ width: 0 })).toBe('')
    expect(textWidth(frame({ width: 1 }))).toBeLessThanOrEqual(1)
  })
})
