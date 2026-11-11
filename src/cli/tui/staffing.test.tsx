import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunPlan, RunStaffing, StaffingAssignment } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { InputBus } from './context'
import { InspectorPane, inspectorFacts } from './InspectorPane'
import { OrgTreePane, rowLine } from './OrgTreePane'
import { PlanPane } from './PlanPane'
import { StatusBar } from './StatusBar'
import { ESC_RE, Providers, env } from './panes/testUtil'
import { textWidth } from './panes/text'
import { agentDetail, orgTreeRows, planView, statusSummary } from './selectors'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import type { OrgTreeRow, TuiState } from './types'

const agent = (id: string, parentId: string | null, over: Partial<AgentInstance> = {}): AgentInstance => ({
  id, roleId: null, roleSlug: id, name: 'Engineer', parentId, spawnToolUseId: null, state: 'thinking', activity: 'Working',
  inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over
})
const asg = (over: Partial<StaffingAssignment> = {}): StaffingAssignment => ({ agentId: 'w1', roleId: 'engineer', tier: 'everyday', model: 'sonnet', effort: 'medium', source: 'orchestrator', at: 1, ...over })
const plan = (steps: RunPlan['steps']): RunPlan => ({ goal: 'Ship', status: 'active', autoContinues: 0, updatedAt: 1, steps })

function state(over: { staffing?: RunStaffing; plan?: RunPlan; agents?: AgentInstance[] } = {}): TuiState {
  const base: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Shop' }) }
  const rec = record(summary('r1', { status: 'running' }))
  const agents = Object.fromEntries((over.agents ?? [agent('root', null, { name: 'Orchestrator' }), agent('w1', 'root', { model: 'sonnet' })]).map((a) => [a.id, a]))
  return setActiveRun(applyRecord(base, { ...rec, agents, ...(over.plan ? { plan: over.plan } : {}), ...(over.staffing ? { staffing: over.staffing } : {}) } as never), 'r1')
}

describe('selectors', () => {
  it('rows and the inspector carry the newest assignment of the agent; an unstaffed agent gets nothing', () => {
    const s = state({ staffing: { goal: 'balanced', assignments: [asg({ at: 1, effort: 'low' }), asg({ at: 2, source: 'clamped', note: 'fast is the cap\u001b[31m' })] } })
    const rows = orgTreeRows(s)
    expect(rows.find((r) => r.id === 'w1')?.staffing).toBe('everyday / medium')
    expect(rows.find((r) => r.id === 'w1')).toMatchObject({ model: 'sonnet', staffingPick: { tier: 'everyday', effort: 'medium' } })
    expect(rows.find((r) => r.id === 'root')?.staffing).toBeUndefined()
    expect(agentDetail(s, 'w1')?.staffing).toEqual({ label: 'everyday (sonnet) / medium', reason: 'capped by the role: fast is the cap', model: 'sonnet' })
    expect(agentDetail(s, 'root')).not.toHaveProperty('staffing')
    expect(orgTreeRows(state()).some((r) => 'staffing' in r)).toBe(false)
  })

  it('a plan without the graph is unchanged; with it, open steps get flow and staff, sanitized', () => {
    const plain = planView(state({ plan: plan([{ id: 'p1', title: 'One', status: 'pending' }, { id: 'p2', title: 'Two', status: 'in_progress' }]) }))!
    expect(plain).not.toHaveProperty('graph')
    expect(plain.steps.every((st) => !('flow' in st) && !('staff' in st))).toBe(true)
    const g = planView(state({ plan: plan([
      { id: 'p1', title: 'Draft\u001b[31m copy', status: 'in_progress', staff: { role: 'writer\u001b]0;x\u0007', tier: 'fast', effort: 'low' } },
      { id: 'p2', title: 'Review', status: 'pending', after: ['p1'] },
      { id: 'p3', title: 'Ship', status: 'pending' },
      { id: 'p4', title: 'Done', status: 'done' }
    ]) }))!
    expect(g.graph).toBe(true)
    expect(g.steps.map((st) => st.flow)).toEqual([{ state: 'running' }, { state: 'waiting', on: ['Draft copy'] }, { state: 'ready' }, undefined])
    expect(g.steps[0]!.staff).toBe('writer (fast / low)')
  })

  it('a step with an assignment shows what ran, and what was asked when it differs', () => {
    const steps = [{ id: 'p1', title: 'Write', status: 'in_progress' as const, staff: { role: 'writer', tier: 'top' as const, effort: 'max' as const } }]
    const staffing: RunStaffing = { goal: 'balanced', assignments: [asg({ stepId: 'p1', roleId: 'writer', tier: 'everyday', effort: 'high' })] }
    expect(planView(state({ plan: plan(steps), staffing }))!.steps[0]!.staff).toBe('writer (everyday / high, asked top / max)')
  })

  it('status counts: working and ready only above zero and only with staffing data or a graph plan', () => {
    const graph = plan([{ id: 'p1', title: 'A', status: 'pending' }, { id: 'p2', title: 'B', status: 'pending', after: ['p1'] }, { id: 'p3', title: 'C', status: 'pending', after: ['gone'] }])
    expect(statusSummary(state({ plan: graph }))).toMatchObject({ working: 2, readySteps: 2 })
    const staffedOnly = statusSummary(state({ staffing: { goal: 'balanced', assignments: [asg()] } }))
    expect(staffedOnly.working).toBe(2)
    expect(staffedOnly).not.toHaveProperty('readySteps')
    const none = statusSummary(state({ plan: plan([{ id: 'p1', title: 'A', status: 'pending' }]) }))
    expect(none).not.toHaveProperty('working')
    expect(none).not.toHaveProperty('readySteps')
    const idle = statusSummary(state({ plan: graph, agents: [agent('root', null, { state: 'done' })] }))
    expect(idle).not.toHaveProperty('working')
  })
})

