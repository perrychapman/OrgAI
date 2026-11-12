import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { Project, RunSummary } from '../../shared/types'

// The T1-T4 modules are stubs in this task's worktree (and may change shape inside): replace them with small fakes so
// this file tests composition, focus and routing only.

const seen = vi.hoisted(() => ({ transcriptRows: [] as { key: string; text: string }[][], composerText: '' }))

vi.mock('./selectors', () => {
  type S = { testCards?: unknown[]; testLive?: number; testRows?: unknown[] }
  return {
    trayCards: (s: S) => s.testCards ?? [],
    topCard: (s: S) => (s.testCards ?? [])[0],
    orgTreeRows: () => [],
    cardsByAgent: () => ({}),
    collapseTarget: () => undefined,
    resolveSelectedRow: (_rows: unknown, id: string | undefined) => id,
    transcriptRows: (s: S) => ({ rows: s.testRows ?? [], omitted: 0 }),
    partialRows: () => [],
    planView: () => undefined,
    worktreeRows: () => [],
    statusSummary: (s: S) => ({ needsYou: (s.testCards ?? []).length, liveRuns: s.testLive ?? 0, connection: 'live' }),
    composerMode: () => 'send',
    runTagOf: (s: { runOrder: string[] }, id: string) => `R${s.runOrder.indexOf(id) + 1}`
  }
})

vi.mock('./layout', () => ({
  computeLayout: (input: { cols: number; rows: number; trayRows: number; visible: Record<string, boolean> }) => ({
    mode: 'split',
    statusRows: 1,
    panes: (['tree', 'transcript', 'plan', 'worktrees'] as const).filter((p) => input.visible[p]).map((pane) => ({ pane, column: pane === 'tree' ? 0 : 1, width: 40, height: 5 })),
    tray: { width: input.cols, height: input.trayRows },
    composer: { width: input.cols, height: 3 }
  })
}))

vi.mock('./input/keys', () => ({
  KeyParser: class {},
  PASTE_MAX_CHARS: 10,
  isTrayFocusKey: (e: { type: string; name?: string; ch?: string; ctrl?: boolean; alt?: boolean }) =>
    e.type === 'key' && (e.name === 'f2' || (e.name === 'char' && e.alt === true && e.ch === 'd') || (e.name === 'char' && e.ctrl === true && e.ch === '.'))
}))

vi.mock('./decisions', () => ({
  proposalPreview: () => undefined,
  cardDetailLines: (card: { key: string }) => [`DETAIL ${card.key}`, 'second line'],
  cardTitle: () => 'title',
  bindingsFor: () => [],
  decisionFor: () => ({ channel: 'runs:decide', payload: {} }),
  cardFullText: () => ''
}))

vi.mock('./pager', () => ({ showInPager: vi.fn(async () => 'no-pager'), pagerCommand: () => null }))
vi.mock('./slashCommands', () => ({ SLASH_COMMANDS: [], matchSlash: () => [], parseSlash: () => null }))

vi.mock('./Composer', async () => {
  const { useFocusHandler } = await import('./context')
  const { useState } = await import('react')
  const ink = await import('ink')
  return {
    Composer: (p: { focused: boolean; onSubmit(t: string): void }) => {
      const [text, setText] = useState('')
      seen.composerText = text
      useFocusHandler('composer', (e) => {
        if (e.type !== 'key') return true
        if (e.name === 'char' && e.ctrl && (e.ch === 'c' || e.ch === 'd')) {
          if (!text) return false
          setText('')
          return true
        }
        if (e.name === 'char' && !e.ctrl && !e.alt && e.ch) {
          setText((t) => t + e.ch)
          return true
        }
        if (e.name === 'enter') {
          p.onSubmit(text)
          setText('')
          return true
        }
        return false
      })
      return <ink.Text>COMPOSER{p.focused ? '*' : ''}[{text}]</ink.Text>
    }
  }
})

vi.mock('./DecisionTray', async () => {
  const { useFocusHandler } = await import('./context')
  const ink = await import('ink')
  return {
    DecisionTray: (p: { focused: boolean; cards: unknown[]; variant: string; onLeave(): void }) => {
      useFocusHandler('tray', (e) => {
        if (e.type === 'key' && e.name === 'escape') {
          p.onLeave()
          return true
        }
        return true
      })
      return (
        <ink.Text>
          TRAY{p.focused ? '*' : ''}({p.cards.length},{p.variant})
        </ink.Text>
      )
    }
  }
})

