/**
 * Frames of the real App (real selectors, layout, tree, tray and composer) over a hand-built state, for the org tree work
 * of ux-review-tui-org.md: finished subtrees folded, spaced agent rows, the waiting agent in view, the tray naming its
 * agent, at the sizes the review looked at. ink-testing-library; nothing here talks to a host.
 */
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, PermissionRequest, Role, RunEvent, RunSummary } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { App } from './App'
import { DEFAULT_TUI_ENV } from './context'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import type { InputEvent, KeyEvent, TuiEnv, TuiState } from './types'

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

/** The review's run: root, two finished top-level agents (one failed), mock-lead thinking with a finished and a waiting report. */
function sampleState(): TuiState {
  const agents: Record<string, AgentInstance> = {
    root: agent('root', null, { name: 'Orchestrator', state: 'delegating', activity: 'Waiting for reports', costUsd: 0.31 }),
    designer: agent('designer', 'root', { name: 'Designer', handle: 'designer-1', state: 'done', startedAt: 2, endedAt: OLD, costUsd: 0.04 }),
    writer: agent('writer', 'root', { name: 'Writer', handle: 'writer-1', state: 'error', startedAt: 3, endedAt: OLD, costUsd: 0.04 }),
    lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', startedAt: 4, activity: 'Reviewing mock-lead-report-1', costUsd: 0.12 }),
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
  s = applyRecord(s, { ...record(summary('run1', { status: 'running', prompt: 'Build the thing' }) as RunSummary), agents })
  s = setActiveRun(s, 'run1')
  const request = { id: 'perm1', runId: 'run1', agentId: 'r2', toolName: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test' } as PermissionRequest
  return applyEvent(s, { seq: 1, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
}

const key = (ch: string, extra: Partial<KeyEvent> = {}): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))

function mount(opts: { cols: number; rows: number; env?: Partial<TuiEnv>; inline?: boolean; state?: TuiState; realClock?: boolean }) {
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
    worktreeDiff: vi.fn(),
    listRuns: vi.fn(async () => []),
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
      {...(opts.realClock ? {} : { now: () => NOW })}
      onExit={() => undefined}
    />
  )
  const send = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) {
      for (const fn of [...listeners]) fn(e)
      await tick()
    }
  }
  const frame = (): string => r.lastFrame() ?? ''
  /** Several events in the same tick, as one pty chunk delivers them (no render between them). */
  const sendBatch = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) for (const fn of [...listeners]) fn(e)
    await tick()
  }
  return { r, session, send, sendBatch, frame }
}

// The narrow sidebar clips the long handles in the middle ("mock-lead-…ort-2"); their ends stay apart.
const AGENT_ROWS = ['Orchestrator', 'mock-lead ', 'ort-2', '1 done', '2 done']

/** Indexes of the lines carrying each tree row, in order; wide sidebar rows have separate status lines and a gap between agents. */
function rowLines(frame: string, names = AGENT_ROWS): number[] {
  const lines = frame.split('\n')
  return names.map((n) => lines.findIndex((l) => l.includes(n)))
}

function expectSpaced(frame: string, stride = 3): void {
  const at = rowLines(frame)
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
  for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBe(stride)
}

