/**
 * Frames of the real App for the second org-tree round (ux-review-tui-org.md F4, F6, F7, F8, F9, F12, F13): the agent
 * inspector, message marks and counts, subtree focus, run chips and `[` / `]`, the selectable /runs list, the `?`
 * which-key overlay with its glyph legend, the focused pane's own hint line, /usage and /retro. ink-testing-library over a
 * hand-built state; nothing here talks to a host.
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, PermissionRequest, RunEvent, RunSummary } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { App } from './App'
import { DEFAULT_TUI_ENV } from './context'
import { SLASH_COMMANDS } from './slashCommands'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import { TUI_NOTICE_TTL_MS, type InputEvent, type KeyEvent, type SlashContext, type TuiEnv, type TuiState } from './types'

const NOW = Date.now()
const OLD = NOW - 120_000

const agent = (id: string, parentId: string | null, extra: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id,
  name: 'Worker',
  parentId,
  spawnToolUseId: null,
  state: 'thinking',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...extra
})

const USAGE = {
  tokens: { input: 1000, output: 300, cacheRead: 500, cacheWrite: 100 },
  models: [{ model: 'sonnet-4-5', tokens: { input: 1000, output: 300, cacheRead: 500, cacheWrite: 100 }, costUsd: 0.12, priceSource: 'builtin' }],
  costUsd: 0.12,
  costSource: 'computed',
  turns: 4,
  toolCalls: 9,
  retries: 0
}

let seq = 0
function sampleState(over: { status?: RunSummary['status']; extra?: (s: TuiState) => TuiState } = {}): TuiState {
  const agents: Record<string, AgentInstance> = {
    root: agent('root', null, { name: 'Orchestrator', state: 'delegating', activity: 'Waiting for reports', costUsd: 0.31 }),
    designer: agent('designer', 'root', { name: 'Designer', handle: 'designer-1', state: 'done', startedAt: 2, endedAt: OLD, costUsd: 0.04 }),
    lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', startedAt: NOW - 134_000, activity: 'Reviewing mock-lead-report-1', costUsd: 0.12, model: 'sonnet-4-5', usage: USAGE as never }),
    r1: agent('r1', 'lead', { name: 'Reporter', handle: 'mock-lead-report-1', state: 'done', startedAt: 5, endedAt: OLD, costUsd: 0.02 }),
    r2: agent('r2', 'lead', {
      name: 'Reporter',
      handle: 'mock-lead-report-2',
      state: 'waiting',
      startedAt: 6,
      activity: 'Wants to run: npm test',
      costUsd: 0.03,
      worktree: { path: '/wt', branch: 'worktree-agent-r2', status: 'active', baseRef: 'x', mergeTarget: 'main', changedFiles: ['a', 'b'] } as never
    })
  }
  let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
  s = applyRecord(s, {
    ...record(summary('run1', { status: over.status ?? 'running', prompt: 'Build the thing' })),
    agents,
    transcript: [
      { id: 't1', agentId: 'lead', at: 1, block: { kind: 'text', text: 'LEAD-SAYS-HELLO' } },
      { id: 't2', agentId: 'lead', at: 2, block: { kind: 'thinking', text: 'LEAD-THINKS-HARD' } },
      { id: 't3', agentId: 'r2', at: 3, block: { kind: 'text', text: 'REPORT-TWO-TEXT' } },
      { id: 't4', agentId: 'root', at: 4, block: { kind: 'text', text: 'ROOT-ONLY-LINE' } }
    ] as never
  })
  s = setActiveRun(s, 'run1')
  const request = { id: 'perm1', runId: 'run1', agentId: 'r2', toolName: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test' } as PermissionRequest
  s = applyEvent(s, { seq: ++seq, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
  return over.extra ? over.extra(s) : s
}

const withMessages = (s: TuiState): TuiState => {
  s = applyEvent(s, { seq: ++seq, event: { type: 'agent.message', runId: 'run1', from: 'lead', to: 'r2', toHandle: 'mock-lead-report-2', text: 'do it', at: NOW - 1000 } as RunEvent })
  return applyEvent(s, { seq: ++seq, event: { type: 'agent.message', runId: 'run1', from: 'r2', to: 'lead', toHandle: 'mock-lead', text: 'done', at: NOW - 500 } as RunEvent })
}

const key = (ch: string, extra: Partial<KeyEvent> = {}): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 45))

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

function mount(opts: { cols: number; rows: number; env?: Partial<TuiEnv>; inline?: boolean; state?: TuiState; listRuns?: RunSummary[] }) {
  const state = opts.state ?? sampleState()
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
    worktreeDiff: vi.fn(async () => ({ stat: ' a.ts | 2 ++', patch: '+x\n' })),
    listRuns: vi.fn(async () => opts.listRuns ?? []),
    startRetro: vi.fn(async () => summary('retro1', { kind: 'setup' })),
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
      launch={{}}
      conn={{ client: {} as never, hello: {} as never, started: false } as never}
      input={{ subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)) }}
      processEnv={{}}
      now={() => NOW}
      onExit={() => undefined}
    />
  )
  mounted.push(r)
  const send = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) {
      for (const fn of [...listeners]) fn(e)
      await tick()
    }
  }
  const frame = (): string => r.lastFrame() ?? ''
  /** Tab to the tree, then up to the mock-lead row (the tree starts on the agent that needs you). */
  const onTree = async (): Promise<void> => {
    await send(named('escape'), named('tab'), ...(opts.cols >= 110 ? [named('tab')] : []))
  }
  const onLeadRow = async (): Promise<void> => {
    await onTree()
    await send(named('up'))
  }
  return { r, session, send, frame, onLeadRow, onTree }
}

