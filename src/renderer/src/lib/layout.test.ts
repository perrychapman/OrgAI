import { describe, expect, it } from 'vitest'
import { acyclicParents, initials, layoutCanvas, radialLayout, treeLayout } from './layout'

describe('initials', () => {
  it('uses the first letters of the first two words', () => {
    expect(initials('Code reviewer')).toBe('CR')
    expect(initials('frontend-dev')).toBe('FD')
    expect(initials('orchestrator')).toBe('OR')
    expect(initials('')).toBe('?')
  })

  it('keeps the default when nothing collides', () => {
    expect(initials('Reviewer', ['Writer'])).toBe('RE')
  })

  it('takes a later letter of the slug on a collision', () => {
    const names = ['Reviewer', 'Researcher']
    expect(initials('Reviewer', names)).toBe('RV')
    expect(initials('Researcher', names)).toBe('RS')
  })

  it('never collides with a third role', () => {
    const names = ['Reviewer', 'Researcher', 'Release']
    const out = names.map((n) => initials(n, names))
    expect(new Set(out).size).toBe(3)
  })
})

const item = (id: string, parentId: string | null) => ({ id, parentId, width: 100, height: 50 })

describe('treeLayout', () => {
  it('lays out a tree', () => {
    const pos = treeLayout([item('a', null), item('b', 'a'), item('c', 'a')])
    expect(pos.b.y).toBeGreaterThan(pos.a.y)
    expect(pos.b.x).not.toBe(pos.c.x)
  })

  it('survives a cyclic reportsTo graph', () => {
    const items = [item('root', null), item('a', 'b'), item('b', 'a'), item('c', 'c')]
    const pos = treeLayout(items)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c', 'root'])
    for (const p of Object.values(pos)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })

  it('drops unknown parents and keeps valid ones', () => {
    const parents = acyclicParents([item('r', null), item('a', 'r'), item('b', 'ghost')])
    expect(parents.get('a')).toBe('r')
    expect(parents.has('b')).toBe(false)
  })
})

describe('radialLayout', () => {
  const W = 160
  const H = 40
  const n = (id: string, parentId: string | null) => ({ id, parentId, width: W, height: H })
  const centreOf = (p: { x: number; y: number }) => ({ x: p.x + W / 2, y: p.y + H / 2 })
  const tree = [n('r', null), n('a', 'r'), n('b', 'r'), n('c', 'r'), n('a1', 'a'), n('a2', 'a'), n('b1', 'b')]

  it('handles empty and single inputs', () => {
    expect(radialLayout([])).toEqual({ positions: {}, rings: { cx: 0, cy: 0, radii: [] } })
    const one = radialLayout([n('r', null)])
    expect(centreOf(one.positions.r)).toEqual({ x: 0, y: 0 })
    expect(one.rings?.radii).toEqual([])
  })

  it('puts the root at the centre and each depth on its ring', () => {
    const out = radialLayout(tree, { ringStep: 200 })
    expect(centreOf(out.positions.r)).toEqual({ x: 0, y: 0 })
    const depth: Record<string, number> = { a: 1, b: 1, c: 1, a1: 2, a2: 2, b1: 2 }
    expect(out.rings?.radii.length).toBe(2)
    for (const [id, d] of Object.entries(depth)) {
      const c = centreOf(out.positions[id])
      expect(Math.abs(Math.hypot(c.x, c.y) - (out.rings?.radii[d - 1] ?? -1))).toBeLessThan(1)
    }
    expect(out.rings!.radii[1] - out.rings!.radii[0]).toBeGreaterThanOrEqual(200)
  })

  it('starts at 12 o clock and runs clockwise in input order', () => {
    const out = radialLayout([n('r', null), n('a', 'r'), n('b', 'r'), n('c', 'r'), n('d', 'r')])
    const a = centreOf(out.positions.a)
    const b = centreOf(out.positions.b)
    expect(a.y).toBeLessThan(0)
    expect(a.x).toBeGreaterThan(0)
    expect(b.x).toBeGreaterThan(0)
    expect(b.y).toBeGreaterThan(0)
  })

  it('keeps children inside their parent sector', () => {
    const out = radialLayout(tree)
    const ang = (id: string): number => {
      const c = centreOf(out.positions[id])
      return (Math.atan2(c.x, -c.y) + 2 * Math.PI) % (2 * Math.PI)
    }
    // a owns 2 of 4 leaves: [0, PI).
    expect(ang('a1')).toBeLessThan(Math.PI)
    expect(ang('a2')).toBeLessThan(Math.PI)
    expect(ang('b1')).toBeGreaterThan(ang('a2'))
  })

  it('never overlaps nodes on a full ring', () => {
    const kids = Array.from({ length: 24 }, (_, i) => n(`k${i}`, 'r'))
    const out = radialLayout([n('r', null), ...kids])
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const p = out.positions[kids[i].id]
        const q = out.positions[kids[j].id]
        const apart = Math.abs(p.x - q.x) >= W || Math.abs(p.y - q.y) >= H
        expect(apart).toBe(true)
      }
    }
  })

  it('treats extra roots as children of the first and survives cycles', () => {
    const out = radialLayout([n('r', null), n('s', null), n('x', 'y'), n('y', 'x')])
    const c = centreOf(out.positions.s)
    expect(Math.hypot(c.x, c.y)).toBeGreaterThan(0)
    expect(Object.keys(out.positions).sort()).toEqual(['r', 's', 'x', 'y'])
  })
})

describe('layoutCanvas', () => {
  it('puts a child right of its parent in left to right', () => {
    const items = [{ id: 'r', parentId: null, width: 100, height: 40 }, { id: 'a', parentId: 'r', width: 100, height: 40 }]
    const out = layoutCanvas('left-right', items)
    expect(out.positions.a.x).toBeGreaterThan(out.positions.r.x + 100)
    expect(out.rings).toBeUndefined()
  })
  it('returns rings for radial', () => {
    const items = [{ id: 'r', parentId: null, width: 100, height: 40 }, { id: 'a', parentId: 'r', width: 100, height: 40 }]
    expect(layoutCanvas('radial', items, { ringStep: 300 }).rings?.radii).toEqual([300])
  })
})
