import { describe, expect, it } from 'vitest'
import type { PlanStep } from './types'
import { normalizePlanPath, pathOverlaps, planUsesGraph, readySteps, stepViews } from './planGraph'

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({ id, title: `Step ${id}`, status: 'pending', ...over })
const plan = (steps: PlanStep[]) => ({ steps })
const ids = (steps: PlanStep[]): string[] => steps.map((s) => s.id)

describe('readySteps and stepViews', () => {
  it('ignores an after id that names no step', () => {
    const p = plan([step('p1', { after: ['gone'] })])
    expect(ids(readySteps(p))).toEqual(['p1'])
    expect(stepViews(p)[0]).toEqual({ state: 'ready', waitingOn: [] })
  })
  it('terminates on a cycle and leaves it waiting', () => {
    const p = plan([step('p1', { after: ['p2'] }), step('p2', { after: ['p3'] }), step('p3', { after: ['p1'] }), step('p4')])
    expect(stepViews(p).map((v) => v.state)).toEqual(['waiting', 'waiting', 'waiting', 'ready'])
    expect(ids(readySteps(p))).toEqual(['p4'])
  })
  it('makes a step that names itself wait for itself', () => {
    const p = plan([step('p1', { after: ['p1'] })])
    expect(readySteps(p)).toEqual([])
    expect(stepViews(p)[0]).toEqual({ state: 'waiting', waitingOn: ['p1'] })
  })
  it('treats duplicate ids as one name: an id is done when any step with it is finished', () => {
    expect(ids(readySteps(plan([step('p1'), step('p1', { after: ['p1'] })])))).toEqual(['p1'])
    const p = plan([step('p1', { status: 'done' }), step('p1'), step('p2', { after: ['p1'] })])
    expect(ids(readySteps(p))).toEqual(['p1', 'p2'])
  })
  it('counts skipped steps as finished', () => {
    const p = plan([step('p1', { status: 'skipped' }), step('p2', { after: ['p1'] }), step('p3', { status: 'done' })])
    expect(stepViews(p).map((v) => v.state)).toEqual(['finished', 'ready', 'finished'])
  })
  it('reports running, blocked and waiting steps with what they wait on, each id once, in order', () => {
    const p = plan([step('p1', { status: 'in_progress' }), step('p2', { status: 'blocked' }), step('p3', { after: ['p2', 'p1', 'p2'] })])
    const v = stepViews(p)
    expect(v.map((x) => x.state)).toEqual(['running', 'blocked', 'waiting'])
    expect(v[2].waitingOn).toEqual(['p2', 'p1'])
    expect(readySteps(p)).toEqual([])
  })
})

describe('path overlap', () => {
  it('makes the later of two parallel steps wait for the earlier', () => {
    const p = plan([step('p1', { paths: ['src/a'] }), step('p2', { paths: ['src/a/b.ts'] }), step('p3', { paths: ['docs'] })])
    expect(pathOverlaps(p)).toEqual([{ first: 'p1', second: 'p2', path: 'src/a' }])
    expect(ids(readySteps(p))).toEqual(['p1', 'p3'])
    expect(stepViews(p)[1]).toEqual({ state: 'waiting', waitingOn: ['p1'] })
  })
  it('adds the path wait after the after waits without repeating an id', () => {
    const p = plan([step('p1', { paths: ['a'] }), step('p0', { status: 'in_progress' }), step('p2', { paths: ['a'], after: ['p0', 'p1'] }), step('p3', { paths: ['a'], after: ['p0'] })])
    const v = stepViews(p)
    expect(v[2].waitingOn).toEqual(['p0', 'p1'])
    expect(v[3].waitingOn).toEqual(['p0', 'p1', 'p2'])
  })
  it('does not order a step after its own ancestor, direct or indirect', () => {
    const p = plan([step('p1', { paths: ['src'] }), step('p2', { after: ['p1'] }), step('p3', { paths: ['src'], after: ['p2'] })])
    expect(pathOverlaps(p)).toEqual([])
    expect(stepViews(p)[2].waitingOn).toEqual(['p2'])
  })
  it('frees the later step once the earlier is done or skipped', () => {
    for (const status of ['done', 'skipped'] as const) {
      expect(ids(readySteps(plan([step('p1', { status, paths: ['src'] }), step('p2', { paths: ['src'] })])))).toEqual(['p2'])
    }
  })
  it('normalises ./a, a/, backslashes and . before comparing', () => {
    expect(normalizePlanPath('./a')).toBe('a')
    expect(normalizePlanPath('a/')).toBe('a')
    expect(normalizePlanPath('a\\b\\')).toBe('a/b')
    expect(normalizePlanPath(' .//a//b ')).toBe('a/b')
    expect(normalizePlanPath('.')).toBe('.')
    expect(normalizePlanPath('')).toBe('.')
    expect(pathOverlaps(plan([step('p1', { paths: ['./a'] }), step('p2', { paths: ['a/'] })]))).toHaveLength(1)
    expect(pathOverlaps(plan([step('p1', { paths: ['a\\b'] }), step('p2', { paths: ['a/b/c.ts'] })]))[0].path).toBe('a/b')
    expect(pathOverlaps(plan([step('p1', { paths: ['.'] }), step('p2', { paths: ['x/y'] })]))[0].path).toBe('.')
    expect(pathOverlaps(plan([step('p1', { paths: ['ab'] }), step('p2', { paths: ['a/b'] })]))).toEqual([])
  })
})

describe('planUsesGraph', () => {
  it('is true for after, paths or staff only', () => {
    expect(planUsesGraph(undefined)).toBe(false)
    expect(planUsesGraph([step('p1'), step('p2', { after: [], paths: [] })])).toBe(false)
    expect(planUsesGraph([step('p1', { after: ['p2'] })])).toBe(true)
    expect(planUsesGraph([step('p1', { paths: ['a'] })])).toBe(true)
    expect(planUsesGraph([step('p1', { staff: { role: 'x' } })])).toBe(true)
  })
})