describe('the org tree in the real App: folded, spaced agent rows, the waiting agent in view', () => {
  it.each([true, false])('shows the configured team and opens available role details (run present: %s)', async (hasRun) => {
    const roles = ['Coordinator', 'Builder', 'Reviewer'].map((name, index): Role => ({
      id: name, slug: name.toLowerCase(), name, reportsTo: index ? 'Coordinator' : null,
      description: `${name} role description`, responsibilities: ['Review the code'], prompt: '', tools: [],
      model: 'inherit', canSpawn: false, spawnable: [], position: { x: 0, y: 0 }, color: ''
    }))
    let state: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { roles }), connection: 'live' }
    if (hasRun) state = setActiveRun(applyRecord(state, record(summary('run1', { status: 'idle' }), {
      agents: { root: agent('root', null, { roleId: 'Coordinator', name: 'Coordinator', roleSlug: 'coordinator', state: 'idle' }) }
    })), 'run1')
    const m = mount({ cols: 120, rows: 40, state })
    await tick()
    expect(m.frame().split('\n')[0].indexOf('Team 3')).toBeGreaterThan(70)
    expect(m.frame()).toContain('Builder')
    expect(m.frame()).toContain('Reviewer')
    expect(m.frame().match(/Available/g)).toHaveLength(hasRun ? 2 : 3)
    await m.send(named('tab'), named('tab'), named('down'), named('enter'))
    expect(m.frame()).toContain('Builder role description')
    expect(m.frame()).toContain('not started in this run')
    expect(m.session.submitPrompt).not.toHaveBeenCalled()
    m.r.unmount()
  })

  it('120x40 split: five spaced entries for six agents, the title counts, the tray names the agent', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await tick()
    const f = m.frame()
    expect(f).toContain('Agents 6 • 2 working • ! 1')
    expectSpaced(f)
    expect(f).toMatch(/2 done[^\n]*\n[^\n]*\(1 failed\)/)
    const waitAt = f.split('\n').findIndex(l => l.includes('ort-2'))
    expect(f.split('\n')[waitAt + 1]).toContain('Needs you')
    expect(f).toContain('Approval needed · R1 · mock-lead-report-2')
    // The Worktrees and Plan panes are not drawn: nothing needs them.
    expect(f).not.toContain('Worktrees (')
    expect(f).not.toContain('No plan yet')
    m.r.unmount()
  })

  it('90x30 stacked: the waiting agent row is on screen', async () => {
    const m = mount({ cols: 90, rows: 30 })
    await tick()
    const f = m.frame()
    expect(f.split('\n').length).toBeLessThanOrEqual(30)
    expect(f).toContain('mock-lead-report-2')
    expect(f.split('\n').find((l) => l.includes('mock-lead-report-2'))).toMatch(/! 1 +2f/)
    expectSpaced(f, 1)
    expect(f).toContain('Approval needed')
    m.r.unmount()
  })

  it('100x24: the waiting agent row is on screen with the tray and the composer', async () => {
    const m = mount({ cols: 100, rows: 24 })
    await tick()
    const f = m.frame()
    expect(f.split('\n').length).toBeLessThanOrEqual(24)
    expect(f).toContain('mock-lead-report-2')
    expect(f).toContain('Approval needed')
    expect(f).toContain('Message R1')
    m.r.unmount()
  })

  it('inline 80x24 keeps its three-line footer and draws no tree', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await tick()
    const f = m.frame()
    expect(f).not.toContain('Agents 6')
    const tail = f.trimEnd().split('\n').slice(-3)
    expect(tail.join('\n')).toContain('mock-lead-report-2: ')
    expect(tail.join('\n')).toContain('Message R1')
    m.r.unmount()
  })

  it('ASCII glyphs: no box-drawing or symbol characters in the tree', async () => {
    const m = mount({ cols: 120, rows: 40, env: { unicode: false } })
    await tick()
    const f = m.frame()
    expectSpaced(f)
    for (const ch of ['├', '└', '✓', '✗', '●', '◇', '›']) expect(f).not.toContain(ch)
    expect(f).toContain('|-')
    m.r.unmount()
  })

  it('screen reader: plain words, the group says it is folded, the waiting agent is still listed', async () => {
    const m = mount({ cols: 90, rows: 30, env: { screenReader: true, unicode: false } })
    await tick()
    const f = m.frame()
    expect(f).toContain('1 done, folded')
    expect(f).toContain('2 done, folded')
    expect(f).toContain('mock-lead-report-2')
    expect(f).toContain('Needs you')
    m.r.unmount()
  })

  it('keys: Right expands a group, Left folds it back, h shows every agent, n jumps to the waiting agent, Enter focuses its card', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await tick()
    // Focus the tree: Tab past the conversation from the composer.
    await m.send(named('tab'), named('tab'))
    expect(m.frame()).toContain('Agents 6')
    // The waiting agent is selected by default; Down moves to its "1 done" group; Right opens it.
    await m.send(named('down'))
    await m.send(named('right'))
    expect(m.frame()).toMatch(/ort-1[^\n]*\n[^\n]*Finished/)
    expect(m.frame()).not.toContain('1 done')
    // Left on the opened report folds the group again and keeps the selection on the group row.
    await m.send(named('left'))
    expect(m.frame()).not.toMatch(/ort-1[^\n]*\n[^\n]*Finished/)
    expect(m.frame()).toContain('1 done')
    // h: every agent.
    await m.send(key('h'))
    for (const n of ['designer-1', 'writer-1']) expect(m.frame()).toContain(n)
    expect(m.frame()).toMatch(/ort-1[^\n]*\n[^\n]*Finished/)
    expect(m.session.notify).toHaveBeenCalledWith('Showing every agent.', undefined)
    await m.send(key('h'))
    expect(m.frame()).toMatch(/2 done[^\n]*\n[^\n]*\(1 failed\)/)
    // n from the top goes to the waiting agent; Enter focuses the tray on its card.
    await m.send(named('home'))
    await m.send(key('n'))
    await m.send(named('enter'))
    expect(m.frame()).toMatch(/Approval needed · R1 · mock-lead-report-2/)
    expect(m.frame()).toContain('Allow once')
    m.r.unmount()
  })

  it('a report that finishes folds after the grace by itself, with the run still running (one timer to the next settle moment)', async () => {
    const s = sampleState()
    const r1 = s.runs.run1.agents.r1
    // Finished 5.4 s ago: the 6 s grace ends in about 600 ms (roomy, so a loaded test run still sees the row first).
    const fresh: TuiState = { ...s, runs: { ...s.runs, run1: { ...s.runs.run1, agents: { ...s.runs.run1.agents, r1: { ...r1, endedAt: Date.now() - 5400 } } } } }
    const m = mount({ cols: 90, rows: 30, state: fresh, realClock: true })
    await tick()
    expect(m.frame()).toMatch(/mock-lead-report-1 +Finished/)
    await new Promise((r) => setTimeout(r, 1000))
    expect(m.frame()).not.toMatch(/mock-lead-report-1 +Finished/)
    expect(m.frame()).toContain('1 done')
    m.r.unmount()
  })

  it('n with nothing waiting says so', async () => {
    const s = sampleState()
    const calm: TuiState = { ...s, runs: { ...s.runs, run1: { ...s.runs.run1, cards: { ...s.runs.run1.cards, permissions: [] } } } }
    const m = mount({ cols: 120, rows: 40, state: calm })
    await tick()
    await m.send(named('tab'), named('tab'))
    await m.send(key('n'))
    expect(m.session.notify).toHaveBeenCalledWith('Nothing needs you.', undefined)
    m.r.unmount()
  })
})

