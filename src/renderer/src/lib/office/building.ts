import atlas from '../../assets/pocket-office/atlas.json'
import { assignDepartmentSlots, DESKS_PER_ROOM, type Point } from './layout'
import { themeIndex, type PlacedProp } from './themes'

/**
 * One building per team (rework spec sections 1 and 5). Pure geometry in tiles: there is no viewport,
 * zoom or stage input anywhere in this module, so the same team always yields the same building.
 *
 * Coordinates: the lobby sits at x = 0; when a corridor exists the corridor's top row is fixed at
 * `CORRIDOR_ROW` so a room growing taller never moves the lobby, the corridor or any other room.
 * Rooms north of the corridor hang from it (their bottom wall touches the corridor), rooms south of it
 * grow downward. In north rooms the first four slots sit in the row nearest the door, so a north room that
 * gains a second desk row grows upward and leaves every existing desk where it was.
 */

export const CENTRAL_GROUP = '__central__'
export const CORRIDOR_HEIGHT = 3
/** The tallest department room (two desk rows). The corridor starts at this row so room growth never shifts anything. */
export const CORRIDOR_ROW = 15
export const LOBBY_MIN_WIDTH = 18
/** Local row (inside the lobby) of the aisle and both lobby doors. */
const LOBBY_AISLE_ROW = 6

export interface Rect { x: number; y: number; width: number; height: number }
export interface BuildingAgent { id: string; departmentId: string; departmentName: string; central: boolean }
export interface BuildingMemory {
  /** Slots keyed `JSON.stringify([group, id])` (group is `__central__` or the department id). */
  slots: ReadonlyMap<string, number>
  /** Groups in first-seen order, tombstones kept. */
  groups: readonly string[]
  /** Department room keys `JSON.stringify([group, roomNumber])` in first-seen order, tombstones kept. The sequence fixes north/south alternation. */
  rooms?: readonly string[]
}
export const EMPTY_BUILDING_MEMORY: BuildingMemory = { slots: new Map(), groups: [], rooms: [] }

export interface Doorway { cells: Point[]; outside: Point[]; wall: 'north' | 'south' | 'east' | 'west' }
export interface BuildingRoom {
  id: string
  kind: 'lobby' | 'department' | 'sample'
  group: string
  departmentName: string
  label: string
  side: 'west' | 'north' | 'south' | 'none'
  x: number
  y: number
  width: number
  height: number
  door: Doorway | null
  agents: string[]
  /** 0-5, -1 for the lobby. */
  theme: number
  /** Desk columns (2, 3 or 4) and rows the room is sized for, tombstones included. */
  cols: number
  rows: number
  /** The two-tile-tall aisle strip, absolute tiles. */
  rug: Rect
  /** Top row of the two-tile-tall far-wall prop band, absolute tiles. */
  farWallY: number
}
export interface BuildingDesk { agentId: string; roomId: string; slot: number; furniture: Point; anchor: Point }
export interface Building {
  width: number
  height: number
  rooms: BuildingRoom[]
  corridor: Rect | null
  /** The outside cell (upper one) of the west front door; null when there is no lobby (Settings sample). It lies at x = -1. */
  frontDoor: Point | null
  /** The two opening cells in the lobby's west wall. */
  frontDoorCells: Point[]
  desks: ReadonlyMap<string, BuildingDesk>
  walls: ReadonlySet<string>
  /** Every walkable cell ("x,y"): room interiors, door openings, corridor floor and the cells outside the front door. */
  floor: ReadonlySet<string>
  /** Tight rectangle around the drawn rooms (the origin keeps empty rows above short north rooms). */
  bounds: Rect
}

const cellKey = (x: number, y: number): string => `${x},${y}`
const groupOf = (agent: BuildingAgent): string => (agent.central ? CENTRAL_GROUP : agent.departmentId)
const roomKeyOf = (group: string, slot: number): string => JSON.stringify([group, group === CENTRAL_GROUP ? 0 : Math.floor(slot / DESKS_PER_ROOM)])

