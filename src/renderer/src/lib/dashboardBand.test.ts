import { describe, expect, it } from 'vitest'
import type { AgentInstance, Project, RunSummary } from '@shared/types'
import {
  BAND_MAX_DEPTH,
  agentRowName,
  bandAgentState,
  bandAgents,
  bandModel,
  bandSignature,
  countParts,
  currentStep,
  decisionsSuffix,
  doneText,
  emptyLine,
  groupOf,
  markLines,
  moreAgentsText,
  moreRunsLabel,
  roleColorFor,
  treeOrder,
  type BandRow,
  type BandRunIn
} from './dashboardBand'

const NOW = 1_000_000
const ag = (id: string, over: Partial<AgentInstance> = {}): AgentInstance =>
  ({ id, name: `Role ${id}`, roleId: null, roleSlug: id, parentId: 'root', state: 'thinking', activity: `doing ${id}`, startedAt: 10, ...over }) as AgentInstance
const root = (over: Partial<AgentInstance> = {}): AgentInstance => ag('root', { parentId: null, startedAt: 0, name: 'Lead', ...over })
const summary = (id: string, over: Partial<RunSummary> = {}): RunSummary =>
  ({ id, projectId: 'p1', kind: 'work', status: 'running', startedAt: 1, prompt: `prompt ${id}`, ...over }) as RunSummary
const input = (id: string, agents: AgentInstance[], over: Partial<BandRunIn> = {}): BandRunIn => ({
  summary: summary(id),
  agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  decisions: 0,
  ...over
})
const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Alpha', roles: [], ...over }) as Project
const caps = { bandRuns: 3, bandAgents: 6, bandAgentsPerRun: 4 }

describe('states and colours', () => {
  it('maps agent states to the five band states', () => {
    expect(['starting', 'thinking', 'tool', 'delegating'].map((s) => bandAgentState(s as never))).toEqual(['working', 'working', 'working', 'working'])
    expect(bandAgentState('waiting')).toBe('waiting')
    expect(bandAgentState('idle')).toBe('idle')
    expect(bandAgentState('done')).toBe('done')
    expect(bandAgentState('error')).toBe('failed')
  })
  it('resolves the role colour by id, then slug, then neutral', () => {
    const p = project({ roles: [{ id: 'r1', slug: 'dev', color: '#111' }, { id: 'r2', slug: 'qa', color: '#222' }] as never })
    expect(roleColorFor(p, 'r2', 'x')).toBe('#222')
    expect(roleColorFor(p, null, 'dev')).toBe('#111')
    expect(roleColorFor(p, null, 'none')).toBe('var(--text-tertiary)')
    expect(roleColorFor(undefined, null, 'dev')).toBe('var(--text-tertiary)')
  })
})

describe('treeOrder', () => {
  it('orders parent before children, siblings by start, never the root, with depth', () => {
    const list = [root(), ag('b', { startedAt: 30 }), ag('a', { startedAt: 20 }), ag('a1', { parentId: 'a', startedAt: 40 })]
    expect(treeOrder(list).map((t) => [t.agent.id, t.realDepth])).toEqual([
      ['a', 1],
      ['a1', 2],
      ['b', 1]
    ])
  })
  it('keeps a parentless extra agent and an orphan at depth 1', () => {
    const list = [root(), ag('x', { parentId: null, startedAt: 5 }), ag('o', { parentId: 'ghost', startedAt: 6 })]
    expect(treeOrder(list).map((t) => t.agent.id).sort()).toEqual(['o', 'x'])
  })
})

