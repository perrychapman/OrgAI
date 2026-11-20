// Control booth (Factory Floor sections 1.1 and 4.6): a 6 x 4 m glass-fronted booth on the gantry with a desk, a server
// rack and three screens. Origin at the booth centre (7, -6) on the deck's top surface; +z is the glass front. The roof
// is a frame only, so the desk and the robot read from the overhead camera.
import type { BufferGeometry } from 'three'
import { box, merge, place } from './geo'
import { part } from './common'
import type { ObjectKit } from './types'

const W = 6
const D = 4
const WALL_H = 2.6
const BASE_H = 0.15
const SILL_H = 0.9
const T = 0.2
const DESK_H = 0.85

export function booth(): ObjectKit {
  const hw = W / 2
  const hd = D / 2

  const shell: BufferGeometry[] = [
    box(W, BASE_H, D, 0, 0, 0),
    // North wall (full height), the two side walls up to sill height and the front sill.
    box(W, WALL_H - BASE_H, T, 0, BASE_H, -hd + T / 2),
    box(T, SILL_H, D - 2 * T, -hw + T / 2, BASE_H, 0),
    box(T, SILL_H, D - 2 * T, hw - T / 2, BASE_H, 0),
    box(W - 2 * T, SILL_H, T, 0, BASE_H, hd - T / 2)
  ]

  const trim: BufferGeometry[] = []
  // Corner posts and a roof frame.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) trim.push(box(T, WALL_H - BASE_H, T, sx * (hw - T / 2), BASE_H, sz * (hd - T / 2)))
  const top = WALL_H - 0.12
  trim.push(box(W, 0.12, T, 0, top, -hd + T / 2), box(W, 0.12, T, 0, top, hd - T / 2))
  trim.push(box(T, 0.12, D - 2 * T, -hw + T / 2, top, 0), box(T, 0.12, D - 2 * T, hw - T / 2, top, 0))
  // Two mullions in the glass front, and a thin transom at screen height.
  for (const x of [-hw / 3, hw / 3]) trim.push(box(0.08, WALL_H - BASE_H - SILL_H - BASE_H, 0.08, x, BASE_H + SILL_H, hd - T / 2))
  // Monitor frames and stands on the desk.
  const deckTop = BASE_H + DESK_H
  for (const x of [-1.5, 0, 1.5]) {
    trim.push(box(0.12, 0.25, 0.1, x, deckTop, -1.45))
    trim.push(place(box(1.1, 0.66, 0.06, 0, 0, 0), x, deckTop + 0.25, -1.5, 0, -0.22))
  }

  const glass: BufferGeometry[] = [
    box(W - 2 * T, WALL_H - BASE_H - SILL_H - 0.12, 0.04, 0, BASE_H + SILL_H, hd - T / 2),
    box(0.04, WALL_H - BASE_H - SILL_H - 0.12, D - 2 * T, -hw + T / 2, BASE_H + SILL_H, 0),
    box(0.04, WALL_H - BASE_H - SILL_H - 0.12, D - 2 * T, hw - T / 2, BASE_H + SILL_H, 0)
  ]

  const desk: BufferGeometry[] = [
    // Back counter along the north wall, a side return and a server rack in the north-west corner.
    box(4.2, DESK_H, 0.9, 0.5, BASE_H, -hd + T + 0.45),
    box(0.9, DESK_H, 1.6, 1.95, BASE_H, -0.55),
    box(0.8, 2.0, 0.6, -hw + T + 0.5, BASE_H, -hd + T + 0.35)
  ]

  const screens: BufferGeometry[] = []
  for (const x of [-1.5, 0, 1.5]) screens.push(place(box(0.98, 0.54, 0.02, 0, 0, 0), x, deckTop + 0.31, -1.465, 0, -0.22))
  // Rack indicator strips (unlit so they read in the dark theme).
  screens.push(box(0.5, 0.06, 0.02, -hw + T + 0.5, BASE_H + 1.5, -hd + T + 0.66), box(0.5, 0.06, 0.02, -hw + T + 0.5, BASE_H + 1.2, -hd + T + 0.66))

  return {
    name: 'booth',
    parts: [
      part('booth.shell', merge(shell), 'booth'),
      part('booth.trim', merge(trim), 'boothTrim'),
      part('booth.glass', merge(glass), 'glass', { cast: false }),
      part('booth.desk', merge(desk), 'console'),
      part('booth.screens', merge(screens), 'screen', { cast: false })
    ],
    anchors: {
      robot: { x: 0, y: BASE_H, z: -0.45, rotY: 0 },
      stackLight: { x: hw + 0.5, y: 0, z: hd - 0.4, rotY: 0 },
      nameplate: { x: 0, y: WALL_H + 0.4, z: 0, rotY: 0 },
      // Slice 3. Inside, left of the desk's open front: idle and finished spots for the root's robot (facing south).
      'robot.rest': { x: -1.6, y: BASE_H, z: 0.6, rotY: 0 },
      'robot.dock': { x: -0.2, y: BASE_H, z: 0.7, rotY: 0 },
      // Outside, on the deck between the booth and the dock (booth frame; deck top is y 0): own crate, hold pad, and the
      // 2 x 2 grid of crates merged into the root's branch (first crate at 'inbox', 0.8 m pitch east then south). The
      // stack light stands at x 3.5, z 1.6; the dock starts 4 m east of the booth's east wall (world x 14).
      pad: { x: 4.4, y: 0, z: -1.0, rotY: 0 },
      hold: { x: 5.6, y: 0, z: -1.0, rotY: 0 },
      inbox: { x: 4.6, y: 0, z: 1.0, rotY: 0 }
    }
  }
}