/** Remember slots, first-seen groups and first-seen rooms. Pure; never reorders or forgets. */
export function rememberTeam(previous: BuildingMemory, agents: readonly BuildingAgent[]): BuildingMemory {
  const slots = assignDepartmentSlots(previous.slots, agents)
  const groups = [...previous.groups]
  const rooms = [...(previous.rooms ?? [])]
  for (const agent of agents) {
    const group = groupOf(agent)
    if (!groups.includes(group)) groups.push(group)
    if (agent.central) continue
    const slot = slots.get(JSON.stringify([group, agent.id])) ?? 0
    const roomKey = roomKeyOf(group, slot)
    if (!rooms.includes(roomKey)) rooms.push(roomKey)
  }
  if (slots.size === previous.slots.size && groups.length === previous.groups.length && rooms.length === (previous.rooms?.length ?? 0)) return previous
  return { slots, groups, rooms }
}

function deskColumns(maxSlot: number): number { return maxSlot >= 3 ? 4 : maxSlot === 2 ? 3 : 2 }

/** Department room size from the highest slot ever assigned in it. */
export function departmentRoomSize(maxSlot: number): { cols: number; rows: number; width: number; height: number } {
  const cols = deskColumns(maxSlot)
  const rows = maxSlot >= 4 ? 2 : 1
  return { cols, rows, width: 4 * cols + 4, height: 5 * rows + 5 }
}

/** Lobby size: wide enough for its desk block (at least 18), tall enough for its rows plus a social area. */
export function lobbySize(maxSlot: number): { cols: number; rows: number; width: number; height: number } {
  const cols = deskColumns(maxSlot)
  const rows = maxSlot < 0 ? 1 : Math.floor(maxSlot / 4) + 1
  return { cols, rows, width: Math.max(LOBBY_MIN_WIDTH, 4 * cols + 4), height: 5 * rows + 9 }
}

/** Desk furniture position for a slot (row r counts from the door in north rooms, from the top elsewhere). */
function deskFurniture(room: Pick<BuildingRoom, 'x' | 'y' | 'height' | 'side'>, slot: number): Point {
  const column = slot % 4
  const row = Math.floor(slot / 4)
  const y = room.side === 'north' ? room.y + room.height - 7 - 5 * row : room.y + 3 + 5 * row
  return { x: room.x + 2 + 4 * column, y }
}

const ANCHOR_CELL = atlas.props.desk.interactionAnchors[0].cell

interface RoomInput {
  kind: BuildingRoom['kind']
  group: string
  number: number
  name: string
  label: string
  side: BuildingRoom['side']
  x: number
  y: number
  cols: number
  rows: number
  width: number
  height: number
  members: readonly { id: string; slot: number }[]
}

function makeRoom(input: RoomInput): BuildingRoom {
  const { x, y, width, height, side, kind, rows, cols } = input
  const centerX = x + width / 2 - 1
  let door: Doorway | null = null
  if (side === 'north') door = { wall: 'south', cells: [{ x: centerX, y: y + height - 1 }, { x: centerX + 1, y: y + height - 1 }], outside: [{ x: centerX, y: y + height }, { x: centerX + 1, y: y + height }] }
  else if (side === 'south') door = { wall: 'north', cells: [{ x: centerX, y }, { x: centerX + 1, y }], outside: [{ x: centerX, y: y - 1 }, { x: centerX + 1, y: y - 1 }] }
  const rugY = kind === 'lobby' ? y + LOBBY_AISLE_ROW : side === 'north' ? y + height - 4 : side === 'south' ? y + 1 : y + 5 * rows + 1
  const sorted = [...input.members].sort((a, b) => a.slot - b.slot)
  return {
    id: JSON.stringify([input.group, input.number]), kind, group: input.group, departmentName: input.name, label: input.label, side,
    x, y, width, height, door, agents: sorted.map(member => member.id), theme: kind === 'lobby' ? -1 : themeIndex(input.name),
    cols, rows, rug: { x: x + 2, y: rugY, width: width - 4, height: 2 }, farWallY: side === 'south' ? y + height - 3 : y + 1
  }
}

function desksFor(room: BuildingRoom, members: readonly { id: string; slot: number }[]): BuildingDesk[] {
  return members.map(member => {
    const furniture = deskFurniture(room, member.slot)
    return { agentId: member.id, roomId: room.id, slot: member.slot, furniture, anchor: { x: furniture.x + ANCHOR_CELL[0], y: furniture.y + ANCHOR_CELL[1] } }
  })
}

