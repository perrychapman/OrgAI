// Stack light (Factory Floor sections 1.4, 4.4, 4.6): base, pole and three stacked lamps, top Failed, middle Needs you,
// bottom Running. The lamps are unlit white parts with instanceColor: the engine sets a status token colour when a lamp
// is lit and `lampOffColour` when it is not. Lamp position, not colour, is the redundant state cue. Origin at the
// foot of the pole (the station plate's top surface); about 1.4 m tall.
import type { BufferGeometry } from 'three'
import { cyl, merge } from './geo'
import { part } from './common'
import type { ObjectKit } from './types'

const SEG = 10
const LAMP_R = 0.18
const LAMP_H = 0.26
const POLE_H = 0.7
const BASE_H = 0.06
const LAMP_Y0 = POLE_H

export const STACK_LIGHT_HEIGHT = LAMP_Y0 + 3 * LAMP_H

export function stackLight(): ObjectKit {
  const housing: BufferGeometry[] = [
    cyl(0.2, 0.24, BASE_H, 8, 0, 0, 0, false),
    cyl(0.045, 0.045, POLE_H - BASE_H, 8, 0, BASE_H, 0, true)
  ]
  const lamp = (i: number): BufferGeometry => cyl(LAMP_R, LAMP_R, LAMP_H - 0.045, SEG, 0, LAMP_Y0 + i * LAMP_H, 0, false)
  return {
    name: 'stackLight',
    parts: [
      part('stack.pole', merge(housing), 'pole'),
      // Bottom lamp is Running, middle Needs you, top Failed.
      part('lamp.bottom', lamp(0), 'lamp', { cast: false, receive: false, instanceColor: true }),
      part('lamp.middle', lamp(1), 'lamp', { cast: false, receive: false, instanceColor: true }),
      part('lamp.top', lamp(2), 'lamp', { cast: false, receive: false, instanceColor: true })
    ],
    anchors: { top: { x: 0, y: STACK_LIGHT_HEIGHT, z: 0, rotY: 0 } }
  }
}
