/**
 * Unit tests of the second org-tree round's smaller pieces: InspectorPane, the tree pane's message footer and subtree keys,
 * the status bar's run chips, runPick, the new slash commands and the session's startRetro.
 */
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '../../shared/types'
import { FakeHostClient, fakeContext, project, record, summary } from '../testing/fakeContext'
import { InputBus } from './context'
import { InspectorPane, inspectorFacts } from './InspectorPane'
import { textWidth } from './panes/text'
import { OrgTreePane, messageLines } from './OrgTreePane'
import { Providers, ESC_RE, char, env, key, press } from './panes/testUtil'
import { runPickLines, runPickRows } from './runPick'
import { connectTuiHost, openTuiSession } from './session'
import { findSlash, matchSlash, SLASH_COMMANDS } from './slashCommands'
import { StatusBar, runChipsText, statusSegments } from './StatusBar'
import type { InspectorView, OrgTreeRow, SlashContext, StatusSummary, TranscriptRow, TuiEnv, TuiState } from './types'

const view = (over: Partial<InspectorView> = {}): InspectorView => ({
  id: 'a1',
  runId: 'r1',
  label: 'writer-1',
  role: 'Writer',
  state: 'waiting',
  stateWord: 'Needs you',
  model: 'sonnet-4-5',
  wall: '2m 14s',
  tokensIn: '1.6k',
  tokensOut: '300',
  cost: '$0.03',
  turns: 4,
  toolCalls: 9,
  activity: 'Wants to run: npm test',
  worktree: { branch: 'worktree-agent-a1', status: 'active', files: 2, mergeTarget: 'main' },
  waiting: 1,
  msgOut: [{ label: 'mock-lead', count: 2 }],
  msgIn: [],
  ...over
})

const rowsOf = (n: number): TranscriptRow[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, runId: 'r1', agentId: 'a1', agentLabel: 'writer-1', kind: 'text' as const, text: `line ${i}` }))

function mountInspector(over: Partial<Parameters<typeof InspectorPane>[0]> = {}, e: TuiEnv = env({ color: false })) {
  const bus = new InputBus()
  const props = { width: 80, height: 16, focused: true, view: view(), rows: rowsOf(3), partials: [], showThinking: false, ...over }
  const r = render(
    <Providers env={e} bus={bus}>
      <InspectorPane {...props} />
    </Providers>
  )
  return { ...r, bus }
}

