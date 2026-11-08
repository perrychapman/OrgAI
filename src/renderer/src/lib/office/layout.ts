export const OFFICE_TILE = 16

export interface Point { x: number; y: number }
export interface Desk { slot: number; room: number; furniture: Point; anchor: Point }
export const DESKS_PER_ROOM = 8
export const ROOM_WIDTH = 18
export const ROOM_HEIGHT = 13

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
  return { slot, room: Math.floor(slot / DESKS_PER_ROOM), furniture: { x, y }, anchor: { x, y: y + 2 } }
}

export function blockedCells(): Set<string> {
  return new Set(Array.from({ length: DESKS_PER_ROOM }, (_, i) => {
    const { furniture } = deskForSlot(i)
    return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => `${furniture.x + x},${furniture.y + y}`)
  }).flat())
}

/** Breadth-first route through the connected floor; includes both endpoints. */
export function route(from: Point, to: Point, blocked = blockedCells()): Point[] {
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
      if (n.x < 0 || n.y < 0 || n.x >= ROOM_WIDTH || n.y >= ROOM_HEIGHT || blocked.has(key(n)) || parent.has(key(n))) continue
      parent.set(key(n), p); queue.push(n)
    }
  }
  return []
}
