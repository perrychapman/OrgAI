import { describe, expect, it } from 'vitest'
import { namesText, readyCount, stepFlows, usesGraph, type GraphStep } from './planGraph'

const s = (id: string, status: GraphStep['status'], after?: string[]): GraphStep => ({ id, status, ...(after ? { after } : {}) })

describe('usesGraph', () => {
  it('is true for after, paths or staff only', () => {
    expect(usesGraph([s('p1', 'pending'), s('p2', 'done')])).toBe(false)
    expect(usesGraph([s('p1', 'pending', [])])).toBe(false)
    expect(usesGraph([s('p1', 'pending'), s('p2', 'pending', ['p1'])])).toBe(true)
    expect(usesGraph([{ id: 'p1', status: 'pending', paths: ['src'] }])).toBe(true)
    expect(usesGraph([{ id: 'p1', status: 'pending', staff: { role: 'x' } }])).toBe(true)
  })
})

describe('stepFlows', () => {
  it('marks running, ready and waiting, and leaves finished steps out', () => {
    const f = stepFlows([s('p1', 'done'), s('p2', 'in_progress'), s('p3', 'pending', ['p1']), s('p4', 'pending', ['p2', 'p1']), s('p5', 'skipped'), s('p6', 'blocked')])
    expect(f.get('p2')).toEqual({ state: 'running' })
    expect(f.get('p3')).toEqual({ state: 'ready' })
    expect(f.get('p4')).toEqual({ state: 'waiting', on: ['p2'] })
    expect([...f.keys()]).toEqual(['p2', 'p3', 'p4'])
  })
  it('treats a skipped step as satisfied and ignores an id that is not in the plan', () => {
    const f = stepFlows([s('p1', 'skipped'), s('p2', 'pending', ['p1', 'gone'])])
    expect(f.get('p2')).toEqual({ state: 'ready' })
  })
  it('does not hang on a cycle or a self reference: the steps just keep waiting', () => {
    const f = stepFlows([s('p1', 'pending', ['p2']), s('p2', 'pending', ['p1']), s('p3', 'pending', ['p3'])])
    expect(f.get('p1')).toEqual({ state: 'waiting', on: ['p2'] })
    expect(f.get('p2')).toEqual({ state: 'waiting', on: ['p1'] })
    expect(f.get('p3')).toEqual({ state: 'waiting', on: ['p3'] })
    expect(readyCount([s('p1', 'pending', ['p2']), s('p2', 'pending', ['p1'])])).toBe(0)
  })
  it('counts ready steps', () => {
    expect(readyCount([s('p1', 'pending'), s('p2', 'pending'), s('p3', 'pending', ['p1']), s('p4', 'in_progress')])).toBe(2)
  })
})

describe('namesText', () => {
  it('names at most two, then the rest', () => {
    expect(namesText(['A'])).toBe('A')
    expect(namesText(['A', 'B'])).toBe('A and B')
    expect(namesText(['A', 'B', 'C'])).toBe('A, B and 1 more')
    expect(namesText(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more')
  })
})
