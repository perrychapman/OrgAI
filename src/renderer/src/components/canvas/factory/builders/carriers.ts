// Slice 4 carriers (Factory Floor sections 4.3, 4.6, 5.2): the things that travel. A work-order tote (delegation), a
// message capsule and a tool part on the belt. All are moving things: they cast no shadow (the engine gives each a blob
// shadow from props() 'blob') and are built with their origin at the bottom centre, front +z, metres. The crate of
// slice 3 (stateProps.ts) is the fourth carrier.
import { SphereGeometry, type BufferGeometry } from 'three'
import { box, cylX, merge, place, taper } from './geo'
import { part } from './common'
import type { ObjectKit } from './types'

export const TOTE_W = 0.7
export const TOTE_D = 0.5
export const TOTE_H = 0.35

/**
 * Work-order tote: a tapered open tray 0.7 x 0.5 m, 0.35 m tall (72 triangles). The tapered body and four rim bars are
 * 'tote.body'; the dark liner just below the rim is 'tote.liner' so the tote reads as a hollow tray from above, which
 * a crate (lid, straps, lamp) never does.
 */
export function tote(): ObjectKit {
  const h = 0.3
  const body = taper(0.6, 0.4, TOTE_W - 0.04, TOTE_D - 0.04, h, 0, 0, 0)
  const rim = [
    box(TOTE_W, 0.05, 0.05, 0, h, -(TOTE_D - 0.05) / 2),
    box(TOTE_W, 0.05, 0.05, 0, h, (TOTE_D - 0.05) / 2),
    box(0.05, 0.05, TOTE_D - 0.1, -(TOTE_W - 0.05) / 2, h, 0),
    box(0.05, 0.05, TOTE_D - 0.1, (TOTE_W - 0.05) / 2, h, 0)
  ]
  const liner = box(TOTE_W - 0.12, 0.012, TOTE_D - 0.12, 0, h - 0.004, 0)
  return {
    name: 'tote',
    parts: [part('tote.body', merge([body, ...rim]), 'tote', { cast: false }), part('tote.liner', liner, 'boothTrim', { cast: false, receive: false })]
  }
}

export const CAPSULE_R = 0.12
export const CAPSULE_LENGTH = 0.5

/**
 * Message capsule: a pill 0.5 m long and 0.24 m across lying along x (east-west), a cylinder with two half-spheres and a
 * dark band round the middle (100 triangles). The band stops it reading as a plain ball from far away and gives the
 * "slightly larger" coalesced capsule a visible stripe. Origin at the bottom centre, so the centre is 0.12 m up.
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
  // The band is 1.2 cm proud of the body; lifted 6 mm so it does not dip below the origin plane.
  const band = cylX(r + 0.012, 0.07, 10, 0, r + 0.006, 0, true)
  return {
    name: 'capsule',
    parts: [part('capsule.body', body, 'capsule', { cast: false }), part('capsule.band', band, 'boothTrim', { cast: false, receive: false })]
  }
}

export const PART_SIZE = 0.25

/**
 * Tool part riding the belt: a tapered block 0.25 m across (12 triangles), one part. Near and mid only (section 4.5: parts
 * are not shown at far zoom).
 */
export function toolPart(): ObjectKit {
  return {
    name: 'part',
    parts: [part('part.block', taper(PART_SIZE, PART_SIZE, 0.17, 0.17, 0.16, 0, 0, 0), 'part', { cast: false, lods: ['near', 'mid'] })]
  }
}
