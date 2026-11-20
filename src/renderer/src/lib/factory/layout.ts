// Factory Floor layout (docs/design/factory-floor.md section 3). Pure: no three, no DOM. Live mode is append-only (a
// placed station never moves while its run lasts); team mode lays roles out in preorder from scratch.
// 1 world unit = 1 metre; x grows east, z grows south, y is up.
import { floorRoutes } from './routes'
import type { Bounds, FactoryAgentInput, FloorLayout, FloorLine, FloorRoute, LayoutMemory, PlacedStation, Vec2 } from './types'

/** Head zone: x 0 to 4 (signs at x 2, routes at x 1 to 2.5). */
export const HEAD_W = 4
/** Station footprint 3 m plus a 1 m gap. */
export const SLOT_PITCH = 4
/** A line longer than this continues on a continuation row. */
export const SLOTS_PER_ROW = 8
/** Station 3 m, belt 1 m, aisle 3 m. */
export const ROW_PITCH = 7
/** Station footprint edge (metres). */
export const STATION_SIZE = 3
/** x of slot 0's centre. */
export const FIRST_SLOT_X = 6
/** z of row 0's station centre and of row 0's aisle centre line. */
export const ROW0_CENTER_Z = 1.5
export const ROW0_AISLE_Z = 5.5
/** Gantry deck along the north wall, and its top surface (booth, dock and board stand on it). */
export const GANTRY_MIN_Z = -10
export const GANTRY_MAX_Z = -2
export const GANTRY_TOP = 1.5
export const BOOTH_CENTER: Vec2 = { x: 7, z: -6 }
export const BOOTH_SIZE = { w: 6, d: 4 }
export const DOCK_CENTER: Vec2 = { x: 17, z: -6 }
export const DOCK_SIZE = { w: 6, d: 4 }
export const BOARD_CENTER: Vec2 = { x: 25, z: -9.5 }
export const BOARD_SIZE = { w: 6, d: 1 }
/** The hall is never narrower than this. */
export const MIN_HALL_W = 30
/** Line signs stand at this x, on the row's centre line. */
export const SIGN_X = 2

/** Booth stations sit on no line: line 0, row -1, slot 0. */
export const BOOTH_LINE = 0
export const BOOTH_ROW = -1

export const EMPTY_LAYOUT_MEMORY: LayoutMemory = Object.freeze({
  runKey: '',
  lines: Object.freeze({}) as LayoutMemory['lines'],
  slots: Object.freeze({}) as LayoutMemory['slots'],
  nextLine: 1,
  nextRow: 0
}) as LayoutMemory

export interface LayoutInput {
  /** The run id (live) or `team:{projectId}` (team): memory resets when it changes. */
  runKey: string
  agents: readonly FactoryAgentInput[]
}

export interface LayoutResult {
  layout: FloorLayout
  memory: LayoutMemory
}

/** Station centre of a line slot on a hall row (section 3.1). */
export function stationCenter(slot: number, row: number): Vec2 {
  return { x: FIRST_SLOT_X + SLOT_PITCH * (slot % SLOTS_PER_ROW), z: ROW0_CENTER_Z + ROW_PITCH * row }
}
export function rowCenterZ(row: number): number {
  return ROW0_CENTER_Z + ROW_PITCH * row
}
export function aisleZ(row: number): number {
  return ROW0_AISLE_Z + ROW_PITCH * row
}

