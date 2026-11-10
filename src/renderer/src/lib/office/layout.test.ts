import { describe, expect, it } from 'vitest'
import { assignAppearances, assignDepartmentSlots, clearWorkerPath, DESKS_PER_ROOM, OFFICE_TILE, route } from './layout'

describe('office layout helpers', () => {
  it('assigns twelve distinct looks and retains identity through reorder, removal and return', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `person-${index}`)
    const first = assignAppearances(new Map(), ids, 12)
    expect(new Set(first.values()).size).toBe(12)
    expect(assignAppearances(first, [...ids].reverse(), 12)).toEqual(first)
    const removed = assignAppearances(first, ids.slice(1), 12)
    expect(assignAppearances(removed, ids, 12)).toEqual(first)
    const replaced = assignAppearances(first, Array.from({ length: 12 }, (_, index) => `new-${index}`), 12)
    expect(new Set([...replaced].filter(([id]) => id.startsWith('new-')).map(([, look]) => look)).size).toBe(12)
  })

  it('keeps department slots as tombstones across removal and return', () => {
    const agents = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, departmentId: 'd', central: false }))
    const slots = assignDepartmentSlots(new Map(), agents)
    expect([...slots.values()]).toEqual([0, 1, 2, 3])
    expect(assignDepartmentSlots(slots, agents.slice(1)).get(JSON.stringify(['d', 'a1']))).toBe(1)
    const added = assignDepartmentSlots(slots, [...agents.slice(1), { id: 'new', departmentId: 'd', central: false }])
    expect(added.get(JSON.stringify(['d', 'new']))).toBe(4)
    expect(assignDepartmentSlots(slots, [{ id: 'c', departmentId: 'd', central: true }]).get(JSON.stringify(['__central__', 'c']))).toBe(0)
  })

  it('keeps the tile size and desk capacity the building relies on', () => {
    expect(OFFICE_TILE).toBe(16)
    expect(DESKS_PER_ROOM).toBe(8)
  })

  it('routes around blocked cells, returns both endpoints and gives up when walled in', () => {
    const blocked = new Set(['1,0', '1,1'])
    const path = route({ x: 0, y: 0 }, { x: 2, y: 0 }, blocked, 3, 3)
    expect(path[0]).toEqual({ x: 0, y: 0 })
    expect(path.at(-1)).toEqual({ x: 2, y: 0 })
    for (const p of path) expect(blocked.has(`${p.x},${p.y}`)).toBe(false)
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y)).toBe(1)
    expect(route({ x: 0, y: 0 }, { x: 2, y: 0 }, new Set(['1,0', '1,1', '1,2']), 3, 3)).toEqual([])
    expect(route({ x: 0, y: 0 }, { x: 2, y: 0 }, new Set(['2,0']), 3, 3)).toEqual([])
  })

  it('stops a walk before it gets within a person-sized stand-off of another worker', () => {
    const path = Array.from({ length: 8 }, (_, x) => ({ x, y: 0 }))
    const safe = clearWorkerPath(path, [{ x: 6, y: 0 }])
    expect(safe.at(-1)).toEqual({ x: 4, y: 0 })
    for (const point of safe) expect(Math.abs(point.x - 6) >= 2 || Math.abs(point.y) >= 3).toBe(true)
    expect(clearWorkerPath(path, [{ x: 6, y: 5 }])).toEqual(path)
  })
})
