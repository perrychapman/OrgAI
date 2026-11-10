import type { Building, BuildingRoom, Doorway } from './building'

/**
 * Room looks and the static furniture layer of the Pocket Office (rework spec section 5).
 * Pure: no React, no DOM, no viewport. Everything is deterministic from a `Building`.
 * This module imports only types from building.ts so the two can reference each other.
 */

export interface PlacedProp { key: string; name: string; x: number; y: number; roomId: string }
export interface PlacedTile { x: number; y: number; frame: string; rotate?: 0 | 90 | 180 | 270 }
export interface DeskSet { desk: string; chair: string }

export const THEME_COUNT = 6
/** Far-wall prop x offsets inside a room; only those that fit the room width are used. */
export const FAR_WALL_SLOTS = [1, 5, 9, 13] as const
/** Two-tile gaps between far-wall slots, used for the per-look extras. */
export const FAR_WALL_GAPS = [3, 7, 11, 15] as const
/** Plain floor must stay at least this share of every room interior. */
export const PLAIN_FLOOR_SHARE = 0.7

export interface ThemeLook {
  name: string
  floor: string
  rug: string
  decor: 'none' | 'sparse' | 'dense'
  desk: DeskSet
  /** Props at far-wall slots x = 1, 5, 9, 13. */
  farWall: readonly string[]
  /** Gap extras: `first` goes in the first gap, `last` in the last gap, `wide` replaces `last` at width 20. */
  extras: { first?: string; last?: string; wide?: string; mugOnOddSlots?: boolean }
}

/** The screen is always the crt family (state driven at runtime), so desk sets only choose desk and chair. */
export const THEMES: readonly ThemeLook[] = [
  { name: 'Studio', floor: 'tile.00', rug: 'tile.18', decor: 'sparse', desk: { desk: 'desk-wide', chair: 'chair-side' }, farWall: ['whiteboard', 'window', 'whiteboard', 'plant-tall'], extras: { mugOnOddSlots: true } },
  { name: 'Library', floor: 'tile.02', rug: 'tile.17', decor: 'none', desk: { desk: 'desk', chair: 'chair' }, farWall: ['shelf', 'shelf', 'cabinet', 'shelf'], extras: { first: 'lamp', last: 'plant-tall' } },
  { name: 'Lab', floor: 'tile.03', rug: 'tile.19', decor: 'none', desk: { desk: 'desk-wide', chair: 'chair' }, farWall: ['cabinet', 'printer', 'whiteboard', 'cabinet'], extras: { first: 'partition', last: 'partition' } },
  { name: 'Lounge', floor: 'tile.00', rug: 'tile.20', decor: 'none', desk: { desk: 'desk', chair: 'chair-side' }, farWall: ['window', 'sofa', 'side-table', 'window'], extras: { first: 'lamp', last: 'plant' } },
  { name: 'Ops', floor: 'tile.03', rug: 'tile.21', decor: 'none', desk: { desk: 'desk-wide', chair: 'chair' }, farWall: ['whiteboard', 'window', 'printer', 'cabinet'], extras: { first: 'coffee-station', wide: 'meeting-table' } },
  { name: 'Garden', floor: 'tile.01', rug: 'tile.22', decor: 'dense', desk: { desk: 'desk', chair: 'chair-side' }, farWall: ['window', 'plant-tall', 'window', 'plant-tall'], extras: { first: 'side-table', last: 'plant' } }
]

/** The lobby has its own fixed look; its social furniture is placed by `furnishLobby`. */
export const LOBBY_LOOK: ThemeLook = { name: 'Lobby', floor: 'tile.00', rug: 'tile.16', decor: 'none', desk: { desk: 'desk', chair: 'chair' }, farWall: ['plant-tall', 'lamp', 'window', 'window', 'plant-tall'], extras: {} }

const CORRIDOR_FLOOR = 'tile.01'
const CORRIDOR_RUNNER = 'tile.18'
const MAT = 'tile.43'

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return hash >>> 0
}

/** FNV-1a (32-bit) of the casefolded department name, modulo the six looks. */
export function themeIndex(departmentName: string): number {
  return fnv1a(departmentName.normalize('NFC').toLowerCase()) % THEME_COUNT
}

const key = (x: number, y: number): string => `${x},${y}`

interface Opening { wall: Doorway['wall']; cells: readonly { x: number; y: number }[] }