describe('InspectorPane', () => {
  it('shows the header, every fact, the rule and the transcript, with the keys on the last line', () => {
    const f = mountInspector().lastFrame() ?? ''
    expect(f).toContain('writer-1 (Writer)')
    expect(f).toContain('Needs you')
    expect(f).toContain('model sonnet-4-5 • 2m 14s • 1.6k in / 300 out • $0.03 • 4 turns • 9 tool calls')
    expect(f).toContain('now      Wants to run: npm test')
    expect(f).toContain('d: decide')
    expect(f).toContain('worktree worktree-agent-a1  active  2 files')
    expect(f).toContain('w: diff')
    expect(f).toContain('messages sent 2 (to mock-lead)')
    expect(f).toContain('transcript (this agent, thinking hidden: t)')
    expect(f).toContain('line 2')
    expect(f.split('\n').at(-1)).toContain('d decide')
    expect(f.split('\n').length).toBeLessThanOrEqual(16)
  })

  it('leaves out a fact the agent does not have, and says when there is nothing yet', () => {
    const f = mountInspector({ view: view({ model: undefined, tokensIn: undefined, tokensOut: undefined, cost: undefined, turns: undefined, toolCalls: undefined, activity: undefined, worktree: undefined, waiting: 0, msgOut: [] }), rows: [] }).lastFrame() ?? ''
    expect(f).not.toContain('model')
    expect(f).not.toContain('tool call')
    expect(f).not.toContain('worktree ')
    expect(f).not.toContain('messages')
    expect(f).not.toContain('now ')
    expect(f).toContain('2m 14s')
    expect(f).toContain('Nothing from this agent yet.')
  })

  it('a short pane drops the facts and keeps three transcript rows', () => {
    const f = mountInspector({ height: 8 }).lastFrame() ?? ''
    expect(f.split('\n').length).toBeLessThanOrEqual(8)
    expect(f).toContain('line 0')
    expect(f).toContain('line 2')
    expect(f).toContain('transcript (this agent')
  })

  it('d w t u go to the callbacks; d and w say why when they do not apply; scroll keys are the transcript\'s', () => {
    const calls = { d: vi.fn(), w: vi.fn(), t: vi.fn(), u: vi.fn(), n: vi.fn() }
    const m = mountInspector({ onDecide: calls.d, onDiff: calls.w, onToggleThinking: calls.t, onUsage: calls.u, onNotice: calls.n })
    expect(press(m.bus, 'inspector', char('d'), char('w'), char('t'), char('u'), char('x'))).toEqual([true, true, true, true, false])
    expect([calls.d, calls.w, calls.t, calls.u].map((c) => c.mock.calls.length)).toEqual([1, 1, 1, 1])
    expect(press(m.bus, 'inspector', key('down'), key('pagedown'))).toEqual([true, true])
    const none = mountInspector({ view: view({ waiting: 0, worktree: undefined }), onDecide: calls.d, onDiff: calls.w, onNotice: calls.n })
    press(none.bus, 'inspector', char('d'), char('w'))
    expect(calls.d).toHaveBeenCalledTimes(1)
    expect(calls.n.mock.calls.map((c) => c[0])).toEqual(['This agent has no decision open.', 'This agent has no worktree.'])
  })

  it('does not take keys when unfocused', () => {
    const m = mountInspector({ focused: false })
    expect(press(m.bus, 'inspector', char('t'))).toEqual([false])
    expect(m.lastFrame()).not.toContain('d decide')
  })

  it('ASCII and screen-reader modes use plain words and no glyphs', () => {
    const ascii = mountInspector({}, env({ color: false, unicode: false })).lastFrame() ?? ''
    expect(ascii).not.toMatch(/[─│•→●·]/)
    expect(ascii).toContain('-> d: decide')
    expect(ascii).toContain('-> w: diff')
    const sr = mountInspector({}, env({ color: false, unicode: false, screenReader: true })).lastFrame() ?? ''
    expect(sr).not.toMatch(/[─│•→●·]/)
    expect(sr).not.toContain('->  d')
    expect(sr).toContain('press d to decide')
    expect(sr).toContain('press w for the diff')
    expect(sr.split('\n')[0]).toBe('writer-1 (Writer)  Needs you')
  })

  it('a long worktree branch is cut in the middle, the status and target stay', () => {
    const wt = { branch: 'worktree-agent-' + 'x'.repeat(60) + '-tail', status: 'active', files: 3, mergeTarget: 'main' }
    const v = view({ worktree: wt as never })
    const facts = inspectorFacts(v, env({ color: false }), 70)
    const line = facts.find(([l]) => l.startsWith('worktree'))![0]
    expect(textWidth(line) + textWidth(facts.find(([l]) => l.startsWith('worktree'))![1] ?? '')).toBeLessThanOrEqual(70)
    expect(line).toContain('-tail')
    expect(line).toContain('active')
    expect(line).toContain('main')
  })

  it('hostile text cannot carry a control sequence (rows arrive sanitized; the frame has no ESC)', () => {
    const f = mountInspector({ view: view({ activity: 'plain' }) }).lastFrame() ?? ''
    expect(f).not.toMatch(ESC_RE)
  })
})

