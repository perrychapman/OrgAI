import { describe, expect, it } from 'vitest'
import { DOCK_SLOTS, arcApex, arcPoint, dockSlot, floorRoutes, holdPad, laneX, outfeedPad, routeSegments } from './routes'

describe('floorRoutes (section 3.2 step 7)', () => {
  it('line 1 from the booth front; line n from its lead aisle in lane (n - 2) mod 6; continuation rows', () => {
    const lines = [
      { number: 1, leadId: 'root', rows: [0], count: 3 },
      { number: 2, leadId: 'A', rows: [1, 3], count: 9 },
      { number: 8, leadId: 'B', rows: [2], count: 1 }
    ]
    const centres: Record<string, { x: number; z: number }> = { A: { x: 6, z: 1.5 }, B: { x: 10, z: 8.5 } }
    const routes = floorRoutes(lines, 'root', (id) => centres[id])
    expect(routes).toEqual([
      { line: 1, lane: 0, points: [{ x: 7, z: -3.5 }, { x: 1, z: -3.5 }, { x: 1, z: 1.5 }, { x: 2, z: 1.5 }] },
      { line: 2, lane: 0, points: [{ x: 6, z: 5.5 }, { x: 1, z: 5.5 }, { x: 1, z: 8.5 }, { x: 2, z: 8.5 }] },
      { line: 2, lane: 0, points: [{ x: 1, z: 8.5 }, { x: 1, z: 22.5 }, { x: 2, z: 22.5 }] },
      { line: 8, lane: 0, points: [{ x: 10, z: 12.5 }, { x: 1, z: 12.5 }, { x: 1, z: 15.5 }, { x: 2, z: 15.5 }] }
    ])
    expect(floorRoutes([{ number: 4, leadId: 'B', rows: [2], count: 1 }], 'root', (id) => centres[id])[0].lane).toBe(2)
    expect(laneX(5)).toBe(2.25)
  })

  it('skips a line whose lead has no station', () => {
    expect(floorRoutes([{ number: 3, leadId: 'gone', rows: [2], count: 1 }], 'root', () => undefined)).toEqual([])
  })

  it('segments: centre, length plus a stripe, rotation along the segment', () => {
    const segs = routeSegments([{ line: 1, lane: 0, points: [{ x: 7, z: -3.5 }, { x: 1, z: -3.5 }, { x: 1, z: 1.5 }, { x: 1, z: 1.5 }] }])
    expect(segs).toHaveLength(2)
    expect(segs[0].center).toEqual({ x: 4, z: -3.5 })
    expect(segs[0].length).toBeCloseTo(6.25, 9)
    expect(Math.abs(Math.cos(segs[0].rotY))).toBeCloseTo(1, 9)
    expect(segs[1].center).toEqual({ x: 1, z: -1 })
    expect(Math.abs(Math.sin(segs[1].rotY))).toBeCloseTo(1, 9)
  })
})

describe('arcs and slots', () => {
  it('arcPoint starts and ends on the floor and peaks at the apex mid-way', () => {
    const a = { x: 0, z: 0 }
    const b = { x: 20, z: 0 }
    expect(arcApex(a, b)).toBe(5.5)
    expect(arcApex(a, { x: 100, z: 0 })).toBe(7.5)
    expect(arcPoint(a, b, 0)).toEqual({ x: 0, y: 0, z: 0 })
    expect(arcPoint(a, b, 1)).toEqual({ x: 20, y: 0, z: 0 })
    expect(arcPoint(a, b, 0.5)).toEqual({ x: 10, y: 5.5, z: 0 })
    expect(arcPoint(a, b, 2)).toEqual({ x: 20, y: 0, z: 0 })
    expect(arcPoint(a, b, 0.5, 1, 1.5).y).toBe(2.5)
  })

  it('dock has nine slots inside its 6 x 4 m; pads sit on the belt', () => {
    const dock = { x: 17, z: -6 }
    const slots = Array.from({ length: DOCK_SLOTS }, (_, i) => dockSlot(i, dock)!)
    for (const s of slots) {
      expect(Math.abs(s.x - 17)).toBeLessThanOrEqual(3)
      expect(Math.abs(s.z + 6)).toBeLessThanOrEqual(2)
    }
    expect(new Set(slots.map((s) => `${s.x},${s.z}`)).size).toBe(9)
    expect(dockSlot(9, dock)).toBeNull()
    expect(outfeedPad({ x: 6, z: 1.5 })).toEqual({ x: 7, z: 3.5 })
    expect(holdPad({ x: 6, z: 1.5 })).toEqual({ x: 5, z: 3.5 })
  })
})
