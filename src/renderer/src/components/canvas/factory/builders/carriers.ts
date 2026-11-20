// Slice 4 carriers (Factory Floor sections 4.3, 4.6, 5.2): the things that travel. A work-order tote (delegation), a
// message capsule and a tool part on the belt. All are moving things: they cast no shadow (the engine gives each a blob
// shadow from props() 'blob') and are built with their origin at the bottom centre, front +z, metres. The crate of
// slice 3 (stateProps.ts) is the fourth carrier.
import { SphereGeometry, type BufferGeometry } from 'three'
import { box, cylX, merge, place, taper } from './geo'
import { part } from './common'
import type { ObjectKit } from './types'

// Slice 6 (carried art item): the travellers are about 20 percent larger than slice 4's (tote 0.84 x 0.6, capsule 0.64 m,
// part 0.3 m) and take the palette's saturated carrier colours with a high-contrast second tone (palette.carrierBand), so
// they read at fit and in the light theme. Triangle counts are unchanged (tote 72, capsule 100, part 12).
export const TOTE_W = 0.84
export const TOTE_D = 0.6
export const TOTE_H = 0.4

/**
 * Work-order tote: a tapered open tray 0.84 x 0.6 m, 0.4 m tall (72 triangles). The tapered body and four rim bars are
 * 'tote.body'; the liner just below the rim is 'tote.liner' in the carriers' contrasting tone, wide, so the tote reads as
 * a dark (or, in the light theme, white) hollow in a coloured tray from above, which a crate (lid, straps, lamp) never does.
 */
export function tote(): ObjectKit {
  const h = TOTE_H - 0.05
  const body = taper(0.72, 0.48, TOTE_W - 0.04, TOTE_D - 0.04, h, 0, 0, 0)
  const rim = [
    box(TOTE_W, 0.05, 0.06, 0, h, -(TOTE_D - 0.06) / 2),
    box(TOTE_W, 0.05, 0.06, 0, h, (TOTE_D - 0.06) / 2),
    box(0.06, 0.05, TOTE_D - 0.12, -(TOTE_W - 0.06) / 2, h, 0),
    box(0.06, 0.05, TOTE_D - 0.12, (TOTE_W - 0.06) / 2, h, 0)
  ]
  const liner = box(TOTE_W - 0.22, 0.012, TOTE_D - 0.22, 0, h - 0.004, 0)
  return {
    name: 'tote',
    parts: [part('tote.body', merge([body, ...rim]), 'tote', { cast: false }), part('tote.liner', liner, 'carrierBand', { cast: false, receive: false })]
  }
}

export const CAPSULE_R = 0.15
export const CAPSULE_LENGTH = 0.64

/**
 * Message capsule: a pill 0.64 m long and 0.3 m across lying along x (east-west), a cylinder with two half-spheres and a
 * wide contrasting band round the middle (100 triangles). The band stops it reading as a plain ball from far away and gives
 * the "slightly larger" coalesced capsule a visible stripe. Origin at the bottom centre, so the centre is 0.15 m up.
 */
export function capsule(): ObjectKit {
  const r = CAPSULE_R
  const cyl = CAPSULE_LENGTH - 2 * r
  const dome = (sign: 1 | -1): BufferGeometry => {
    const g = new SphereGeometry(r, 10, 2, 0, Math.PI * 2, 0, Math.PI / 2)
    // Hemisphere about +y -> about +x (sign 1) or -x (sign -1), then to the end of the cylinder.
    g.rotateZ(-sign * (Math.PI / 2))
    return place(g.toNonIndexed(), sign * (cyl / 2), r, 0)
  }
  const body = merge([cylX(r, cyl, 10, 0, r, 0, true), dome(1), dome(-1)])
  // The band is 1.5 cm proud of the body; lifted 7.5 mm so it does not dip below the origin plane.
  const band = cylX(r + 0.015, 0.12, 10, 0, r + 0.0075, 0, true)
  return {
    name: 'capsule',
    parts: [part('capsule.body', body, 'capsule', { cast: false }), part('capsule.band', band, 'carrierBand', { cast: false, receive: false })]
  }
}

export const PART_SIZE = 0.3

/**
 * Tool part riding the belt: a tapered block 0.3 m across (12 triangles), one part. Near and mid only (section 4.5: parts
 * are not shown at far zoom).
 */
export function toolPart(): ObjectKit {
  return {
    name: 'part',
    parts: [part('part.block', taper(PART_SIZE, PART_SIZE, 0.2, 0.2, 0.18, 0, 0, 0), 'part', { cast: false, lods: ['near', 'mid'] })]
  }
}
