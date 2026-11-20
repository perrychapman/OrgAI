// Robot worker (Factory Floor sections 4.1, 4.5, 4.6): a compact wheeled robot, no legs, 1.4 m tall, with a head block, a
// dark visor and two two-segment arms. Rest pose, facing +z (south, towards the camera), origin on the floor under the
// body centre. Geometry is baked in the robot's frame; the joint pivots (for the poses of slice 3) are listed as
// anchors, 'l' being the west (-x) side and 'r' the east (+x) side: 'pivot.head', 'pivot.shoulder.l/r' and
// 'pivot.elbow.l/r'. A pose rotates a part about its pivot (head, upper arm about the shoulder, lower arm about the elbow).
//
// Near and mid draw nine parts (about 600 triangles); far draws a capsule with a visor (about 85 triangles, two parts).
// Robots do not cast shadows: moving things use the blob shadow (props 'blob').
import { SphereGeometry, type BufferGeometry } from 'three'
import { ball, box, chamfer, cyl, cylX, merge, place, strut } from './geo'
import { FAR_ONLY, NEAR_MID, part } from './common'
import type { ObjectKit } from './types'

export const ROBOT_HEIGHT = 1.4

const SHOULDER_X = 0.4
const SHOULDER_Y = 0.88
const HEAD_PIVOT_Y = 0.98

/** One arm; side -1 is the west (l) arm, +1 the east (r) arm. */
function arm(side: -1 | 1): { upper: BufferGeometry; lower: BufferGeometry } {
  const sx = side * SHOULDER_X
  const ex = side * 0.47
  const hx = side * 0.5
  const upper = merge([
    ball(0.1, 6, 4, sx, SHOULDER_Y, 0),
    strut([sx, SHOULDER_Y, 0], [ex, 0.62, 0.1], 0.11),
    ball(0.085, 6, 4, ex, 0.62, 0.1)
  ])
  const lower = merge([strut([ex, 0.62, 0.1], [hx, 0.4, 0.3], 0.09), box(0.13, 0.1, 0.13, hx, 0.3, 0.32)])
  return { upper, lower }
}

export function robot(): ObjectKit {
  const wheels = merge([cylX(0.16, 0.1, 12, -0.36, 0.16, 0), cylX(0.16, 0.1, 12, 0.36, 0.16, 0)])
  const chassis = merge([chamfer(0.76, 0.26, 0.66, 0.12, 0, 0.1, 0), cyl(0.1, 0.12, 0.1, 8, 0, 0.94, 0)])
  const torso = merge([
    chamfer(0.6, 0.62, 0.46, 0.12, 0, 0.36, 0),
    chamfer(0.2, 0.2, 0.3, 0.05, -0.38, 0.78, 0),
    chamfer(0.2, 0.2, 0.3, 0.05, 0.38, 0.78, 0),
    box(0.36, 0.4, 0.14, 0, 0.46, -0.3)
  ])
  const head = merge([
    chamfer(0.5, 0.3, 0.4, 0.1, 0, 1.06, 0),
    box(0.06, 0.12, 0.18, -0.28, 1.12, 0),
    box(0.06, 0.12, 0.18, 0.28, 1.12, 0),
    cyl(0.02, 0.02, 0.06, 6, 0.15, 1.36, -0.05)
  ])
  const visor = box(0.38, 0.12, 0.06, 0, 1.13, 0.21)
  const left = arm(-1)
  const right = arm(1)

  const farBody = merge([
    cyl(0.3, 0.3, 0.9, 8, 0, 0.15, 0),
    place(new SphereGeometry(0.3, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.05, 0)
  ])
  const farVisor = box(0.4, 0.16, 0.06, 0, 1.0, 0.27)

  const near = { lods: NEAR_MID, cast: false }
  return {
    name: 'robot',
    parts: [
      part('robot.chassis', chassis, 'robot.base', near),
      part('robot.wheels', wheels, 'robot.wheel', near),
      part('robot.torso', torso, 'robot.body', near),
      part('robot.head', head, 'robot.body', near),
      part('robot.visor', visor, 'robot.visor', near),
      part('robot.arm.l.upper', left.upper, 'robot.joint', near),
      part('robot.arm.l.lower', left.lower, 'robot.joint', near),
      part('robot.arm.r.upper', right.upper, 'robot.joint', near),
      part('robot.arm.r.lower', right.lower, 'robot.joint', near),
      part('robot.far.body', farBody, 'robot.body', { lods: FAR_ONLY, cast: false }),
      part('robot.far.visor', farVisor, 'robot.visor', { lods: FAR_ONLY, cast: false })
    ],
    anchors: {
      'pivot.head': { x: 0, y: HEAD_PIVOT_Y, z: 0, rotY: 0 },
      'pivot.shoulder.l': { x: -SHOULDER_X, y: SHOULDER_Y, z: 0, rotY: 0 },
      'pivot.shoulder.r': { x: SHOULDER_X, y: SHOULDER_Y, z: 0, rotY: 0 },
      'pivot.elbow.l': { x: -0.47, y: 0.62, z: 0.1, rotY: 0 },
      'pivot.elbow.r': { x: 0.47, y: 0.62, z: 0.1, rotY: 0 }
    }
  }
}
