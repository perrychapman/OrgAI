/**
 * /approvals in the real App (cli-parity 3.4): the overlay shows what the host's offer returned, takes the typed code,
 * re-offers after an answer or a refusal, and shows the host's reason when this terminal may not approve. The host is
 * faked here (its gate is tested in host/approvalGate.test.ts and the integration test).
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOffer, ProviderModel, TeamFilesStatus } from '../../shared/types'
import { project, summary } from '../testing/fakeContext'
import { App } from './App'
import type { ApprovalItem, ApprovalsApi } from './approvals'
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

const status = (over: Partial<TeamFilesStatus> = {}): TeamFilesStatus => ({
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
  warnings: [],
  ...over
})

const m = (id: string): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'builtin' }) as ProviderModel

const ITEM: ApprovalItem = { kind: 'teamFiles', projectId: 'p1', projectName: 'Demo', digest: 'ab'.repeat(32), label: 'Team files of Demo: 1 change to approve' }

const offerOf = (code: string, st = status()): ApprovalOffer => ({ offerId: 'f'.repeat(32), kind: 'teamFiles', projectId: 'p1', digest: st.digest!, actions: st.state === 'pending' ? ['approve', 'reject'] : [], codeActions: st.state === 'pending' ? ['approve'] : [], code, expiresAt: 1, teamFiles: st })

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


function api(over: Partial<ApprovalsApi> = {}): ApprovalsApi & { offers: ApprovalItem[]; answers: unknown[][] } {
  const offers: ApprovalItem[] = []
  const answers: unknown[][] = []
  let n = 0
  return {
    offers,
    answers,
    withheld: () => undefined,
    list: async () => [ITEM],
    waiting: async () => undefined,
    offer: async (item) => (offers.push(item), offerOf(++n === 1 ? 'KMNP' : 'WXYA', n === 1 ? status() : status({ state: 'in-sync', changes: [] }))),
    answer: async (...args) => (answers.push(args), { kind: 'teamFiles', action: 'approve', projectId: 'p1', message: 'Approved 1 change to the team of Demo.' }),
    ...over
  }
}

describe('/approvals in the shell', () => {
  it('opens the offer the host returned, takes the typed code and sends it; then shows the fresh offer', async () => {
    const a = api()
    const app = mount({ approvals: a })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    let f = app.frame()
    expect(f).toContain('Team files of Demo: 1 change to approve')
    expect(f).toContain('Reviewer gains Bash. (New tools)')
    expect(f).toContain('a approve · r reject')
    expect(a.offers).toEqual([ITEM])
    await app.typed('a')
    expect(app.frame()).toContain('Type KMNP to approve, then Enter')
    await app.typed('kmnp')
    await app.send(named('enter'))
    await tick()
    expect(a.answers).toEqual([['f'.repeat(32), 'approve', 'KMNP']])
    // Re-offered without the list's digest: the host binds what it reads now.
    expect(a.offers[1]).toMatchObject({ projectId: 'p1', digest: undefined })
    f = app.frame()
    expect(f).toContain('Approved 1 change to the team of Demo.')
    expect(f).toContain('Nothing to approve, reject, undo or commit here right now.')
    await app.send(named('escape'))
    expect(app.frame()).not.toContain('Team files of Demo: 1 change')
  })

  it("a terminal the host did not attest shows the host's reason and offers nothing", async () => {
    const a = api({ withheld: () => 'This orgai was started from inside an agent (claude, pid 7); approvals are never taken there.' })
    const app = mount({ approvals: a })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    const f = app.frame()
    expect(f).toContain('Not approved:')
    expect(f).toContain('inside an agent (claude, pid 7)')
    expect(a.offers).toEqual([])
    await app.typed('a')
    expect(a.answers).toEqual([])
  })

  it('a refused offer (the terminal fails the check now) shows the reason; a stale answer is shown again from a fresh offer', async () => {
    const refusing = api({ offer: async () => Promise.reject(Object.assign(new Error('A process OrgAI started shares this terminal (claude, pid 9).'), { code: 'scope_denied' })) })
    const app = mount({ approvals: refusing })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    expect(app.frame()).toContain('shares this terminal (claude, pid 9)')

    const stale = api({ answer: async () => Promise.reject(Object.assign(new Error('This changed since you looked. Review it again.'), { code: 'stale_target_digest' })) })
    const app2 = mount({ approvals: stale })
    await tick()
    await app2.typed('/approvals\r')
    await tick()
    await app2.typed('aKMNP')
    await app2.send(named('enter'))
    await tick()
    expect(app2.frame()).toContain('This changed since you looked. Review it again.')
    expect(stale.offers).toHaveLength(2)
  })

  it('a mistyped code stays on the same offer with the host words; a spent offer ends and is not offered again by itself', async () => {
    let n = 0
    const a = api({
      answer: async () => {
        n += 1
        throw Object.assign(new Error(n === 1 ? 'The code did not match; nothing was changed. 2 tries left.' : 'The code did not match too many times; nothing was changed. Open the approval again for a new code.'), {
          code: n === 1 ? 'bad_request' : 'stale_revision'
        })
      }
    })
    const app = mount({ approvals: a })
    await tick()
    await app.typed('/approvals\r')
    await tick()
    await app.typed('aKMNA')
    await app.send(named('enter'))
    await tick()
    let f = app.frame()
    expect(f).toContain('2 tries left.')
    expect(f).toContain('Type KMNP to approve')
    expect(a.offers).toHaveLength(1)
    await app.typed('KMNX')
    await app.send(named('enter'))
    await tick()
    f = app.frame()
    expect(f).toContain('Not approved:')
    expect(f).toContain('too many times')
    expect(a.offers).toHaveLength(1)
  })

  it('says on open when something waits', async () => {
    const app = mount({ approvals: api({ waiting: async () => 'Waiting for your approval: team files of 1 project. Type /approvals.' }) })
    await tick()
    await tick()
    expect(app.frame()).toContain('Waiting for your approval: team files of 1 project. Type /approvals.')
  })
})
