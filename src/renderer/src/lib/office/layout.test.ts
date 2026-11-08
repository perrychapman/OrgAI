import { describe, expect, it } from 'vitest'
import { assignDesks, blockedCells, deskForSlot, DESKS_PER_ROOM, route } from './layout'

describe('office layout', () => {
  it('preserves occupied and removed slots when the team changes order', () => {
    const first = assignDesks(new Map(), ['a', 'b', 'c'])
    const next = assignDesks(first, ['c', 'a', 'd'])
    expect([...next]).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]])
  })
  it('connects every interaction anchor without crossing furniture', () => {
    const blocked = blockedCells()
    const anchors = Array.from({ length: DESKS_PER_ROOM }, (_, i) => deskForSlot(i).anchor)
    for (const from of anchors) for (const to of anchors) {
      const path = route(from, to)
      expect(path[0]).toEqual(from)
      expect(path.at(-1)).toEqual(to)
      for (const p of path) expect(blocked.has(`${p.x},${p.y}`)).toBe(false)
      for (let i = 1; i < path.length; i++) expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y)).toBe(1)
    }
  })
})