function openingsOf(room: BuildingRoom, building: Building): Opening[] {
  const list: Opening[] = []
  if (room.door) list.push(room.door)
  if (room.kind === 'lobby' && building.frontDoor) list.push({ wall: 'west', cells: building.frontDoorCells })
  return list
}

/** Static layer: floors, walls, rugs, mats, jambs and every non-desk prop, plus the desk set of each agent. */
export function furnishBuilding(building: Building): { tiles: PlacedTile[]; props: PlacedProp[]; deskSets: ReadonlyMap<string, DeskSet> } {
  const tiles = new Map<string, PlacedTile>()
  const props: PlacedProp[] = []
  const deskSets = new Map<string, DeskSet>()
  const put = (x: number, y: number, frame: string, rotate?: 90): void => { tiles.set(key(x, y), rotate ? { x, y, frame, rotate } : { x, y, frame }) }
  const occupied = new Map<string, Set<string>>()
  const place: Place = (roomId, name, x, y) => {
    props.push({ key: `${roomId}|${name}|${x},${y}`, name, x, y, roomId })
    const cells = occupied.get(roomId) ?? new Set<string>()
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) cells.add(key(x + dx, y + dy))
    occupied.set(roomId, cells)
  }

  for (const room of building.rooms) {
    const look = room.kind === 'lobby' ? LOBBY_LOOK : THEMES[room.theme] ?? THEMES[0]
    // Desk sets, desks and chairs occupy their footprint even though they are drawn by the scene.
    const cells = occupied.get(room.id) ?? new Set<string>()
    occupied.set(room.id, cells)
    for (const id of room.agents) {
      deskSets.set(id, look.desk)
      const desk = building.desks.get(id)
      if (!desk) continue
      for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 2; dy++) cells.add(key(desk.furniture.x + dx, desk.furniture.y + dy))
      if (look.extras.mugOnOddSlots && desk.slot % 2 === 1) place(room.id, 'mug', desk.furniture.x, desk.furniture.y)
    }
    if (room.kind === 'lobby') furnishLobby(room, place)
    else furnishRoom(room, look, place)
  }

  // Floors, rugs and decoration.
  for (const room of building.rooms) {
    const look = room.kind === 'lobby' ? LOBBY_LOOK : THEMES[room.theme] ?? THEMES[0]
    const taken = occupied.get(room.id) ?? new Set<string>()
    const interior = (room.width - 2) * (room.height - 2)
    const rugCells = room.rug.width * room.rug.height
    let budget = Math.max(0, Math.floor(interior * (1 - PLAIN_FLOOR_SHARE)) - rugCells)
    const period = look.decor === 'dense' ? 5 : 14
    for (let y = room.y + 1; y < room.y + room.height - 1; y++) for (let x = room.x + 1; x < room.x + room.width - 1; x++) {
      const inRug = x >= room.rug.x && x < room.rug.x + room.rug.width && y >= room.rug.y && y < room.rug.y + room.rug.height
      if (inRug) { put(x, y, look.rug); continue }
      const hash = fnv1a(`${room.id}|${x},${y}`)
      if (look.decor !== 'none' && budget > 0 && !taken.has(key(x, y)) && hash % period === 0) { put(x, y, `tile.0${4 + ((hash >>> 8) % 4)}`); budget--; continue }
      put(x, y, look.floor)
    }
  }

  const corridor = building.corridor
  if (corridor) {
    const end = corridor.x + corridor.width - 1
    for (let y = corridor.y; y < corridor.y + corridor.height; y++) for (let x = corridor.x; x < end; x++) put(x, y, y === corridor.y + 1 ? CORRIDOR_RUNNER : CORRIDOR_FLOOR)
    furnishCorridor(building, place)
  }

  // Door openings: mat floor.
  for (const room of building.rooms) for (const opening of openingsOf(room, building)) for (const cell of opening.cells) put(cell.x, cell.y, MAT)

  // Walls.
  for (const room of building.rooms) {
    const openings = openingsOf(room, building)
    const door = (wall: Doorway['wall']): Opening | undefined => openings.find(o => o.wall === wall)
    for (const [row, wall] of [[room.y, 'north'], [room.y + room.height - 1, 'south']] as const) {
      const opening = door(wall)
      const first = opening ? Math.min(...opening.cells.map(c => c.x)) : NaN
      const last = opening ? Math.max(...opening.cells.map(c => c.x)) : NaN
      for (let x = room.x; x < room.x + room.width; x++) {
        const i = x - room.x
        if (opening && x >= first && x <= last) continue
        if (opening && x === first - 1) put(x, row, 'tile.24')
        else if (opening && x === last + 1) put(x, row, 'tile.25')
        else if (i === 0) put(x, row, 'tile.09')
        else if (i === room.width - 1) put(x, row, 'tile.10')
        else put(x, row, i % 2 === 1 ? 'tile.12' : 'tile.08')
      }
    }
    for (const [column, wall] of [[room.x, 'west'], [room.x + room.width - 1, 'east']] as const) {
      const opening = door(wall)
      const first = opening ? Math.min(...opening.cells.map(c => c.y)) : NaN
      const last = opening ? Math.max(...opening.cells.map(c => c.y)) : NaN
      for (let y = room.y + 1; y < room.y + room.height - 1; y++) {
        if (opening && y >= first && y <= last) continue
        if (opening && y === first - 1) put(column, y, 'tile.24', 90)
        else if (opening && y === last + 1) put(column, y, 'tile.25', 90)
        else put(column, y, 'tile.08', 90)
      }
    }
  }
  if (corridor) {
    const end = corridor.x + corridor.width - 1
    const reach = (side: BuildingRoom['side']): number => building.rooms.filter(r => r.side === side).reduce((max, r) => Math.max(max, r.x + r.width), corridor.x)
    for (const [row, from] of [[corridor.y - 1, reach('north')], [corridor.y + corridor.height, reach('south')]] as const) {
      for (let x = from; x <= end; x++) put(x, row, from === end ? 'tile.11' : x === end ? 'tile.10' : (x - corridor.x) % 2 === 1 ? 'tile.12' : 'tile.08')
    }
    for (let y = corridor.y; y < corridor.y + corridor.height; y++) put(end, y, 'tile.08', 90)
  }

  return { tiles: [...tiles.values()].sort((a, b) => a.y - b.y || a.x - b.x), props, deskSets }
}

