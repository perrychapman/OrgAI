// Flat floor props (Factory Floor section 4.6): floor-paint quad, vacant-slot outline, selection ring and blob shadow.
// All lie within a few centimetres of the floor and use polygon offset (materials.ts) so they never z-fight with it.
// The engine scales 'paint' along route segments (1 x 1 m unit quad, x by length, z by 0.25 m) and 'blob' to a worker's
// footprint. None casts a shadow. Floor paint is safety yellow and is never a state colour.
import { RingGeometry, type BufferGeometry } from 'three'
import { merge, place, quad } from './geo'
import { part } from './common'
import type { ObjectKit } from './types'

export const PAINT_Y = 0.02
export const VACANT_Y = 0.025
export const RING_Y = 0.03
export const BLOB_Y = 0.012
/** Selection ring: inner and outer radius in metres (3.6 m across at the outer edge). */
export const RING_INNER = 1.7
export const RING_OUTER = 1.8

export function props(): ObjectKit {
  // Vacant slot: four corner brackets around the 3 x 3 m footprint (16 triangles).
  const brackets: BufferGeometry[] = []
  const half = 1.5
  const arm = 0.6
  const t = 0.08
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      brackets.push(quad(arm, t, sx * (half - arm / 2), VACANT_Y, sz * (half - t / 2)))
      brackets.push(quad(t, arm, sx * (half - t / 2), VACANT_Y, sz * (half - arm / 2)))
    }
  }
  const ring = new RingGeometry(RING_INNER, RING_OUTER, 32, 1)
  ring.rotateX(-Math.PI / 2)

  const decal = { cast: false }
  return {
    name: 'props',
    parts: [
      part('paint', quad(1, 1, 0, PAINT_Y, 0), 'paint', decal),
      part('vacant', merge(brackets), 'vacant', { cast: false, receive: false }),
      part('ring', place(ring, 0, RING_Y, 0), 'ring', { cast: false, receive: false }),
      part('blob', quad(1, 1, 0, BLOB_Y, 0), 'blob', { cast: false, receive: false })
    ]
  }
}
