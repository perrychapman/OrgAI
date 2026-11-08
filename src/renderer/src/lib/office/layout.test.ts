import { describe, expect, it } from 'vitest'
import atlas from '../../assets/pocket-office/atlas.json'
import { assignDepartmentSlots, assignDesks, blockedCells, buildingBlocked, buildingDesk, buildingLayout, deskForSlot, DESKS_PER_ROOM, floorBounds, OFFICE_TILE, ROOM_PROPS, route, type BuildingAgent } from './layout'

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
  it('blocks every metadata footprint and places desks in deterministic rooms', () => {
    const blocked = blockedCells()
    for (const prop of ROOM_PROPS) for (const [x, y] of atlas.props[prop.name].footprint) expect(blocked.has(`${prop.x + x},${prop.y + y}`)).toBe(true)
    expect(deskForSlot(DESKS_PER_ROOM).room).toBe(1)
    expect(deskForSlot(DESKS_PER_ROOM).anchor).toEqual(deskForSlot(0).anchor)
  })
  it('connects every room through doors without crossing furniture or stationary workers', () => {
    const agents: BuildingAgent[] = Array.from({ length: 32 }, (_, i) => ({ id: `a${i}`, departmentId: `d${Math.floor(i / 8)}`, departmentName: `Department ${Math.floor(i / 8)}`, central: false }))
    const slots = assignDepartmentSlots(new Map(), agents)
    const layout = buildingLayout(agents, slots, 700, 800, 1)
    expect(layout.rooms).toHaveLength(4)
    const rooms = layout.rooms.filter(r => r.floor === 0)
    const blocked = buildingBlocked(rooms, agents, slots)
    for (const agent of agents) {
      const room = rooms.find(r => r.agents.includes(agent.id))!
      const desk = buildingDesk(room, slots.get(JSON.stringify([agent.departmentId, agent.id]))!)
      for (const [x, y] of atlas.props.chair.footprint) expect(blocked.has(`${desk.furniture.x + 2 + x},${desk.furniture.y + y}`)).toBe(true)
    }
    const anchors = agents.map(a => buildingDesk(rooms.find(r => r.agents.includes(a.id))!, slots.get(JSON.stringify([a.departmentId, a.id]))!).anchor)
    for (const from of anchors) for (const to of anchors) {
      const obstacles = new Set(blocked)
      for (const other of anchors) if (other !== from && other !== to) obstacles.add(`${other.x},${other.y}`)
      const path = route(from, to, obstacles, layout.height, layout.width)
      expect(path[0]).toEqual(from)
      expect(path.at(-1)).toEqual(to)
      for (const p of path) expect(obstacles.has(`${p.x},${p.y}`)).toBe(false)
    }
  })
  it('uses viewport capacity, caps floors, and retains department slots on resize and removal', () => {
    const agents: BuildingAgent[] = Array.from({ length: 41 }, (_, i) => ({ id: `a${i}`, departmentId: `d${Math.floor(i / 9)}`, departmentName: `Lead ${Math.floor(i / 9)}`, central: false }))
    const slots = assignDepartmentSlots(new Map(), agents)
    const large = buildingLayout(agents, slots, 1600, 1000, 1)
    const small = buildingLayout(agents, slots, 320, 200, 1)
    expect(large.floorCount).toBeGreaterThan(1)
    expect(small.floorCount).toBeGreaterThan(large.floorCount)
    for (let floor = 0; floor < large.floorCount; floor++) expect(large.rooms.filter(r => r.floor === floor).length).toBeLessThanOrEqual(4)
    expect(small.width * OFFICE_TILE).toBeGreaterThanOrEqual(320)
    expect(small.height * OFFICE_TILE).toBeGreaterThanOrEqual(200)
    const filled = floorBounds(large, 1601, 1001, 1)
    expect(filled.width * OFFICE_TILE).toBeGreaterThanOrEqual(1601)
    expect(filled.height * OFFICE_TILE).toBeGreaterThanOrEqual(1001)
    expect(large.rooms.some(room => room.label === 'Lead 0 2')).toBe(true)
    expect(assignDepartmentSlots(slots, agents.slice(1)).get(JSON.stringify(['d0', 'a1']))).toBe(1)
    expect(small.rooms.find(r => r.agents.includes('a1'))?.id).toBe(large.rooms.find(r => r.agents.includes('a1'))?.id)
  })
})