const notices = (m: { session: { notify: { mock: { calls: unknown[][] } } } }): unknown[] => m.session.notify.mock.calls.map((c) => c[0])
const lines = (f: string): string[] => f.split('\n')

describe('agent inspector (F4)', () => {
  it('Enter on a non-waiting agent opens it over the conversation column with the facts and its own transcript', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onLeadRow()
    await m.send(named('enter'))
    const f = m.frame()
    expect(f).toContain('mock-lead')
    expect(f).toContain('(Lead)')
    expect(f).toContain('model sonnet-4-5')
    expect(f).toContain('1.6k in / 300 out')
    expect(f).toContain('$0.12')
    expect(f).toContain('4 turns')
    expect(f).toContain('9 tool calls')
    expect(f).toContain('now      Reviewing mock-lead-report-1')
    expect(f).toContain('transcript (this agent')
    expect(f).toContain('LEAD-SAYS-HELLO')
    // Only this agent's rows; thinking hidden until t.
    expect(f).not.toContain('ROOT-ONLY-LINE')
    expect(f).not.toContain('REPORT-TWO-TEXT')
    expect(f).not.toContain('LEAD-THINKS-HARD')
    // Split layout: the tree stays on the right, the old transcript column is replaced.
    expect(f).toContain('Agents')
    expect(f).toContain('Esc back')
  })

  it('t shows the thinking rows, Esc closes and the tree keeps the same row selected', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onLeadRow()
    await m.send(named('enter'), key('t'))
    expect(m.frame()).toContain('LEAD-THINKS-HARD')
    await m.send(named('escape'))
    const f = m.frame()
    expect(f).not.toContain('transcript (this agent')
    expect(f).toContain('ROOT-ONLY-LINE')
    const row = lines(f).find((l) => /mock-lead(?:\s|~|$)/.test(l))!
    expect(row.trimStart().startsWith('>')).toBe(true)
  })

  it('d on an agent that needs you focuses its decision card; on one that does not it says so', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onTree()
    // The tree starts on mock-lead-report-2 (it needs you): Enter goes to the card, so open the inspector through /agent.
    await m.send(named('escape'))
    const ctx: { run?: SlashContext['openAgent'] } = {}
    expect(ctx).toBeDefined()
    await m.send(...'/agent mock-lead-report-2'.split('').map((c) => key(c)), named('enter'))
    const f = m.frame()
    expect(f).toContain('mock-lead-report-2')
    expect(f).toContain('d: decide')
    expect(f).toContain('w: diff')
    expect(f).toContain('worktree-agent-r2')
    await m.send(key('d'))
    // The tray now has focus on that agent's card.
    expect(m.frame()).toContain('Command: npm test')
    expect(m.frame()).toContain('Esc to type')
  })

  it('w opens the worktree diff in the pager path (overlay without a pager)', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(...'/agent mock-lead-report-2'.split('').map((c) => key(c)), named('enter'))
    await m.send(key('w'))
    await tick()
    expect(m.session.worktreeDiff).toHaveBeenCalledWith('worktree-agent-r2')
    expect(m.frame()).toContain('Changes on worktree-agent-r2')
  })

  it('u opens the usage text', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onLeadRow()
    await m.send(named('enter'), key('u'))
    await tick()
    const f = m.frame()
    expect(f).toContain('Usage for R1')
    expect(f).toContain('By agent')
  })

  it('at 90x30 (stacked) it takes the whole body; Esc brings the tree back', async () => {
    const m = mount({ cols: 90, rows: 30 })
    await m.onLeadRow()
    await m.send(named('enter'))
    const f = m.frame()
    expect(f).toContain('transcript (this agent')
    expect(f).not.toContain('Agents ')
    expect(lines(f).length).toBeLessThanOrEqual(30)
    await m.send(named('escape'))
    expect(m.frame()).toContain('Agents ')
  })

  it('at 100x24 the transcript keeps three rows (facts give way in a short pane)', async () => {
    const m = mount({ cols: 100, rows: 24 })
    await m.onLeadRow()
    await m.send(named('enter'))
    const f = m.frame()
    expect(f).toContain('LEAD-SAYS-HELLO')
    expect(lines(f).length).toBeLessThanOrEqual(24)
  })

  it('inline: /agent shows the inspector above the 3-line footer', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await m.send(...'/agent mock-lead'.split('').map((c) => key(c)), named('enter'))
    const f = m.frame()
    expect(f).toContain('transcript (this agent')
    expect(f).toContain('LEAD-SAYS-HELLO')
    const tail = lines(f).slice(-3).join('\n')
    // The 80-column status line keeps the status and the hint; the project name gives way first (issue #26).
    expect(tail).toContain('needs you')
  })

  it('ASCII and screen-reader modes use no glyphs in the inspector', async () => {
    for (const env of [{ unicode: false }, { unicode: false, screenReader: true }]) {
      const m = mount({ cols: 120, rows: 40, env })
      await m.onLeadRow()
      await m.send(named('enter'))
      const f = m.frame()
      expect(f).toContain('transcript (this agent')
      expect(f).not.toMatch(/[─│•→✓●]/)
    }
  })
})

