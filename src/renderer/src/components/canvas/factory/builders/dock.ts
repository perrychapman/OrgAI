// Shipping dock (Factory Floor sections 1.1 and 4.6): a 6 x 4 m platform on the gantry with a 3 x 3 grid of crate slots, a
// hazard-striped front lip, bollards and a low back stop. Origin at the dock centre (17, -6) on the deck's top surface.
import type { BufferGeometry } from 'three'
import { box, cyl, merge, para } from './geo'
import { part } from './common'
import type { Anchor, ObjectKit } from './types'

const W = 6
const D = 4
const PLATFORM_H = 0.2
const SLOT = 0.9
const SLOT_PITCH = 1.0
const SLOT_CENTRE_Z = -0.25
const LIP_D = 0.4

export function dock(): ObjectKit {
  const hd = D / 2

  const platform: BufferGeometry[] = [box(W, PLATFORM_H, D, 0, 0, 0), box(W, 0.9, 0.2, 0, PLATFORM_H, -hd + 0.1)]

  const slots: BufferGeometry[] = []
  const anchors: Record<string, Anchor> = { label: { x: 0, y: 1.9, z: 0, rotY: 0 } }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = (c - 1) * SLOT_PITCH
      const z = SLOT_CENTRE_Z + (r - 1) * SLOT_PITCH
      slots.push(box(SLOT, 0.02, SLOT, x, PLATFORM_H, z))
      anchors[`slot.${r * 3 + c}`] = { x, y: PLATFORM_H + 0.02, z, rotY: 0 }
    }
  }
  // Dark base of the hazard lip along the front edge.
  slots.push(box(W, 0.02, LIP_D, 0, PLATFORM_H, hd - LIP_D / 2))

  const stripes: BufferGeometry[] = []
  const stripeW = 0.28
  const skew = 0.2
  for (let x = -W / 2; x + stripeW + skew <= W / 2 + 1e-6; x += stripeW * 2) {
    stripes.push(para(x, stripeW, hd - LIP_D, hd, skew, PLATFORM_H + 0.025))
  }

  const bollards: BufferGeometry[] = []
  for (const x of [-2.7, -0.9, 0.9, 2.7]) bollards.push(cyl(0.12, 0.14, 0.9, 8, x, PLATFORM_H, hd - 0.75))

  return {
    name: 'dock',
    parts: [
      part('dock.platform', merge(platform), 'dock'),
      part('dock.slots', merge(slots), 'dockSlot', { cast: false }),
      part('dock.stripes', merge(stripes), 'hazard', { cast: false }),
      part('dock.bollards', merge(bollards), 'bollard')
    ],
    anchors
  }
}
