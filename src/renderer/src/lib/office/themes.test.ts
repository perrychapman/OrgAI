import { describe, expect, it } from 'vitest'
import atlas from '../../assets/pocket-office/atlas.json'
import { buildingLayout, EMPTY_BUILDING_MEMORY, rememberTeam, type Building, type BuildingAgent, type BuildingRoom } from './building'
import { FAR_WALL_SLOTS, furnishBuilding, LOBBY_LOOK, PLAIN_FLOOR_SHARE, THEMES, themeIndex } from './themes'

const slug = (name: string): string => name.toLowerCase().replace(/\s+/g, '-')
function team(central: number, departments: readonly (readonly [string, number])[]): BuildingAgent[] {
  return [
    ...Array.from({ length: central }, (_, i) => ({ id: `central-${i}`, departmentId: 'central', departmentName: 'Orchestrators', central: true })),
    ...departments.flatMap(([name, count]) => Array.from({ length: count }, (_, i) => ({ id: `${slug(name)}-${i}`, departmentId: slug(name), departmentName: name, central: false })))
  ]
}
const build = (agents: readonly BuildingAgent[], mode: 'live' | 'team' | 'sample' = 'live'): Building => buildingLayout(agents, rememberTeam(EMPTY_BUILDING_MEMORY, agents), mode)
/** Department names that hash to looks 0..5 (found by search; stable because the hash is). */
const NAMES = ['Dept0', 'Dept3', 'Dept2', 'Dept5', 'Dept4', 'Dept1']
const key = (x: number, y: number): string => `${x},${y}`
const WALL_FRAMES = new Set(['tile.08', 'tile.09', 'tile.10', 'tile.11', 'tile.12', 'tile.24', 'tile.25'])
const footprint = (name: string): readonly (readonly number[])[] => (atlas.props as Record<string, { footprint: number[][] }>)[name].footprint

