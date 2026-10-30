import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { ancestorsOf, hasLiveDescendant, normalizeParents } from './agentTree'

const ag = (id: string, parentId: string | null, state = 'done'): AgentInstance => ({ id, parentId, state }) as unknown as AgentInstance
const map = (list: AgentInstance[]): Map<string, AgentInstance> => new Map(list.map((a) => [a.id, a]))
const settled = (a: AgentInstance): boolean => a.state === 'done'

describe('ancestorsOf', () => {
  it('walks a deep chain', () => {
    expect(ancestorsOf(map([ag('r', null), ag('a', 'r'), ag('b', 'a')]), 'b')).toEqual(['a', 'r'])
  })
  it('handles self-parent, 2-cycle, 3-cycle', () => {
    expect(ancestorsOf(map([ag('a', 'a')]), 'a')).toEqual([])
    expect(ancestorsOf(map([ag('a', 'b'), ag('b', 'a')]), 'a')).toEqual(['b'])
    expect(ancestorsOf(map([ag('a', 'b'), ag('b', 'c'), ag('c', 'a')]), 'a')).toEqual(['b', 'c'])
  })
  it('stops at a dangling parent and accepts a record', () => {
    expect(ancestorsOf({ a: ag('a', 'x') }, 'a')).toEqual(['x'])
  })
})

describe('normalizeParents', () => {
  it('returns the same reference when unchanged', () => {
    const list = [ag('r', null), ag('a', 'r'), ag('b', 'a')]
    expect(normalizeParents(list)).toBe(list)
  })
  it('detaches self-parent, 3-cycle and dangling chains without mutating', () => {
    const list = [ag('s', 's'), ag('a', 'b'), ag('b', 'c'), ag('c', 'a'), ag('d', 'missing'), ag('e', 'd')]
    const out = normalizeParents(list)
    expect(out.map((x) => x.parentId)).toEqual([null, null, 'c', 'a', null, 'd'])
    expect(list[0].parentId).toBe('s')
  })
  it('handles the real run shape', () => {
    const list = [ag('a5b1', 'a2b8'), ag('a2b8', 'a5b1'), ag('x1', 'a5b1'), ag('x2', 'a2b8')]
    const out = normalizeParents(list)
    expect(out.map((a) => a.parentId)).toEqual([null, 'a5b1', 'a5b1', 'a2b8'])
  })
  it('repairs the persisted run shape (a7e2 keeps its parent) and is idempotent', () => {
    const list = [ag('root', null), ag('a5b1', 'a2b8'), ag('a2b8', 'a5b1'), ag('a7e2', 'a5b1')]
    const out = normalizeParents(list)
    expect(out.map((a) => a.parentId)).toEqual([null, null, 'a5b1', 'a5b1'])
    expect(normalizeParents(out)).toBe(out)
    expect(list[1].parentId).toBe('a2b8')
  })
})

describe('hasLiveDescendant', () => {
  it('finds a live deep descendant and terminates on cycles', () => {
    expect(hasLiveDescendant([ag('r', null), ag('a', 'r'), ag('b', 'a', 'running')], 'r', settled)).toBe(true)
    expect(hasLiveDescendant([ag('a', 'b'), ag('b', 'a')], 'a', settled)).toBe(false)
  })
})