describe('bandAgents', () => {
  it('never shows the root', () => {
    const r = bandAgents([root(), ag('a')], NOW, 4)
    expect(r.rows.map((x) => x.id)).toEqual(['a'])
  })
  it('shows a done agent inside its 6 s grace and counts it after', () => {
    const fresh = ag('a', { state: 'done', endedAt: NOW - 1000, result: 'ok' })
    expect(bandAgents([root(), fresh], NOW, 4).rows.map((x) => x.state)).toEqual(['done'])
    const old = ag('a', { state: 'done', endedAt: NOW - 7000, result: 'ok' })
    const r = bandAgents([root(), old], NOW, 4)
    expect(r.rows).toEqual([])
    expect(r.done).toBe(1)
    expect(r.failed).toBe(0)
  })
  it('counts settled failures', () => {
    const r = bandAgents([root(), ag('a', { state: 'error', endedAt: NOW - 9000 }), ag('b', { state: 'done', endedAt: NOW - 9000, result: 'x' })], NOW, 4)
    expect(r.done).toBe(2)
    expect(r.failed).toBe(1)
  })
  it('keeps a settled agent while a report under it is live', () => {
    const parent = ag('a', { state: 'done', endedAt: NOW - 9000, result: 'x' })
    const child = ag('a1', { parentId: 'a', startedAt: 20 })
    const r = bandAgents([root(), parent, child], NOW, 4)
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'a1'])
    expect(r.done).toBe(0)
  })
  it('treats a done agent with an unsettled worktree as live', () => {
    const a = ag('a', { state: 'done', endedAt: NOW - 9000, result: 'x', worktree: { status: 'review' } as never })
    const r = bandAgents([root(), a], NOW, 4)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].worktree).toBe('awaiting your review')
  })
  it('keeps rows by priority waiting > working > idle > done and shows them in tree order', () => {
    const list = [
      root(),
      ag('a', { state: 'idle', startedAt: 1 }),
      ag('b', { state: 'done', endedAt: NOW - 1000, result: 'x', startedAt: 2 }),
      ag('c', { state: 'thinking', startedAt: 3 }),
      ag('d', { state: 'waiting', startedAt: 4 }),
      ag('e', { state: 'idle', startedAt: 5 })
    ]
    const r = bandAgents(list, NOW, 3)
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'c', 'd'])
    expect(r.more).toBe(2)
    expect(r.kept).toBe(3)
  })
  it('gives no rows and a more count at zero share', () => {
    const r = bandAgents([root(), ag('a'), ag('b')], NOW, 0)
    expect(r.rows).toEqual([])
    expect(r.more).toBe(2)
  })
  it('clamps depth at 3 and names the parent beyond it', () => {
    const chain = [root(), ag('a', { startedAt: 1 }), ag('b', { parentId: 'a', startedAt: 2 }), ag('c', { parentId: 'b', startedAt: 3 }), ag('d', { parentId: 'c', startedAt: 4, handle: 'deep-d' })]
    const r = bandAgents(chain, NOW, 8)
    expect(r.rows.map((x) => x.depth)).toEqual([1, 2, BAND_MAX_DEPTH, BAND_MAX_DEPTH])
    expect(r.rows[2].under).toBeUndefined()
    expect(r.rows[3].under).toBe('Role c')
    expect(r.rows[3].label).toBe('deep-d')
  })
  it('uses the parent role colour for the line and flags a worktree word only for conflict, review, held', () => {
    const p = project({ roles: [{ id: 'r1', slug: 'lead', color: '#abc' }] as never })
    const lead = ag('a', { roleId: 'r1', roleSlug: 'lead', startedAt: 1 })
    const kid = ag('b', { parentId: 'a', startedAt: 2, worktree: { status: 'active' } as never })
    const r = bandAgents([root(), lead, kid], NOW, 4, p)
    expect(r.rows[1].lineColor).toBe('#abc')
    expect(r.rows[1].worktree).toBeUndefined()
  })
  it('uses the shared activity words', () => {
    const r = bandAgents([root(), ag('a', { state: 'done', endedAt: NOW - 100, result: '' })], NOW, 4)
    expect(r.rows[0].activity).toBe('Ended without a result')
  })
})

describe('markLines', () => {
  const row = (depth: number): BandRow => ({ kind: 'more', count: 1, depth: depth as 1, through: [], last: true })
  it('marks the last sibling and the lines passing through deeper rows', () => {
    const rows = markLines([row(1), row(2), row(1), row(1)])
    expect(rows.map((r) => r.last)).toEqual([false, true, false, true])
    expect(rows[1].through).toEqual([1])
    expect(rows[3].through).toEqual([])
  })
  it('lets no line continue past the final row', () => {
    const rows = markLines([row(1), row(2), row(3)])
    expect(rows.map((r) => r.through)).toEqual([[], [], []])
    expect(rows.every((r) => r.last)).toBe(true)
  })
})