describe('agent rows', () => {
  const row = (over: Partial<OrgTreeRow> = {}): OrgTreeRow => ({
    id: 'w1', runId: 'r1', depth: 1, label: 'engineer-1', role: 'Engineer', state: 'thinking', stateWord: 'Working', activity: 'reading',
    costText: '$0.10', isRoot: false, staffing: 'everyday / medium', ...over
  })
  const text = (width: number, r = row()): string => rowLine({ kind: 'row', row: r, prefix: '' }, false, false, width, env()).map((s) => s.text).join('')
  it('shows the staffing when the row has room, dim, and drops it first when narrow', () => {
    expect(text(80)).toContain('everyday / medium')
    const segs = rowLine({ kind: 'row', row: row(), prefix: '' }, false, false, 80, env())
    expect(segs.find((s) => s.text.includes('everyday / medium'))?.dim).toBe(true)
    const without = text(80, row({ staffing: undefined }))
    // Narrow enough that the staffing text does not fit: the row is exactly what it was without it.
    for (let w = 22; w < 80; w++) {
      const base = text(w, row({ staffing: undefined }))
      const with_ = text(w)
      if (!with_.includes('everyday')) expect(with_).toBe(base)
      expect(textWidth(with_)).toBeLessThanOrEqual(w)
    }
    expect(text(30)).not.toContain('everyday')
    expect(without).not.toContain('everyday')
  })
  it('names the model inside the staffing label, cuts the id first when narrow, and keeps state and step', () => {
    const r = row({ model: 'claude-sonnet-5-5', staffingPick: { tier: 'everyday', effort: 'medium' } })
    expect(text(100, r)).toContain(' everyday (claude-sonnet-5-5) / medium')
    const widths = Array.from({ length: 70 }, (_, i) => i + 30)
    const cut = widths.map((w) => text(w, r)).find((t) => /everyday \(claude-.*…\) \/ medium/.test(t))
    expect(cut).toBeDefined()
    const bare = widths.map((w) => text(w, r)).find((t) => t.includes('everyday / medium'))
    expect(bare).toBeDefined()
    for (const w of widths) {
      const t = text(w, r)
      expect(textWidth(t)).toBeLessThanOrEqual(w)
      expect(t).toContain('reading')
    }
  })
  it('shows a model alone without staffing, and the connection when set', () => {
    expect(text(100, row({ staffing: undefined, model: 'claude-opus-5-5' }))).toContain(' claude-opus-5-5')
    expect(text(100, row({ model: 'gpt-6.1-sol', staffingPick: { tier: 'fast' }, staffing: 'fast', connection: 'openai' }))).toContain(' fast (gpt-6.1-sol) on openai')
  })
  it('renders in a pane', () => {
    const r = render(<Providers env={env()} bus={new InputBus()}><OrgTreePane width={70} height={6} focused={false} rows={[row()]} /></Providers>)
    expect(r.lastFrame()).toContain('everyday / medium')
    r.unmount()
  })
})

describe('inspector', () => {
  const view = (agentId = 'w1') => agentDetail(state({ staffing: { goal: 'balanced', assignments: [asg({ source: 'escalated', model: 'opus' })] } }), agentId)!
  it('gives the reason in words, with the model in the label', () => {
    const facts = inspectorFacts(view(), env())
    expect(facts.map((f) => f[0]).find((l) => l?.startsWith('staffing'))).toMatch(/^staffing everyday \(opus\) \/ medium \W raised after a failed attempt$/)
  })
  it('lists every model the agent used, and the connection when the run spans several', () => {
    const usage = (models: string[]) => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, turns: 0, toolCalls: 0, models: models.map((model) => ({ model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) })
    const s = state({ agents: [agent('root', null, { connection: 'anthropic', model: 'claude-opus-5-5' }), agent('w1', 'root', { connection: 'openai', model: 'gpt-6.1-sol', usage: usage(['gpt-6-sol', 'gpt-6.1-sol']) as never })] })
    const v = agentDetail(s, 'w1')!
    expect(v.models).toEqual(['gpt-6-sol', 'gpt-6.1-sol'])
    expect(inspectorFacts(v, env())[0]![0]).toMatch(/^models gpt-6-sol, gpt-6\.1-sol on openai/)
    const one = agentDetail(state(), 'w1')!
    expect(one).not.toHaveProperty('models')
    expect(one).not.toHaveProperty('connection')
    expect(inspectorFacts(one, env())[0]![0]).toMatch(/^model sonnet/)
    const rows = orgTreeRows(s)
    expect(rows.find((r) => r.id === 'w1')).toMatchObject({ model: 'gpt-6.1-sol', connection: 'openai' })
    expect(orgTreeRows(state()).some((r) => 'connection' in r)).toBe(false)
  })
  it('adds nothing for an unstaffed agent', () => {
    expect(inspectorFacts(view('root'), env()).some((f) => f[0]?.startsWith('staffing'))).toBe(false)
  })
  it('draws in the pane', () => {
    const r = render(<Providers env={env()} bus={new InputBus()}><InspectorPane width={90} height={14} focused={false} view={view()} rows={[]} partials={[]} showThinking={false} /></Providers>)
    expect(r.lastFrame()).toContain('raised after a failed attempt')
    r.unmount()
  })
})

