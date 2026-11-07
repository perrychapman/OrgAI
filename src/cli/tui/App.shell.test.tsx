/**
 * The shell of the real App (issues #27-#32): input queued across a focus change ("/runs\r" in one chunk), overlays that
 * wrap and show where you are, `?` on the composer, the run named in the placeholder, the one-time "needs you" notice,
 * Tab in inline mode and the frame at four terminal sizes. Real Composer, palette and slash commands over a hand-built
 * state; nothing talks to a host.
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, RunEvent } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { App, overlayCue, placeholderFor, wrapOverlayLines } from './App'
import { DEFAULT_TUI_ENV } from './context'
import { KeyParser } from './input/keys'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import type { InputEvent, KeyEvent, TuiEnv, TuiLaunch, TuiState } from './types'

const key = (ch: string, extra: Partial<KeyEvent> = {}): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let seq = 0
function stateWith(opts: { title?: string; waiting?: boolean; second?: boolean } = {}): TuiState {
  let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
  s = applyRecord(s, record(summary('run1', { status: 'idle', prompt: 'Build the thing', ...(opts.title ? { title: opts.title } : {}) })))
  if (opts.second) s = applyRecord(s, record(summary('run2', { status: 'idle', prompt: 'Another' })))
  s = setActiveRun(s, 'run1')
  if (opts.waiting) {
    const request = { id: 'perm1', runId: 'run1', agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test' } as PermissionRequest
    s = applyEvent(s, { seq: ++seq, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
  }
  return s
}

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

function mount(opts: { cols: number; rows: number; env?: Partial<TuiEnv>; inline?: boolean; state?: TuiState; launch?: TuiLaunch }) {
  const state = opts.state ?? stateWith()
  const listeners = new Set<(e: InputEvent) => void>()
  const session = {
    getState: () => state,
    subscribe: () => () => undefined,
    hostKind: 'daemon',
    hostInstanceId: 'h1',
    focusRun: vi.fn(async () => undefined),
    setComposeTarget: vi.fn(),
    submitPrompt: vi.fn(async () => undefined),
    startQuick: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    decide: vi.fn(async () => ({ status: 'decided' })),
    worktreeDiff: vi.fn(async () => ({ stat: '', patch: '' })),
    listRuns: vi.fn(async () => []),
    startRetro: vi.fn(),
    openInDesktop: vi.fn(),
    resync: vi.fn(async () => undefined),
    notify: vi.fn(),
    close: vi.fn(async () => undefined)
  }
  const terminal = {
    bufferMode: opts.inline ? ('inline' as const) : ('fullscreen' as const),
    bracketedPaste: false,
    enter: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    restore: vi.fn(),
    size: () => ({ cols: opts.cols, rows: opts.rows }),
    onResize: () => () => undefined
  }
  const env: TuiEnv = { ...DEFAULT_TUI_ENV, bufferMode: terminal.bufferMode, unicode: true, ...opts.env }
  const r = render(
    <App
      session={session as never}
      terminal={terminal as never}
      env={env}
      launch={opts.launch ?? {}}
      conn={{ client: {} as never, hello: {} as never, started: false } as never}
      input={{ subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)) }}
      processEnv={{}}
      now={() => 1_000_000}
      onExit={() => undefined}
    />
  )
  mounted.push(r)
  const emit = (...events: InputEvent[]): void => {
    for (const e of events) for (const fn of [...listeners]) fn(e)
  }
  const send = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) {
      emit(e)
      await tick()
    }
  }
  return { r, session, emit, send, frame: () => plain(r.lastFrame() ?? '') }
}

describe('input across a focus change (issue #31 M9)', () => {
  it('"/runs" then Enter pushed with no render between runs /runs and sends nothing to the agent', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await tick()
    m.emit(key('/'), key('r'), key('u'), key('n'), key('s'), named('enter'))
    await tick()
    await tick()
    expect(m.session.listRuns).toHaveBeenCalledTimes(1)
    expect(m.session.submitPrompt).not.toHaveBeenCalled()
    expect(m.frame()).not.toContain('/runs')
  })

  it('one KeyParser chunk "/runs\\r" does the same', async () => {
    const m = mount({ cols: 100, rows: 30 })
    await tick()
    const p = new KeyParser({ bracketedPaste: false })
    m.emit(...p.feed('/runs\r'), ...p.flush())
    await tick()
    await tick()
    expect(m.session.listRuns).toHaveBeenCalledTimes(1)
    expect(m.session.submitPrompt).not.toHaveBeenCalled()
  })
})

describe('? on the composer (issue #30 L5)', () => {
  it('opens the composer keys on an empty composer, types ? when there is text', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    await m.send(named('escape'))
    await m.send(key('a'), key('?'))
    expect(m.frame()).not.toContain('Keys: Composer')
    expect(m.frame()).toContain('a?')
  })
})

describe('text overlays wrap and show a position cue (issue #30 M8)', () => {
  const box = (f: string): string => f.slice(f.indexOf('┌'), f.indexOf('└'))
  it('80x24: no line is cut, the hint row says where you are and PgDn reaches the end', async () => {
    const m = mount({ cols: 80, rows: 24 })
    await m.send(key('?'))
    const f = m.frame()
    expect(f).toContain('Keys: Composer')
    expect(f).toMatch(/lines 1-[0-9]+ of [0-9]+ · more below/)
    expect(box(f)).not.toContain('…')
    for (let i = 0; i < 12; i++) await m.send(named('pagedown'))
    expect(m.frame()).toMatch(/of [0-9]+ · end/)
  })

  it('120x40: everything fits, wrapped, with no cue', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(key('?'))
    const f = m.frame()
    expect(f).toContain('Keys: Composer')
    expect(box(f)).not.toContain('…')
    expect(f).not.toMatch(/lines 1-/)
    expect(f).toContain('back (/focus)')
  })

  it('inline mode draws the overlay without a border', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    expect(m.frame()).not.toMatch(/[┌┐└┘│]/)
  })

  it('pure helpers', () => {
    expect(wrapOverlayLines(['a '.repeat(30)], 20).every((l) => l.length <= 20)).toBe(true)
    expect(overlayCue(0, 10, 5, ' · ')).toBe('')
    expect(overlayCue(0, 10, 40, ' · ')).toBe('lines 1-10 of 40 · more below')
    expect(overlayCue(30, 10, 40, ' · ')).toBe('lines 31-40 of 40 · end')
  })
})

describe('the composer names the run (issue #29 M3)', () => {
  it('placeholderFor', () => {
    const s = stateWith({ title: 'Fix the login bug' })
    expect(placeholderFor('send', s, 80)).toBe('Message R1 · Fix the login bug')
    expect(placeholderFor('send', s, 24)).toMatch(/^Message R1/)
    expect(placeholderFor('send', s, 24).length).toBeLessThanOrEqual(24)
    expect(placeholderFor('continue', s, 80)).toBe('Send to continue R1 with its memory')
    expect(placeholderFor('start', s, 80)).toBe('Describe the work to start a run')
  })

  it('shows it in the frame', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ title: 'Fix the login bug' }) })
    await tick()
    expect(m.frame()).toContain('Message R1 · Fix the login bug')
  })

  it('says once that the opened run needs you when it is not the newest', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true, second: true }) })
    await tick()
    const said = m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Opened R1: it needs you'))
    expect(said.length).toBe(1)
  })

  it('stays quiet when the launch named a run', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true, second: true }), launch: { runId: 'run1' } })
    await tick()
    expect(m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Opened R1')).length).toBe(0)
  })
})

describe('inline Tab (issue #27)', () => {
  it('stays on the composer and explains once', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await m.send(named('tab'), named('tab'), named('backtab'))
    expect(m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Panes need a full-screen')).length).toBe(1)
    await m.send(key('h'))
    expect(m.frame()).toContain('h')
  })
})

describe('the shell at four sizes', () => {
  for (const [cols, rows] of [
    [120, 40],
    [100, 30],
    [80, 24],
    [70, 24]
  ] as const) {
    it(`${cols}x${rows}: status, composer with the run name and no line wider than the terminal`, async () => {
      const m = mount({ cols, rows, state: stateWith({ title: 'Fix the login bug' }) })
      await tick()
      const f = m.frame()
      expect(f).toContain('Message R1')
      for (const l of f.split('\n')) expect([...l].length).toBeLessThanOrEqual(cols)
      expect(f.split('\n').length).toBeLessThanOrEqual(rows)
    })
  }

  it('screen reader: no box glyphs in an overlay', async () => {
    const m = mount({ cols: 80, rows: 24, env: { screenReader: true, unicode: false } })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    expect(m.frame()).not.toMatch(/[┌┐└┘│─·]/)
  })
})
