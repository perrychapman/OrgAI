import { describe, expect, it } from 'vitest'
import type { PlanStep, RunPlan } from '@shared/types'
import { planHasGraph, readyStepIds, shortTitle, staffingCounts, stepViews, waitingOnText } from './planGraph'

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({ id, title: `Step ${id}`, status: 'pending', ...over })
const plan = (steps: PlanStep[]): RunPlan => ({ goal: 'g', steps, status: 'active', autoContinues: 0, updatedAt: 1 })

describe('stepViews', () => {
  it('marks running, ready, waiting, blocked and finished steps', () => {
    const p = plan([
      step('p1', { status: 'done' }),
      step('p2', { status: 'in_progress', after: ['p1'] }),
      step('p3', { after: ['p1'] }),
      step('p4', { after: ['p2', 'p3'] }),
      step('p5', { status: 'blocked' }),
      step('p6', { status: 'skipped' }),
      step('p7', { after: ['p6'] })
    ])
    const v = stepViews(p)
    expect(v.map((x) => x.state)).toEqual(['finished', 'running', 'ready', 'waiting', 'blocked', 'finished', 'ready'])
    expect(v[3].waitingOn).toEqual(['p2', 'p3'])
    expect(readyStepIds(p)).toEqual(['p3', 'p7'])
  })
  it('ignores a reference to a missing step and to itself', () => {
    const v = stepViews(plan([step('p1', { after: ['nope', 'p1'] })]))
    expect(v[0]).toEqual({ state: 'ready', waitingOn: [] })
  })
  it('does not hang or throw on a cycle, and nothing in it is ready', () => {
    const p = plan([step('p1', { after: ['p2'] }), step('p2', { after: ['p3'] }), step('p3', { after: ['p1'] }), step('p4')])
    expect(stepViews(p).map((x) => x.state)).toEqual(['waiting', 'waiting', 'waiting', 'ready'])
    expect(readyStepIds(p)).toEqual(['p4'])
  })
  it('orders steps that share a path by plan order, like the harness', () => {
    const p = plan([step('p1', { paths: ['src/a'] }), step('p2', { paths: ['src/a/b.ts'] }), step('p3', { paths: ['docs'] })])
    const v = stepViews(p)
    expect(v.map((x) => x.state)).toEqual(['ready', 'waiting', 'ready'])
    expect(v[1].waitingOn).toEqual(['p1'])
    const done = plan([step('p1', { status: 'done', paths: ['src/a'] }), step('p2', { paths: ['src/a/b.ts'] })])
    expect(readyStepIds(done)).toEqual(['p2'])
    // A step that already waits for the other through `after` is not ordered twice.
    const chained = plan([step('p1', { paths: ['src'] }), step('p2', { paths: ['src'], after: ['p1'] })])
    expect(stepViews(chained)[1].waitingOn).toEqual(['p1'])
  })
  it('handles an empty plan and duplicate ids', () => {
    expect(stepViews(plan([]))).toEqual([])
    expect(stepViews(plan([step('p1'), step('p1', { after: ['p1'] })])).map((x) => x.state)).toEqual(['ready', 'ready'])
  })
})

describe('planHasGraph', () => {
  it('is false for a plan as written before the graph', () => {
    expect(planHasGraph(undefined)).toBe(false)
    expect(planHasGraph(plan([step('p1'), step('p2', { after: [] })]))).toBe(false)
    expect(planHasGraph(plan([step('p1', { after: ['p2'] }), step('p2')]))).toBe(true)
    expect(planHasGraph(plan([step('p1', { staff: { role: 'x' } })]))).toBe(true)
  })
})

describe('waitingOnText and shortTitle', () => {
  it('shortens titles and counts the rest', () => {
    const p = plan([step('p1', { title: 'Write the migration for the accounts table' }), step('p2', { title: 'Two' }), step('p3', { title: 'Three' })])
    expect(shortTitle('Write the migration for the accounts table', 20)).toBe('Write the migration…')
    expect(shortTitle('  a   b ')).toBe('a b')
    expect(waitingOnText(p, ['p2'])).toBe('Waiting on Two')
    expect(waitingOnText(p, ['p2', 'p3', 'p1'])).toBe('Waiting on Two, Three and 1 more')
    expect(waitingOnText(p, ['gone'])).toBe('Waiting on gone')
  })
})

describe('staffingCounts', () => {
  const working = new Set(['thinking', 'tool'])
  const agents = [{ state: 'thinking' }, { state: 'done' }, { state: 'tool' }, { state: 'idle' }]
  it('is zero for a run with no staffing data and a plain plan', () => {
    expect(staffingCounts({ agents, isWorking: (s: string) => working.has(s), plan: plan([step('p1')]), hasAssignments: false })).toEqual({ working: 0, ready: 0 })
  })
  it('counts working agents once there are assignments, and ready steps once the plan has a graph', () => {
    expect(staffingCounts({ agents, isWorking: (s: string) => working.has(s), hasAssignments: true })).toEqual({ working: 2, ready: 0 })
    const p = plan([step('p1', { status: 'done' }), step('p2', { after: ['p1'] }), step('p3', { after: ['p2'] }), step('p4', { after: ['p1'] })])
    expect(staffingCounts({ agents, isWorking: (s: string) => working.has(s), plan: p, hasAssignments: false })).toEqual({ working: 2, ready: 2 })
  })
})
