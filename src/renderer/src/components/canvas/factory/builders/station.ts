// Station (Factory Floor sections 1.1, 1.2, 4.6): a 3 x 3 m plate with a console and screen, an outfeed belt with rollers
// and an output bin. The bench kit leaves the machine to machines.ts (the engine puts machine(variant) at the 'machine'
// anchor); the lead kit adds a dispatch desk there and a line plate on the floor. Origin at the plate centre on the
// floor; the front faces +z. Belt and bin reach 2.5 m south of the origin, into the 1 m belt strip of the row (3.1).
//
// Layout in the plate frame (x east, z south): machine centre (0.1, -0.45), console at the west back (-1.1, -0.7),
// robot at the console's front (-0.95, 0.65), stack light at the east edge (1.25, 0), belt down the middle (x 0.1).
import type { BufferGeometry } from 'three'
import { box, chamfer, cylX, merge, para, place, taper } from './geo'
import { NEAR_MID, NEAR_ONLY, PLATE_TOP, part } from './common'
import type { Anchor, ObjectKit, PartSpec } from './types'

const PLATE = 3
const PLATE_H = PLATE_TOP
const BELT_X = 0.1
const BELT_W = 0.9
const BELT_Z0 = 0.3
const BELT_Z1 = 2.1
const BELT_H = 0.12
const BELT_Y = PLATE_H
const BIN_Z = 2.3
const NAMEPLATE_Y = 2.3

export const STATION_ANCHORS: Record<string, Anchor> = {
  robot: { x: -0.95, y: PLATE_H, z: 0.65, rotY: 0 },
  machine: { x: BELT_X, y: PLATE_H, z: -0.45, rotY: 0 },
  stackLight: { x: 1.25, y: PLATE_H, z: 0, rotY: 0 },
  nameplate: { x: 0, y: NAMEPLATE_Y, z: 0, rotY: 0 }
}

function belt(): { body: BufferGeometry; rollers: BufferGeometry } {
  const len = BELT_Z1 - BELT_Z0
  const cz = (BELT_Z0 + BELT_Z1) / 2
  const body = merge([
    box(BELT_W, BELT_H, len, BELT_X, BELT_Y, cz),
    box(0.05, 0.1, len, BELT_X - BELT_W / 2 + 0.025, BELT_Y + BELT_H, cz),
    box(0.05, 0.1, len, BELT_X + BELT_W / 2 - 0.025, BELT_Y + BELT_H, cz),
    // Two legs under the part of the belt that overhangs the plate, and the output bin at its end.
    box(0.08, BELT_Y, 0.08, BELT_X - 0.38, 0, BELT_Z1 - 0.12),
    box(0.08, BELT_Y, 0.08, BELT_X + 0.38, 0, BELT_Z1 - 0.12),
    box(0.8, 0.3, 0.4, BELT_X, 0, BIN_Z)
  ])
  const rollers: BufferGeometry[] = []
  for (let z = BELT_Z0 + 0.15; z < BELT_Z1 - 0.05; z += 0.2) rollers.push(cylX(0.05, 0.78, 6, BELT_X, BELT_Y + BELT_H + 0.04, z))
  return { body, rollers: merge(rollers) }
}

function console_(): { casing: BufferGeometry[]; screen: BufferGeometry[] } {
  const x = -1.1
  const z = -0.75
  return {
    casing: [
      box(0.8, 0.7, 0.6, x, PLATE_H, z),
      taper(0.8, 0.6, 0.8, 0.25, 0.28, x, PLATE_H + 0.7, z),
      // Monitor stand and housing; the lit screen is a separate part.
      box(0.08, 0.2, 0.08, x, PLATE_H + 0.98, z - 0.1),
      place(box(0.78, 0.48, 0.05, 0, 0, 0), x, PLATE_H + 1.18, z - 0.14, 0, -0.18)
    ],
    screen: [place(box(0.66, 0.36, 0.02, 0, 0, 0), x, PLATE_H + 1.24, z - 0.105, 0, -0.18)]
  }
}

function dispatchDesk(): { casing: BufferGeometry[]; screen: BufferGeometry[] } {
  const x = BELT_X
  const z = -0.5
  return {
    casing: [
      box(1.5, 0.78, 0.7, x, PLATE_H, z),
      box(0.5, 0.78, 0.5, x + 0.5, PLATE_H, z + 0.55),
      // Two monitors on stands at the back edge.
      box(0.08, 0.2, 0.08, x - 0.4, PLATE_H + 0.78, z - 0.2),
      box(0.08, 0.2, 0.08, x + 0.3, PLATE_H + 0.78, z - 0.2),
      place(box(0.62, 0.42, 0.05, 0, 0, 0), x - 0.4, PLATE_H + 0.98, z - 0.24, 0, -0.18),
      place(box(0.62, 0.42, 0.05, 0, 0, 0), x + 0.3, PLATE_H + 0.98, z - 0.24, 0, -0.18)
    ],
    screen: [
      place(box(0.52, 0.32, 0.02, 0, 0, 0), x - 0.4, PLATE_H + 1.03, z - 0.2, 0, -0.18),
      place(box(0.52, 0.32, 0.02, 0, 0, 0), x + 0.3, PLATE_H + 1.03, z - 0.2, 0, -0.18)
    ]
  }
}

/** The lead's line plate on the floor south-west of the belt: a yellow slab with two dark chevrons pointing west. */
function linePlate(): { slab: BufferGeometry; marks: BufferGeometry } {
  const x = -0.95
  const z = 1.95
  const slab = box(0.9, 0.03, 0.62, x, 0, z)
  const y = 0.035
  const marks: BufferGeometry[] = []
  for (const dx of [-0.16, 0.14]) {
    // A '<' made of two slanted bars.
    marks.push(para(x + dx - 0.02, 0.07, z - 0.22, z, -0.16, y), para(x + dx - 0.18, 0.07, z, z + 0.22, 0.16, y))
  }
  return { slab, marks: merge(marks) }
}

export function station(kind: 'lead' | 'bench'): ObjectKit {
  const b = belt()
  const c = kind === 'lead' ? dispatchDesk() : console_()
  const casing = [...c.casing]
  const screen = [...c.screen]
  if (kind === 'lead') {
    // The lead keeps a small console too, so the bench pose set works at the desk.
    const k = console_()
    casing.push(...k.casing)
    screen.push(...k.screen)
  }
  const parts: PartSpec[] = [
    part('station.plate', chamfer(PLATE, PLATE_H, PLATE, 0.14, 0, 0, 0), 'plate'),
    part('station.console', merge(casing), 'console'),
    part('station.screen', merge(screen), 'screen', { lods: NEAR_MID, cast: false }),
    part('belt.body', b.body, 'belt'),
    part('belt.rollers', b.rollers, 'rollers', { lods: NEAR_ONLY, cast: false })
  ]
  if (kind === 'lead') {
    const lp = linePlate()
    parts.push(part('station.plaque', lp.slab, 'paint', { cast: false }), part('station.plaque.mark', lp.marks, 'belt', { cast: false }))
  }
  return { name: `station.${kind}`, parts, anchors: { ...STATION_ANCHORS } }
}