function outline(room: BuildingRoom, openings: ReadonlySet<string>, walls: Set<string>): void {
  for (let i = 0; i < room.width; i++) for (const y of [room.y, room.y + room.height - 1]) walls.add(cellKey(room.x + i, y))
  for (let j = 1; j < room.height - 1; j++) for (const x of [room.x, room.x + room.width - 1]) walls.add(cellKey(x, room.y + j))
  for (const opening of openings) walls.delete(opening)
}

function assemble(rooms: BuildingRoom[], memberSlots: Map<string, { id: string; slot: number }[]>, options: { corridor: Rect | null; frontDoorCells: Point[]; width: number; height: number }): Building {
  const walls = new Set<string>()
  const floor = new Set<string>()
  const desks = new Map<string, BuildingDesk>()
  const frontOpenings = new Set(options.frontDoorCells.map(cell => cellKey(cell.x, cell.y)))
  for (const room of rooms) {
    const openings = new Set<string>([...(room.door?.cells ?? []).map(cell => cellKey(cell.x, cell.y)), ...(room.kind === 'lobby' ? frontOpenings : [])])
    outline(room, openings, walls)
    for (let y = room.y + 1; y < room.y + room.height - 1; y++) for (let x = room.x + 1; x < room.x + room.width - 1; x++) floor.add(cellKey(x, y))
    for (const opening of openings) floor.add(opening)
    for (const desk of desksFor(room, memberSlots.get(room.id) ?? [])) desks.set(desk.agentId, desk)
  }
  const corridor = options.corridor
  if (corridor) {
    const end = corridor.x + corridor.width - 1
    for (let y = corridor.y; y < corridor.y + corridor.height; y++) for (let x = corridor.x; x < end; x++) floor.add(cellKey(x, y))
    for (let y = corridor.y; y < corridor.y + corridor.height; y++) walls.add(cellKey(end, y))
    for (const [side, row] of [['north', corridor.y - 1], ['south', corridor.y + corridor.height]] as const) {
      const reach = rooms.filter(room => room.side === side).reduce((max, room) => Math.max(max, room.x + room.width), corridor.x)
      for (let x = reach; x <= end; x++) walls.add(cellKey(x, row))
    }
  }
  for (const cell of options.frontDoorCells) floor.add(cellKey(cell.x - 1, cell.y))
  const top = rooms.reduce((min, room) => Math.min(min, room.y), Number.POSITIVE_INFINITY)
  const frontDoor = options.frontDoorCells.length ? { x: options.frontDoorCells[0].x - 1, y: options.frontDoorCells[0].y } : null
  return {
    width: options.width, height: options.height, rooms, corridor, frontDoor, frontDoorCells: options.frontDoorCells, desks, walls, floor,
    bounds: { x: 0, y: Number.isFinite(top) ? top : 0, width: options.width, height: options.height - (Number.isFinite(top) ? top : 0) }
  }
}

function sampleBuilding(agents: readonly BuildingAgent[]): Building {
  const members = agents.slice(0, DESKS_PER_ROOM).map((agent, slot) => ({ id: agent.id, slot }))
  const size = departmentRoomSize(Math.max(0, members.length - 1))
  const first = agents[0]
  const name = first?.departmentName ?? 'Sample'
  const room = makeRoom({ kind: 'sample', group: first ? groupOf(first) : '__sample__', number: 0, name, label: name, side: 'none', x: 0, y: 0, ...size, members })
  return assemble([room], new Map([[room.id, members]]), { corridor: null, frontDoorCells: [], width: room.width, height: room.height })
}

/**
 * The whole building for a team. `memory` supplies slots and first-seen order; agents not yet remembered are
 * remembered on the fly (so Team mode may pass `EMPTY_BUILDING_MEMORY` and input order). Rooms whose agents are all
 * gone are not drawn, but their place in the north/south sequence stays reserved so nothing flips sides.
 */