/** 32-bit FNV-1a: a stable hash for the machine silhouette (same roleKey, same variant, on every machine). */
export function stableHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
export function machineVariant(roleKey: string): 0 | 1 | 2 | 3 {
  return (stableHash(roleKey) % 4) as 0 | 1 | 2 | 3
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byStart = (a: FactoryAgentInput, b: FactoryAgentInput): number => a.startedAt - b.startedAt || cmpId(a.id, b.id)

/** Section 3.2 step 1: no parent, earliest start, then the smallest id. */
export function pickRoot(agents: readonly FactoryAgentInput[]): FactoryAgentInput | null {
  let root: FactoryAgentInput | null = null
  for (const a of agents) {
    if (a.parentId !== null) continue
    if (!root || byStart(a, root) < 0) root = a
  }
  return root
}

function cloneMemory(m: LayoutMemory): LayoutMemory {
  const lines: LayoutMemory['lines'] = {}
  for (const [k, v] of Object.entries(m.lines)) lines[k] = { number: v.number, rows: [...v.rows], count: v.count }
  return { runKey: m.runKey, lines, slots: { ...m.slots }, nextLine: m.nextLine, nextRow: m.nextRow }
}

function freshMemory(runKey: string): LayoutMemory {
  return { runKey, lines: {}, slots: {}, nextLine: 1, nextRow: 0 }
}

/** The lead a non-root agent sits under: its parent when that parent is on the floor, else the root. */
function leadOf(a: FactoryAgentInput, ids: ReadonlySet<string>, rootId: string): string {
  return a.parentId !== null && a.parentId !== a.id && ids.has(a.parentId) ? a.parentId : rootId
}

/** Section 3.2 step 3, in the given order; mutates `memory`. */
function place(order: readonly FactoryAgentInput[], memory: LayoutMemory, ids: ReadonlySet<string>, rootId: string): void {
  for (const a of order) {
    if (memory.slots[a.id]) continue
    const lead = leadOf(a, ids, rootId)
    let line = memory.lines[lead]
    if (!line) {
      line = { number: memory.nextLine++, rows: [memory.nextRow++], count: 0 }
      memory.lines[lead] = line
    }
    const slot = line.count++
    const rowIndex = Math.floor(slot / SLOTS_PER_ROW)
    if (rowIndex === line.rows.length) line.rows.push(memory.nextRow++)
    memory.slots[a.id] = { lead, slot }
  }
}

/**
 * Live layout (section 3.2): current-session agents only, append-only against `memory`. Same input and memory give
 * the same output. Memory resets when `runKey` changes.
 */
export function layoutFloor(input: LayoutInput, memory: LayoutMemory): LayoutResult {
  const current = input.agents.filter((a) => a.session === 'current')
  const next = memory.runKey === input.runKey ? cloneMemory(memory) : freshMemory(input.runKey)
  const root = pickRoot(current)
  if (!root) return { layout: buildLayout(current, null, next), memory: next }
  const ids = new Set(current.map((a) => a.id))
  place(current.filter((a) => a !== root).sort(byStart), next, ids, root.id)
  return { layout: buildLayout(current, root, next), memory: next }
}

/**
 * Team mode (section 3.2, last paragraph): roles walked depth-first in input order (children in the order they appear),
 * lines created in that preorder, recomputed from scratch (no vacancies).
 */
export function layoutTeam(roles: readonly FactoryAgentInput[], runKey: string): LayoutResult {
  const memory = freshMemory(runKey)
  const root = pickRoot(roles)
  if (!root) return { layout: buildLayout(roles, null, memory), memory }
  const order = teamPreorder(roles, root)
  const ids = new Set(roles.map((a) => a.id))
  place(order, memory, ids, root.id)
  return { layout: buildLayout(roles, root, memory), memory }
}

/** Non-root roles in preorder from the root; roles a reportsTo cycle cuts off follow in input order. */
export function teamPreorder(roles: readonly FactoryAgentInput[], root: FactoryAgentInput): FactoryAgentInput[] {
  const ids = new Set(roles.map((r) => r.id))
  const children = new Map<string, FactoryAgentInput[]>()
  for (const r of roles) {
    if (r === root) continue
    const lead = leadOf(r, ids, root.id)
    const list = children.get(lead)
    if (list) list.push(r)
    else children.set(lead, [r])
  }
  const out: FactoryAgentInput[] = []
  const seen = new Set<string>([root.id])
  const walk = (id: string): void => {
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
      walk(c.id)
    }
  }
  walk(root.id)
  for (const r of roles) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
    walk(r.id)
  }
  return out
}

function rect(c: Vec2, w: number, d: number): Bounds {
  return { minX: c.x - w / 2, maxX: c.x + w / 2, minZ: c.z - d / 2, maxZ: c.z + d / 2 }
}
function union(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b }
  return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) }
}

