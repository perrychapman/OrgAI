import atlas from '../../assets/pocket-office/atlas.json'

/**
 * Small shared helpers of the Pocket Office. The building itself is laid out in `building.ts`; the floor-packing
 * layout this file used to hold is retired (rework spec section 1).
 */
export const OFFICE_TILE = atlas.tileSize
export const DESKS_PER_ROOM = 8

export interface Point { x: number; y: number }

/** Stop before a two-tile-wide, three-tile-high person could overlap another. */
export function clearWorkerPath(path: readonly Point[], occupied: readonly Point[]): Point[] {
  const safe: Point[] = []
  for (const point of path) {
    if (occupied.some(other => Math.abs(point.x - other.x) < 2 && Math.abs(point.y - other.y) < 3)) break
    safe.push(point)
  }
  return safe
}

export function assignAppearances(previous: ReadonlyMap<string, number>, ids: readonly string[], count: number): Map<string, number> {
  const next = new Map(previous)
  const present = new Set(ids)
  for (const id of ids) {
    if (next.has(id)) continue
    let hash = 0
    for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
    const preferred = hash % count
    const used = new Set([...next].filter(([existing]) => present.has(existing)).map(([, value]) => value))
    let look = preferred
    for (let offset = 0; offset < count; offset++) {
      const candidate = (preferred + offset) % count
      if (!used.has(candidate)) { look = candidate; break }
    }
    next.set(id, look)
  }
  return next
}

/** Group slots retain tombstones just like agent slots, including across resizes. */
export function assignDepartmentSlots(previous: ReadonlyMap<string, number>, agents: readonly { id: string; departmentId: string; central: boolean }[]): Map<string, number> {
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

/** Breadth-first route through the connected floor; includes both endpoints. Cells outside `width` x `height` or in `blocked` are walls. */
export function route(from: Point, to: Point, blocked: ReadonlySet<string>, height: number, width: number): Point[] {
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
