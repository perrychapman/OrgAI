// Slice 3 state props (Factory Floor sections 1.4, 4.4, 4.6): the static end states a station can show besides its stack
// light and robot pose: shutter (finished), barrier (failed), fence (isolated worktree), crate (a branch on its way), hold pad.
// Each is a kit in the frame of the anchor it is placed at (builders/station.ts documents the anchors); geometry is
// built once per engine, instanced per station, and every shape cue is geometry, never a texture.
import type { BufferGeometry } from 'three'
import { box, cyl, cylX, merge, para, paraV, quad } from './geo'
import { PLATE_TOP, part } from './common'
import type { ObjectKit } from './types'

// ---- shutter: a roll-down shutter, lowered over the machine or the dispatch desk with its header ----------------------

const SHUTTER_W = 1.6
const SHUTTER_D = 1.4
const SHUTTER_H = 1.9

/**
 * Origin at the footprint centre on the plate top (anchor 'shutter'): a roof slab and roll drum (steel), side guides and
 * seven dark slats down the front. From the camera the finished station reads as a closed, dark-fronted hood. About 150
 * triangles; casts shadows.
 */
export function shutter(): ObjectKit {
  const hw = SHUTTER_W / 2
  const hd = SHUTTER_D / 2
  const hood: BufferGeometry[] = [
    box(SHUTTER_W, 0.14, SHUTTER_D, 0, SHUTTER_H - 0.14, 0),
    cylX(0.1, SHUTTER_W - 0.1, 6, 0, SHUTTER_H - 0.2, hd - 0.04),
    box(0.07, SHUTTER_H - 0.14, 0.12, -hw + 0.035, 0, hd - 0.06),
    box(0.07, SHUTTER_H - 0.14, 0.12, hw - 0.035, 0, hd - 0.06)
  ]
  const slats: BufferGeometry[] = []
  for (let i = 0; i < 7; i++) slats.push(box(SHUTTER_W - 0.2, 0.2, 0.05, 0, 0.02 + i * 0.24, hd - 0.04))
  return {
    name: 'shutter',
    parts: [part('shutter.hood', merge(hood), 'console'), part('shutter.slats', merge(slats), 'boothTrim')]
  }
}

// ---- barrier: a striped gate arm lowered across the station front ----------------------------------------------------

const BARRIER_HALF = 1.45
const ARM_Y = 0.55
const ARM_H = 0.16
const ARM_D = 0.1

/**
 * Origin at the middle of the station front on the floor (anchor 'barrier'): two posts with feet and an arm across the
 * front. The arm carries hazard stripes on its front face and its top, as geometry. About 110 triangles.
 */
export function barrier(): ObjectKit {
  const frame: BufferGeometry[] = [
    box(0.12, ARM_Y + ARM_H + 0.1, 0.12, -BARRIER_HALF, 0, 0),
    box(0.12, ARM_Y + ARM_H + 0.1, 0.12, BARRIER_HALF, 0, 0),
    box(0.2, 0.05, 0.28, -BARRIER_HALF, 0, 0),
    box(0.2, 0.05, 0.28, BARRIER_HALF, 0, 0),
    box(2 * BARRIER_HALF - 0.1, ARM_H, ARM_D, 0, ARM_Y, 0)
  ]
  const stripes: BufferGeometry[] = []
  const w = 0.16
  const pitch = 0.32
  const skew = 0.16
  const x0 = -BARRIER_HALF + 0.12
  const x1 = BARRIER_HALF - 0.12
  for (let x = x0; x + w + skew <= x1 + 1e-6; x += pitch) {
    stripes.push(paraV(x, w, ARM_Y + 0.01, ARM_Y + ARM_H - 0.01, skew, ARM_D / 2 + 0.003))
    stripes.push(para(x, w, -ARM_D / 2 + 0.01, ARM_D / 2 - 0.01, skew * 0.6, ARM_Y + ARM_H + 0.003))
  }
  return {
    name: 'barrier',
    parts: [part('barrier.frame', merge(frame), 'boothTrim'), part('barrier.stripes', merge(stripes), 'hazard', { cast: false })]
  }
}

// ---- fence: a low mesh fence around an isolated worktree ---------------------------------------------------------------

const FENCE_E = 1.47
const FENCE_H = 0.9

/**
 * Origin at the plate centre on the FLOOR (the station frame; the plate top is PLATE_TOP): posts, flat top rails, a mid rail,
 * a kick plate and vertical bars on the west, north and east sides; the front stays open. Posts keep clear of the stack
 * light (x 1.2, z -0.24..0.24). The top rail is a flat strip 0.14 m wide so the cell still reads as an outline at fit. About
 * 300 triangles; casts shadows.
 */
