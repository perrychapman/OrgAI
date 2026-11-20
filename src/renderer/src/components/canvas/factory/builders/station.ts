// Station (Factory Floor sections 1.1, 1.2, 4.6): a 3 x 3 m plate with a console and screen, an outfeed belt conveyor and
// an output bin. The bench kit leaves the machine to machines.ts (the engine puts machine(variant) at the 'machine'
// anchor); the lead kit adds a dispatch desk under a yellow header board, a yellow rim around its plate and a yellow
// line plate on the floor in front (slice 3: "yellow = this station runs a line", readable at fit without text).
// Origin at the plate centre on the floor; the front faces +z.
//
// Space in the station frame (x east, z south), the rules every anchor below keeps:
//   plate           x, z -1.5..1.5 (top 0.1 m); machine (0.1, -0.45) within 1.5 x 1.2; console x -1.45..-0.75 at the west back
//   belt strip      z 1.5..2.5: belt x -0.35..0.55 from z 0.4 to 2.1, bin to z 2.5; west of it the idle robot, east of it the pad
//   gap             x 1.5..2.5 between slots: hold pad north (z -1.25..-0.35), docked robot south
//   aisle           z 2.5..5.5; painted routes along z 4.0 (west of x 0); the lead's line plate and inbox crates sit at z 2.6..4.1
//
// The conveyor (slice 3): two steel side frames, a continuous dark belt between them, a drum at each end and a bin; no
// evenly spaced rollers (slice 2's rollers read as a ladder).
import type { BufferGeometry } from 'three'
import { box, chamfer, cylX, merge, para, paraV, place, taper } from './geo'
import { NEAR_MID, PLATE_TOP, part } from './common'
import type { Anchor, ObjectKit, PartSpec } from './types'

const PLATE = 3
const PLATE_H = PLATE_TOP
const BELT_X = 0.1
const BELT_W = 0.82
const BELT_Z0 = 0.4
const BELT_Z1 = 2.1
const BIN_Z = 2.3
const NAMEPLATE_Y = 2.3

/** Header board (lead): lean back towards the camera, as the plan board does. */
const HEADER_LEAN = -0.5

export const STATION_ANCHORS: Record<string, Anchor> = {
  robot: { x: -0.95, y: PLATE_H, z: 0.65, rotY: 0 },
  machine: { x: BELT_X, y: PLATE_H, z: -0.45, rotY: 0 },
  stackLight: { x: 1.2, y: PLATE_H, z: 0, rotY: 0 },
  nameplate: { x: 0, y: NAMEPLATE_Y, z: 0, rotY: 0 },
  // ---- slice 3 ----
  /** Over the machine (bench) or the dispatch desk with its header (lead): footprint 1.6 x 1.4 m, 1.9 m high. */
  shutter: { x: BELT_X, y: PLATE_H, z: -0.5, rotY: 0 },
  /** Across the front: the arm spans x -1.45..1.45 at z 1.62, 0.55 to 0.71 m above the floor, over the belt. */
  barrier: { x: 0, y: 0, z: 1.62, rotY: 0 },
  /** The station's own outfeed crate: a 0.9 x 0.8 m slab east of the bin (floor level). */
  pad: { x: 1.05, y: 0, z: 2.0, rotY: 0 },
  /** The hold pad in the gap east of the plate, north half (0.9 x 0.9 m). */
  hold: { x: 2.0, y: 0, z: -0.8, rotY: 0 },
  /** First of up to four crates merged in from this station's reports: 0.8 m pitch east then south, z 2.65..4.15. */
  inbox: { x: 0.9, y: 0, z: 3.0, rotY: 0 },
  /** At the machine (bench) or the desk (lead, same spot as 'robot.dispatch'): the robot faces it (rotY 0 faces south). */
  'robot.machine': { x: -0.9, y: PLATE_H, z: 0.55, rotY: 2.4 },
  /** Idle: on the floor in the belt strip west of the belt, facing the camera. */
  'robot.rest': { x: -0.95, y: 0, z: 2.05, rotY: 0 },
  /**
   * Finished: on the floor in the gap east of the plate, south half, facing the camera. The body (0.76 m) stays inside
   * the 1 m gap; arm tips reach 0.56 m from the centre, a few centimetres past the neighbour's gap edge, so a docked
   * pose should hold the arms in.
   */
  'robot.dock': { x: 1.9, y: 0, z: 1.15, rotY: 0 }
}

/**
 * Lead-only anchors: 'robot.dispatch' in front of the dispatch desk, facing north; the lead's 'robot.machine' is the same
 * spot (a lead in the tool state works at its desk).
 */
