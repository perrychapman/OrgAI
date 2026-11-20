// Hall shell (Factory Floor sections 1.1, 3.1, 4.6): floor, boundary walls and pillars, the raised gantry deck along the
// north wall with its stairs, front kerb and railing. Built for the hall rectangle it is given; the engine rebuilds it
// when the hall grows (stations never move, walls do).
import { BufferGeometry } from 'three'
import { box, merge } from './geo'
import { floorGeometry } from './floor'
import { GANTRY_MAX_Z, GANTRY_MIN_Z, GANTRY_TOP, part } from './common'
import type { FloorRect, ObjectKit } from './types'

export { GANTRY_TOP }

const WALL_T = 0.3
const WALL_H = 1.2
const SOUTH_WALL_H = 0.6
const NORTH_WALL_H = GANTRY_TOP + 1.2
const PILLAR = 0.5
const PILLAR_H = 1.6
const PILLAR_PITCH = 8
const DECK_T = 0.3
const LEG = 0.3
const LEG_PITCH = 4
const STAIR_W = 1.2
const STAIR_STEPS = 6
const STAIR_RUN = 0.45
const RAIL_POST = 0.08
const RAIL_PITCH = 2
const RAIL_H = 1.05
const RAIL_Z = GANTRY_MAX_Z - 0.12
const KERB_W = 0.4

export function hall(rect: FloorRect): ObjectKit {
  const { minX, maxX, minZ, maxZ } = rect
  const w = maxX - minX
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const d = maxZ - minZ

  // Stairs sit at the east end of the gantry's front edge; the railing and kerb leave a gap for them.
  const stairX0 = maxX - 1.0 - STAIR_W
  const stairX1 = maxX - 1.0
  const stairCx = (stairX0 + stairX1) / 2

  // ---- walls and pillars ----
  const walls: BufferGeometry[] = [
    box(w + 2 * WALL_T, NORTH_WALL_H, WALL_T, cx, 0, minZ - WALL_T / 2),
    box(w + 2 * WALL_T, SOUTH_WALL_H, WALL_T, cx, 0, maxZ + WALL_T / 2),
    box(WALL_T, WALL_H, d, minX - WALL_T / 2, 0, cz),
    box(WALL_T, WALL_H, d, maxX + WALL_T / 2, 0, cz)
  ]
  for (let x = minX; x <= maxX + 0.01; x += PILLAR_PITCH) walls.push(box(PILLAR, PILLAR_H, PILLAR, x, 0, maxZ + WALL_T / 2))
  for (let z = GANTRY_MAX_Z + PILLAR_PITCH; z <= maxZ - 0.01; z += PILLAR_PITCH) {
    walls.push(box(PILLAR, PILLAR_H, PILLAR, minX - WALL_T / 2, 0, z), box(PILLAR, PILLAR_H, PILLAR, maxX + WALL_T / 2, 0, z))
  }

  // ---- gantry deck: slab, legs under the front edge, stairs ----
  const deckZ = (GANTRY_MIN_Z + GANTRY_MAX_Z) / 2
  const deck: BufferGeometry[] = [box(w, DECK_T, GANTRY_MAX_Z - GANTRY_MIN_Z, cx, GANTRY_TOP - DECK_T, deckZ)]
  for (let x = minX + 2; x < maxX - 1; x += LEG_PITCH) {
    if (x > stairX0 - LEG && x < stairX1 + LEG) continue
    deck.push(box(LEG, GANTRY_TOP - DECK_T, LEG, x, 0, GANTRY_MAX_Z - 0.4))
  }
  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = GANTRY_TOP * (1 - (i + 1) / (STAIR_STEPS + 1))
    deck.push(box(STAIR_W, top, STAIR_RUN, stairCx, 0, GANTRY_MAX_Z + STAIR_RUN * (i + 0.5)))
  }

  // ---- kerb along the front edge and plate seams every 4 m across the deck ----
  const edge: BufferGeometry[] = []
  const kerbZ = GANTRY_MAX_Z - KERB_W / 2
  edge.push(box(stairX0 - minX, 0.04, KERB_W, (minX + stairX0) / 2, GANTRY_TOP, kerbZ))
  if (maxX > stairX1) edge.push(box(maxX - stairX1, 0.04, KERB_W, (stairX1 + maxX) / 2, GANTRY_TOP, kerbZ))
  for (let x = minX + LEG_PITCH; x < maxX - 0.01; x += LEG_PITCH) {
    edge.push(box(0.06, 0.02, GANTRY_MAX_Z - GANTRY_MIN_Z - KERB_W, x, GANTRY_TOP, deckZ - KERB_W / 2))
  }

  // ---- railing: posts every 2 m plus a top and a mid rail, with a gap at the stairs ----
  const rail: BufferGeometry[] = []
  const runs: [number, number][] = [[minX + 0.1, stairX0 - 0.1]]
  if (maxX - stairX1 > 0.6) runs.push([stairX1 + 0.1, maxX - 0.1])
  for (const [a, b] of runs) {
    if (b - a < 0.5) continue
    const n = Math.max(1, Math.round((b - a) / RAIL_PITCH))
    for (let i = 0; i <= n; i++) rail.push(box(RAIL_POST, RAIL_H, RAIL_POST, a + ((b - a) * i) / n, GANTRY_TOP, RAIL_Z))
    rail.push(box(b - a, 0.06, 0.06, (a + b) / 2, GANTRY_TOP + RAIL_H - 0.06, RAIL_Z))
    rail.push(box(b - a, 0.05, 0.05, (a + b) / 2, GANTRY_TOP + RAIL_H * 0.5, RAIL_Z))
  }

  return {
    name: 'hall',
    parts: [
      part('hall.floor', floorGeometry(rect), 'floor', { cast: false }),
      part('hall.walls', merge(walls), 'wall'),
      part('hall.deck', merge(deck), 'deck'),
      part('hall.edge', merge(edge), 'deckEdge', { cast: false }),
      part('hall.rail', merge(rail), 'rail', { cast: false })
    ],
    anchors: {
      booth: { x: 7, y: GANTRY_TOP, z: -6, rotY: 0 },
      dock: { x: 17, y: GANTRY_TOP, z: -6, rotY: 0 },
      board: { x: 25, y: GANTRY_TOP, z: -9.5, rotY: 0 },
      stairs: { x: stairCx, y: 0, z: GANTRY_MAX_Z, rotY: 0 }
    }
  }
}
