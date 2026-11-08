import atlas from '../../assets/pocket-office/atlas.json'

export const OFFICE_TILE = atlas.tileSize

export interface Point { x: number; y: number }
export interface Desk { slot: number; room: number; furniture: Point; anchor: Point }
export interface BuildingAgent { id: string; departmentId: string; departmentName: string; central: boolean }
export interface BuildingRoom { id: string; label: string; floor: number; x: number; y: number; agents: string[] }
export interface BuildingLayout { rooms: BuildingRoom[]; floorCount: number; width: number; height: number; columns: number }
export function floorBounds(layout: BuildingLayout, viewportWidth: number, viewportHeight: number, zoom: number): { width: number; height: number } {
  return { width: Math.max(layout.width, Math.ceil(viewportWidth / (OFFICE_TILE * zoom))), height: Math.max(layout.height, Math.ceil(viewportHeight / (OFFICE_TILE * zoom))) }
}
export const DESKS_PER_ROOM = 8
export const ROOM_WIDTH = 18
export const ROOM_HEIGHT = 13
export const ROOM_PROPS = [{ name: 'plant', x: 0, y: 11 }, { name: 'shelf', x: 7, y: 11 }, { name: 'coffee-station', x: 15, y: 11 }] as const

const BUILDING_ROOM_WIDTH = ROOM_WIDTH + 2
const BUILDING_INTERIOR_HEIGHT = ROOM_HEIGHT + 7
const BUILDING_ROW_HEIGHT = BUILDING_INTERIOR_HEIGHT + 4

/** Group slots retain tombstones just like agent slots, including across resizes. */
export function assignDepartmentSlots(previous: ReadonlyMap<string, number>, agents: readonly BuildingAgent[]): Map<string, number> {
  const next = new Map(previous)
  for (const agent of agents) {
    const group = agent.central ? '__central__' : agent.departmentId
    const key = JSON.stringify([group, agent.id])
    if (next.has(key)) continue
    let slot = 0
    for (const [existing, value] of next) if ((JSON.parse(existing) as string[])[0] === group) slot = Math.max(slot, value + 1)
    next.set(key, slot)
  }
  return next
}

export function buildingLayout(agents: readonly BuildingAgent[], slots: ReadonlyMap<string, number>, viewportWidth: number, viewportHeight: number, zoom: number): BuildingLayout {
  const columns = Math.max(1, Math.min(4, Math.floor((viewportWidth / (OFFICE_TILE * zoom) - 2) / BUILDING_ROOM_WIDTH)))
  const rows = Math.max(1, Math.min(4, Math.floor(viewportHeight / (OFFICE_TILE * zoom) / BUILDING_ROW_HEIGHT)))
  const capacity = Math.min(4, columns * rows)
  const groups = new Map<string, { label: string; rooms: Map<number, string[]> }>()
  for (const agent of agents) {
    const group = agent.central ? '__central__' : agent.departmentId
    const local = slots.get(JSON.stringify([group, agent.id])) ?? 0
    const entry = groups.get(group) ?? { label: agent.central ? 'Central' : agent.departmentName, rooms: new Map<number, string[]>() }
    const room = Math.floor(local / DESKS_PER_ROOM)
    entry.rooms.set(room, [...(entry.rooms.get(room) ?? []), agent.id]); groups.set(group, entry)
  }
  const entries = [...groups].sort(([a], [b]) => a === '__central__' ? -1 : b === '__central__' ? 1 : a.localeCompare(b))
    .flatMap(([group, value]) => [...value.rooms].sort(([a], [b]) => a - b).map(([number, members]) => ({ id: JSON.stringify([group, number]), label: `${value.label}${value.rooms.size > 1 || number > 0 ? ` ${number + 1}` : ''}`, agents: members })))
  const rooms = entries.map((entry, i) => {
    const position = i % capacity
    return { ...entry, floor: Math.floor(i / capacity), x: 2 + (position % columns) * BUILDING_ROOM_WIDTH, y: Math.floor(position / columns) * BUILDING_ROW_HEIGHT }
  })
  const usedColumns = Math.max(1, Math.min(columns, capacity, entries.length))
  const usedRows = Math.max(1, Math.ceil(Math.min(capacity, Math.max(1, entries.length)) / columns))
  return { rooms, floorCount: Math.max(1, Math.ceil(entries.length / capacity)), width: 2 + usedColumns * BUILDING_ROOM_WIDTH, height: usedRows * BUILDING_ROW_HEIGHT, columns }
}

export function buildingDesk(room: BuildingRoom, localSlot: number): Desk {
  const desk = deskForSlot(localSlot)
  const offsetY = 5 + Math.floor((localSlot % DESKS_PER_ROOM) / 4) * 3
  return { ...desk, furniture: { x: desk.furniture.x + room.x + 1, y: desk.furniture.y + room.y + offsetY }, anchor: { x: desk.anchor.x + room.x + 1, y: desk.anchor.y + room.y + offsetY } }
}

