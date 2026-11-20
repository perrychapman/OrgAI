import { describe, expect, it } from 'vitest'
import { placeNewRole, revealShift, type PlacementNode } from './rolePlacement'

const SIZE = { width: 220, height: 96 }
const node = (id: string, x: number, y: number, reportsTo: string | null): PlacementNode => ({ id, position: { x, y }, reportsTo })
const box = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, w: SIZE.width, h: SIZE.height })
const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('placeNewRole', () => {
  it('puts the first role at the origin', () => {
    expect(placeNewRole([], null, SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('puts the first report directly below its manager, centred on it', () => {
    const roles = [node('root', 100, 50, null)]
    expect(placeNewRole(roles, 'root', SIZE)).toEqual({ x: 100, y: 50 + SIZE.height + 110 })
  })

  it('centres the first report under a manager of another width', () => {
    const roles = [node('root', 0, 0, null)]
    const p = placeNewRole(roles, 'root', { width: 160, height: 40 }, { sizeOf: () => SIZE })
    expect(p.x).toBe((220 - 160) / 2)
  })

  it('puts the second report beside the first, on the same row', () => {
    const roles = [node('root', 0, 0, null), node('a', 0, 206, 'root')]
    const p = placeNewRole(roles, 'root', SIZE)
    expect(p).toEqual({ x: 220 + 40, y: 206 })
  })

  it('skips a slot another node already holds', () => {
    // A node of another branch sits where the next sibling would go.
    const roles = [node('root', 0, 0, null), node('a', 0, 206, 'root'), node('other', 260, 206, null)]
    const p = placeNewRole(roles, 'root', SIZE)
    expect(p.y).toBe(206)
    expect(p.x).toBe(520)
    expect(hit(box(p), box({ x: 260, y: 206 }))).toBe(false)
  })

  it('wraps to the next row when the row is full', () => {
    const roles = [node('root', 0, 0, null), node('a', 0, 206, 'root')]
    // Eight foreign nodes fill the slots right of the sibling.
    for (let i = 0; i < 8; i++) roles.push(node(`s${i}`, 260 * (i + 1), 206, null))
    const p = placeNewRole(roles, 'root', SIZE)
    for (const r of roles) expect(hit(box(p), box(r.position))).toBe(false)
    expect(p.y).toBeGreaterThan(206)
  })

  it('uses the measured size of existing nodes', () => {
    const roles = [node('root', 0, 0, null), node('a', 0, 206, 'root')]
    const p = placeNewRole(roles, 'root', SIZE, { sizeOf: (id) => (id === 'a' ? { width: 300, height: 96 } : undefined) })
    expect(p.x).toBe(340)
  })

  it('left-right: the first report goes to the right, siblings stack downward', () => {
    const roles = [node('root', 0, 0, null)]
    const first = placeNewRole(roles, 'root', SIZE, { layout: 'left-right' })
    expect(first.x).toBe(220 + 110)
    roles.push(node('a', first.x, first.y, 'root'))
    const second = placeNewRole(roles, 'root', SIZE, { layout: 'left-right' })
    expect(second).toEqual({ x: first.x, y: first.y + SIZE.height + 40 })
  })

  it('treats radial like top-down', () => {
    const roles = [node('root', 0, 0, null)]
    expect(placeNewRole(roles, 'root', SIZE, { layout: 'radial' })).toEqual(placeNewRole(roles, 'root', SIZE))
  })

  it('never overlaps any node over many adds, under several managers, in every layout', () => {
    for (const layout of ['top-down', 'left-right', 'radial']) {
      const roles: PlacementNode[] = [node('root', 0, 0, null)]
      for (let i = 0; i < 40; i++) {
        const manager = i % 3 === 0 ? 'root' : roles[(i * 7) % roles.length].id
        const p = placeNewRole(roles, manager, SIZE, { layout })
        for (const r of roles) expect(hit(box(p), box(r.position)), `${layout} add ${i} overlaps ${r.id}`).toBe(false)
        roles.push(node(`n${i}`, p.x, p.y, manager))
      }
    }
  })

  it('still finds room when the manager is unknown', () => {
    const roles = [node('a', 0, 0, null)]
    const p = placeNewRole(roles, 'gone', SIZE)
    expect(hit(box(p), box({ x: 0, y: 0 }))).toBe(false)
  })
})

describe('revealShift (QA S1)', () => {
  const M = { top: 24, right: 24, bottom: 24, left: 24 }
  const stage = { w: 1000, h: 600 }
  const controls = { x: 950, y: 480, w: 34, h: 100 }
  const minimap = { x: 15, y: 470, w: 200, h: 115 }
  const clear = (n: { x: number; y: number; w: number; h: number }, s: { dx: number; dy: number }, o: { x: number; y: number; w: number; h: number }): boolean => {
    const a = { ...n, x: n.x + s.dx, y: n.y + s.dy }
    return a.x + a.w + 8 <= o.x || o.x + o.w + 8 <= a.x || a.y + a.h + 8 <= o.y || o.y + o.h + 8 <= a.y
  }

  it('leaves a box that is in the stage and clear of the controls alone', () => {
    expect(revealShift({ x: 400, y: 200, w: 200, h: 80 }, stage, M, [controls, minimap])).toEqual({ dx: 0, dy: 0 })
  })

  it('moves a box out from under the zoom controls, by the shorter way that stays in the stage', () => {
    const n = { x: 760, y: 480, w: 200, h: 80 }
    const s = revealShift(n, stage, M, [controls, minimap])
    expect(clear(n, s, controls)).toBe(true)
    expect(clear(n, s, minimap)).toBe(true)
    expect(n.x + s.dx + n.w).toBeLessThanOrEqual(stage.w - M.right)
  })

  it('moves a box off the minimap and keeps it inside the stage', () => {
    const n = { x: 40, y: 500, w: 200, h: 80 }
    const s = revealShift(n, stage, M, [controls, minimap])
    expect(clear(n, s, minimap)).toBe(true)
    expect(n.y + s.dy).toBeGreaterThanOrEqual(M.top)
  })

  it('first brings a box that is off the stage back in, then clears the controls', () => {
    const n = { x: 1100, y: 650, w: 200, h: 80 }
    const s = revealShift(n, stage, M, [controls])
    expect(n.x + s.dx + n.w).toBeLessThanOrEqual(stage.w - M.right)
    expect(clear(n, s, controls)).toBe(true)
  })
})
