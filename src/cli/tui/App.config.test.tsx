/**
 * /team and /settings in the real App (cli-parity 3.7): they open over the run view (the status bar stays), take their
 * own keys, and Esc brings the run view back unchanged; /help lists them; the first open of a project hints at them once.
 */
import { render } from 'ink-testing-library'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { CONFIG_HINT, hintStore, type TuiConfigApi } from './configApi'
import { fakeConfig, fixtureProject } from './configTestUtil'
import { DEFAULT_TUI_ENV } from './context'
import { KeyParser } from './input/keys'
import { HELP_TEXT } from './slashCommands'
import { addNotice, applyRecord, createInitialState, setActiveRun, setComposeTarget } from './state'
import { record, summary } from '../testing/fakeContext'
import type { ComposeTarget, InputEvent, KeyEvent, TuiEnv, TuiState } from './types'

const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

const mounted: { unmount(): void }[] = []
const dirs: string[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function mount(config: TuiConfigApi | undefined, initial?: TuiState) {
  let state: TuiState = initial ?? { ...createInitialState('/work'), project: fixtureProject(), connection: 'live' }
  const listeners = new Set<(e: InputEvent) => void>()
  const subs = new Set<() => void>()
  const setState = (next: TuiState): void => {
    state = next
    for (const f of [...subs]) f()
  }
  const session = {
    getState: () => state,
    subscribe: (cb: () => void) => (subs.add(cb), () => void subs.delete(cb)),
    hostKind: 'inproc',
    hostInstanceId: 'h1',
    focusRun: vi.fn(async () => undefined),
    setComposeTarget: vi.fn((t: ComposeTarget) => setState(setComposeTarget(state, t))),
    submitPrompt: vi.fn(async () => undefined),
    startQuick: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    decide: vi.fn(),
    worktreeDiff: vi.fn(),
    listRuns: vi.fn(async () => []),
    startRetro: vi.fn(),
    resync: vi.fn(async () => undefined),
    modelCatalog: vi.fn(),
    switchModel: vi.fn(),
    resumeNow: vi.fn(),
    cancelAutoResume: vi.fn(),
    config,
    notify: vi.fn((text: string, tone?: 'dim' | 'warn' | 'danger') => setState(addNotice(state, text, tone, 1_000_000))),
    close: vi.fn(async () => undefined)
  }
  const terminal = { bufferMode: 'fullscreen' as const, bracketedPaste: false, enter: vi.fn(), suspend: vi.fn(), resume: vi.fn(), restore: vi.fn(), size: () => ({ cols: 100, rows: 30 }), onResize: () => () => undefined }
  const env: TuiEnv = { ...DEFAULT_TUI_ENV, bufferMode: 'fullscreen', unicode: true }
  const r = render(
    <App
      session={session as never}
      terminal={terminal as never}
      env={env}
      launch={{}}
      conn={{ client: {} as never, hello: { grantedScopes: ['read', 'operate', 'decide'] } as never, started: false } as never}
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
  const typed = async (text: string): Promise<void> => {
    const p = new KeyParser({ bracketedPaste: false })
    emit(...p.feed(text), ...p.flush())
    await tick()
    await tick()
  }
  const send = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) {
      emit(e)
      await tick()
    }
  }
  return { r, session, typed, send, frame: () => plain(r.lastFrame() ?? '') }
}

describe('/team and /settings in the shell', () => {
  it('/team opens the saved roles over the run view; Esc returns to it', async () => {
    const app = mount(fakeConfig())
    await tick()
    await app.typed('/team\r')
    await tick()
    let f = app.frame()
    expect(f).toContain('Team of App (4 roles, saved)')
    expect(f).toContain('deep (claude-opus-5)')
    // Keys go to the view: j moves the selection, not the composer.
    await app.typed('j')
    expect(app.frame()).toMatch(/> ├─ Dev/)
    await app.send(named('escape'))
    f = app.frame()
    expect(f).not.toContain('Team of App')
    expect(f).toContain('/ commands')
  })

  it('/settings opens the settings; Esc returns', async () => {
    const app = mount(fakeConfig())
    await tick()
    await app.typed('/settings\r')
    await tick()
    expect(app.frame()).toContain('Settings of App')
    expect(app.frame()).toMatch(/Staffing mode\s+fixed/)
    await app.send(named('escape'))
    expect(app.frame()).not.toContain('Settings of App')
  })

  it('/help lists both commands', () => {
    expect(HELP_TEXT).toMatch(/\/team\s+The project's saved roles/)
    expect(HELP_TEXT).toMatch(/\/settings\s+Project, tier and app settings/)
  })

  it('hints at /team and /settings once, the first time this terminal opens the project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-hint-'))
    dirs.push(dir)
    const first = { ...fakeConfig(), firstOpen: hintStore(dir) }
    const a = mount(first)
    await tick()
    await tick()
    expect(a.session.notify.mock.calls.some((c) => c[0] === CONFIG_HINT)).toBe(true)
    expect(a.frame()).toContain('New here? /team')
    a.r.unmount()
    const b = mount({ ...fakeConfig(), firstOpen: hintStore(dir) })
    await tick()
    await tick()
    expect(b.session.notify.mock.calls.some((c) => c[0] === CONFIG_HINT)).toBe(false)
  })

  it.each(['team', 'settings'])('leaving /%s returns to the same transcript position and follow state', async (view) => {
    const text = Array.from({ length: 60 }, (_, i) => `Transcript line ${i + 1}`).join('\n')
    let st: TuiState = { ...createInitialState('/work'), project: fixtureProject(), connection: 'live' }
    st = applyRecord(st, record(summary('run1', { status: 'idle' }), { transcript: [{ id: 't1', agentId: 'root', at: 1, block: { kind: 'text', text } }] }))
    st = setActiveRun(st, 'run1')
    const app = mount(fakeConfig(), st)
    await tick()
    // Focus the transcript (Tab through the panes) and scroll up two pages: the view leaves follow mode.
    for (let i = 0; i < 6 && !app.frame().includes('More below'); i++) {
      await app.send(named('tab'))
      await app.send(named('pageup'), named('pageup'))
    }
    const lines = (f: string): string[] => f.split('\n').filter((l) => /Transcript line \d+|More below/.test(l))
    const scrolled = lines(app.frame())
    // Tab on to the composer (Esc in the transcript jumps to the end): the pane keeps its place, it only loses its key line.
    for (let i = 0; i < 6 && !app.frame().includes('/ commands'); i++) await app.send(named('tab'))
    const before = lines(app.frame())
    expect(before[0]).toBe(scrolled[0])
    expect(before.join('\n')).toContain('More below')
    expect(before.join('\n')).not.toContain('Transcript line 60')
    await app.typed(`/${view}\r`)
    await tick()
    expect(app.frame()).toContain(view === 'team' ? 'Team of App' : 'Settings of App')
    await app.send(named('escape'))
    await tick()
    expect(lines(app.frame())).toEqual(before)
  })
})