export function buildingLayout(agents: readonly BuildingAgent[], memory: BuildingMemory, mode: 'live' | 'team' | 'sample'): Building {
  if (mode === 'sample') return sampleBuilding(agents)
  const remembered = rememberTeam(memory, agents)
  const present = new Map<string, { id: string; slot: number; name: string }[]>()
  for (const agent of agents) {
    const group = groupOf(agent)
    const slot = remembered.slots.get(JSON.stringify([group, agent.id])) ?? 0
    const key = roomKeyOf(group, slot)
    present.set(key, [...(present.get(key) ?? []), { id: agent.id, slot, name: agent.departmentName }])
  }
  // Highest slot ever assigned per room, tombstones included.
  const highest = new Map<string, number>()
  for (const [slotKey, slot] of remembered.slots) {
    const group = (JSON.parse(slotKey) as string[])[0]
    const key = roomKeyOf(group, slot)
    highest.set(key, Math.max(highest.get(key) ?? -1, group === CENTRAL_GROUP ? slot : slot % DESKS_PER_ROOM))
  }

  const lobbyKey = JSON.stringify([CENTRAL_GROUP, 0])
  const lobbyMembers = (present.get(lobbyKey) ?? []).map(({ id, slot }) => ({ id, slot }))
  const lobby = lobbySize(highest.get(lobbyKey) ?? -1)

  const north: RoomInput[] = []
  const south: RoomInput[] = []
  for (const [index, roomKey] of (remembered.rooms ?? []).entries()) {
    const members = present.get(roomKey)
    if (!members?.length) continue
    const [group, number] = JSON.parse(roomKey) as [string, number]
    const name = members[0].name
    const size = departmentRoomSize(highest.get(roomKey) ?? 0)
    const input: RoomInput = { kind: 'department', group, number, name, label: number === 0 ? name : `${name} ${number + 1}`, side: index % 2 === 0 ? 'north' : 'south', x: 0, y: 0, ...size, members: members.map(({ id, slot }) => ({ id, slot: slot % DESKS_PER_ROOM })) }
    ;(index % 2 === 0 ? north : south).push(input)
  }

  const hasCorridor = north.length + south.length > 0
  const lobbyY = hasCorridor ? CORRIDOR_ROW - LOBBY_AISLE_ROW : 0
  const rooms: BuildingRoom[] = []
  const memberSlots = new Map<string, { id: string; slot: number }[]>()
  const lobbyRoom = makeRoom({ kind: 'lobby', group: CENTRAL_GROUP, number: 0, name: 'Orchestrators', label: 'Orchestrators', side: 'west', x: 0, y: lobbyY, ...lobby, members: lobbyMembers })
  lobbyRoom.door = hasCorridor
    ? { wall: 'east', cells: [{ x: lobby.width - 1, y: lobbyY + LOBBY_AISLE_ROW }, { x: lobby.width - 1, y: lobbyY + LOBBY_AISLE_ROW + 1 }], outside: [{ x: lobby.width, y: lobbyY + LOBBY_AISLE_ROW }, { x: lobby.width, y: lobbyY + LOBBY_AISLE_ROW + 1 }] }
    : null
  rooms.push(lobbyRoom)
  memberSlots.set(lobbyRoom.id, lobbyMembers)

  const placed = { north: [] as BuildingRoom[], south: [] as BuildingRoom[] }
  const cursor = { north: lobby.width, south: lobby.width }
  const order = remembered.rooms ?? []
  const byKey = new Map<string, RoomInput>()
  for (const input of [...north, ...south]) byKey.set(JSON.stringify([input.group, input.number]), input)
  for (const roomKey of order) {
    const input = byKey.get(roomKey)
    if (!input) continue
    const side = input.side as 'north' | 'south'
    const x = cursor[side]
    cursor[side] += input.width
    const y = side === 'north' ? CORRIDOR_ROW - input.height : CORRIDOR_ROW + CORRIDOR_HEIGHT
    const room = makeRoom({ ...input, x, y })
    placed[side].push(room)
    rooms.push(room)
    memberSlots.set(room.id, [...input.members])
  }

  if (!hasCorridor) {
    return assemble(rooms, memberSlots, { corridor: null, frontDoorCells: frontDoorCells(lobbyRoom), width: lobby.width, height: lobby.height })
  }
  const length = Math.max(cursor.north, cursor.south) - lobby.width
  const southBand = placed.south.reduce((max, room) => Math.max(max, room.height), 1)
  const corridor: Rect = { x: lobby.width, y: CORRIDOR_ROW, width: length, height: CORRIDOR_HEIGHT }
  return assemble(rooms, memberSlots, {
    corridor, frontDoorCells: frontDoorCells(lobbyRoom), width: lobby.width + length,
    height: Math.max(lobbyY + lobby.height, CORRIDOR_ROW + CORRIDOR_HEIGHT + southBand)
  })
}

