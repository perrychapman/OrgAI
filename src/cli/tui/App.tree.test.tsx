/**
 * Frames of the real App (real selectors, layout, tree, tray and composer) over a hand-built state, for the org tree work
 * of ux-review-tui-org.md: finished subtrees folded, one line per agent, the waiting agent in view, the tray naming its
 * agent, at the sizes the review looked at. ink-testing-library; nothing here talks to a host.
 */
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, PermissionRequest, RunEvent, RunSummary } from '../../shared/types'
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
  return { r, session, send, frame }
}

// The 41-column tree clips the long handles in the middle ("mock-lead-…ort-2"); their ends stay apart.
const AGENT_ROWS = ['Orchestrator', 'mock-lead ', 'ort-2', '1 done', '2 done']

/** Indexes of the lines carrying each tree row, in order; the rows must be consecutive (no blank line between agents). */
function rowLines(frame: string, names = AGENT_ROWS): number[] {
  const lines = frame.split('\n')
  return names.map((n) => lines.findIndex((l) => l.includes(n)))
}

function expectConsecutive(frame: string): void {
  const at = rowLines(frame)
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
  for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBe(1)
}

describe('the org tree in the real App: folded, one line per agent, the waiting agent in view', () => {
  it('120x40 split: five rows for six agents, the title counts, the tray names the agent', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await tick()
    const f = m.frame()
    expect(f).toContain('Agents 6 • 2 working • ! 1')
    expectConsecutive(f)
    expect(f).toContain('2 done  (1 failed)')
    const wait = f.split('\n').find((l) => l.includes('ort-2'))!
    expect(wait).toContain('Needs you')
    expect(f).toMatch(/Needs you \(1\) • R1 • mock-lead-report-2 • permission/)
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
    expectConsecutive(f)
    expect(f).toMatch(/Needs you \(1\)/)
    m.r.unmount()
  })

  it('100x24: the waiting agent row is on screen with the tray and the composer', async () => {
    const m = mount({ cols: 100, rows: 24 })
    await tick()
    const f = m.frame()
    expect(f.split('\n').length).toBeLessThanOrEqual(24)
    expect(f).toContain('mock-lead-report-2')
    expect(f).toMatch(/Needs you \(1\)/)
    expect(f).toContain('Message the run')
    m.r.unmount()
  })

  it('inline 80x24 keeps its three-line footer and draws no tree', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await tick()
    const f = m.frame()
    expect(f).not.toContain('Agents 6')
    const tail = f.trimEnd().split('\n').slice(-3)
    expect(tail.join('\n')).toContain('mock-lead-report-2: ')
    expect(tail.join('\n')).toContain('Message the run')
    m.r.unmount()
  })

  it('ASCII glyphs: no box-drawing or symbol characters in the tree', async () => {
    const m = mount({ cols: 120, rows: 40, env: { unicode: false } })
    await tick()
    const f = m.frame()
    expectConsecutive(f)
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
    // Focus the tree: Tab from the composer.
    await m.send(named('tab'))
    expect(m.frame()).toContain('Agents 6')
    // The waiting agent is selected by default; Down moves to its "1 done" group; Right opens it.
    await m.send(named('down'))
    await m.send(named('right'))
    expect(m.frame()).toMatch(/ort-1 +Finished/)
    expect(m.frame()).not.toContain('1 done')
    // Left on the opened report folds the group again and keeps the selection on the group row.
    await m.send(named('left'))
    expect(m.frame()).not.toMatch(/ort-1 +Finished/)
    expect(m.frame()).toContain('1 done')
    // h: every agent.
    await m.send(key('h'))
    for (const n of ['designer-1', 'writer-1']) expect(m.frame()).toContain(n)
    expect(m.frame()).toMatch(/ort-1 +Finished/)
    expect(m.session.notify).toHaveBeenCalledWith('Showing every agent.', undefined)
    await m.send(key('h'))
    expect(m.frame()).toContain('2 done  (1 failed)')
    // n from the top goes to the waiting agent; Enter focuses the tray on its card.
    await m.send(named('home'))
    await m.send(key('n'))
    await m.send(named('enter'))
    expect(m.frame()).toMatch(/Needs you \(1\) • R1 • mock-lead-report-2/)
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
    await m.send(named('tab'))
    await m.send(key('n'))
    expect(m.session.notify).toHaveBeenCalledWith('No agent needs you in this run.', undefined)
    m.r.unmount()
  })
})
