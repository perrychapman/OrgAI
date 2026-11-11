import { describe, expect, it } from 'vitest'
import { buildingBlocked, buildingLayout, CENTRAL_GROUP, departmentRoomSize, doorwayOf, EMPTY_BUILDING_MEMORY, lobbySize, rememberTeam, roomOf, routeInBuilding, type Building, type BuildingAgent, type BuildingMemory } from './building'
import { furnishBuilding } from './themes'

const slug = (name: string): string => name.toLowerCase().replace(/\s+/g, '-')
function team(central: number, departments: readonly (readonly [string, number])[]): BuildingAgent[] {
  return [
    ...Array.from({ length: central }, (_, i) => ({ id: `central-${i}`, departmentId: 'central', departmentName: 'Orchestrators', central: true })),
    ...departments.flatMap(([name, count]) => Array.from({ length: count }, (_, i) => ({ id: `${slug(name)}-${i}`, departmentId: slug(name), departmentName: name, central: false })))
  ]
}
const layout = (agents: readonly BuildingAgent[], memory: BuildingMemory = EMPTY_BUILDING_MEMORY, mode: 'live' | 'team' | 'sample' = 'live'): Building => buildingLayout(agents, rememberTeam(memory, agents), mode)
const rect = (room: { x: number; y: number; width: number; height: number }) => ({ x: room.x, y: room.y, width: room.width, height: room.height })
const label = (b: Building, text: string) => b.rooms.find(room => room.label === text)!
const deskAt = (b: Building, id: string) => b.desks.get(id)!.furniture

function reachability(building: Building): void {
  const props = furnishBuilding(building).props
  const blocked = buildingBlocked(building, props)
  for (const desk of building.desks.values()) {
    expect(blocked.has(`${desk.anchor.x},${desk.anchor.y}`), `anchor of ${desk.agentId} is free`).toBe(false)
    if (building.frontDoor) {
      const path = routeInBuilding(building, blocked, building.frontDoor, desk.anchor)
      expect(path.length, `route front door to ${desk.agentId}`).toBeGreaterThan(1)
      expect(path[0]).toEqual(building.frontDoor)
      expect(path.at(-1)).toEqual(desk.anchor)
      for (let i = 1; i < path.length; i++) expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y)).toBe(1)
      for (const p of path) expect(blocked.has(`${p.x},${p.y}`)).toBe(false)
      // With every other person standing at their anchor.
      const occupied = new Set(blocked)
      for (const other of building.desks.values()) if (other.agentId !== desk.agentId) occupied.add(`${other.anchor.x},${other.anchor.y}`)
      expect(routeInBuilding(building, occupied, building.frontDoor, desk.anchor).length, `route with others seated to ${desk.agentId}`).toBeGreaterThan(1)
    }
  }
}