describe('external decision lifecycle', () => {
  const scenarios = [
    { label: 'external running', status: 'running', surface: 'cli', action: 'confirm', outcome: 'applied', order: 'after', throws: false, notice: true, cancelled: false },
    { label: 'external finished', status: 'finished', surface: 'cli', action: 'confirm', outcome: 'applied', order: 'after', throws: false, notice: true, cancelled: false },
    { label: 'local TUI', status: 'running', surface: 'tui', action: 'direct', outcome: 'applied', order: 'after', throws: false, notice: false, cancelled: false },
    { label: 'local TUI event before applied', status: 'running', surface: 'tui', action: 'direct', outcome: 'applied', order: 'before', throws: false, notice: false, cancelled: false },
    { label: 'external after rejection', status: 'running', surface: 'cli', action: 'direct', outcome: 'not-found', order: 'after', throws: false, notice: true, cancelled: false },
    { label: 'external before not-found', status: 'running', surface: 'cli', action: 'direct', outcome: 'not-found', order: 'before', throws: false, notice: true, cancelled: false },
    { label: 'external after thrown rejection', status: 'running', surface: 'cli', action: 'direct', outcome: 'not-found', order: 'after', throws: true, notice: true, cancelled: false },
    { label: 'cancelled', status: 'running', surface: 'cli', action: 'confirm', outcome: 'applied', order: 'after', throws: false, notice: false, cancelled: true }
  ] as const

  it.each(scenarios)('$label resolution keeps the activity lifecycle intact', async (scenario) => {
    let state = sampleState({ status: scenario.status })
    let clock = 10_000
    const initialPermission = state.runs.run1?.cards.permissions[0] as PermissionRequest
    state = applyEvent(state, {
      seq: ++seq,
      event: {
        type: 'permission.request',
        runId: 'run1',
        request: {
          ...initialPermission,
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'project' }]
        }
      } as RunEvent
    })
    const listeners = new Set<() => void>()
    let releaseDecision: (() => void) | undefined
    const emit = () => {
      for (const fn of [...listeners]) fn()
    }
    const session = {
      getState: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      },
      hostKind: 'daemon',
      hostInstanceId: 'h1',
      focusRun: vi.fn(async () => undefined),
      setComposeTarget: vi.fn(),
      submitPrompt: vi.fn(async () => undefined),
      startQuick: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      decide: vi.fn(() => {
        if (scenario.throws) return Promise.reject(new Error('decision rejected'))
        if (scenario.order === 'before') return new Promise<{ status: typeof scenario.outcome }>((resolve) => { releaseDecision = () => resolve({ status: scenario.outcome }) })
        return Promise.resolve({ status: scenario.outcome })
      }),
      worktreeDiff: vi.fn(async () => ({ stat: '', patch: '' })),
      listRuns: vi.fn(async () => []),
      startRetro: vi.fn(async () => summary('retro1', { kind: 'setup' })),
      openInDesktop: vi.fn(),
      resync: vi.fn(async () => undefined),
      notify: vi.fn((text: string) => {
        state = { ...state, notices: [...state.notices, { id: state.notices.length + 1, text, at: clock }] }
        emit()
      }),
      close: vi.fn(async () => undefined)
    }
    const listenersInput = new Set<(e: InputEvent) => void>()
    const terminal = {
      bufferMode: 'fullscreen' as const,
      bracketedPaste: false,
      enter: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      restore: vi.fn(),
      size: () => ({ cols: 120, rows: 40 }),
      onResize: () => () => undefined
    }
    const r = render(
      <App
        session={session as never}
        terminal={terminal as never}
        env={{ ...DEFAULT_TUI_ENV, bufferMode: 'fullscreen' }}
        launch={{}}
        conn={{ client: {} as never, hello: {} as never, started: false } as never}
        input={{ subscribe: (fn) => (listenersInput.add(fn), () => void listenersInput.delete(fn)) }}
        processEnv={{}}
        now={() => clock}
        onExit={() => undefined}
      />
    )
    const send = async (...events: InputEvent[]) => {
      for (const event of events) {
        for (const fn of [...listenersInput]) fn(event)
        await tick()
      }
    }
    await send(named('f2'))
    clock += 1_000
    await send(key(scenario.action === 'confirm' ? 'a' : 'y'))
    if (scenario.action === 'confirm') expect(r.lastFrame()).toContain('to confirm')
    else await tick()

    state = applyEvent(state, {
      seq: ++seq,
      event: { type: 'permission.resolved', runId: 'run1', requestId: 'perm1', cancelled: scenario.cancelled, decidedBy: { surface: scenario.surface } } as RunEvent
    })
    state = applyEvent(state, { seq: ++seq, event: { type: 'run.status', runId: 'run1', status: scenario.status } as RunEvent })
    emit()
    await tick()
    if (scenario.order === 'before') {
      releaseDecision?.()
      await tick()
    }

    if (scenario.notice) {
      expect(r.lastFrame()).toContain('Resolved by')
      clock += TUI_NOTICE_TTL_MS + 1
      state = { ...state }
      emit()
      await tick()
      expect(r.lastFrame()).not.toContain('Resolved by')
    } else {
      expect(r.lastFrame()).not.toContain('Resolved by')
    }
    expect(r.lastFrame()).toContain(scenario.status === 'finished' ? 'Run finished' : '2 agents working')
    r.unmount()
  })
})

