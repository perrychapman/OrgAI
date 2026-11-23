import { describe, expect, it } from 'vitest'
import type { KnowledgeEdge, KnowledgeNode } from '@shared/types'
import { CONNECTED_LIMIT, CONNECTED_LIMIT_ABOVE, connectionDegrees, limitNote, mostConnected, restrictGraph } from './knowledgeLimit'

const node = (id: string, createdAt = 1, extra: Partial<KnowledgeNode> = {}): KnowledgeNode => ({ id, name: id, kind: 'person', facts: [], createdAt, updatedAt: createdAt, ...extra }) as unknown as KnowledgeNode
const edge = (from: string, to: string, extra: Partial<KnowledgeEdge> = {}): KnowledgeEdge => ({ id: `${from}-${to}`, from, to, relation: 'knows', ...extra }) as unknown as KnowledgeEdge
/** n items n0..n(n-1) in creation order; the hub n0 is linked to the first `spokes` others. */
const star = (n: number, spokes: number) => ({
  nodes: Array.from({ length: n }, (_, i) => node(`n${i}`, i + 1)),
  edges: Array.from({ length: spokes }, (_, i) => edge('n0', `n${i + 1}`))
})
const base = { showRetired: false, all: false, filtering: false }

describe('connectionDegrees', () => {
  it('counts live relations at both ends', () => {
    const d = connectionDegrees({ nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('a', 'c')] }, false)
    expect([d.get('a'), d.get('b'), d.get('c')]).toEqual([2, 1, 1])
  })
  it('ignores retired relations, relations of retired items and self loops, unless retired items are shown', () => {
    const g = { nodes: [node('a'), node('b'), node('c', 1, { retired: true })], edges: [edge('a', 'b', { retired: true }), edge('a', 'c'), edge('b', 'b')] }
    const live = connectionDegrees(g, false)
    expect([...live.keys()]).toEqual(['a', 'b'])
    expect(live.get('a')).toBe(0)
    const all = connectionDegrees(g, true)
    expect(all.get('a')).toBe(2)
    expect(all.get('c')).toBe(1)
  })
})

describe('mostConnected', () => {
  it('does not apply to a small graph', () => {
    const v = mostConnected(star(CONNECTED_LIMIT_ABOVE, 10), base)
    expect(v).toMatchObject({ limited: false, eligible: false, ids: null, shown: CONNECTED_LIMIT_ABOVE, total: CONNECTED_LIMIT_ABOVE, extra: 0 })
  })
  it('keeps the most connected items of a big graph', () => {
    const g = star(CONNECTED_LIMIT_ABOVE + 25, 70)
    const v = mostConnected(g, base)
    expect(v.limited).toBe(true)
    expect(v.shown).toBe(CONNECTED_LIMIT)
    expect(v.total).toBe(g.nodes.length)
    expect(v.ids?.has('n0')).toBe(true)
    // The hub's spokes (one link each) fill the rest in creation order; unlinked items come after them.
    expect(v.ids?.has('n59')).toBe(true)
    expect(v.ids?.has('n60')).toBe(false)
    expect(v.ids?.has('n99')).toBe(false)
  })
  it('breaks ties by creation order, then name, then id', () => {
    const nodes = [node('z', 1), node('a', 1), node('m', 1), ...Array.from({ length: 80 }, (_, i) => node(`x${i}`, 5 + i))]
    const v = mostConnected({ nodes, edges: [] }, { ...base, limit: 2, above: 10 })
    expect([...(v.ids ?? [])].sort()).toEqual(['a', 'm'])
  })
  it('always draws the items the user opened, and says so', () => {
    const g = star(120, 50)
    const v = mostConnected(g, { ...base, keep: ['n110', null, 'n111', 'missing'] })
    expect(v.ids?.has('n110')).toBe(true)
    expect(v.ids?.has('n111')).toBe(true)
    expect(v.ids?.has('missing')).toBe(false)
    expect(v.extra).toBe(2)
    expect(limitNote(v)).toBe(`Showing the ${CONNECTED_LIMIT} most connected of 120, and 2 you opened`)
  })
  it('does not count an item already inside the limit as extra', () => {
    expect(mostConnected(star(120, 50), { ...base, keep: ['n0'] }).extra).toBe(0)
  })
  it('draws everything after "Show all" and while a search or filter is active', () => {
    const g = star(120, 50)
    expect(mostConnected(g, { ...base, all: true })).toMatchObject({ limited: false, eligible: true, ids: null, shown: 120 })
    expect(mostConnected(g, { ...base, filtering: true })).toMatchObject({ limited: false, eligible: true, ids: null, shown: 120 })
  })
  it('counts retired items only when they are shown', () => {
    const g = { nodes: Array.from({ length: 130 }, (_, i) => node(`n${i}`, i, i < 30 ? { retired: true } : {})), edges: [] }
    expect(mostConnected(g, base).total).toBe(100)
    expect(mostConnected(g, { ...base, showRetired: true }).total).toBe(130)
    expect(mostConnected(g, base).ids?.has('n0')).toBe(false)
  })
})

describe('restrictGraph', () => {
  it('keeps the drawn items and the relations between them', () => {
    const g = { nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] }
    const r = restrictGraph(g, new Set(['a', 'b']))
    expect(r.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(r.edges.map((e) => e.id)).toEqual(['a-b'])
    expect(g.nodes).toHaveLength(3)
  })
  it('returns the same graph when nothing is left out', () => {
    const g = star(3, 2)
    expect(restrictGraph(g, null)).toBe(g)
  })
})

describe('limitNote', () => {
  it('is silent for a small graph and names what a big one shows', () => {
    expect(limitNote(mostConnected(star(10, 5), base))).toBeNull()
    expect(limitNote(mostConnected(star(120, 50), base))).toBe(`Showing the ${CONNECTED_LIMIT} most connected of 120`)
    expect(limitNote(mostConnected(star(120, 50), { ...base, all: true }))).toBe('Showing all 120 items')
  })
})
