// Factory Floor routes and carrier paths (docs/design/factory-floor.md sections 3.2 step 7, 5.2). Pure: no three, no DOM.
import type { FloorLine, FloorRoute, Vec2 } from './types'

/** Head zone and gantry constants the routes need (kept here so layout.ts and routes.ts do not import each other). */
const ROW0_CENTER_Z = 1.5
const ROW0_AISLE_Z = 5.5
const ROW_PITCH = 7
const SIGN_X = 2
/** Line 1's route leaves the booth front here. */
export const BOOTH_FRONT: Vec2 = { x: 7, z: -3.5 }
/** Route lanes in the head zone: x = ROUTE_X0 + ROUTE_LANE_W * lane, lane 0 to ROUTE_LANES - 1. */
export const ROUTE_X0 = 1
export const ROUTE_LANE_W = 0.25
export const ROUTE_LANES = 6
/** Painted stripe width (metres). */
export const ROUTE_STRIPE_W = 0.25

export function laneX(lane: number): number {
  return ROUTE_X0 + ROUTE_LANE_W * lane
}
const rowZ = (row: number): number => ROW0_CENTER_Z + ROW_PITCH * row
const aisle = (row: number): number => ROW0_AISLE_Z + ROW_PITCH * row
const rowOf = (z: number): number => Math.round((z - ROW0_CENTER_Z) / ROW_PITCH)

/**
 * Section 3.2 step 7. Line 1 (the root's): booth front west to x 1, south to its first row, east to the sign. Every
 * other line: from the lead's station front on its aisle west to the line's lane, south (or north) to the line's first
 * row centre, east to the sign at x 2; lane = (line - 2) mod 6. Continuation rows: a short route from the previous row
 * of the same line down the head zone to the sign. `leadCentre` gives a lead's station centre (placed or vacant).
 */
export function floorRoutes(lines: readonly FloorLine[], rootId: string | null, leadCentre: (id: string) => Vec2 | undefined): FloorRoute[] {
  const routes: FloorRoute[] = []
  for (const l of lines) {
    const firstZ = rowZ(l.rows[0])
    const isRootLine = l.leadId === rootId
    const lane = isRootLine ? 0 : (((l.number - 2) % ROUTE_LANES) + ROUTE_LANES) % ROUTE_LANES
    const x = laneX(lane)
    if (isRootLine) {
      routes.push({ line: l.number, lane, points: [{ ...BOOTH_FRONT }, { x, z: BOOTH_FRONT.z }, { x, z: firstZ }, { x: SIGN_X, z: firstZ }] })
    } else {
      const lead = leadCentre(l.leadId)
      if (lead) {
        const az = aisle(rowOf(lead.z))
        routes.push({ line: l.number, lane, points: [{ x: lead.x, z: az }, { x, z: az }, { x, z: firstZ }, { x: SIGN_X, z: firstZ }] })
      }
    }
    for (let i = 1; i < l.rows.length; i++) {
      const toZ = rowZ(l.rows[i])
      routes.push({ line: l.number, lane, points: [{ x, z: rowZ(l.rows[i - 1]) }, { x, z: toZ }, { x: SIGN_X, z: toZ }] })
    }
  }
  return routes
}

export interface RouteSegment {
  /** Midpoint of the segment. */
  center: Vec2
  length: number
  /** Rotation about +y (radians) that turns a quad's +x axis along the segment. */
  rotY: number
  line: number
}

/** A route's non-empty segments, for drawing stripes (a unit quad scaled along each segment). */
export function routeSegments(routes: readonly FloorRoute[]): RouteSegment[] {
  const out: RouteSegment[] = []
  for (const r of routes) {
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]
      const b = r.points[i]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const length = Math.hypot(dx, dz)
      if (length < 1e-6) continue
      // Extend each segment by half a stripe at both ends so corners close.
      out.push({ center: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, length: length + ROUTE_STRIPE_W, rotY: -Math.atan2(dz, dx), line: r.line })
    }
  }
  return out
}

export interface Point3 {
  x: number
  y: number
  z: number
}

/** Carrier arc apex (section 5.2): 3.5 + min(0.1 * distance, 4) metres. */
export function arcApex(from: Vec2, to: Vec2): number {
  return 3.5 + Math.min(0.1 * Math.hypot(to.x - from.x, to.z - from.z), 4)
}

/**
 * A point on a quadratic arc from `from` to `to` at progress t (0 to 1), rising `apex` metres above the start and end
 * height `y0` at the middle. t is clamped.
 */
export function arcPoint(from: Vec2, to: Vec2, t: number, apex = arcApex(from, to), y0 = 0): Point3 {
  const s = Math.min(1, Math.max(0, t))
  return { x: from.x + (to.x - from.x) * s, y: y0 + 4 * apex * s * (1 - s), z: from.z + (to.z - from.z) * s }
}

/** Dock crate slots (section 3.1): a 3 x 3 grid on the 6 x 4 m dock, north-west first; the tenth and later are counted on its label. */
export const DOCK_SLOTS = 9
export function dockSlot(index: number, dock: Vec2): Vec2 | null {
  if (index < 0 || index >= DOCK_SLOTS) return null
  const col = index % 3
  const row = Math.floor(index / 3)
  return { x: dock.x + (col - 1) * 1.6, z: dock.z + (row - 1) * 1.1 }
}

/** The outfeed pad at the east end of a station's belt (z 3 to 4 of the row) where merge crates wait. */
export function outfeedPad(station: Vec2): Vec2 {
  return { x: station.x + 1, z: station.z + 2 }
}
/** The hold pad at the west end of the belt (conflict, held). */
export function holdPad(station: Vec2): Vec2 {
  return { x: station.x - 1, z: station.z + 2 }
}