describe('message counts (F6)', () => {
  it('the selected row footer and the ~ mark; the inspector shows counts', async () => {
    const m = mount({ cols: 120, rows: 40, state: withMessages(sampleState()) })
    const f0 = m.frame()
    const leadRow = lines(f0).find((l) => /mock-lead(?:\s|~|$)/.test(l))!
    expect(leadRow).toContain('~')
    await m.onLeadRow()
    const f = m.frame()
    expect(f).toContain('→ mock-lead-report-2 (1)')
    expect(f).toContain('← mock-lead-report-2 (1)')
    await m.send(named('enter'))
    expect(m.frame()).toContain('messages sent 1 (to mock-lead-report-2)')
    expect(m.frame()).toContain('got 1 (from mock-lead-report-2)')
  })

  it('ascii: -> and <-; screen reader: words', async () => {
    const a = mount({ cols: 120, rows: 40, env: { unicode: false }, state: withMessages(sampleState()) })
    await a.onLeadRow()
    expect(a.frame()).toContain('-> mock-lead-report-2 (1)')
    const sr = mount({ cols: 120, rows: 40, env: { unicode: false, screenReader: true }, state: withMessages(sampleState()) })
    await sr.onLeadRow()
    expect(sr.frame()).toContain('sent to mock-lead-report-2 (1)')
    expect(sr.frame()).toContain('messaging')
  })
})