vi.mock('./SlashPalette', async () => {
  const ink = await import('ink')
  return { SlashPalette: () => <ink.Text>PALETTE</ink.Text> }
})
vi.mock('./StatusBar', async () => {
  const ink = await import('ink')
  return { StatusBar: (p: { notice?: { text: string } }) => <ink.Text>STATUS {p.notice?.text ?? ''}</ink.Text> }
})
const paneMock = vi.hoisted(() => (name: string) => async () => {
  const ink = await import('ink')
  const { createElement } = await import('react')
  return { [`${name}Pane`]: (p: { focused: boolean }) => createElement(ink.Text, null, `${name.toUpperCase()}${p.focused ? '*' : ''}`) }
})
vi.mock('./OrgTreePane', () => paneMock('OrgTree')())
vi.mock('./PlanPane', () => paneMock('Plan')())
vi.mock('./WorktreesPane', () => paneMock('Worktrees')())
vi.mock('./TranscriptPane', async () => {
  const ink = await import('ink')
  return {
    TranscriptPane: (p: { focused: boolean; rows: { key: string; text: string }[] }) => {
      seen.transcriptRows.push(p.rows)
      return (
        <ink.Text>
          TRANSCRIPT{p.focused ? '*' : ''} {p.rows.map((r) => r.text).join('|')}
        </ink.Text>
      )
    }
  }
})

const { App, CTRL_C_QUIT_MS, NOTHING_NEEDS_YOU, PASTE_CUT_NOTICE, PRESS_AGAIN, runForRef } = await import('./App')
const { DEFAULT_TUI_ENV } = await import('./context')
type Ev = import('./types').InputEvent
type KeyEv = import('./types').KeyEvent

const key = (ch: string, extra: Partial<KeyEv> = {}): Ev => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEv['name'], extra: Partial<KeyEv> = {}): Ev => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '', ...extra })
const ctrlKey = (ch: string): Ev => key(ch, { ctrl: true })

const tick = () => new Promise((r) => setTimeout(r, 10))

interface TestState {
  folder: string
  runs: Record<string, TestRun>
  runOrder: string[]
  activeChain: string[]
  activeRunId?: string
  project?: Project
  composeTarget: 'active'
  notices: { id: number; text: string; at: number }[]
  resolved: never[]
  cardSeq: number
  connection: 'live'
  readOnlyReason?: string
  testCards?: { key: string; ref: { runId: string } }[]
  testLive?: number
  testRows?: { key: string; runId: string; kind: string; text: string }[]
}

/** Keep App fixtures on the same shape as the session's real TuiRun snapshots. */
interface TestRun {
  summary: Partial<RunSummary>
  agents?: Record<string, never>
  transcript?: unknown[]
  partials?: Record<string, string>
  cards?: {
    permissions: unknown[]
    questions: unknown[]
    proposals: unknown[]
    ruleRequests: unknown[]
    mergeReviews: unknown[]
    mcpInstalls: unknown[]
  }
  recordLoaded?: boolean
  messages?: unknown[]
}

const completeRun = (id: string, run: TestRun): TestRun => ({
  ...run,
  summary: { id, status: 'idle', ...run.summary },
  agents: run.agents ?? {},
  transcript: run.transcript ?? [],
  partials: run.partials ?? {},
  cards: run.cards ?? { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] },
  recordLoaded: run.recordLoaded ?? true
})

const completeRuns = (runs: Record<string, TestRun>): Record<string, TestRun> =>
  Object.fromEntries(Object.entries(runs).map(([id, run]) => [id, completeRun(id, run)]))