describe('building layout', () => {
  it('is a pure function of the team: no viewport input, equal results for equal input', () => {
    expect(buildingLayout.length).toBe(3)
    const agents = team(2, [['Engineering', 6], ['Design', 3], ['Support', 9]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    expect(buildingLayout(agents, memory, 'live')).toEqual(buildingLayout(agents, memory, 'live'))
    expect(buildingLayout(agents, memory, 'live')).toEqual(buildingLayout(agents, rememberTeam(EMPTY_BUILDING_MEMORY, agents), 'team'))
    // Passing an empty memory is the same as passing the remembered team.
    expect(buildingLayout(agents, EMPTY_BUILDING_MEMORY, 'live')).toEqual(buildingLayout(agents, memory, 'live'))
  })

  it('remembers slots, groups and rooms without ever reordering or forgetting', () => {
    const first = rememberTeam(EMPTY_BUILDING_MEMORY, team(1, [['A', 2], ['B', 1]]))
    expect(first.groups).toEqual([CENTRAL_GROUP, 'a', 'b'])
    expect(first.rooms).toEqual([JSON.stringify(['a', 0]), JSON.stringify(['b', 0])])
    expect(rememberTeam(first, team(1, [['A', 2], ['B', 1]]))).toBe(first)
    const later = rememberTeam(first, team(0, [['C', 1], ['B', 1]]))
    expect(later.groups).toEqual([...first.groups, 'c'])
    expect(later.rooms).toEqual([...first.rooms!, JSON.stringify(['c', 0])])
    expect([...first.slots].every(([key, slot]) => later.slots.get(key) === slot)).toBe(true)
  })

  it('sizes rooms from the highest slot ever assigned, tombstones included', () => {
    const table: [number, number, number][] = [[1, 12, 10], [2, 12, 10], [3, 16, 10], [4, 20, 10], [5, 20, 15], [8, 20, 15]]
    for (const [count, width, height] of table) {
      const building = layout(team(1, [['Studio', count]]))
      const room = label(building, 'Studio')
      expect([room.width, room.height], `${count} agents`).toEqual([width, height])
      expect(room.cols).toBe((width - 4) / 4)
      expect(room.rows).toBe((height - 5) / 5)
    }
    expect(departmentRoomSize(-1)).toMatchObject({ width: 12, height: 10 })
    // The agents leave; the memory keeps the size.
    const agents = team(1, [['Studio', 8], ['Other', 1]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    const after = buildingLayout(agents.filter(agent => agent.id !== 'studio-7' && agent.id !== 'studio-6' && agent.id !== 'studio-5' && agent.id !== 'studio-4' && agent.id !== 'studio-3'), memory, 'live')
    expect([label(after, 'Studio').width, label(after, 'Studio').height]).toEqual([20, 15])
  })

  it('never moves or shrinks a room or desk when someone leaves', () => {
    const agents = team(2, [['Alpha', 8], ['Beta', 5], ['Gamma', 2], ['Delta', 4]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    const full = buildingLayout(agents, memory, 'live')
    const gone = new Set(['alpha-3', 'beta-4', 'gamma-0', 'central-1', 'delta-2'])
    const remaining = agents.filter(agent => !gone.has(agent.id))
    const after = buildingLayout(remaining, memory, 'live')
    expect(after.width).toBe(full.width)
    expect(after.height).toBe(full.height)
    for (const room of full.rooms) expect(rect(after.rooms.find(r => r.id === room.id)!)).toEqual(rect(room))
    for (const agent of remaining) expect(after.desks.get(agent.id)).toEqual(full.desks.get(agent.id))
  })

  it('adds a department at the end without moving anything that exists', () => {
    const agents = team(1, [['Alpha', 8], ['Beta', 3], ['Gamma', 2]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    const before = buildingLayout(agents, memory, 'live')
    const more = [...agents, ...team(0, [['Delta', 1], ['Epsilon', 8]])]
    const after = buildingLayout(more, memory, 'live')
    for (const room of before.rooms) expect(rect(after.rooms.find(r => r.id === room.id)!), room.label).toEqual(rect(room))
    for (const agent of agents) expect(after.desks.get(agent.id)).toEqual(before.desks.get(agent.id))
    expect(after.width).toBeGreaterThan(before.width)
  })

  it('shifts only the rooms after a growing room on the same side', () => {
    // N: Alpha, Gamma, Epsilon   S: Beta, Delta
    const agents = team(1, [['Alpha', 2], ['Beta', 2], ['Gamma', 2], ['Delta', 2], ['Epsilon', 2]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    const before = buildingLayout(agents, memory, 'live')
    // Gamma (north, middle) gains a third and then a fifth desk: wider, then taller.
    const grown = [...agents, { id: 'gamma-2', departmentId: 'gamma', departmentName: 'Gamma', central: false }]
    const wider = buildingLayout(grown, memory, 'live')
    const dx = label(wider, 'Gamma').width - label(before, 'Gamma').width
    expect(dx).toBe(4)
    const moved = (b: Building) => b.rooms.filter(room => rect(room).x !== rect(before.rooms.find(r => r.id === room.id)!).x || room.y !== before.rooms.find(r => r.id === room.id)!.y).map(room => room.label)
    expect(moved(wider)).toEqual(['Epsilon'])
    expect(label(wider, 'Epsilon').x - label(before, 'Epsilon').x).toBe(dx)
    // Desks inside rooms that did not move are identical; the growing room keeps its desks too.
    for (const agent of agents) {
      const room = roomOf(before, agent.id)!
      if (room.label === 'Epsilon') continue
      expect(wider.desks.get(agent.id)).toEqual(before.desks.get(agent.id))
    }
    // Taller: slots 0-4 push the room up, never the existing desks.
    const taller = [...grown, ...Array.from({ length: 2 }, (_, i) => ({ id: `gamma-${3 + i}`, departmentId: 'gamma', departmentName: 'Gamma', central: false }))]
    const tallMemory = rememberTeam(rememberTeam(memory, grown), taller)
    const tall = buildingLayout(taller, tallMemory, 'live')
    expect(label(tall, 'Gamma').height).toBe(15)
    for (const agent of agents) if (roomOf(before, agent.id)!.label !== 'Epsilon') expect(tall.desks.get(agent.id), agent.id).toEqual(before.desks.get(agent.id))
    expect(tall.rooms.filter(room => room.side === 'south').map(room => rect(room))).toEqual(before.rooms.filter(room => room.side === 'south').map(room => rect(room)))
    expect(rect(label(tall, 'Alpha'))).toEqual(rect(label(before, 'Alpha')))
    expect(label(tall, 'Orchestrators')).toEqual(label(before, 'Orchestrators'))
  })

  it('moves the lobby only when the corridor first appears or the lobby itself grows', () => {
    const lobbyOnly = layout(team(2, []))
    const withRoom = layout(team(2, [['Alpha', 1]]))
    expect(rect(lobbyOnly.rooms[0])).toEqual({ x: 0, y: 0, width: 18, height: 14 })
    expect(withRoom.rooms[0].x).toBe(0)
    const four = layout(team(4, [['Alpha', 1], ['Beta', 1]]))
    expect(four.rooms[0].width).toBe(20)
    expect(label(four, 'Alpha').x).toBe(20)
    expect(four.rooms[0].y).toBe(withRoom.rooms[0].y)
    expect(lobbySize(7)).toMatchObject({ cols: 4, rows: 2, width: 20, height: 19 })
  })

  it('keeps first-seen order, alternates north and south and adds overflow rooms in sequence', () => {
    const agents = team(1, [['Alpha', 9], ['Beta', 1], ['Gamma', 1], ['Delta', 1]])
    const building = layout(agents)
    const sequence = building.rooms.filter(room => room.kind === 'department')
    expect(sequence.map(room => [room.label, room.side])).toEqual([
      ['Alpha', 'north'], ['Alpha 2', 'south'], ['Beta', 'north'], ['Gamma', 'south'], ['Delta', 'north']
    ])
    expect(sequence[1]).toMatchObject({ departmentName: 'Alpha', label: 'Alpha 2' })
    expect(sequence[1].agents).toEqual(['alpha-8'])
    expect(building.rooms[0]).toMatchObject({ kind: 'lobby', label: 'Orchestrators', side: 'west', theme: -1 })
    // A later overflow room does not flip the sides of rooms that already exist.
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, team(1, [['Alpha', 8], ['Beta', 1], ['Gamma', 1]]))
    const grown = buildingLayout(team(1, [['Alpha', 9], ['Beta', 1], ['Gamma', 1]]), memory, 'live')
    expect(grown.rooms.filter(room => room.kind === 'department').map(room => [room.label, room.side])).toEqual([['Alpha', 'north'], ['Beta', 'south'], ['Gamma', 'north'], ['Alpha 2', 'south']])
    // Team mode: input order is first-seen order.
    const reversed = layout([...agents].reverse(), EMPTY_BUILDING_MEMORY, 'team')
    expect(reversed.rooms.filter(room => room.kind === 'department').map(room => [room.label, room.side])).toEqual([['Delta', 'north'], ['Gamma', 'south'], ['Beta', 'north'], ['Alpha', 'south'], ['Alpha 2', 'north']])
  })

  it('keeps the sequence slot of a department that has no people left', () => {
    const agents = team(1, [['Alpha', 1], ['Beta', 1], ['Gamma', 1]])
    const memory = rememberTeam(EMPTY_BUILDING_MEMORY, agents)
    const building = buildingLayout(agents.filter(agent => agent.id !== 'beta-0'), memory, 'live')
    expect(building.rooms.map(room => room.label)).toEqual(['Orchestrators', 'Alpha', 'Gamma'])
    expect(label(building, 'Gamma').side).toBe('north')
    expect(label(building, 'Alpha').side).toBe('north')
  })

  it('joins every door to the corridor and routes every desk from the front door', () => {
    for (const agents of [team(2, [['Alpha', 8], ['Beta', 5], ['Gamma', 2], ['Delta', 4]]), team(1, [['Alpha', 12], ['Beta', 3]]), team(6, [['Alpha', 8]]), team(1, [['Studio', 1]])]) {
      const building = layout(agents)
      const corridor = building.corridor!
      expect(corridor.height).toBe(3)
      for (const room of building.rooms) {
        expect(room.door, room.label).not.toBeNull()
        const inCorridor = (p: { x: number; y: number }) => p.x >= corridor.x && p.x < corridor.x + corridor.width - 1 && p.y >= corridor.y && p.y < corridor.y + corridor.height
        for (const cell of room.door!.outside) expect(inCorridor(cell), `${room.label} outside`).toBe(true)
        for (const cell of room.door!.cells) expect(building.walls.has(`${cell.x},${cell.y}`)).toBe(false)
        const centre = room.x + room.width / 2
        if (room.kind === 'department') expect(room.door!.cells.map(c => c.x)).toEqual([centre - 1, centre])
      }
      expect(building.rooms[0].door!.wall).toBe('east')
      expect(building.frontDoor).toEqual({ x: -1, y: building.rooms[0].y + 6 })
      reachability(building)
      for (const agent of agents) {
        const inside = doorwayOf(building, agent.id)!
        const room = roomOf(building, agent.id)!
        const blocked = buildingBlocked(building, furnishBuilding(building).props)
        expect(blocked.has(`${inside.x},${inside.y}`)).toBe(false)
        // The door-to-aisle line: from the inside cell to the rug row is a straight, unblocked line.
        const rugRow = room.side === 'south' ? room.rug.y : room.rug.y + 1
        const step = rugRow >= inside.y ? 1 : -1
        for (let y = inside.y; y !== rugRow + step; y += step) expect(blocked.has(`${inside.x},${y}`), `${room.label} door line`).toBe(false)
      }
    }
  })

  it('lays out a desk at the spec module in every room and keeps the person and plate rows off the walls', () => {
    const building = layout(team(2, [['Alpha', 8], ['Beta', 8]]))
    for (const room of building.rooms) for (const id of room.agents) {
      const desk = building.desks.get(id)!
      expect(desk.anchor).toEqual({ x: desk.furniture.x, y: desk.furniture.y + 2 })
      expect((desk.furniture.x - room.x - 2) % 4).toBe(0)
      for (const row of [desk.anchor.y, desk.anchor.y + 1]) for (const x of [desk.anchor.x]) {
        expect(building.walls.has(`${x},${row}`), `${id} person or plate row`).toBe(false)
        expect(building.floor.has(`${x},${row}`)).toBe(true)
      }
      expect(desk.furniture.x + 3).toBeLessThanOrEqual(room.x + room.width - 2)
      expect(desk.furniture.y).toBeGreaterThanOrEqual(room.y + 3)
    }
    const alpha = label(building, 'Alpha')
    expect(alpha.agents).toHaveLength(8)
    expect(deskAt(building, 'alpha-0')).toEqual({ x: alpha.x + 2, y: alpha.y + 8 })
    expect(deskAt(building, 'alpha-4')).toEqual({ x: alpha.x + 2, y: alpha.y + 3 })
    const beta = label(building, 'Beta')
    expect(deskAt(building, 'beta-0')).toEqual({ x: beta.x + 2, y: beta.y + 3 })
    expect(deskAt(building, 'beta-5')).toEqual({ x: beta.x + 6, y: beta.y + 8 })
  })

  it('builds the 33-role building at 58 x 33 tiles', () => {
    const building = layout(team(1, [['Alpha', 8], ['Beta', 8], ['Gamma', 8], ['Delta', 8]]))
    expect([building.width, building.height]).toEqual([58, 33])
    expect(rect(building.rooms[0])).toEqual({ x: 0, y: 9, width: 18, height: 14 })
    expect(building.corridor).toEqual({ x: 18, y: 15, width: 40, height: 3 })
    expect(building.rooms.filter(room => room.kind === 'department').map(room => rect(room))).toEqual([
      { x: 18, y: 0, width: 20, height: 15 }, { x: 18, y: 18, width: 20, height: 15 },
      { x: 38, y: 0, width: 20, height: 15 }, { x: 38, y: 18, width: 20, height: 15 }
    ])
    expect(building.desks.size).toBe(33)
    expect(building.bounds).toEqual({ x: 0, y: 0, width: 58, height: 33 })
    reachability(building)
  })

  it('builds the small teams: empty, one person, two and three departments', () => {
    const empty = layout([])
    expect([empty.width, empty.height, empty.rooms.length, empty.desks.size, empty.corridor]).toEqual([18, 14, 1, 0, null])
    expect(empty.frontDoor).toEqual({ x: -1, y: 6 })
    expect(empty.rooms[0].door).toBeNull()
    const one = layout(team(1, []))
    expect([one.width, one.height, one.corridor, one.rooms.length]).toEqual([18, 14, null, 1])
    reachability(one)
    const two = layout(team(1, [['Alpha', 2], ['Beta', 2]]))
    expect([two.width, two.height]).toEqual([18 + 12, 28])
    expect(two.bounds).toEqual({ x: 0, y: 5, width: 30, height: 23 })
    reachability(two)
    const three = layout(team(1, [['Alpha', 2], ['Beta', 3], ['Gamma', 5]]))
    expect([three.width, three.height]).toEqual([18 + 32, 28])
    reachability(three)
    const lobbyHeavy = layout(team(9, [['Alpha', 1]]))
    expect(rect(lobbyHeavy.rooms[0])).toEqual({ x: 0, y: 9, width: 20, height: 24 })
    reachability(lobbyHeavy)
  })

  it('lays out the Settings sample as one 12 x 10 room without lobby, corridor or front door', () => {
    const sample = layout(team(0, [['Sample', 2]]), EMPTY_BUILDING_MEMORY, 'sample')
    expect([sample.width, sample.height, sample.rooms.length, sample.corridor, sample.frontDoor]).toEqual([12, 10, 1, null, null])
    expect(sample.rooms[0]).toMatchObject({ kind: 'sample', door: null, agents: ['sample-0', 'sample-1'] })
    const blocked = buildingBlocked(sample, furnishBuilding(sample).props)
    const [a, b] = [...sample.desks.values()]
    expect(routeInBuilding(sample, blocked, a.anchor, b.anchor).length).toBeGreaterThan(1)
  })

  it('routes over the whole grid of a 160 x 35 tile building in a few milliseconds', () => {
    const departments: [string, number][] = Array.from({ length: 14 }, (_, i) => [`Department ${i}`, 8])
    const building = layout(team(1, departments))
    expect(building.width).toBeGreaterThanOrEqual(158)
    expect(building.height).toBe(33)
    const blocked = buildingBlocked(building, furnishBuilding(building).props)
    const far = [...building.desks.values()].at(-1)!
    routeInBuilding(building, blocked, building.frontDoor!, far.anchor)
    const start = performance.now()
    let path: unknown[] = []
    for (let i = 0; i < 5; i++) path = routeInBuilding(building, blocked, building.frontDoor!, far.anchor)
    const each = (performance.now() - start) / 5
    console.info(`route across ${building.width} x ${building.height} tiles: ${each.toFixed(2)} ms, ${path.length} steps`)
    expect(path.length).toBeGreaterThan(100)
    expect(each).toBeLessThan(200)
    // An unreachable target fails over the whole grid just as quickly.
    const sealed = new Set(blocked)
    for (const cell of roomOf(building, far.agentId)!.door!.cells) sealed.add(`${cell.x},${cell.y}`)
    const unreachable = performance.now()
    expect(routeInBuilding(building, sealed, building.frontDoor!, far.anchor)).toEqual([])
    expect(performance.now() - unreachable).toBeLessThan(200)
  })
})