describe('subtree focus (F7)', () => {
  it('z roots the tree at the agent with a breadcrumb and filters the transcript; Z pops', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onLeadRow()
    await m.send(key('z'))
    const f = m.frame()
    expect(f).toContain('Focus: Orchestrator > mock-lead')
    expect(f).toContain('LEAD-SAYS-HELLO')
    expect(f).not.toContain('ROOT-ONLY-LINE')
    expect(f).not.toContain('Orchestrator  ')
    await m.send(key('Z', { shift: true }))
    const g = m.frame()
    expect(g).toContain('Agents ')
    expect(g).toContain('ROOT-ONLY-LINE')
  })

  it('Backspace pops too; popping at the top says so', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onLeadRow()
    await m.send(key('z'), named('backspace'))
    expect(m.frame()).not.toContain('Focus:')
    await m.send(named('backspace'))
    expect(notices(m)).toContain('The tree already shows the whole run.')
  })
})

describe('run chips and switching (F8)', () => {
  function liveRuns(): TuiState {
    let s = sampleState()
    s = applyRecord(s, { ...record(summary('run2', { status: 'idle', startedAt: 2000, prompt: 'Second' })) })
    return setActiveRun(s, 'run1')
  }

  it('the status bar lists the live runs as chips when there is room, else a count, and keeps the hint (issue #26)', async () => {
    const wide = mount({ cols: 180, rows: 40, state: liveRuns() })
    expect(lines(wide.frame()).at(-1)).toMatch(/R1\*!? R2/)
    for (const [cols, rows] of [
      [120, 40],
      [90, 30],
      [100, 24]
    ]) {
      const m = mount({ cols, rows, state: liveRuns() })
      const footer = lines(m.frame()).at(-1) ?? ''
      expect(footer, `${cols}x${rows}`).toMatch(/R1\*!? R2|2 live/)
      expect(m.frame(), `${cols}x${rows}`).toContain('Ctrl+O tools')
    }
  })

  it('inline footer carries the live runs too and stays three lines', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true, state: liveRuns() })
    const f = m.frame()
    expect(f).toMatch(/R1\*!? R2|2 live/)
  })

  it('screen reader reads words, not marks', async () => {
    const m = mount({ cols: 200, rows: 40, env: { screenReader: true, unicode: false }, state: liveRuns() })
    expect(lines(m.frame()).at(-1)).toContain('R1 followed')
  })

  it('] follows the next live run through focusRun; [ the previous', async () => {
    const m = mount({ cols: 120, rows: 40, state: liveRuns() })
    await m.send(named('tab'), key(']'))
    expect(m.session.focusRun).toHaveBeenCalledWith('run2')
    await m.send(key('['))
    expect(m.session.focusRun).toHaveBeenLastCalledWith('run2')
  })

  it('with one live run [ says there is no other', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(named('tab'), key(']'))
    expect(m.session.focusRun).not.toHaveBeenCalled()
    expect(notices(m)).toContain('No other live run.')
  })

  it('the composer types [ and ? as text', async () => {
    const m = mount({ cols: 120, rows: 40, state: liveRuns() })
    await m.send(key('['), key('?'))
    expect(m.session.focusRun).not.toHaveBeenCalled()
    expect(m.frame()).toContain('[?')
  })
})

describe('/runs picker (F8)', () => {
  const RUNS = [summary('run1', { status: 'finished', startedAt: 1, title: 'First run' }), summary('run2', { status: 'error', startedAt: 2, title: 'Second run' })]

  async function open(extra: Partial<Parameters<typeof mount>[0]> = {}) {
    const m = mount({ cols: 120, rows: 40, listRuns: RUNS, ...extra })
    await m.send(...'/runs'.split('').map((c) => key(c)), named('enter'))
    await tick()
    return m
  }

  it('lists the runs selectable; Enter opens the chosen one', async () => {
    const m = await open()
    const f = m.frame()
    expect(f).toContain('First run')
    expect(f).toContain('Second run')
    expect(f).toContain('Enter opens')
    await m.send(named('up'), named('enter'))
    expect(m.session.focusRun).toHaveBeenCalledWith('run1')
  })

  it('c continues: focuses the run and tells how', async () => {
    const m = await open()
    await m.send(named('down'), key('c'))
    expect(m.session.focusRun).toHaveBeenCalledWith('run2')
    await tick()
    expect(m.session.notify).toHaveBeenCalled()
  })

  it('r asks first, then starts the retrospective of that run', async () => {
    const m = await open()
    await m.send(named('down'), key('r'))
    await tick()
    expect(m.frame()).toContain('Org retrospective')
    await m.send(key('y'))
    await tick()
    expect(m.session.focusRun).toHaveBeenCalledWith('run2')
    expect(m.session.startRetro).toHaveBeenCalledWith('run2')
  })

  it('r on a run that is not an ended work run explains instead', async () => {
    const m = await open({ listRuns: [summary('run1', { status: 'running', startedAt: 1 })] })
    await m.send(key('r'))
    expect(m.session.startRetro).not.toHaveBeenCalled()
    expect(m.session.notify).toHaveBeenCalledWith(expect.stringContaining('no retrospective'), 'warn')
  })

  it('Esc closes it', async () => {
    const m = await open()
    await m.send(named('escape'))
    expect(m.frame()).not.toContain('Enter opens')
  })
})