const DISPATCH: Anchor = { x: 0.15, y: PLATE_H, z: -0.02, rotY: Math.PI }
const LEAD_ANCHORS: Record<string, Anchor> = { 'robot.dispatch': DISPATCH, 'robot.machine': DISPATCH }

/** The output bin at the belt's end: a tray (floor, four walls). */
function bin(): BufferGeometry {
  const w = 0.8
  const d = 0.4
  const h = 0.3
  const t = 0.04
  return merge([
    box(w, 0.05, d, BELT_X, 0, BIN_Z),
    box(w, h, t, BELT_X, 0, BIN_Z - d / 2 + t / 2),
    box(w, h, t, BELT_X, 0, BIN_Z + d / 2 - t / 2),
    box(t, h, d - 2 * t, BELT_X - w / 2 + t / 2, 0, BIN_Z),
    box(t, h, d - 2 * t, BELT_X + w / 2 - t / 2, 0, BIN_Z)
  ])
}

/** Dark belt inside the bin so it reads as a hollow tray. */
function binLiner(): BufferGeometry {
  return box(0.72, 0.01, 0.32, BELT_X, 0.05, BIN_Z)
}

function belt(): { frame: BufferGeometry[]; body: BufferGeometry; drums: BufferGeometry } {
  const len = BELT_Z1 - BELT_Z0
  const cz = (BELT_Z0 + BELT_Z1) / 2
  const railX = BELT_W / 2 + 0.035
  const railH = 0.24
  const beltTop = 0.28
  const drumR = 0.07
  const frame = [
    // Two side frames, a low cross member at each end and two legs under the part that hangs over the floor.
    box(0.07, railH, len, BELT_X - railX, PLATE_H, cz),
    box(0.07, railH, len, BELT_X + railX, PLATE_H, cz),
    box(0.8, 0.06, 0.08, BELT_X, PLATE_H, BELT_Z0 + 0.04),
    box(0.8, 0.06, 0.08, BELT_X, PLATE_H, BELT_Z1 - 0.04),
    box(0.07, PLATE_H, 0.07, BELT_X - railX, 0, BELT_Z1 - 0.2),
    box(0.07, PLATE_H, 0.07, BELT_X + railX, 0, BELT_Z1 - 0.2)
  ]
  // The belt: one continuous slab between the drums, black rubber.
  const body = merge([box(BELT_W - 0.02, beltTop - 0.2, len - 2 * drumR, BELT_X, 0.2, cz), binLiner()])
  const drums = merge([
    cylX(drumR, BELT_W, 10, BELT_X, beltTop - drumR, BELT_Z0 + drumR),
    cylX(drumR, BELT_W, 10, BELT_X, beltTop - drumR, BELT_Z1 - drumR)
  ])
  return { frame, body, drums }
}

function console_(): { casing: BufferGeometry[]; screen: BufferGeometry[] } {
  const x = -1.1
  const z = -0.75
  return {
    casing: [
      box(0.7, 0.7, 0.6, x, PLATE_H, z),
      taper(0.7, 0.6, 0.7, 0.25, 0.28, x, PLATE_H + 0.7, z),
      // Monitor stand and housing; the lit screen is a separate part.
      box(0.08, 0.2, 0.08, x, PLATE_H + 0.98, z - 0.1),
      place(box(0.7, 0.46, 0.05, 0, 0, 0), x, PLATE_H + 1.18, z - 0.14, 0, -0.18)
    ],
    screen: [place(box(0.58, 0.34, 0.02, 0, 0, 0), x, PLATE_H + 1.24, z - 0.105, 0, -0.18)]
  }
}

const DESK_X = BELT_X
const DESK_Z = -0.825