describe('groups and words', () => {
  const view = (word: string) => ({ word }) as never
  it('puts decisions first, then running, else idle', () => {
    expect(groupOf(view('Running'), 2)).toBe('waiting')
    expect(groupOf(view('Running'), 0)).toBe('working')
    expect(groupOf(view('Idle'), 0)).toBe('idle')
  })
  it('picks the current plan step', () => {
    const plan = { steps: [{ status: 'done', title: 'a' }, { status: 'pending', title: 'b' }, { status: 'in_progress', title: 'c' }] } as never
    expect(currentStep(plan)).toBe('c')
    expect(currentStep({ steps: [{ status: 'pending', title: 'b' }] } as never)).toBe('b')
    expect(currentStep(undefined)).toBeUndefined()
  })
  it('words counts, suffixes and summaries', () => {
    expect(countParts({ working: 2, waiting: 1, idle: 0 }).map((p) => p.text)).toEqual(['2 working', '1 waiting for you'])
    expect(countParts({ working: 0, waiting: 0, idle: 0 })).toEqual([])
    expect(decisionsSuffix(0)).toBe('')
    expect(decisionsSuffix(1)).toBe(' · 1 decision in Needs you')
    expect(decisionsSuffix(3)).toBe(' · 3 decisions in Needs you')
    expect(emptyLine(0)).toBe('Nothing is running.')
    expect(emptyLine(2)).toBe('Nothing is running. 2 paused, see Paused.')
    expect(moreRunsLabel(1)).toBe('Show 1 more run')
    expect(moreRunsLabel(4)).toBe('Show 4 more runs')
    expect(moreAgentsText(1)).toBe('1 more agent')
    expect(moreAgentsText(5)).toBe('5 more agents')
    expect(doneText(3, 0)).toBe('3 done')
    expect(doneText(3, 1)).toBe('3 done, 1 failed')
  })
})