describe('the deep-tree keys of the pty test (section i)', () => {
  /** root -> mock-lead -> two reports; no `leadEnd` keeps mock-lead thinking (its fold has not happened yet). */
  function deepState(leadEnd?: number): TuiState {
    const agents: Record<string, AgentInstance> = {
      root: agent('root', null, { name: 'Orchestrator', state: 'idle', costUsd: 0.004 }),
      lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', state: leadEnd ? 'done' : 'thinking', startedAt: 4, ...(leadEnd ? { endedAt: leadEnd } : {}), costUsd: 0.003 }),
      r1: agent('r1', 'lead', { name: 'Reporter', handle: 'mock-lead-report-1', state: 'done', startedAt: 5, endedAt: OLD, costUsd: 0.001 }),
      r2: agent('r2', 'lead', { name: 'Reporter', handle: 'mock-lead-report-2', state: 'done', startedAt: 6, endedAt: OLD, costUsd: 0.001 })
    }
    let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
    s = applyRecord(s, { ...record(summary('run1', { status: 'running', prompt: 'deep' }) as RunSummary), agents })
    return setActiveRun(s, 'run1')
  }
  const treeRows = (f: string): string[] => f.split('\n').map((l) => l.slice(79)).filter((l) => /done|mock-lead|Orchestrator/.test(l))

  it('once everything has settled the tree is root + "3 done"; Down, Right selects mock-lead and Enter opens its inspector', async () => {
    const m = mount({ cols: 120, rows: 40, state: deepState(OLD) })
    await tick()
    await m.send(named('tab'), named('tab'), key('n'), named('down'))
    expect(treeRows(m.frame()).some((l) => l.startsWith('> ') && l.includes('3 done'))).toBe(true)
    await m.send(named('right'))
    expect(treeRows(m.frame()).some((l) => l.startsWith('> ') && /mock-lead(?:\s|$)/.test(l))).toBe(true)
    await m.send(named('enter'))
    const f = m.frame()
    expect(f).toContain('transcript (this agent')
    expect(f).toContain('mock-lead (Lead)')
    m.r.unmount()
  })

  it('Enter on a "N done" row unfolds it and opens no inspector (how the old fixed-sleep script lost its Enter)', async () => {
    const m = mount({ cols: 120, rows: 40, state: deepState(OLD) })
    await tick()
    await m.send(named('tab'), named('tab'), named('down'))
    await m.send(named('enter'))
    const f = m.frame()
    expect(f).not.toContain('transcript (this agent')
    expect(treeRows(f).some((l) => l.startsWith('> ') && /mock-lead(?:\s|$)/.test(l))).toBe(true)
    m.r.unmount()
  })

  it('while mock-lead is still live the tree is root, mock-lead, "2 done"; Down Down, Right, Up, Enter opens mock-lead', async () => {
    const m = mount({ cols: 120, rows: 40, state: deepState() })
    await tick()
    await m.send(named('tab'), named('tab'), named('down'), named('down'), named('right'), named('up'), named('enter'))
    expect(m.frame()).toContain('mock-lead (Lead)')
    expect(m.frame()).toContain('transcript (this agent')
    m.r.unmount()
  })
})
