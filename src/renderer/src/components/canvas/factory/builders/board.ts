// Plan board (Factory Floor sections 1.1 and 4.6): a 6 m wide panel that leans back towards the north wall so it faces the
// overhead camera, with twelve round step lamps in two rows. Origin at the board's footprint centre (25, -9.5) on the
// deck's top surface.
//
// The twelve lamps are one part ('board.lamps', unlit, instanceColor) whose lamps all take the object's one instance
// colour. Per-step colours need either twelve instances of a single lamp (anchors `lamp.0` to `lamp.11` give their
// positions, in the board frame, rotated to the panel's normal) or a contract change; that is slice 3's decision.
import type { BufferGeometry } from 'three'
import { box, cyl, merge, place } from './geo'
import { part } from './common'
import type { Anchor, ObjectKit } from './types'

const PANEL_W = 6
const PANEL_H = 1.5
const PANEL_T = 0.12
const PANEL_BOTTOM = 0.9
/** Rotation about +x in radians: the panel's top leans north (towards -z). */
const LEAN = -0.55
/** The panel's lower edge sits this far south of the origin so its top clears the north wall. */
const FRONT_Z = 0.8
const LAMP_R = 0.2
const LAMP_H = 0.05

export const BOARD_LAMPS = 12

/** Position of lamp i (0 to 11) in the board frame: two rows of six on the panel face. */
export function boardLampPosition(i: number): { x: number; y: number; z: number } {
  const col = i % 6
  const row = Math.floor(i / 6)
  const x = (col - 2.5) * 0.95
  const v = row === 0 ? 1.0 : 0.5
  const up = { y: Math.cos(LEAN), z: Math.sin(LEAN) }
  const normal = { y: -Math.sin(LEAN), z: Math.cos(LEAN) }
  const lift = PANEL_T / 2 + LAMP_H / 2
  return {
    x,
    y: PANEL_BOTTOM + v * up.y + lift * normal.y,
    z: FRONT_Z + v * up.z + lift * normal.z
  }
}

export function board(): ObjectKit {
  const frame: BufferGeometry[] = [
    box(0.12, PANEL_BOTTOM + 0.1, 0.12, -PANEL_W / 2 + 0.3, 0, FRONT_Z),
    box(0.12, PANEL_BOTTOM + 0.1, 0.12, PANEL_W / 2 - 0.3, 0, FRONT_Z),
    box(PANEL_W - 0.4, 0.1, 0.3, 0, 0, FRONT_Z)
  ]
  const panel: BufferGeometry[] = [place(box(PANEL_W, PANEL_H, PANEL_T, 0, 0, 0), 0, PANEL_BOTTOM, FRONT_Z, 0, LEAN)]
  const lamps: BufferGeometry[] = []
  const anchors: Record<string, Anchor> = { label: { x: 0, y: 2.7, z: 0, rotY: 0 } }
  for (let i = 0; i < BOARD_LAMPS; i++) {
    const p = boardLampPosition(i)
    // A cylinder's axis is +y; tilt it onto the panel normal, then centre it on the lamp position.
    const g = place(cyl(LAMP_R, LAMP_R, LAMP_H, 10, 0, -LAMP_H / 2, 0), p.x, p.y, p.z, 0, Math.PI / 2 + LEAN)
    lamps.push(g)
    anchors[`lamp.${i}`] = { x: p.x, y: p.y, z: p.z, rotY: 0 }
  }

  return {
    name: 'board',
    parts: [
      part('board.frame', merge(frame), 'console'),
      part('board.panel', merge(panel), 'boardPanel'),
      part('board.lamps', merge(lamps), 'lamp', { cast: false, receive: false, instanceColor: true })
    ],
    anchors
  }
}