export function boothRect(): Bounds {
  return rect(BOOTH_CENTER, BOOTH_SIZE.w, BOOTH_SIZE.d)
}
export function dockRect(): Bounds {
  return rect(DOCK_CENTER, DOCK_SIZE.w, DOCK_SIZE.d)
}
export function boardRect(): Bounds {
  return rect(BOARD_CENTER, BOARD_SIZE.w, BOARD_SIZE.d)
}
export function stationRect(c: Vec2): Bounds {
  return rect(c, STATION_SIZE, STATION_SIZE)
}

function buildLayout(agents: readonly FactoryAgentInput[], root: FactoryAgentInput | null, memory: LayoutMemory): FloorLayout {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const stations: Record<string, PlacedStation> = {}
  const vacant: FloorLayout['vacant'] = []
  const placed: PlacedStation[] = []
  if (root) {
    stations[root.id] = { id: root.id, kind: 'booth', variant: machineVariant(root.roleKey), line: BOOTH_LINE, row: BOOTH_ROW, slot: 0, center: { ...BOOTH_CENTER } }
  }
  const centres = new Map<string, Vec2>()
  for (const [id, s] of Object.entries(memory.slots)) {
    const line = memory.lines[s.lead]
    if (!line) continue
    const row = line.rows[Math.floor(s.slot / SLOTS_PER_ROW)]
    const center = stationCenter(s.slot, row)
    centres.set(id, center)
    const a = byId.get(id)
    if (a && a !== root) {
      const st: PlacedStation = { id, kind: memory.lines[id] ? 'lead' : 'bench', variant: machineVariant(a.roleKey), line: line.number, row, slot: s.slot, center }
      stations[id] = st
      placed.push(st)
    } else if (!a) {
      vacant.push({ id, line: line.number, row, slot: s.slot, center })
    }
  }
  placed.sort((a, b) => a.row - b.row || a.center.x - b.center.x)
  vacant.sort((a, b) => a.row - b.row || a.center.x - b.center.x)
  const order = [...(root ? [root.id] : []), ...placed.map((s) => s.id)]

  const lines: FloorLine[] = Object.entries(memory.lines)
    .map(([leadId, l]) => ({ number: l.number, leadId, rows: [...l.rows], count: l.count }))
    .sort((a, b) => a.number - b.number)

  let widest = 0
  for (const l of lines) {
    for (let i = 0; i < l.rows.length; i++) widest = Math.max(widest, Math.min(SLOTS_PER_ROW, l.count - SLOTS_PER_ROW * i))
  }
  const rows = memory.nextRow
  const hall: Bounds = {
    minX: 0,
    maxX: Math.max(MIN_HALL_W, FIRST_SLOT_X + SLOT_PITCH * Math.max(0, widest - 1) + SLOT_PITCH),
    minZ: GANTRY_MIN_Z,
    maxZ: rows === 0 ? 2 : ROW_PITCH * rows + 1
  }

  let content: Bounds | null = union(union(boothRect(), dockRect()), boardRect())
  for (const s of placed) content = union(content, stationRect(s.center))

  const routes: FloorRoute[] = floorRoutes(lines, root?.id ?? null, (id) => centres.get(id))

  return {
    stations,
    order,
    lines,
    vacant,
    routes,
    rows,
    hall,
    content: content ?? hall,
    booth: root ? { ...BOOTH_CENTER } : null,
    dock: { ...DOCK_CENTER },
    board: { ...BOARD_CENTER }
  }
}

export interface LineSign {
  line: number
  leadId: string
  row: number
  /** A continuation row ("Line n · lead, continued"). */
  continued: boolean
  at: Vec2
}

/** Section 3.2 step 8: one sign per row of every line, at (2, row centre z). */
export function lineSigns(layout: FloorLayout): LineSign[] {
  const out: LineSign[] = []
  for (const l of layout.lines) {
    l.rows.forEach((row, i) => out.push({ line: l.number, leadId: l.leadId, row, continued: i > 0, at: { x: SIGN_X, z: rowCenterZ(row) } }))
  }
  return out.sort((a, b) => a.row - b.row)
}