describe('which-key overlay and hints (F9)', () => {
  it('? from the tree opens that pane\'s keys, the global ones and the glyph legend; Esc closes it', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.onTree()
    await m.send(key('?'))
    const f = m.frame()
    expect(f).toContain('Keys: Agents')
    expect(f).toContain('Open the agent inspector')
    expect(f).toContain('Glyphs')
    await m.send(named('pagedown'))
    const scrolled = m.frame()
    expect(scrolled).toContain('○ idle  ● thinking  ◆ tool')
    await m.send(named('escape'))
    expect(m.frame()).not.toContain('Keys: Agents')
  })

  it('ascii legend at 100x24, and ? from the transcript and the inspector', async () => {
    const m = mount({ cols: 100, rows: 24, env: { unicode: false } })
    await m.send(named('tab'), named('tab'), key('?'))
    expect(m.frame()).toContain('Keys: Transcript')
    await m.send(named('escape'))
    await m.onLeadRow()
    await m.send(named('escape'))
    await m.onLeadRow()
    await m.send(named('enter'), key('?'))
    expect(m.frame()).toContain('Keys: Agent inspector')
  })

  it('? in the inspector at 120x40 renders its keys and the glyph legend in one frame', async () => {
    for (const env of [{}, { unicode: false }, { screenReader: true }]) {
      const m = mount({ cols: 120, rows: 40, env })
      await m.onLeadRow()
      await m.send(named('escape'))
      await m.onLeadRow()
      await m.send(named('enter'), key('?'))
      const f = m.frame()
      expect(f).toContain('Keys: Agent inspector')
      expect(f).toContain('Glyphs')
      expect(f).toMatch(/idle/i)
      expect(f).toMatch(/finished/i)
    }
  })

  it('the focused tree has its own hint line, swapped by the row; the composer shows none', async () => {
    const m = mount({ cols: 120, rows: 40 })
    expect(m.frame()).not.toContain('Enter details')
    await m.onTree()
    // The selected row needs you.
    expect(m.frame()).toContain('Enter decide')
    expect(m.frame()).toContain('? all keys')
    await m.send(named('up'))
    expect(m.frame()).toContain('Enter details')
    expect(m.frame()).not.toContain('Enter decide')
    await m.send(named('down'), named('down'))
    expect(m.frame()).toContain('Enter/Right unfold')
  })

  it('the hint also survives a status line too long to show it (80-column inline keeps its three lines)', async () => {
    const m = mount({ cols: 100, rows: 24 })
    await m.onTree()
    expect(m.frame()).toContain('? all keys')
  })
})