/** Dispatch desk (1.5 x 0.75 m, rounded corners) with two monitors on stands and two posts carrying the header board. */
function dispatchDesk(): { casing: BufferGeometry[]; screen: BufferGeometry[]; header: BufferGeometry[]; headerMarks: BufferGeometry[] } {
  const top = PLATE_H + 0.78
  const hy = PLATE_H + 1.62 // header centre height
  const hz = DESK_Z - 0.15
  const header = [place(box(1.5, 0.34, 0.05, 0, -0.17, 0), DESK_X, hy, hz, 0, HEADER_LEAN)]
  // Three '<' chevrons on the header face, pointing west (towards the head zone, where the line's route runs).
  const marks: BufferGeometry[] = []
  const zf = 0.028
  for (const cx of [-0.45, 0, 0.45]) {
    marks.push(paraV(cx + 0.06, 0.07, -0.12, 0, -0.12, zf), paraV(cx - 0.06, 0.07, 0, 0.12, 0.12, zf))
  }
  const headerMarks = marks.map((g) => place(g, DESK_X, hy, hz, 0, HEADER_LEAN))
  return {
    casing: [
      chamfer(1.5, 0.78, 0.75, 0.18, DESK_X, PLATE_H, DESK_Z),
      // Posts under the header, and two monitors on stands below it.
      box(0.07, 0.7, 0.07, DESK_X - 0.7, top, hz - 0.02),
      box(0.07, 0.7, 0.07, DESK_X + 0.7, top, hz - 0.02),
      box(0.08, 0.18, 0.08, DESK_X - 0.3, top, DESK_Z - 0.2),
      box(0.08, 0.18, 0.08, DESK_X + 0.3, top, DESK_Z - 0.2),
      place(box(0.5, 0.36, 0.05, 0, 0, 0), DESK_X - 0.3, top + 0.16, DESK_Z - 0.24, 0, -0.18),
      place(box(0.5, 0.36, 0.05, 0, 0, 0), DESK_X + 0.3, top + 0.16, DESK_Z - 0.24, 0, -0.18)
    ],
    screen: [
      place(box(0.42, 0.28, 0.02, 0, 0, 0), DESK_X - 0.3, top + 0.2, DESK_Z - 0.2, 0, -0.18),
      place(box(0.42, 0.28, 0.02, 0, 0, 0), DESK_X + 0.3, top + 0.2, DESK_Z - 0.2, 0, -0.18)
    ],
    header,
    headerMarks
  }
}

/** Yellow rim just inside the plate's edge (lead only): a closed outline of the 3 m plate, readable at fit. */
function rim(): BufferGeometry[] {
  const e = 1.4
  const t = 0.09
  const h = 0.014
  return [
    box(2 * e - 0.2, h, t, 0, PLATE_H, -e),
    box(2 * e - 0.2, h, t, 0, PLATE_H, e),
    box(t, h, 2 * e - 0.2, -e, PLATE_H, 0),
    box(t, h, 2 * e - 0.2, e, PLATE_H, 0)
  ]
}

/** The lead's line plate on the floor in the aisle in front of the belt: a yellow slab with three dark chevrons pointing west. */
function linePlate(): { slab: BufferGeometry; marks: BufferGeometry[] } {
  const x = -0.7
  const z = 3.2
  const slab = box(1.3, 0.03, 0.72, x, 0, z)
  const y = 0.035
  const marks: BufferGeometry[] = []
  for (const dx of [-0.38, 0, 0.38]) {
    // A '<' made of two slanted bars.
    marks.push(para(x + dx - 0.02, 0.08, z - 0.25, z, -0.18, y), para(x + dx - 0.2, 0.08, z, z + 0.25, 0.18, y))
  }
  return { slab, marks }
}

/** The outfeed pad: a slab on the floor east of the bin where the station's own crate sits. */
function outfeedPad(): BufferGeometry {
  return box(0.9, 0.02, 0.8, 1.05, 0, 2.0)
}

export function station(kind: 'lead' | 'bench'): ObjectKit {
  const b = belt()
  const c = kind === 'lead' ? dispatchDesk() : null
  const k = console_()
  const casing = [...(c ? c.casing : []), ...k.casing, ...b.frame, bin()]
  const screen = [...(c ? c.screen : []), ...k.screen]
  const parts: PartSpec[] = [
    part('station.plate', merge([chamfer(PLATE, PLATE_H, PLATE, 0.14, 0, 0, 0), outfeedPad()]), 'plate'),
    part('station.console', merge(casing), 'console'),
    part('station.screen', merge(screen), 'screen', { lods: NEAR_MID, cast: false }),
    part('belt.body', b.body, 'belt', { cast: false }),
    part('belt.rollers', b.drums, 'rollers', { lods: NEAR_MID, cast: false })
  ]
  if (c) {
    const lp = linePlate()
    parts.push(
      part('station.rim', merge([...rim(), ...c.header]), 'hazard', { cast: false }),
      part('station.plaque', lp.slab, 'paint', { cast: false }),
      part('station.plaque.mark', merge([...lp.marks, ...c.headerMarks]), 'paintMark', { cast: false })
    )
  }
  const anchors = kind === 'lead' ? { ...STATION_ANCHORS, ...LEAD_ANCHORS } : { ...STATION_ANCHORS }
  return { name: `station.${kind}`, parts, anchors }
}