describe('theme index', () => {
  it('is FNV-1a over the casefolded name, modulo six', () => {
    expect(themeIndex('a')).toBe(0xe40c292c % 6)
    expect(themeIndex('foobar')).toBe(0xbf9cf968 % 6)
    expect(NAMES.map(themeIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(themeIndex('Engineering')).toBe(themeIndex('ENGINEERING'))
    expect(themeIndex('Engineering')).toBe(themeIndex('engineering'))
    expect(themeIndex('Engineering')).toBe(themeIndex('Engineering'))
    const seen = new Set(Array.from({ length: 60 }, (_, i) => themeIndex(`Department ${i}`)))
    expect(seen.size).toBe(6)
    for (const value of seen) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(6) }
  })
})

describe('furnished building', () => {
  const agents = team(2, [['Dept0', 8], ['Dept3', 4], ['Dept2', 8], ['Dept5', 3], ['Dept4', 8], ['Dept1', 2]])
  const building = build(agents)
  const furnished = furnishBuilding(building)
  const tileAt = new Map(furnished.tiles.map(tile => [key(tile.x, tile.y), tile]))

  it('is deterministic and gives each cell at most one tile', () => {
    expect(furnishBuilding(build(agents))).toEqual(furnished)
    expect(tileAt.size).toBe(furnished.tiles.length)
  })

  it('tiles every walkable cell and every wall, and nothing else', () => {
    for (const cell of building.floor) {
      const [x] = cell.split(',').map(Number)
      if (x < 0) continue // outside the front door
      expect(tileAt.has(cell), `floor ${cell}`).toBe(true)
      expect(WALL_FRAMES.has(tileAt.get(cell)!.frame) && !['tile.24', 'tile.25'].includes(tileAt.get(cell)!.frame), `floor ${cell} is not a wall`).toBe(false)
    }
    for (const cell of building.walls) {
      expect(tileAt.has(cell), `wall ${cell}`).toBe(true)
      expect(WALL_FRAMES.has(tileAt.get(cell)!.frame), `wall ${cell}`).toBe(true)
    }
    for (const tile of furnished.tiles) expect(building.floor.has(key(tile.x, tile.y)) || building.walls.has(key(tile.x, tile.y)), `${tile.x},${tile.y}`).toBe(true)
    // Corridor: floor, middle runner, mats and rotated side walls.
    const corridor = building.corridor!
    expect(tileAt.get(key(corridor.x + 3, corridor.y))!.frame).toBe('tile.01')
    expect(tileAt.get(key(corridor.x + 3, corridor.y + 1))!.frame).toBe('tile.18')
    expect(tileAt.get(key(corridor.x + 3, corridor.y + 2))!.frame).toBe('tile.01')
  })

  it('draws corners, alternating walls, rotated side walls, jambs and a mat at every opening', () => {
    for (const room of building.rooms) {
      expect(tileAt.get(key(room.x, room.y))!.frame).toBe('tile.09')
      expect(tileAt.get(key(room.x + room.width - 1, room.y))!.frame).toBe('tile.10')
      expect(tileAt.get(key(room.x, room.y + room.height - 1))!.frame).toBe('tile.09')
      expect(tileAt.get(key(room.x + room.width - 1, room.y + room.height - 1))!.frame).toBe('tile.10')
      const side = tileAt.get(key(room.x, room.y + 1))!
      expect([side.frame, side.rotate]).toEqual(['tile.08', 90])
      if (room.side === 'north' || room.side === 'south') {
        const wallRow = room.side === 'north' ? room.y + room.height - 1 : room.y
        const [a, b] = room.door!.cells
        expect(tileAt.get(key(a.x, a.y))!.frame).toBe('tile.43')
        expect(tileAt.get(key(b.x, b.y))!.frame).toBe('tile.43')
        expect(tileAt.get(key(a.x - 1, wallRow))!.frame).toBe('tile.24')
        expect(tileAt.get(key(b.x + 1, wallRow))!.frame).toBe('tile.25')
      }
    }
    const top = building.rooms[1]
    expect([1, 2, 3, 4].map(i => tileAt.get(key(top.x + i, top.y))!.frame)).toEqual(['tile.12', 'tile.08', 'tile.12', 'tile.08'])
    const lobby = building.rooms[0]
    const [upper, lower] = building.frontDoorCells
    expect([tileAt.get(key(upper.x, upper.y))!.frame, tileAt.get(key(lower.x, lower.y))!.frame]).toEqual(['tile.43', 'tile.43'])
    expect(tileAt.get(key(0, upper.y - 1))).toMatchObject({ frame: 'tile.24', rotate: 90 })
    expect(tileAt.get(key(0, lower.y + 1))).toMatchObject({ frame: 'tile.25', rotate: 90 })
    expect(lobby.door!.wall).toBe('east')
  })

  it('gives each of the six looks a different floor, rug and far-wall signature', () => {
    const signatures = new Map<number, string>()
    for (const room of building.rooms.filter(r => r.kind === 'department')) {
      const floorTile = tileAt.get(key(room.x + 1, room.y + 1 + (room.side === 'south' ? 2 : 3)))!.frame
      const rug = tileAt.get(key(room.rug.x + 1, room.rug.y))!.frame
      const wall = furnished.props.filter(p => p.roomId === room.id && p.y === room.farWallY && FAR_WALL_SLOTS.some(s => s === p.x - room.x)).sort((a, b) => a.x - b.x).map(p => p.name)
      expect(rug).toBe(THEMES[room.theme].rug)
      expect(wall).toEqual(THEMES[room.theme].farWall.slice(0, wall.length))
      signatures.set(room.theme, `${THEMES[room.theme].floor}|${rug}|${wall.join(',')}`)
      expect(floorTile.startsWith('tile.0')).toBe(true)
    }
    expect([...signatures.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5])
    expect(new Set(signatures.values()).size).toBe(6)
    expect(new Set(THEMES.map(look => look.rug)).size).toBe(6)
    expect(new Set(THEMES.map(look => `${look.floor}|${look.rug}|${look.farWall.join(',')}`)).size).toBe(6)
    expect(LOBBY_LOOK.rug).not.toBe(THEMES.find(look => look.rug === LOBBY_LOOK.rug)?.rug)
  })

  it('keeps at least 70% of every room interior plain floor in every size', () => {
    const everything = [
      building,
      build(team(1, [['Dept1', 1], ['Dept3', 1], ['Dept0', 1], ['Dept2', 1], ['Dept4', 1], ['Dept5', 1]])),
      build(team(1, [['Dept5', 3], ['Dept1', 4]])),
      build(team(9, [['Dept5', 8]]))
    ]
    for (const target of everything) {
      const tiles = new Map(furnishBuilding(target).tiles.map(tile => [key(tile.x, tile.y), tile]))
      for (const room of target.rooms) {
        const look = room.kind === 'lobby' ? LOBBY_LOOK : THEMES[room.theme]
        let plain = 0
        for (let y = room.y + 1; y < room.y + room.height - 1; y++) for (let x = room.x + 1; x < room.x + room.width - 1; x++) if (tiles.get(key(x, y))!.frame === look.floor) plain++
        const interior = (room.width - 2) * (room.height - 2)
        expect(plain / interior, `${room.label} ${room.width}x${room.height}`).toBeGreaterThanOrEqual(PLAIN_FLOOR_SHARE)
      }
    }
    // Studio sparse and Garden dense actually vary the floor.
    const variants = (themeId: number) => furnished.tiles.filter(tile => /^tile\.0[4-7]$/.test(tile.frame) && building.rooms.some(room => room.theme === themeId && tile.x > room.x && tile.x < room.x + room.width - 1 && tile.y > room.y && tile.y < room.y + room.height - 1)).length
    expect(variants(0)).toBeGreaterThan(0)
    expect(variants(5)).toBeGreaterThan(variants(0))
    expect(variants(1) + variants(2) + variants(3) + variants(4)).toBe(0)
  })

  it('places only atlas props with 2 x 2 footprints, clear of walls, desks, anchors and each other', () => {
    const taken = new Map<string, string>()
    for (const prop of furnished.props) {
      expect(atlas.props, prop.name).toHaveProperty(prop.name)
      expect(footprint(prop.name)).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]])
      expect(prop.name.startsWith('crt')).toBe(false)
      for (const [dx, dy] of footprint(prop.name)) {
        const cell = key(prop.x + dx, prop.y + dy)
        expect(building.walls.has(cell), `${prop.key} on a wall`).toBe(false)
        expect(building.floor.has(cell), `${prop.key} off the floor`).toBe(true)
        if (prop.name !== 'mug') expect(taken.has(cell), `${prop.key} overlaps ${taken.get(cell)}`).toBe(false)
        if (prop.name !== 'mug') taken.set(cell, prop.key)
      }
    }
    for (const desk of building.desks.values()) {
      expect(taken.has(key(desk.anchor.x, desk.anchor.y))).toBe(false)
      for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 2; dy++) expect(taken.has(key(desk.furniture.x + dx, desk.furniture.y + dy)), desk.agentId).toBe(false)
    }
    // The mug sits on the desk of odd slots in the Studio look only.
    const mugs = furnished.props.filter(prop => prop.name === 'mug')
    const studio = building.rooms.find(room => room.theme === 0)!
    expect(mugs.map(mug => mug.roomId)).toEqual(mugs.map(() => studio.id))
    expect(mugs).toHaveLength(4)
  })

  it('assigns desk sets from the look, never a crt frame', () => {
    expect(furnished.deskSets.size).toBe(building.desks.size)
    for (const room of building.rooms) for (const id of room.agents) {
      const look = room.kind === 'lobby' ? LOBBY_LOOK : THEMES[room.theme]
      expect(furnished.deskSets.get(id)).toEqual(look.desk)
      expect(Object.keys(atlas.props)).toEqual(expect.arrayContaining([look.desk.desk, look.desk.chair]))
    }
    expect(THEMES.map(look => `${look.desk.desk}/${look.desk.chair}`)).toEqual(['desk-wide/chair-side', 'desk/chair', 'desk-wide/chair', 'desk/chair-side', 'desk-wide/chair', 'desk/chair-side'])
  })

  it('furnishes the lobby as a reception and the corridor with plants, cabinets and an east window', () => {
    const lobby = building.rooms[0]
    const names = furnished.props.filter(prop => prop.roomId === lobby.id).map(prop => prop.name).sort()
    expect(names).toEqual(['desk-wide', 'lamp', 'meeting-table', 'plant-tall', 'plant-tall', 'side-table', 'sofa', 'window', 'window'])
    const corridor = furnished.props.filter(prop => prop.roomId === 'corridor')
    const end = building.corridor!.x + building.corridor!.width - 1
    expect(corridor.find(prop => prop.name === 'window')).toMatchObject({ x: end - 2 })
    const spaced = corridor.filter(prop => prop.name !== 'window').map(prop => prop.x)
    expect(spaced.length).toBeGreaterThan(3)
    for (let i = 1; i < spaced.length; i++) expect((spaced[i] - spaced[i - 1]) % 8).toBe(0)
    expect(new Set(corridor.map(prop => prop.name))).toEqual(new Set(['window', 'plant-tall', 'cabinet']))
  })

  it('fits the far-wall slots to the room width and the Ops meeting table to width 20', () => {
    const slotsOf = (room: BuildingRoom) => furnished.props.filter(prop => prop.roomId === room.id && prop.y === room.farWallY && FAR_WALL_SLOTS.some(s => s === prop.x - room.x)).length
    for (const room of building.rooms.filter(r => r.kind === 'department')) expect(slotsOf(room), room.label).toBe(FAR_WALL_SLOTS.filter(s => s + 1 <= room.width - 2).length)
    const small = build(team(1, [['Dept4', 1]]))
    const smallProps = furnishBuilding(small).props.filter(prop => prop.roomId === small.rooms[1].id).map(prop => prop.name)
    expect(smallProps).not.toContain('meeting-table')
    expect(smallProps).toContain('coffee-station')
    const wide = building.rooms.find(room => room.theme === 4 && room.width === 20)!
    expect(furnished.props.filter(prop => prop.roomId === wide.id).map(prop => prop.name)).toContain('meeting-table')
  })

  it('furnishes the Settings sample and an empty building without errors', () => {
    const sample = build(team(0, [['Dept2', 2]]), 'sample')
    const result = furnishBuilding(sample)
    expect(result.tiles.length).toBeGreaterThan(100)
    expect(result.deskSets.size).toBe(2)
    expect(furnishBuilding(build([])).props.length).toBeGreaterThan(5)
  })
})