function fakeSession(initial: Partial<TestState> = {}, hostKind: 'daemon' | 'inproc' | 'desktop' = 'daemon') {
  let state: TestState = {
    folder: '/work/repo',
    runOrder: [],
    activeChain: [],
    composeTarget: 'active',
    notices: [],
    resolved: [],
    cardSeq: 0,
    connection: 'live',
    ...initial,
    runs: completeRuns(initial.runs ?? {})
  }
  const subs = new Set<() => void>()
  let n = 0
  const set = (patch: Partial<TestState>) => {
    state = { ...state, ...patch, ...(patch.runs ? { runs: completeRuns(patch.runs) } : {}) }
    for (const fn of [...subs]) fn()
  }
  const api = {
    getState: () => state as never,
    subscribe: (fn: () => void) => {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
    hostKind,
    hostInstanceId: 'h1',
    focusRun: vi.fn(async () => undefined),
    setComposeTarget: vi.fn((_t: string) => undefined),
    submitPrompt: vi.fn(async (_text: string, _o?: unknown) => undefined),
    startQuick: vi.fn(async () => ({}) as RunSummary),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    decide: vi.fn(async () => ({ status: 'decided' }) as never),
    worktreeDiff: vi.fn(async () => ({ stat: '', patch: '' })),
    listRuns: vi.fn(async () => []),
    openInDesktop: vi.fn(async () => undefined),
    resync: vi.fn(async () => undefined),
    notify: vi.fn((text: string) => set({ notices: [...state.notices, { id: ++n, text, at: 0 }] })),
    close: vi.fn(async () => undefined)
  }
  return { api, set, state: () => state }
}

function mount(opts: { session?: ReturnType<typeof fakeSession>; inline?: boolean; inproc?: boolean | object; onboarding?: boolean; now?: () => number; launch?: import('./types').TuiLaunch } = {}) {
  const s = opts.session ?? fakeSession()
  const listeners = new Set<(e: Ev) => void>()
  const input = { subscribe: (fn: (e: Ev) => void) => (listeners.add(fn), () => void listeners.delete(fn)) }
  const resumeFns = new Set<() => void>()
  const terminal = {
    suspended: false,
    resumeNow() {
      this.suspended = false
      for (const fn of [...resumeFns]) fn()
    },
    bufferMode: opts.inline ? ('inline' as const) : ('fullscreen' as const),
    bracketedPaste: true,
    enter: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    restore: vi.fn(),
    size: () => ({ cols: 120, rows: 40 }),
    onResize: () => () => undefined,
    onResume: (fn: () => void) => (resumeFns.add(fn), () => void resumeFns.delete(fn)),
    stopSelf: vi.fn()
  }
  const P = { id: 'p_new', name: 'repo', path: '/work/repo' } as Project
  const next = fakeSession({ project: P })
  const conn = {
    client: {} as never,
    hello: {} as never,
    started: false,
    inproc: (opts.inproc && opts.inproc !== true ? opts.inproc : {}) as never,
    projects: vi.fn(async () => []),
    checkPath: vi.fn(async () => ({ exists: true, isDirectory: true, isGitRepo: true, suggestedName: 'repo', empty: false })),
    createProject: vi.fn(async () => P),
    startSetup: vi.fn(async () => ({ id: 'run_setup' }) as RunSummary),
    close: vi.fn(async () => undefined)
  }
  const exits: [number, unknown][] = []
  const openSession = vi.fn(async () => next.api as never)
  const r = render(
    <App
      session={s.api as never}
      terminal={terminal}
      env={{ ...DEFAULT_TUI_ENV, bufferMode: opts.inline ? 'inline' : 'fullscreen' }}
      launch={opts.launch ?? (opts.onboarding ? { onboarding: { folder: '/work/repo' } } : {})}
      conn={conn as never}
      input={input}
      openSession={openSession}
      processEnv={{}}
      onExit={(code, info) => exits.push([code, info])}
      {...(opts.now ? { now: opts.now } : {})}
    />
  )
  const send = async (...events: Ev[]) => {
    for (const e of events) {
      for (const fn of [...listeners]) fn(e)
      await tick()
    }
  }
  return { r, s, send, exits, terminal, conn, openSession, next, frame: () => r.lastFrame() ?? '' }
}

const card = (k: string) => ({ key: k, ref: { runId: 'run_1' } })

describe('App launch prompt and suspension', () => {
  it('orgai -- <prompt> starts a new run even when the session focused a live run (cli-spec 6.1)', async () => {
    const s = fakeSession({ activeRunId: 'run_live', runs: { run_live: { summary: { id: 'run_live', status: 'idle' } } }, runOrder: ['run_live'], activeChain: ['run_live'] })
    const order: string[] = []
    s.api.setComposeTarget.mockImplementation((t: string) => void order.push(`target:${t}`))
    s.api.submitPrompt.mockImplementation(async (text: string) => void order.push(`submit:${text}`))
    mount({ session: s, launch: { prompt: 'fix the login bug', team: 'single' } })
    await tick()
    expect(order).toEqual(['target:new', 'submit:fix the login bug'])
    expect(s.api.submitPrompt).toHaveBeenCalledWith('fix the login bug', { team: 'single' })
  })

  it('resume text still goes to the focused chain (no new-run target)', async () => {
    const s = fakeSession()
    mount({ session: s, launch: { resumeText: 'carry on' } })
    await tick()
    expect(s.api.setComposeTarget).not.toHaveBeenCalled()
    expect(s.api.submitPrompt).toHaveBeenCalledWith('carry on')
  })

  it('holds the view still while the terminal is suspended and redraws on resume', async () => {
    const s = fakeSession({
      activeRunId: 'run_1',
      activeChain: ['run_1'],
      runOrder: ['run_1'],
      runs: { run_1: { summary: { id: 'run_1', status: 'running' } } },
      testRows: [{ key: 'a', runId: 'r', kind: 'text', text: 'first' }]
    })
    const m = mount({ session: s })
    await tick()
    expect(m.frame()).toContain('first')
    m.terminal.suspended = true
    s.set({ testRows: [{ key: 'a', runId: 'r', kind: 'text', text: 'first' }, { key: 'b', runId: 'r', kind: 'text', text: 'second' }] })
    await tick()
    expect(m.frame()).not.toContain('second')
    m.terminal.resumeNow()
    await tick()
    expect(m.frame()).toContain('second')
  })
})

describe('App focus and routing', () => {
  it('says so when a paste reached the paste cap (KeyParser cut it)', async () => {
    const m = mount()
    await tick()
    await m.send({ type: 'paste', text: 'short' } as Ev)
    expect(m.s.api.notify).not.toHaveBeenCalledWith(PASTE_CUT_NOTICE, 'warn')
    await m.send({ type: 'paste', text: 'x'.repeat(10) } as Ev)
    expect(m.s.api.notify).toHaveBeenLastCalledWith(PASTE_CUT_NOTICE, 'warn')
    m.r.unmount()
  })

  it('focuses the tray with Alt+D / F2 / Ctrl+. only when cards exist', async () => {
    const m = mount()
    await tick()
    expect(m.frame()).toContain('COMPOSER*')
    await m.send(key('d', { alt: true }))
    expect(m.s.api.notify).toHaveBeenLastCalledWith(NOTHING_NEEDS_YOU, undefined)
    expect(m.frame()).toContain('COMPOSER*')
    m.s.set({ testCards: [card('c1')] })
    await tick()
    for (const e of [key('d', { alt: true }), named('f2'), key('.', { ctrl: true })]) {
      await m.send(e)
      expect(m.frame()).toContain('TRAY*')
      await m.send(named('escape'))
      expect(m.frame()).toContain('COMPOSER*')
    }
    m.r.unmount()
  })

  it('characters typed in the composer never reach the tray', async () => {
    const m = mount({ session: fakeSession({ testCards: [card('c1')] }) })
    await m.send(key('y'), key('a'))
    expect(m.frame()).toContain('COMPOSER*[ya]')
    expect(m.s.api.decide).not.toHaveBeenCalled()
    m.r.unmount()
  })

  it('Shift+Tab goes from the composer to the tray, Esc comes back', async () => {
    const m = mount({ session: fakeSession({ testCards: [card('c1')] }) })
    await m.send(named('backtab', { shift: true }))
    expect(m.frame()).toContain('TRAY*')
    await m.send(named('escape'))
    expect(m.frame()).toContain('COMPOSER*')
    m.r.unmount()
  })

  it('Tab cycles the visible panes and back to the composer', async () => {
    const m = mount({
      session: fakeSession({
        activeRunId: 'run_1',
        activeChain: ['run_1'],
        runOrder: ['run_1'],
        runs: { run_1: { summary: { id: 'run_1', status: 'running' } } }
      })
    })
    const order: string[] = []
    // Plan and Worktrees show only when something needs them (nothing does here), so the ring is tree, transcript, composer.
    for (let i = 0; i < 3; i++) {
      await m.send(named('tab'))
      order.push(['ORGTREE*', 'TRANSCRIPT*', 'PLAN*', 'WORKTREES*', 'COMPOSER*'].find((t) => m.frame().includes(t)) ?? '?')
    }
    expect(order).toEqual(['ORGTREE*', 'TRANSCRIPT*', 'COMPOSER*'])
    await m.send(named('tab'), named('backtab'))
    expect(m.frame()).toContain('COMPOSER*')
    m.r.unmount()
  })

  it('Ctrl+C clears a non-empty composer; twice within 1.5 s on an empty one quits', async () => {
    let t = 1000
    const m = mount({ now: () => t })
    await m.send(key('x'), ctrlKey('c'))
    expect(m.frame()).toContain('COMPOSER*[]')
    expect(m.s.api.notify).not.toHaveBeenCalledWith(PRESS_AGAIN)
    await m.send(ctrlKey('c'))
    expect(m.s.api.notify).toHaveBeenLastCalledWith(PRESS_AGAIN, 'warn')
    t += CTRL_C_QUIT_MS + 1
    await m.send(ctrlKey('c'))
    expect(m.exits).toEqual([])
    t += 500
    await m.send(ctrlKey('c'))
    expect(m.exits.map((e) => e[0])).toEqual([0])
    m.r.unmount()
  })

  it('Ctrl+D quits on an empty composer only', async () => {
    const m = mount()
    await m.send(key('x'), ctrlKey('d'))
    expect(m.exits).toEqual([])
    await m.send(ctrlKey('d'))
    expect(m.exits.map((e) => e[0])).toEqual([0])
    m.r.unmount()
  })

  it('Esc interrupts a running run, not an idle one', async () => {
    const s = fakeSession({ activeRunId: 'run_1', runs: { run_1: { summary: { id: 'run_1', status: 'idle' } } } })
    const m = mount({ session: s })
    await m.send(named('escape'))
    expect(s.api.interrupt).not.toHaveBeenCalled()
    s.set({ runs: { run_1: { summary: { id: 'run_1', status: 'running' } } } })
    await tick()
    await m.send(named('escape'))
    expect(s.api.interrupt).not.toHaveBeenCalled()
    expect(s.api.notify).toHaveBeenLastCalledWith('Press Esc again to interrupt the run.', undefined)
    await m.send(named('escape'))
    expect(s.api.interrupt).toHaveBeenCalledTimes(1)
    expect(s.api.notify).toHaveBeenLastCalledWith('Interrupting the run...', undefined)
    m.r.unmount()
  })

  it('the second Esc after ESC_INTERRUPT_MS only asks again; an idle run says nothing is running', async () => {
    let t = 1000
    const s = fakeSession({ activeRunId: 'run_1', runs: { run_1: { summary: { id: 'run_1', status: 'running' } } } })
    const m = mount({ session: s, now: () => t })
    await m.send(named('escape'))
    t += 2000
    await m.send(named('escape'))
    expect(s.api.interrupt).not.toHaveBeenCalled()
    await m.send(key('x'), named('escape')) // a key in between resets
    expect(s.api.interrupt).not.toHaveBeenCalled()
    s.set({ runs: { run_1: { summary: { id: 'run_1', status: 'idle' } } } })
    await tick()
    await m.send(named('escape'))
    expect(s.api.notify).toHaveBeenLastCalledWith('Nothing is running.', undefined)
    m.r.unmount()
  })

  it('Tab in inline mode never moves focus to invisible panes and explains once', async () => {
    const m = mount({ inline: true })
    await tick()
    await m.send(named('tab'), named('tab'))
    expect(m.frame()).toContain('COMPOSER*')
    const calls = m.s.api.notify.mock.calls.filter((c) => String(c[0]).startsWith('Panes need a full-screen'))
    expect(calls.length).toBe(1)
    m.r.unmount()
  })


  it('Ctrl+Z suspends and stops through the terminal', async () => {
    const m = mount()
    await m.send(ctrlKey('z'))
    expect(m.terminal.stopSelf).toHaveBeenCalledTimes(1)
    m.r.unmount()
  })

  it('Enter in the composer submits through the session', async () => {
    const m = mount()
    await m.send(key('h'), key('i'), named('enter'))
    expect(m.s.api.submitPrompt).toHaveBeenCalledWith('hi')
    m.r.unmount()
  })
})

describe('App inline mode', () => {
  it("prints a new top card's detail lines once into the scrollback, and uses the footer tray", async () => {
    seen.transcriptRows.length = 0
    const s = fakeSession({ testRows: [{ key: 't1', runId: 'run_1', kind: 'text', text: 'hello' }] })
    const m = mount({ session: s, inline: true })
    s.set({ testCards: [card('c1')] })
    await tick()
    s.set({ testRows: [{ key: 't1', runId: 'run_1', kind: 'text', text: 'hello' }, { key: 't2', runId: 'run_1', kind: 'text', text: 'world' }] })
    await tick()
    s.set({ notices: [] })
    await tick()
    const last = seen.transcriptRows.at(-1) ?? []
    expect(last.map((r) => r.key)).toEqual(['t1', 'card:c1', 't2'])
    expect(last[1].text).toBe('DETAIL c1\nsecond line')
    expect(m.frame()).toContain('TRAY(1,footer)')
    s.set({ testCards: [card('c2'), card('c1')] })
    await tick()
    expect((seen.transcriptRows.at(-1) ?? []).filter((r) => r.key.startsWith('card:')).map((r) => r.key)).toEqual(['card:c1', 'card:c2'])
    m.r.unmount()
  })
})

describe('App quitting', () => {
  it('an inproc host with live runs asks first; n keeps going, y quits', async () => {
    const m = mount({ inproc: true, session: fakeSession({ testLive: 2 }, 'inproc') })
    await m.send(ctrlKey('d'))
    expect(m.frame()).toContain('Quit and stop 2 active runs?')
    await m.send(key('n'))
    expect(m.exits).toEqual([])
    expect(m.frame()).not.toContain('Quit and stop')
    await m.send(ctrlKey('d'), key('y'))
    expect(m.exits.map((e) => e[0])).toEqual([0])
    m.r.unmount()
  })

  it("counts every live run on this terminal's host, also ones other terminals or projects started", async () => {
    const inproc = { status: () => ({ handoff: { workingRuns: 2, waitingRuns: 1, heldRuns: 0, pausedRuns: 0, openCards: 0, terminalSessions: 2 } }) }
    const m = mount({ inproc, session: fakeSession({ testLive: 1 }, 'inproc') })
    await m.send(ctrlKey('d'))
    expect(m.frame()).toContain('Quit and stop 3 active runs, 2 of them from other projects?')
    await m.send(key('n'))
    m.r.unmount()
  })

  it('onboarding: Ctrl+C, Ctrl+D and Esc ask first when other terminals have runs on this host, none listed here', async () => {
    const inproc = { status: () => ({ handoff: { workingRuns: 1, waitingRuns: 0, heldRuns: 0, pausedRuns: 0, openCards: 0, terminalSessions: 2 } }) }
    for (const [label, quit] of [['ctrl+c', ctrlKey('c')], ['ctrl+d', ctrlKey('d')], ['esc', named('escape')]] as const) {
      const m = mount({ inproc, onboarding: true, session: fakeSession({}, 'inproc') })
      await tick()
      await m.send(quit)
      const flat = m.frame().replace(/[│|]/g, ' ').replace(/\s+/g, ' ')
      expect(flat, label).toContain('Quit and stop 1 active run, 1 of them from other projects?')
      expect(m.exits).toEqual([])
      await m.send(key('y'))
      expect(m.exits.map((e) => e[0])).toEqual([0])
      m.r.unmount()
    }
  })
})

describe('App onboarding', () => {
  it('shows onboarding, checks the folder, and [3] creates the project and opens a session on it', async () => {
    const m = mount({ onboarding: true })
    await tick()
    expect(m.frame()).toContain('[1] Quick run in this folder')
    expect(m.conn.checkPath).toHaveBeenCalledWith('/work/repo')
    await m.send(key('3'))
    await tick()
    expect(m.conn.createProject).toHaveBeenCalledWith({ name: 'repo', path: '/work/repo', brief: '', kind: 'code' })
    expect(m.openSession).toHaveBeenCalledWith({ project: expect.objectContaining({ id: 'p_new' }), folder: '/work/repo' })
    expect(m.frame()).toContain('COMPOSER*')
    expect(m.s.api.close).toHaveBeenCalled()
    m.r.unmount()
  })

  it('[2] starts the Architect on the new project and focuses that setup run', async () => {
    const m = mount({ onboarding: true })
    await tick()
    await m.send(key('2'))
    await tick()
    expect(m.conn.startSetup).toHaveBeenCalledWith('p_new')
    expect(m.openSession).toHaveBeenCalledWith({ project: expect.objectContaining({ id: 'p_new' }), runId: 'run_setup', folder: '/work/repo' })
    m.r.unmount()
  })

  it('[1] then a message starts a quick run; Esc cancels with exit 0', async () => {
    const m = mount({ onboarding: true })
    await tick()
    await m.send(key('e'), key('1'), key('o'), key('k'), named('enter'))
    expect(m.s.api.startQuick).toHaveBeenCalledWith({ prompt: 'ok', allowEdits: true })
    m.r.unmount()
    const c = mount({ onboarding: true })
    await tick()
    await c.send(named('escape'))
    expect(c.exits.map((e) => e[0])).toEqual([0])
    c.r.unmount()
  })
})

describe('runForRef', () => {
  it('resolves R#, ids and unique prefixes', () => {
    const s = { runOrder: ['run_aaaaaa1', 'run_bbbbbb2'], runs: {} } as never
    expect(runForRef(s, 'R2')).toBe('run_bbbbbb2')
    expect(runForRef(s, 'r1')).toBe('run_aaaaaa1')
    expect(runForRef(s, 'R3')).toBeUndefined()
    expect(runForRef(s, 'run_bbb')).toBe('run_bbbbbb2')
    expect(runForRef(s, 'run_')).toBeUndefined()
  })
})

describe('App exitWhenEnded / stopOnQuit (Wave 5 interactive runs)', async () => {
  const { PRESS_AGAIN_STOP, STOP_WAIT_MS, launchedRunExit, setupCompletedSince } = await import('./App')
  const open = (status: RunSummary['status'], extra: Partial<RunSummary> = {}) => ({
    activeRunId: 'run_s',
    activeChain: ['run_s'],
    runOrder: ['run_s'],
    runs: { run_s: { summary: { id: 'run_s', kind: 'setup' as const, status, ...extra } } }
  })
  const LAUNCH = { runId: 'run_s', exitWhenEnded: true, stopOnQuit: true, title: 'Architect setup' }

  it('exits 0 when the launched run finishes, 1 on error or pause, 130 when someone else stopped it', async () => {
    for (const [patch, code] of [
      [{ status: 'finished' }, 0],
      [{ status: 'error', error: 'boom' }, 1],
      [{ status: 'finished', endedBy: 'user' }, 130],
      [{ status: 'paused' }, 1]
    ] as [Partial<RunSummary>, number][]) {
      const s = fakeSession(open('running'))
      const m = mount({ session: s, launch: LAUNCH })
      await tick()
      expect(m.exits).toEqual([])
      s.set({ runs: { run_s: { summary: { id: 'run_s', kind: 'setup', ...patch } } } })
      await tick()
      expect(m.exits.map((e) => e[0])).toEqual([code])
        m.r.unmount()
    }
  })

  it('a finished run prints a closing line; errors carry the reason', () => {
    expect(launchedRunExit({ status: 'finished', kind: 'setup' }, 'Architect setup', undefined)).toEqual({ code: 0, message: 'Architect setup finished.' })
    expect(launchedRunExit({ status: 'error', kind: 'setup', error: 'bad\nthing' }, 'Architect setup', undefined)).toEqual({ code: 1, message: 'Architect setup failed: bad thing' })
    expect(launchedRunExit({ status: 'finished', kind: 'setup', endedBy: 'user' }, 'X', 'quit').code).toBe(130)
    expect(launchedRunExit({ status: 'finished', kind: 'setup', endedBy: 'user' }, 'X', 'slash').code).toBe(0)
    expect(launchedRunExit({ status: 'finished', kind: 'setup', endedBy: 'user' }, 'X', 'slash', false)).toEqual({ code: 1, message: 'X ended before the setup was complete. Run orgai init again to finish it.' })
    expect(launchedRunExit({ status: 'finished', kind: 'mcp-assist', endedBy: 'user' }, 'X', 'slash', false).code).toBe(0)
    expect(launchedRunExit({ status: 'finished', kind: 'setup', endedBy: 'user' }, 'X', 'complete').code).toBe(0)
    expect(launchedRunExit({ status: 'finished', kind: 'setup', endedBy: 'user' }, 'X', undefined).message).toBe('X: Stopped.')
  })

  it('ends a setup run once complete_setup marked the setup complete and it is idle, then exits 0', async () => {
    const before = { id: 'p1', name: 'P', setup: { kind: 'existing', state: 'complete', completedAt: 'old' } } as unknown as Project
    expect(setupCompletedSince(before, 'old')).toBe(false)
    const s = fakeSession({ ...open('running'), project: before })
    const m = mount({ session: s, launch: { ...LAUNCH, project: before } })
    await tick()
    const after = { ...before, setup: { kind: 'existing', state: 'complete', completedAt: 'new' } } as unknown as Project
    expect(setupCompletedSince(after, 'old')).toBe(true)
    s.set({ project: after })
    await tick()
    expect(s.api.stop).not.toHaveBeenCalled() // still running: the closing message comes first
    s.set({ ...open('idle'), project: after })
    await tick()
    expect(s.api.stop).toHaveBeenCalledTimes(1)
    s.set({ ...open('finished', { endedBy: 'user' }), project: after })
    await tick()
    expect(m.exits.map((e) => e[0])).toEqual([0])
    expect(m.exits[0][1]).toMatchObject({ message: 'Architect setup finished.' })
    m.r.unmount()
  })

  it('stopOnQuit: Ctrl+C twice stops the run (runs:stop), waits for it, exits 130', async () => {
    const s = fakeSession(open('idle'))
    s.api.stop.mockImplementation(async () => {
      s.set(open('finished', { endedBy: 'user' }))
    })
    let t = 1000
    const m = mount({ session: s, launch: LAUNCH, now: () => t })
    await m.send(ctrlKey('c'))
    expect(s.api.notify).toHaveBeenLastCalledWith(PRESS_AGAIN_STOP, 'warn')
    t += 100
    await m.send(ctrlKey('c'))
    await tick()
    expect(s.api.stop).toHaveBeenCalledTimes(1)
    expect(m.exits.map((e) => e[0])).toEqual([130])
    expect(m.exits[0][1]).toMatchObject({ message: 'Architect setup stopped.' })
    m.r.unmount()
  })

  it('stopOnQuit: a failed runs:stop never claims "stopped"; it exits 1 and says the run keeps going', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const s = fakeSession(open('running'))
      s.api.stop.mockRejectedValue(new Error('The host refused the stop.'))
      let t = 1000
      const m = mount({ session: s, launch: LAUNCH, now: () => t })
      await m.send(ctrlKey('c'))
      t += 100
      await m.send(ctrlKey('c'))
      await tick()
      expect(s.api.stop).toHaveBeenCalledTimes(1)
      expect(m.exits).toEqual([]) // still waiting (bounded) for a status in case the stop landed anyway
      await vi.advanceTimersByTimeAsync(STOP_WAIT_MS + 10)
      expect(m.exits.map((e) => e[0])).toEqual([1])
      expect(m.exits[0][1]).toMatchObject({ message: 'Could not stop Architect setup: The host refused the stop.' })
      expect((m.exits[0][1] as { message?: string }).message).not.toContain('stopped.')
      m.r.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopOnQuit: a failed runs:stop whose run still ended exits 130 "stopped"', async () => {
    const s = fakeSession(open('running'))
    s.api.stop.mockImplementation(async () => {
      s.set(open('finished', { endedBy: 'user' }))
      throw new Error('connection dropped')
    })
    let t = 1000
    const m = mount({ session: s, launch: LAUNCH, now: () => t })
    await m.send(ctrlKey('c'))
    t += 100
    await m.send(ctrlKey('c'))
    await tick()
    expect(m.exits.map((e) => e[0])).toEqual([130])
    expect(m.exits[0][1]).toMatchObject({ message: 'Architect setup stopped.' })
    m.r.unmount()
  })

  it('stopOnQuit on an in-process host stops without the quit confirmation', async () => {
    const s = fakeSession({ ...open('running'), testLive: 1 }, 'inproc')
    s.api.stop.mockImplementation(async () => {
      s.set(open('finished', { endedBy: 'user' }))
    })
    const m = mount({ session: s, launch: LAUNCH, inproc: true })
    await m.send(ctrlKey('d'))
    await tick()
    expect(m.frame()).not.toContain('Quit and stop')
    expect(s.api.stop).toHaveBeenCalledTimes(1)
    expect(m.exits.map((e) => e[0])).toEqual([130])
    m.r.unmount()
  })

  it('a normal session asks before quitting a live run and does not stop the run itself (the host stop ends it)', async () => {
    const s = fakeSession({ ...open('running'), testLive: 1 })
    const m = mount({ session: s, launch: { runId: 'run_s' } })
    await m.send(ctrlKey('d'))
    expect(m.exits).toEqual([])
    await m.send(key('y'))
    expect(s.api.stop).not.toHaveBeenCalled()
    expect(m.exits).toEqual([[0, { session: s.api }]])
    s.set(open('finished'))
    await tick()
    expect(m.exits).toHaveLength(1)
    m.r.unmount()
  })
})

void Text