describe('OrgTreePane: messages and subtree keys', () => {
  const r = (over: Partial<OrgTreeRow> = {}): OrgTreeRow => ({ id: 'w', runId: 'r1', depth: 0, label: 'writer-1', role: 'Writer', state: 'thinking', stateWord: 'Thinking', activity: 'Typing', costText: '', isRoot: false, ...over })
  const treeFrame = (rows: OrgTreeRow[], e = env({ color: false }), props: Record<string, unknown> = {}) => {
    const bus = new InputBus()
    const out = render(
      <Providers env={e} bus={bus}>
        <OrgTreePane width={60} height={10} focused rows={rows} {...props} />
      </Providers>
    )
    return { bus, out }
  }

  it('messageLines: one line when it fits, two when it does not, words for a screen reader', () => {
    const row = r({ msgOut: [{ label: 'writer-2', count: 2 }], msgIn: [{ label: 'mock-lead', count: 1 }] })
    expect(messageLines(row, env(), 60)).toEqual(['→ writer-2 (2)  ← mock-lead (1)'])
    expect(messageLines(row, env(), 20)).toEqual(['→ writer-2 (2)', '← mock-lead (1)'])
    expect(messageLines(row, env({ unicode: false }), 60)).toEqual(['-> writer-2 (2)  <- mock-lead (1)'])
    expect(messageLines(row, env({ screenReader: true }), 80)).toEqual(['sent to writer-2 (2); got from mock-lead (1)'])
    expect(messageLines(r(), env(), 60)).toEqual([])
    const many = r({ msgOut: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, count: 1 })) })
    expect(messageLines(many, env(), 80)[0]).toContain('+2 more')
  })

  it('shows the ~ mark after the state word for recent traffic and the footer for the selected row', () => {
    const f = treeFrame([r({ traffic: true, msgOut: [{ label: 'mock-lead', count: 1 }] })]).out.lastFrame() ?? ''
    expect(f).toContain('Thinking~')
    expect(f).toContain('→ mock-lead (1)')
    expect(f).toContain('writer-1: Typing')
    const sr = treeFrame([r({ traffic: true })], env({ color: false, screenReader: true })).out.lastFrame() ?? ''
    expect(sr).toContain('Thinking, messaging')
  })

  it('z asks to focus the agent, Z and Backspace to go back; z on a group says why not; the title carries the breadcrumb', () => {
    const onZoom = vi.fn()
    const onUnzoom = vi.fn()
    const onNotice = vi.fn()
    const m = treeFrame([r(), r({ id: 'g', kind: 'group', label: '2 done', groupKey: 'w' })], env({ color: false }), { onZoom, onUnzoom, onNotice, zoomPath: 'Orchestrator > writer-1' })
    press(m.bus, 'tree', char('z'))
    expect(onZoom).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }))
    press(m.bus, 'tree', char('Z'), key('backspace'))
    expect(onUnzoom).toHaveBeenCalledTimes(2)
    press(m.bus, 'tree', key('down'), char('z'))
    expect(onNotice).toHaveBeenCalledWith('Pick an agent of this session to focus on.')
    expect(m.out.lastFrame()).toContain('Focus: Orchestrator > writer-1 (1)')
  })
})

describe('StatusBar run chips (F8)', () => {
  const base: StatusSummary = { needsYou: 0, liveRuns: 3, connection: 'live' }
  const chips = [
    { tag: 'R1', runId: 'a', followed: true, needsYou: false },
    { tag: 'R2', runId: 'b', followed: false, needsYou: true },
    { tag: 'R3', runId: 'c', followed: false, needsYou: false }
  ]

  it('marks the followed run * and a run with a decision !', () => {
    expect(runChipsText(chips, { screenReader: false })).toBe('R1* R2! R3')
    expect(runChipsText(chips, { screenReader: true })).toBe('R1 followed; R2 needs you; R3')
    expect(runChipsText([{ ...chips[0], needsYou: true }], { screenReader: false })).toBe('R1*!')
  })

  it('caps at six chips then +N', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ tag: `R${i + 1}`, runId: `x${i}`, followed: false, needsYou: false }))
    expect(runChipsText(many, { screenReader: false })).toBe('R1 R2 R3 R4 R5 R6 +3')
  })

  it('replaces "N live" when chips exist, tone warn with a decision, and falls back to "N live" without chips', () => {
    const segs = statusSegments({ ...base, runChips: chips })
    expect(segs.map((s) => s.text)).toContain('R1* R2! R3')
    expect(segs.find((s) => s.text === 'R1* R2! R3')?.tone).toBe('warn')
    expect(segs.map((s) => s.text)).not.toContain('3 live')
    expect(statusSegments(base).map((s) => s.text)).toContain('3 live')
    expect(statusSegments({ ...base, runChips: chips }, { screenReader: true }).map((s) => s.text)).toContain('live runs: R1 followed; R2 needs you; R3')
  })

  it('renders in the bar', () => {
    const out = render(
      <Providers env={env({ color: false })} bus={new InputBus()}>
        <StatusBar width={100} summary={{ ...base, runChips: chips }} hints="" />
      </Providers>
    )
    expect(out.lastFrame()).toContain('R1* R2! R3')
  })
})

