/**
 * Run control in the real App (cli-parity 3.5): the /model picker overlay, /new run flags carried to the typed prompt,
 * bare `orgai`'s run flags on the first run, and the pause notice's actions. Nothing talks to a host.
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderModel, RunSummary } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { App } from './App'
import { DEFAULT_TUI_ENV } from './context'
import { KeyParser } from './input/keys'
import { completionLines, pausedActionsLine } from './RunCompletion'
import { addNotice, applyRecord, createInitialState, setActiveRun, setComposeTarget } from './state'
import type { ComposeTarget, InputEvent, KeyEvent, TuiEnv, TuiLaunch, TuiState } from './types'

const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

function stateWith(run: Partial<RunSummary> | null = {}): TuiState {
  let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
  if (run === null) return s
  s = applyRecord(s, record(summary('run1', { status: 'idle', prompt: 'Build the thing', connection: 'anthropic', modelAdapter: 'claude', modelSelection: { model: 'opus', connection: 'anthropic' }, ...run })))
  return setActiveRun(s, 'run1')
}

const m = (id: string, connection = 'anthropic', adapter = 'claude'): ProviderModel => ({ id, label: id, connection, family: 'claude', adapter, source: 'builtin' }) as ProviderModel

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

function mount(opts: { state?: TuiState; launch?: TuiLaunch } = {}) {
  let state = opts.state ?? stateWith()
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
    modelCatalog: vi.fn(async () => ({ connections: [{ connection: { id: 'anthropic', tierModels: { fast: 'haiku' } }, status: { state: 'connected' } }], models: [m('opus'), m('haiku')], failed: [] })),
    switchModel: vi.fn(async (sel: ProviderModel) => ({ kind: 'applied', run: summary('run1', { modelSelection: { model: sel.id, connection: sel.connection } }), stopped: false })),
    resumeNow: vi.fn(async () => summary('run2')),
    cancelAutoResume: vi.fn(async () => undefined),
    notify: vi.fn((text: string, tone?: 'dim' | 'warn' | 'danger') => setState(addNotice(state, text, tone, 1_000_000))),
    close: vi.fn(async () => undefined)
  }
  const terminal = { bufferMode: 'fullscreen' as const, bracketedPaste: false, enter: vi.fn(), suspend: vi.fn(), resume: vi.fn(), restore: vi.fn(), size: () => ({ cols: 110, rows: 32 }), onResize: () => () => undefined }
  const env: TuiEnv = { ...DEFAULT_TUI_ENV, bufferMode: 'fullscreen', unicode: true }
  const r = render(
    <App
      session={session as never}
      terminal={terminal as never}
      env={env}
      launch={opts.launch ?? {}}
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

describe('/model in the shell', () => {
  it('opens a short picker of the choices; Down + Enter switches to the picked model', async () => {
    const app = mount()
    await tick()
    await app.typed('/model\r')
    const f = app.frame()
    expect(f).toContain('Model (current: opus via Anthropic)')
    expect(f).toContain('> haiku · Anthropic · fast')
    expect(f).toContain('opus · Anthropic · current')
    expect(f).toContain('Enter picks')
    await app.send(named('enter'))
    await tick()
    expect(app.session.switchModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'haiku' }), expect.any(Object))
    expect(app.frame()).toContain('Model changed to haiku via Anthropic.')
  })

  it('Esc closes the picker without switching', async () => {
    const app = mount()
    await tick()
    await app.typed('/model\r')
    await app.send(named('escape'))
    expect(app.frame()).not.toContain('Enter picks')
    expect(app.session.switchModel).not.toHaveBeenCalled()
  })
})

describe('run flags in the shell', () => {
  it('/new --goal speed without a prompt carries the flags to the prompt typed next', async () => {
    const app = mount()
    await tick()
    await app.typed('/new --goal speed --strict-delegation\r')
    expect(app.frame()).toContain('Type the prompt for the new run.')
    await app.typed('go\r')
    expect(app.session.submitPrompt).toHaveBeenCalledWith('go', { overrides: { goal: 'speed', strictDelegation: true } })
    // Taken once: the next prompt starts plain.
    app.session.setComposeTarget('new')
    await tick()
    await app.typed('again\r')
    expect(app.session.submitPrompt).toHaveBeenLastCalledWith('again')
  })

  it("bare orgai's run flags go with the launch prompt, or with the first run started from the composer", async () => {
    const a = mount({ state: stateWith(null), launch: { prompt: 'build', overrides: { goal: 'cost' } } })
    await tick()
    expect(a.session.submitPrompt).toHaveBeenCalledWith('build', { overrides: { goal: 'cost' } })

    const b = mount({ state: stateWith(null), launch: { overrides: { permissionMode: 'plan' } } })
    await tick()
    await b.typed('first\r')
    expect(b.session.submitPrompt).toHaveBeenCalledWith('first', { overrides: { permissionMode: 'plan' } })
  })
})

describe('the pause notice', () => {
  it('names the resume actions', () => {
    expect(pausedActionsLine(summary('r', { status: 'paused', autoResume: false }))).toBe('/resume-now resumes it now')
    const at = new Date(2026, 10, 10, 14, 5).getTime()
    expect(pausedActionsLine(summary('r', { status: 'paused', autoResume: true, pausedUntil: at }))).toBe('Resumes by itself at 14:05 | /resume-now resumes now | /cancel-resume keeps it paused')
    expect(pausedActionsLine(summary('r', { status: 'finished' }))).toBeUndefined()
    const lines = completionLines(stateWith({ status: 'paused', autoResume: true, pauseReason: 'Usage limit' }))
    expect(lines.slice(0, 3)).toEqual(['Run paused', expect.stringContaining('Paused: Usage limit'), expect.stringContaining('/resume-now resumes now')])
  })

  it('/resume-now from the shell resumes the paused run', async () => {
    const app = mount({ state: stateWith({ status: 'paused', autoResume: true }) })
    await tick()
    expect(app.frame()).toContain('/resume-now resumes now')
    await app.typed('/resume-now\r')
    expect(app.session.resumeNow).toHaveBeenCalledTimes(1)
  })
})