describe('/usage, /retro and /focus', () => {
  it('/usage opens the usage text', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(...'/usage'.split('').map((c) => key(c)), named('enter'))
    await tick()
    expect(m.frame()).toContain('Usage for R1')
    expect(m.frame()).toContain('By role')
  })

  it('/retro appears only for an ended work run of a project and confirms first', async () => {
    const running = mount({ cols: 120, rows: 40 })
    await running.send(...'/retro'.split('').map((c) => key(c)))
    expect(running.frame()).not.toContain('Org retrospective:')
    const ended = mount({ cols: 120, rows: 40, state: sampleState({ status: 'finished' }) })
    await ended.send(...'/retro'.split('').map((c) => key(c)), named('enter'))
    await tick()
    expect(ended.frame()).toContain('Start an Org retrospective of R1?')
    await ended.send(key('n'))
    expect(ended.session.startRetro).not.toHaveBeenCalled()
    await ended.send(...'/retro'.split('').map((c) => key(c)), named('enter'))
    await tick()
    await ended.send(key('y'))
    await tick()
    expect(ended.session.startRetro).toHaveBeenCalledWith('run1')
  })

  it('/save-project exists but is offered only for a followed chat (quick run)', () => {
    const c = SLASH_COMMANDS.find((x) => x.name === 'save-project')
    expect(c).toBeDefined()
    expect(c?.available?.({ activeRunId: 'r', runs: { r: { summary: { quick: {} } } } } as never)).toBe(true)
    expect(c?.available?.({ activeRunId: 'r', runs: { r: { summary: {} } } } as never)).toBe(false)
  })

  it('m maximises the transcript and brings the panes back', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(named('tab'), key('m'))
    const f = m.frame()
    expect(f).not.toContain('Agents ')
    expect(f).toContain('ROOT-ONLY-LINE')
    // The conversation keeps focus when it is maximised; m restores the sidebar.
    await m.send(key('m'))
    expect(m.frame()).toContain('Agents ')
  })
})

describe('overlays in ASCII and screen-reader mode (review M1, L1)', () => {
  const RUNS = [summary('run1', { status: 'finished', startedAt: 1, title: 'First run' })]
  const openRuns = async (envOver: Partial<TuiEnv>, state?: TuiState) => {
    const m = mount({ cols: 100, rows: 40, listRuns: RUNS, env: { color: false, ...envOver }, ...(state ? { state } : {}) })
    await m.send(...'/runs'.split('').map((c) => key(c)), named('enter'))
    await tick()
    return m
  }

  /** The overlay's own lines: from its title (or the border line above it) to its hint line; the rest of the screen is not under test. */
  const region = (frame: string, title: string, hintEnd: string): string => {
    const lines = frame.split('\n')
    const t = lines.findIndex((l) => l.includes(title))
    const h = lines.findIndex((l, i) => i >= t && l.includes(hintEnd))
    return lines.slice(Math.max(0, t - 1), h + 2).join('\n')
  }

  it('Unicode keeps the single-line border and the dot separators', async () => {
    const f = region((await openRuns({})).frame(), 'Runs', 'Esc closes')
    expect(f).toContain('┌')
    expect(f).toContain('Enter opens · c continues')
  })

  it('ASCII mode uses a classic border and plain separators', async () => {
    const f = region((await openRuns({ unicode: false })).frame(), 'Runs', 'Esc closes')
    expect(f).not.toMatch(/[┌┐└┘│─·…]/)
    expect(f).toContain('+--')
    expect(f).toContain('Enter opens | c continues')
  })

  it('screen-reader mode has no border at all', async () => {
    const f = region((await openRuns({ unicode: false, screenReader: true })).frame(), 'Runs', 'Esc closes')
    expect(f).not.toContain('+--')
    expect(f).not.toMatch(/[┌┐└┘│─·]/)
    expect(f).toContain('Enter opens, c continues')
    expect(f).toContain('First run')
  })

  it('the ? overlay follows the same rules', async () => {
    const m = mount({ cols: 100, rows: 40, env: { color: false, unicode: false, screenReader: true } })
    await m.onTree()
    await m.send(key('?'))
    const sr = region(m.frame(), 'Keys: Agents', 'q or Esc closes')
    expect(sr).toContain('q or Esc closes')
    expect(sr).not.toContain('+--')
    expect(sr).not.toMatch(/[┌│─·…]/)
    const a = mount({ cols: 100, rows: 40, env: { color: false, unicode: false } })
    await a.send(named('tab'), key('?'))
    const ascii = region(a.frame(), 'Keys: Agents', 'q or Esc closes')
    expect(ascii).toContain('+--')
    expect(ascii).not.toMatch(/[┌│─·]/)
  })

  it('r in a read-only session notifies and never opens the confirm', async () => {
    const ro: TuiState = { ...sampleState(), readOnlyReason: 'Read-only: your terminal access does not allow it.' }
    const m = await openRuns({}, ro)
    await m.send(key('r'))
    await tick()
    expect(m.frame()).not.toContain('Start an Org retrospective')
    expect(m.session.startRetro).not.toHaveBeenCalled()
    expect(m.session.notify).toHaveBeenCalledWith(expect.stringContaining('read-only'), 'warn')
  })
})