describe('runPick', () => {
  const runs: RunSummary[] = [summary('b', { startedAt: 2, status: 'error', title: 'Second\x1b[31m' }), summary('a', { startedAt: 1, status: 'finished', title: 'First' }), summary('q', { projectId: 'other', startedAt: 3 })]

  it('lists the project runs oldest first with tag, status, title and whether a retro applies', () => {
    const rows = runPickRows(runs, 'p1')
    expect(rows.map((r) => [r.tag, r.id, r.retro])).toEqual([
      ['R1', 'a', true],
      ['R2', 'b', true]
    ])
    expect(rows[1].title).toBe('Second')
    expect(runPickLines(rows, 1, 60, 'a')[0]).toContain('(following)')
    expect(runPickLines(rows, 1, 60)[1].startsWith('>')).toBe(true)
    expect(runPickLines(rows, 0, 12).every((l) => l.length <= 12)).toBe(true)
  })

  it('a running or single-agent run has no retro', () => {
    const rows = runPickRows([summary('a', { status: 'running' }), summary('b', { team: 'single', startedAt: 2 })], 'p1')
    expect(rows.map((r) => r.retro)).toEqual([false, false])
  })
})

describe('slash commands: /usage /retro /focus /agent /runs', () => {
  const stateOf = (status: RunSummary['status'], over: Partial<RunSummary> = {}): TuiState =>
    ({
      connection: 'live',
      folder: '/w',
      project: { id: 'p1' },
      runs: { r1: { summary: summary('r1', { status, ...over }), agents: {}, transcript: [], partials: {}, cards: {}, recordLoaded: true } },
      runOrder: ['r1'],
      activeChain: ['r1'],
      activeRunId: 'r1',
      composeTarget: 'active',
      notices: [],
      resolved: [],
      cardSeq: 0
    }) as unknown as TuiState
  const ctx = (extra: Partial<SlashContext> = {}): SlashContext =>
    ({ session: { listRuns: vi.fn(async () => [summary('a')]) }, state: () => stateOf('finished'), notify: vi.fn(), setFocus: vi.fn(), togglePane: vi.fn(), newRun: vi.fn(), switchRun: vi.fn(), confirm: vi.fn(), openText: vi.fn(async () => undefined), quit: vi.fn(), ...extra }) as unknown as SlashContext

  it('/retro is offered only for an ended work run of a project; there is no /save-project', () => {
    expect(matchSlash('retro', stateOf('finished')).map((c) => c.name)).toEqual(['retro'])
    expect(matchSlash('retro', stateOf('running'))).toEqual([])
    expect(matchSlash('retro', stateOf('finished', { projectId: 'quick' }))).toEqual([])
    expect(matchSlash('retro', stateOf('finished', { team: 'single' }))).toEqual([])
    expect(findSlash('save-project', stateOf('finished'))).toBeUndefined()
  })

  it('/retro, /focus, /agent call the context; without it they say so', async () => {
    const startRetro = vi.fn(async () => undefined)
    const toggleFocusMode = vi.fn()
    const openAgent = vi.fn()
    const c = ctx({ startRetro, toggleFocusMode, openAgent })
    await findSlash('retro', stateOf('finished'))!.run(c, '')
    await findSlash('focus', stateOf('running'))!.run(c, '')
    await findSlash('agent', stateOf('running'))!.run(c, '  mock-lead\x1b[31m ')
    expect(startRetro).toHaveBeenCalledTimes(1)
    expect(toggleFocusMode).toHaveBeenCalledTimes(1)
    expect(openAgent).toHaveBeenCalledWith('mock-lead')
    const bare = ctx()
    await findSlash('retro', stateOf('finished'))!.run(bare, '')
    expect(bare.notify).toHaveBeenCalledWith('The Org retrospective is not available here.', 'warn')
  })

  it('/usage opens the usage text; /runs opens the picker when the context has one, else the table', async () => {
    const c = ctx()
    await findSlash('usage', stateOf('running'))!.run(c, '')
    expect(c.openText).toHaveBeenCalledWith('Usage', expect.stringContaining('Usage for R1'))
    const openRuns = vi.fn()
    const picker = ctx({ openRuns })
    await findSlash('runs', stateOf('running'))!.run(picker, '')
    expect(openRuns).toHaveBeenCalledTimes(1)
    await findSlash('runs', stateOf('running'))!.run(c, '')
    expect((c.openText as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Runs')
  })

  it('every command is still reachable by name', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(['usage', 'retro', 'focus', 'agent', 'runs', 'fold']))
  })
})