type Place = (roomId: string, name: string, x: number, y: number) => void

function furnishRoom(room: BuildingRoom, look: ThemeLook, place: Place): void {
  FAR_WALL_SLOTS.forEach((offset, index) => {
    if (offset + 1 <= room.width - 2 && look.farWall[index]) place(room.id, look.farWall[index], room.x + offset, room.farWallY)
  })
  const gaps = FAR_WALL_GAPS.filter(offset => offset + 1 <= room.width - 2)
  const { first, last, wide } = look.extras
  if (first && gaps.length) place(room.id, first, room.x + gaps[0], room.farWallY)
  const lastName = wide && room.width === 20 ? wide : last
  if (lastName && gaps.length > 1) place(room.id, lastName, room.x + gaps[gaps.length - 1], room.farWallY)
}

/** Reception, meeting table, sofa and side table in the social band below the desk block; plants, lamp and windows on the far wall. */
function furnishLobby(room: BuildingRoom, place: Place): void {
  const band: readonly (readonly [string, number])[] = [['plant-tall', 1], ['lamp', 3], ['window', 5], ['window', 7], ['plant-tall', 13]]
  for (const [name, offset] of band) place(room.id, name, room.x + offset, room.farWallY)
  const social = room.y + 3 + 5 * room.rows + 1
  place(room.id, 'desk-wide', room.x + 2, social)
  place(room.id, 'meeting-table', room.x + 6, social)
  place(room.id, 'sofa', room.x + 11, social)
  place(room.id, 'side-table', room.x + 13, social)
}

/** A plant-tall or cabinet every 8 tiles on blank wall (no door there), a window at the east end. */
function furnishCorridor(building: Building, place: Place): void {
  const corridor = building.corridor
  if (!corridor) return
  const end = corridor.x + corridor.width - 1
  const doorColumns = building.rooms.flatMap(r => r.door?.outside.map(p => p.x) ?? [])
  place('corridor', 'window', end - 2, corridor.y)
  for (let k = 0, x = corridor.x + 6; x + 1 <= end - 4; k++, x += 8) {
    if (doorColumns.some(column => column >= x - 1 && column <= x + 2)) continue
    if (k % 2 === 0) place('corridor', 'plant-tall', x, corridor.y)
    else place('corridor', 'cabinet', x, corridor.y + 1)
  }
}