export function buildingProps(room: BuildingRoom) {
  return roomProps(BUILDING_INTERIOR_HEIGHT).map(prop => ({ ...prop, x: room.x + 1 + prop.x, y: room.y + 1 + prop.y }))
}

/** Walls have two-cell doors to a two-cell corridor and the corridor's left trunk. */
export function buildingBlocked(rooms: readonly BuildingRoom[], agents: readonly BuildingAgent[], slots: ReadonlyMap<string, number>): Set<string> {
  const blocked = new Set<string>()
  for (const room of rooms) {
    for (let x = 0; x < BUILDING_ROOM_WIDTH; x++) {
      blocked.add(`${room.x + x},${room.y}`)
      if (x !== 9 && x !== 10) blocked.add(`${room.x + x},${room.y + BUILDING_INTERIOR_HEIGHT + 1}`)
    }
    for (let y = 1; y <= BUILDING_INTERIOR_HEIGHT; y++) { blocked.add(`${room.x},${room.y + y}`); blocked.add(`${room.x + BUILDING_ROOM_WIDTH - 1},${room.y + y}`) }
    // Nameplates occupy these bands; leave the two-cell aisle at the left clear.
    for (const start of [2, 10]) for (let y = start; y < start + 3; y++) for (let x = 3; x < 19; x++) blocked.add(`${room.x + x},${room.y + y}`)
    const furniture = agents.filter(a => room.agents.includes(a.id)).flatMap(a => {
      const local = (slots.get(JSON.stringify([a.central ? '__central__' : a.departmentId, a.id])) ?? 0) % DESKS_PER_ROOM
      const { furniture } = buildingDesk(room, local)
      return [{ ...furniture, footprint: atlas.props.desk.footprint }, { x: furniture.x + 2, y: furniture.y, footprint: atlas.props.chair.footprint }]
    }).concat(buildingProps(room).map(p => ({ x: p.x, y: p.y, footprint: atlas.props[p.name].footprint })))
    for (const item of furniture) for (const [x, y] of item.footprint) blocked.add(`${item.x + x},${item.y + y}`)
  }
  return blocked
}

export function roomHeight(slots: readonly number[]): number {
  return slots.some(slot => slot % DESKS_PER_ROOM >= 4) ? ROOM_HEIGHT : 8
}

export function roomProps(height = ROOM_HEIGHT) {
  return ROOM_PROPS.map(prop => ({ ...prop, y: height - 2 }))
}

/** Retain tombstones so removal and later additions never move an existing desk. */
export function assignDesks(previous: ReadonlyMap<string, number>, ids: readonly string[]): Map<string, number> {
  const next = new Map(previous)
  let slot = Math.max(-1, ...next.values()) + 1
  for (const id of ids) if (!next.has(id)) next.set(id, slot++)
  return next
}

export function deskForSlot(slot: number): Desk {
  const local = slot % DESKS_PER_ROOM
  const x = 2 + (local % 4) * 4
  const y = 1 + Math.floor(local / 4) * 5
  const [ax, ay] = atlas.props.desk.interactionAnchors[0].cell
  return { slot, room: Math.floor(slot / DESKS_PER_ROOM), furniture: { x, y }, anchor: { x: x + ax, y: y + ay } }
}

export function blockedCells(slots: readonly number[] = Array.from({ length: DESKS_PER_ROOM }, (_, i) => i), height = ROOM_HEIGHT): Set<string> {
  const furniture = slots.flatMap((i) => {
    const { furniture } = deskForSlot(i)
    return [{ ...furniture, footprint: atlas.props.desk.footprint }, { x: furniture.x + 2, y: furniture.y, footprint: atlas.props.chair.footprint }]
  }).concat(roomProps(height).map(({ x, y, name }) => ({ x, y, footprint: atlas.props[name].footprint })))
  return new Set(furniture.flatMap(p => p.footprint.map(([x, y]) => `${p.x + x},${p.y + y}`)))
}

/** Breadth-first route through the connected floor; includes both endpoints. */
export function route(from: Point, to: Point, blocked = blockedCells(), height = ROOM_HEIGHT, width = ROOM_WIDTH): Point[] {
  const key = (p: Point): string => `${p.x},${p.y}`
  if (blocked.has(key(from)) || blocked.has(key(to))) return []
  const queue = [from]
  const parent = new Map<string, Point | null>([[key(from), null]])
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]
    if (p.x === to.x && p.y === to.y) {
      const result: Point[] = []
      let current: Point | null = p
      while (current) { result.push(current); current = parent.get(key(current)) ?? null }
      return result.reverse()
    }
    for (const d of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
      const n = { x: p.x + d.x, y: p.y + d.y }
      if (n.x < 0 || n.y < 0 || n.x >= width || n.y >= height || blocked.has(key(n)) || parent.has(key(n))) continue
      parent.set(key(n), p); queue.push(n)
    }
  }
  return []
}