describe('session.startRetro (F12)', () => {
  const P = project('p1', '/work', { name: 'Shop' })

  async function open(answers: Record<string, (p: unknown) => unknown>, list: RunSummary[]) {
    let seq = 10
    const h = new FakeHostClient(
      {
        'runs:subscribe': (params) => {
          const input = (params as { includeActiveRunRecord?: string }[])[0]
          const res = { mode: 'snapshot', hostInstanceId: 'aaaaaaaaaaaa', seq: ++seq, filterKey: `fk${seq}`, snapshot: { liveRuns: [], recentEndedRuns: [], pendingCards: {} } } as never
          const s = list.find((r) => r.id === input.includeActiveRunRecord)
          if (s) (res as { snapshot: { activeRun?: unknown } }).snapshot.activeRun = record(s)
          return res
        },
        'runs:list': () => list,
        'projects:list': () => [P],
        'runs:get': (params) => {
          const s = list.find((r) => r.id === (params as string[])[0])
          return s ? record(s) : null
        },
        ...answers
      },
      { hello: { grantedScopes: ['read', 'operate', 'decide'] } }
    )
    const f = fakeContext({ connect: [h] })
    const conn = await connectTuiHost(f.ctx)
    const session = await openTuiSession(conn, { folder: '/work', project: P, runId: list[0].id }, { schedule: (fn) => void fn() })
    return { h, session }
  }

  it('calls setup:retro with the project and run, then follows the new run', async () => {
    const ended = summary('r1', { status: 'finished' })
    const retro = summary('retro1', { kind: 'setup', status: 'running', startedAt: 5000 })
    const { h, session } = await open({ 'setup:retro': () => retro }, [ended])
    const started = await session.startRetro()
    expect(started.id).toBe('retro1')
    expect(h.callsOf('setup:retro')).toEqual([[{ projectId: 'p1', runId: 'r1' }]])
    expect(session.getState().activeRunId).toBe('retro1')
  })

  it('refuses a run that is still open and a missing run, without calling the host', async () => {
    const { h, session } = await open({}, [summary('r1', { status: 'running' })])
    await expect(session.startRetro()).rejects.toThrow(/ended work run/)
    await expect(session.startRetro('nope')).rejects.toThrow(/Open the run first/)
    expect(h.callsOf('setup:retro')).toHaveLength(0)
  })

  it('a host refusal comes back as a plain error', async () => {
    const { session } = await open({ 'setup:retro': () => { throw new Error('Blocked by the host') } }, [summary('r1', { status: 'finished' })])
    await expect(session.startRetro()).rejects.toThrow(/Blocked by the host/)
  })
})
