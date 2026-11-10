/**
 * The read-only /approvals in the real App (cli-parity 3.4 as built): it shows what waits, in full, ending with where
 * approving is done and why, and offers no key that decides anything. The host reads are faked.
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderModel, TeamFilesStatus } from '../../shared/types'
import { project, summary } from '../testing/fakeContext'
import { App } from './App'
import { approvalItems, type ApprovalsApi } from './approvals'
import { DEFAULT_TUI_ENV } from './context'
import { KeyParser } from './input/keys'
import { addNotice, createInitialState, setComposeTarget } from './state'
import type { ComposeTarget, InputEvent, KeyEvent, TuiEnv, TuiLaunch, TuiState } from './types'

const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

function stateWith(): TuiState {
  return { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
}

const m = (id: string): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'builtin' }) as ProviderModel

const status: TeamFilesStatus = {
  projectId: 'p1',
  projectName: 'Demo',
  state: 'pending',
  digest: 'ab'.repeat(32),
  isGitRepo: false,
  uncommitted: false,
  uncommittedFiles: [],
  changes: [{ id: 'c1', kind: 'role', name: 'Reviewer', file: '.orgai/agents/reviewer.md', action: 'changed', summary: 'Reviewer gains Bash.', needsApproval: true, reason: 'New tools' }],
  applied: [],
  problems: [],
  notes: [],
  warnings: []
}

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

function mount(opts: { state?: TuiState; launch?: TuiLaunch; approvals?: ApprovalsApi } = {}) {
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
    approvals: opts.approvals,
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



const api = (over: Partial<ApprovalsApi> = {}): ApprovalsApi => ({ list: async () => approvalItems([status]), waiting: async () => undefined, ...over })

describe('read-only /approvals in the shell', () => {
  it('shows what waits in full and where approving is done; keys only scroll and close', async () => {
    const app = mount({ approvals: api() })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    let f = app.frame()
    expect(f).toContain('Team files of Demo: 1 change waits for approval')
    expect(f).toContain('Reviewer gains Bash. (New tools)')
    expect(f).toContain('Approving is not available in the terminal yet')
    await app.typed('a')
    await app.send(named('escape'))
    f = app.frame()
    expect(f).not.toContain('Team files of Demo: 1 change waits')
  })

  it('nothing waits: a notice, no overlay', async () => {
    const app = mount({ approvals: api({ list: async () => [] }) })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    expect(app.frame()).toContain('Nothing waits for approval.')
  })

  it('says on open when something waits', async () => {
    const app = mount({ approvals: api({ waiting: async () => 'Waiting for approval: team files of 1 project. Type /approvals to read them.' }) })
    await tick()
    await tick()
    expect(app.frame()).toContain('Waiting for approval: team files of 1 project. Type /approvals to read them.')
  })
})