export function fence(): ObjectKit {
  const y = PLATE_TOP
  const e = FENCE_E
  const zs = 2 * e
  const posts: BufferGeometry[] = []
  const post = (x: number, z: number): number => posts.push(box(0.1, FENCE_H, 0.1, x, y, z))
  post(-e, -e)
  post(e, -e)
  post(-e, 1.4)
  post(e, 1.4)
  post(0, -e)
  post(-e, 0.2)
  post(e, 0.7)
  const rails: BufferGeometry[] = [
    // Flat top rails, the three runs.
    box(zs, 0.04, 0.14, 0, y + FENCE_H, -e),
    box(0.14, 0.04, 2.87, -e, y + FENCE_H, -0.035),
    box(0.14, 0.04, 2.87, e, y + FENCE_H, -0.035),
    // Mid rails.
    box(zs, 0.04, 0.04, 0, y + 0.45, -e),
    box(0.04, 0.04, 2.87, -e, y + 0.45, -0.035),
    box(0.04, 0.04, 2.87, e, y + 0.45, -0.035),
    // Kick plates.
    box(zs, 0.18, 0.03, 0, y, -e),
    box(0.03, 0.18, 2.87, -e, y, -0.035),
    box(0.03, 0.18, 2.87, e, y, -0.035)
  ]
  // Vertical bars, open four-sided prisms (8 triangles), every 0.55 m between the kick plate and the top rail.
  const bars: BufferGeometry[] = []
  const bh = FENCE_H - 0.2
  for (const x of [-0.95, -0.5, 0.5, 0.95]) bars.push(cyl(0.012, 0.012, bh, 4, x, y + 0.18, -e, true))
  for (const z of [-0.95, 0.5, 1.0, -0.4]) bars.push(cyl(0.012, 0.012, bh, 4, -e, y + 0.18, z, true))
  for (const z of [-0.95, -0.4, 1.0, 1.25]) bars.push(cyl(0.012, 0.012, bh, 4, e, y + 0.18, z, true))
  return { name: 'fence', parts: [part('fence.mesh', merge([...posts, ...rails, ...bars]), 'rail')] }
}

// ---- crate ---------------------------------------------------------------------------------------------------------------

export const CRATE_W = 0.7
export const CRATE_D = 0.56
export const CRATE_H = 0.5

/**
 * One crate (about 60 triangles), origin at its bottom centre, 0.7 x 0.56 m, 0.5 m tall. The wood body has a lip and two
 * dark straps; 'crate.lamp' is a small unlit slab on top (instanceColor): the engine colours it with the Needs-you token
 * on a crate waiting for merge review and the off colour otherwise.
 */
export function crate(): ObjectKit {
  const body = merge([box(CRATE_W, 0.4, CRATE_D, 0, 0, 0), box(CRATE_W + 0.04, 0.1, CRATE_D + 0.04, 0, 0.4, 0)])
  const straps = merge([box(0.08, CRATE_H, CRATE_D + 0.04, -0.24, 0, 0), box(0.08, CRATE_H, CRATE_D + 0.04, 0.24, 0, 0)])
  const lamp = box(0.24, 0.05, 0.16, 0, CRATE_H, 0)
  return {
    name: 'crate',
    parts: [
      part('crate.body', body, 'crate', { cast: false }),
      part('crate.straps', straps, 'boothTrim', { cast: false }),
      part('crate.lamp', lamp, 'lamp', { cast: false, receive: false, instanceColor: true })
    ]
  }
}

// ---- hold pad ----------------------------------------------------------------------------------------------------------------

export const HOLD_PAD = 0.9

/**
 * Hold pad on the floor beside the station, origin at its centre on the floor, 0.9 x 0.9 m. Plain: a dark slab with a yellow
 * paint outline. Striped (merge conflict): the slab with diagonal hazard stripes, so the conflict reads by shape as well as
 * colour. 12 and 20 triangles.
 */
export function holdPad(striped: boolean): ObjectKit {
  const h = HOLD_PAD / 2
  const slab = box(HOLD_PAD, 0.02, HOLD_PAD, 0, 0, 0)
  if (!striped) {
    const t = 0.06
    const y = 0.022
    const edge = merge([
      quad(HOLD_PAD - 0.1, t, 0, y, -h + 0.06),
      quad(HOLD_PAD - 0.1, t, 0, y, h - 0.06),
      quad(t, HOLD_PAD - 0.1, -h + 0.06, y, 0),
      quad(t, HOLD_PAD - 0.1, h - 0.06, y, 0)
    ])
    return { name: 'holdPad', parts: [part('hold.pad', slab, 'dockSlot', { cast: false }), part('hold.edge', edge, 'paint', { cast: false, receive: false })] }
  }
  const stripes: BufferGeometry[] = []
  const w = 0.09
  const pitch = 0.18
  const skew = 0.15
  for (let i = 0; i < 4; i++) stripes.push(para(-0.39 + i * pitch, w, -h + 0.05, h - 0.05, skew, 0.024))
  return { name: 'holdPad.striped', parts: [part('hold.pad', slab, 'dockSlot', { cast: false }), part('hold.stripes', merge(stripes), 'hazard', { cast: false })] }
}