describe('bandModel', () => {
  const projects = [project(), project({ id: 'p2', name: 'Beta', kind: 'engagement', client: 'Acme' } as never)]

  it('counts groups over every open run and orders working, waiting, idle then newest', () => {
    const runs = [
      input('idle1', [root({ state: 'idle', activity: 'Waiting for you' })], { summary: summary('idle1', { status: 'idle', startedAt: 5 }) }),
      input('work-old', [root()], { summary: summary('work-old', { startedAt: 1 }) }),
      input('work-new', [root()], { summary: summary('work-new', { startedAt: 9 }) }),
      input('wait', [root({ state: 'waiting' })], { decisions: 2, summary: summary('wait', { startedAt: 3 }) })
    ]
    const m = bandModel(runs, projects, {}, NOW, { ...caps, bandRuns: 10 })
    expect(m.counts).toEqual({ working: 2, waiting: 1, idle: 1 })
    expect(m.projects[0].runs.map((r) => r.id)).toEqual(['work-new', 'work-old', 'wait', 'idle1'])
    expect(m.projects[0].runs[2].suffix).toBe(' · 2 decisions in Needs you')
    expect(m.projects[0].runs[2].group).toBe('waiting')
    expect(m.projects[0].runs[3].line2).toBe('Waiting for your reply')
  })

  it('caps shown runs and reports the rest; showAllRuns lifts it', () => {
    const runs = ['a', 'b', 'c', 'd', 'e'].map((id, i) => input(id, [root()], { summary: summary(id, { startedAt: i }) }))
    const m = bandModel(runs, projects, {}, NOW, caps)
    expect(m.shownRuns).toBe(3)
    expect(m.hiddenRuns).toBe(2)
    expect(m.total).toBe(5)
    expect(bandModel(runs, projects, {}, NOW, caps, { showAllRuns: true }).hiddenRuns).toBe(0)
  })

  it('groups by project with the client caption for engagements only', () => {
    const runs = [
      input('a', [root()], { summary: summary('a', { projectId: 'p2', startedAt: 9 }) }),
      input('b', [root()], { summary: summary('b', { projectId: 'p1', startedAt: 1 }) })
    ]
    const m = bandModel(runs, projects, {}, NOW, caps)
    expect(m.projects.map((p) => [p.label, p.client])).toEqual([
      ['Beta', 'Acme'],
      ['Alpha', undefined]
    ])
  })

  it('labels a virtual project and gives the assistant run a kind chip', () => {
    const runs = [input('q', [root()], { summary: summary('q', { projectId: 'quick', kind: 'work', quick: { scratch: true } as never }) })]
    const m = bandModel(runs, projects, {}, NOW, caps)
    expect(m.projects[0].label).toBe('Chat')
    expect(m.projects[0].runs[0].chip).toBe('Chat')
    expect(bandModel([input('w', [root()])], projects, {}, NOW, caps).projects[0].runs[0].chip).toBeUndefined()
  })

  it('shows the current plan step on a working run, else the root activity', () => {
    const plan = { goal: 'g', status: 'active', autoContinues: 0, updatedAt: 0, steps: [{ id: 'p1', title: 'Write the tests', status: 'in_progress' }, { id: 'p2', title: 'Ship', status: 'pending' }] } as never
    const withPlan = bandModel([input('a', [root()], { plan })], projects, {}, NOW, caps).projects[0].runs[0]
    expect(withPlan.line2).toBe('Write the tests')
    expect(withPlan.planStep).toBe('Step 1 of 2')
    const without = bandModel([input('a', [root({ activity: 'Delegating to 2 agents' })])], projects, {}, NOW, caps).projects[0].runs[0]
    expect(without.line2).toBe('Delegating to 2 agents')
  })

  it('shares the total agent cap run by run and staggers working marks', () => {
    const many = (n: number): AgentInstance[] => [root(), ...Array.from({ length: n }, (_, i) => ag(`x${i}`, { startedAt: i + 1 }))]
    const runs = [input('a', many(5), { summary: summary('a', { startedAt: 9 }) }), input('b', many(5), { summary: summary('b', { startedAt: 8 }) })]
    const m = bandModel(runs, projects, {}, NOW, caps)
    const [a, b] = m.projects[0].runs
    const agentRows = (r: typeof a): number => r.rows.filter((x) => x.kind === 'agent').length
    expect(agentRows(a)).toBe(4)
    expect(agentRows(b)).toBe(2)
    expect(a.rows.find((x) => x.kind === 'more')).toMatchObject({ count: 1 })
    expect(b.rows.find((x) => x.kind === 'more')).toMatchObject({ count: 3 })
    expect(a.rows.filter((x) => x.kind === 'agent').map((x) => (x as { breath?: number }).breath)).toEqual([0, 1, 2, 3])
  })

  it('adds a done row for settled agents with failures', () => {
    const list = [root(), ag('a', { state: 'error', endedAt: NOW - 9000 }), ag('b', { state: 'done', endedAt: NOW - 9000, result: 'x' })]
    const run = bandModel([input('a', list)], projects, {}, NOW, caps).projects[0].runs[0]
    expect(run.rows).toHaveLength(1)
    expect(run.rows[0]).toMatchObject({ kind: 'done', count: 2, failed: 1 })
  })
})

describe('accessible names and signature', () => {
  it('words an agent row', () => {
    const r = bandAgents([root(), ag('a', { handle: 'worker-1', name: 'Dev', activity: 'Reading' })], NOW, 4).rows[0]
    expect(agentRowName(r, 'Fix bug')).toBe('worker-1, Dev, Working: Reading. Opens in Fix bug.')
  })
  it('changes only when something drawn changes', () => {
    const a = [input('r', [root(), ag('a')])]
    const same = [input('r', [root(), ag('a')])]
    const moved = [input('r', [root(), ag('a', { activity: 'else' })])]
    const s = (r: BandRunIn[]): string => bandSignature(r, [project()], {})
    expect(s(a)).toBe(s(same))
    expect(s(a)).not.toBe(s(moved))
  })
})