function frontDoorCells(lobby: BuildingRoom): Point[] {
  return [{ x: 0, y: lobby.y + LOBBY_AISLE_ROW }, { x: 0, y: lobby.y + LOBBY_AISLE_ROW + 1 }]
}

export function roomOf(building: Building, agentId: string): BuildingRoom | undefined {
  const desk = building.desks.get(agentId)
  return desk ? building.rooms.find(room => room.id === desk.roomId) : undefined
}

const FOOTPRINT_FALLBACK: readonly (readonly number[])[] = [[0, 0], [1, 0], [0, 1], [1, 1]]

/**
 * Walls, desk footprints of every agent, and the footprint of each static prop. The chair is drawn on the worker's own
 * anchor cell (it is where they sit), so it blocks nothing beyond the anchor, which callers block per person.
 */
export function buildingBlocked(building: Building, props: readonly PlacedProp[]): Set<string> {
  const blocked = new Set(building.walls)
  const add = (x: number, y: number, footprint: readonly (readonly number[])[]): void => { for (const [dx, dy] of footprint) blocked.add(cellKey(x + dx, y + dy)) }
  for (const desk of building.desks.values()) add(desk.furniture.x, desk.furniture.y, atlas.props.desk.footprint)
  const known = atlas.props as Record<string, { footprint: number[][] } | undefined>
  for (const prop of props) add(prop.x, prop.y, known[prop.name]?.footprint ?? FOOTPRINT_FALLBACK)
  return blocked
}

interface Grid { minX: number; minY: number; columns: number; rows: number; open: Uint8Array }
const grids = new WeakMap<Building, Grid>()

function gridOf(building: Building): Grid {
  const cached = grids.get(building)
  if (cached) return cached
  const minX = -1
  const minY = -1
  const columns = building.width + 2
  const rows = building.height + 2
  const open = new Uint8Array(columns * rows)
  for (const cell of building.floor) {
    const [x, y] = cell.split(',')
    open[(Number(y) - minY) * columns + (Number(x) - minX)] = 1
  }
  const grid = { minX, minY, columns, rows, open }
  grids.set(building, grid)
  return grid
}

/** Breadth-first route over the whole building grid (walkable cells only); both endpoints included, `[]` if none. */
export function routeInBuilding(building: Building, blocked: ReadonlySet<string>, from: Point, to: Point): Point[] {
  const { minX, minY, columns, rows, open } = gridOf(building)
  const index = (p: Point): number => (p.y - minY) * columns + (p.x - minX)
  const inside = (p: Point): boolean => p.x >= minX && p.y >= minY && p.x - minX < columns && p.y - minY < rows
  if (!inside(from) || !inside(to) || !open[index(from)] || !open[index(to)] || blocked.has(cellKey(from.x, from.y)) || blocked.has(cellKey(to.x, to.y))) return []
  const start = index(from)
  const goal = index(to)
  const parent = new Int32Array(columns * rows).fill(-2)
  parent[start] = -1
  const queue = new Int32Array(columns * rows)
  let head = 0
  let tail = 0
  queue[tail++] = start
  const steps = [-columns, 1, columns, -1]
  while (head < tail) {
    const current = queue[head++]
    if (current === goal) {
      const path: Point[] = []
      for (let at = current; at !== -1; at = parent[at]) path.push({ x: (at % columns) + minX, y: Math.floor(at / columns) + minY })
      return path.reverse()
    }
    const cx = current % columns
    for (let s = 0; s < 4; s++) {
      const next = current + steps[s]
      if (next < 0 || next >= open.length || parent[next] !== -2 || !open[next]) continue
      const nx = next % columns
      if ((s === 1 || s === 3) && Math.abs(nx - cx) !== 1) continue
      if (blocked.has(cellKey((nx) + minX, Math.floor(next / columns) + minY))) continue
      parent[next] = current
      queue[tail++] = next
    }
  }
  return []
}

/** The inside cell of the door of an agent's room (for "walk to your own doorway and back"). */
export function doorwayOf(building: Building, agentId: string): Point | null {
  const door = roomOf(building, agentId)?.door
  if (!door) return null
  const cell = door.cells[0]
  if (door.wall === 'south') return { x: cell.x, y: cell.y - 1 }
  if (door.wall === 'north') return { x: cell.x, y: cell.y + 1 }
  if (door.wall === 'east') return { x: cell.x - 1, y: cell.y }
  return { x: cell.x + 1, y: cell.y }
}