describe('plan pane and status bar', () => {
  const planV = planView(state({ plan: plan([
    { id: 'p1', title: 'Write the draft', status: 'in_progress', staff: { role: 'writer', tier: 'fast', effort: 'low' } },
    { id: 'p2', title: 'Check facts', status: 'pending', after: ['p1'] },
    { id: 'p3', title: 'Edit', status: 'pending' },
    { id: 'p4', title: 'Publish', status: 'pending', after: ['p1', 'p2', 'p3'] }
  ]) }))!
  const frame = (v: typeof planV, width = 100): string => {
    const r = render(<Providers env={env()} bus={new InputBus()}><PlanPane width={width} height={10} focused={false} plan={v} /></Providers>)
    const f = r.lastFrame() ?? ''
    r.unmount()
    return f
  }
  it('shows running, ready and waiting-on with at most two names, and the staff pick', () => {
    const f = frame(planV)
    expect(f).toMatch(/Write the draft \W running \W writer \(fast \/ low\)/)
    expect(f).toMatch(/Check facts \W waiting on Write the draft/)
    expect(f).toMatch(/Edit \W ready/)
    expect(f).toMatch(/Publish \W waiting on Write the draft, Check facts and 1 more/)
  })
  it('renders a plan without the graph as before', () => {
    const f = frame({ ...planV, graph: undefined, steps: planV.steps.map(({ id, title, status }) => ({ id, title, status })) })
    expect(f).not.toMatch(/running|ready|waiting on/)
  })
  it('a hostile title never puts an escape on screen', () => {
    const v = planView(state({ plan: plan([{ id: 'p1', title: 'A\u001b[31mB\u001b]0;x\u0007', status: 'pending' }, { id: 'p2', title: 'C', status: 'pending', after: ['p1'] }]) }))!
    const f = frame(v)
    expect(f.replace(ESC_RE, '')).toContain('waiting on AB')
    expect(f).not.toContain('\u0007')
  })
  const bar = (summary: object, width = 160): string => {
    const r = render(<Providers env={env()} bus={new InputBus()}><StatusBar width={width} summary={{ needsYou: 0, liveRuns: 1, connection: 'live', projectName: 'Shop', runTag: 'R1', statusWord: 'Running', ...summary }} hints="Tab focus" /></Providers>)
    const f = r.lastFrame() ?? ''
    r.unmount()
    return f
  }
  it('the status bar shows the root model, and the selector follows run.model', () => {
    expect(bar({ rootModel: 'claude-opus-5-5', costText: '$0.10' })).toContain('Running · claude-opus-5-5 · $0.10')
    const s = state({ agents: [agent('root', null, { model: 'claude-opus-5-5' })] })
    expect(statusSummary(s).rootModel).toBe('claude-opus-5-5')
    const switched = applyEvent(s, { event: { type: 'run.model', runId: 'r1', selection: { model: 'gpt-6.1-sol', connection: 'openai' } } } as never)
    expect(statusSummary(switched).rootModel).toBe('gpt-6.1-sol')
  })
  it('the run-start Models line becomes a notice', () => {
    const s = applyEvent(state(), { event: { type: 'log', runId: 'r1', level: 'info', message: 'Models: deep = claude-opus-5-5 (Anthropic)' } } as never)
    expect(s.notices.at(-1)?.text).toBe('Models: deep = claude-opus-5-5 (Anthropic)')
    const quiet = applyEvent(state(), { event: { type: 'log', runId: 'r1', level: 'info', message: 'Messaged run x.' } } as never)
    expect(quiet.notices).toHaveLength(0)
  })
  it('the status bar shows working and ready only when above zero, and drops them first when narrow', () => {
    expect(bar({ working: 3, readySteps: 2 })).toContain('3 working · 2 ready')
    expect(bar({ working: 0, readySteps: 0 })).not.toMatch(/working|ready/)
    expect(bar({})).not.toMatch(/working|ready/)
    const wide = bar({ working: 3, readySteps: 2 }, 80)
    const narrow = bar({ working: 3, readySteps: 2 }, 50)
    expect(wide).toContain('3 working')
    expect(narrow).not.toContain('working')
    expect(narrow).toContain('Running')
  })
})
