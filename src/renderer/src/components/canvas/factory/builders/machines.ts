// Machine silhouettes (Factory Floor sections 1.2 and 4.6). Four abstract shapes, chosen by a hash of the role: a stepped
// tower (0), a jointed boom (1), a post with collars (2) and an open portal frame (3). They are decoration only: no
// tool, nozzle, gripper or screen that would suggest a job. Origin at the footprint centre on the station plate's top
// surface; footprint within 1.5 x 1.2 m (x, z), height at most 1.9 m; the front faces +z.
//
// Parts per variant: 'machine.N.body' and 'machine.N.panel' in near and mid, 'machine.N.far' in far (the bounding
// shape with its top profile: two or three boxes). Slice 4 (section 5.1 ambient stroke): the moving sub-part of each
// variant is split out of the merged body or panel and carries `stroke`, in near and mid only (the far block never
// moves). At wave 0 the stroke parts sit exactly where the slice 3 geometry had them, so a static machine is unchanged.
//   0 tower     'machine.0.head'      top cap of the press, translateY -0.3 (the head presses into the body)
//   1 boom      'machine.1.arm' and 'machine.1.arm.panel'  the boom, swung 40 degrees about the column at x -0.2
//   2 post      'machine.2.spindle'   the two collars with a key lug each, one turn about the post axis
//   3 frame     'machine.3.carriage'  the hanging head, 0.6 m along a beam across the portal (built at x -0.3)
// Stroke parts cast no shadow: the shadow map is refreshed only when the layout changes, so a moving caster would leave a
// frozen shadow at whatever phase the last refresh caught.
import type { BufferGeometry } from 'three'
import { box, chamfer, cyl, merge, strut, taper } from './geo'
import { part, FAR_ONLY, NEAR_MID } from './common'
import type { ObjectKit, PartSpec } from './types'

interface Moving {
  /** Key suffix after `machine.N.` */
  key: string
  geometry: BufferGeometry
  role: 'machine' | 'machinePanel'
  stroke: NonNullable<PartSpec['stroke']>
}

interface Pieces {
  body: BufferGeometry[]
  panel: BufferGeometry[]
  far: BufferGeometry[]
  moving: Moving[]
}

/** Arm swing of the boom: 40 degrees. */
const ARM_SWING = (40 * Math.PI) / 180

function tower(): Pieces {
  return {
    body: [
      chamfer(1.5, 0.5, 1.2, 0.14, 0, 0, 0),
      chamfer(1.2, 0.7, 1.0, 0.12, 0, 0.5, 0),
      taper(1.1, 0.9, 0.7, 0.6, 0.5, 0, 1.2, 0)
    ],
    panel: [
      // Front panel with three vents, a side duct and a hand-wheel stub on the lower block.
      box(0.9, 0.34, 0.04, 0, 0.62, 0.52),
      box(0.7, 0.05, 0.05, 0, 1.05, 0.5),
      box(0.7, 0.05, 0.05, 0, 0.98, 0.5),
      box(0.7, 0.05, 0.05, 0, 0.91, 0.5),
      box(0.12, 0.7, 0.12, 0.66, 0.5, -0.25)
    ],
    far: [box(1.5, 0.5, 1.2, 0, 0, 0), box(1.1, 1.0, 0.9, 0, 0.5, 0), box(0.8, 0.4, 0.6, 0, 1.5, 0)],
    // The press head: the top cap, in the lighter panel colour so its travel reads (it slides down into the tower).
    moving: [{ key: 'head', geometry: chamfer(0.8, 0.2, 0.6, 0.08, 0, 1.7, 0), role: 'machinePanel', stroke: { kind: 'translateY', amount: -0.3 } }]
  }
}

function boom(): Pieces {
  // The arm swings about the vertical column at (-0.2, z 0). rotateY by +40 degrees carries the tip (x +0.62) towards -z,
  // away from the belt and the worker.
  const pivot = { x: -0.2, y: 0, z: 0 }
  return {
    body: [
      chamfer(1.3, 0.3, 1.1, 0.2, 0, 0, 0),
      cyl(0.4, 0.45, 0.2, 8, -0.2, 0.3, 0),
      box(0.35, 0.8, 0.35, -0.2, 0.5, 0),
      box(0.45, 0.4, 0.4, -0.5, 0.3, -0.05)
    ],
    panel: [chamfer(0.5, 0.36, 0.5, 0.1, -0.2, 1.3, 0), box(0.22, 0.1, 0.04, -0.2, 0.9, 0.2), box(0.3, 0.12, 0.04, -0.5, 0.45, 0.17)],
    far: [box(1.3, 0.3, 1.1, 0, 0, 0), box(0.4, 1.2, 0.4, -0.2, 0.3, 0), box(1.0, 0.45, 0.3, 0.2, 1.35, 0), box(0.3, 0.9, 0.3, 0.62, 0.9, 0)],
    moving: [
      {
        key: 'arm',
        geometry: merge([strut([-0.2, 1.45, 0], [0.4, 1.62, 0], 0.22), strut([0.4, 1.62, 0], [0.62, 1.15, 0], 0.2), box(0.3, 0.25, 0.3, 0.62, 0.9, 0)]),
        role: 'machine',
        stroke: { kind: 'rotateY', amount: ARM_SWING, pivot }
      },
      { key: 'arm.panel', geometry: chamfer(0.34, 0.26, 0.34, 0.08, 0.4, 1.5, 0), role: 'machinePanel', stroke: { kind: 'rotateY', amount: ARM_SWING, pivot } }
    ]
  }
}

function post(): Pieces {
  return {
    body: [chamfer(1.4, 0.35, 1.1, 0.18, 0, 0, 0), cyl(0.3, 0.34, 1.3, 10, 0, 0.35, 0), cyl(0.42, 0.3, 0.22, 10, 0, 1.65, 0)],
    panel: [box(0.5, 0.2, 0.05, 0, 0.45, 0.35), box(0.3, 0.25, 0.3, 0.6, 0.35, -0.25)],
    far: [box(1.4, 0.35, 1.1, 0, 0, 0), box(0.7, 1.3, 0.7, 0, 0.35, 0), box(0.85, 0.22, 0.85, 0, 1.65, 0)],
    // Two collars, each with a key lug (a collar is round, so a turn is invisible without it): the lugs sit at 0 and 90
    // degrees, so the pair reads as turning at every phase. The turn is about the post axis (origin).
    moving: [
      {
        key: 'spindle',
        geometry: merge([cyl(0.52, 0.52, 0.08, 10, 0, 0.75, 0), cyl(0.52, 0.52, 0.08, 10, 0, 1.25, 0), box(0.2, 0.1, 0.12, 0.52, 0.74, 0), box(0.12, 0.1, 0.2, 0, 1.24, 0.5)]),
        role: 'machinePanel',
        stroke: { kind: 'rotateY', amount: 2 * Math.PI }
      }
    ]
  }
}

function frame(): Pieces {
  const px = 0.65
  const pz = 0.5
  const body: BufferGeometry[] = [chamfer(1.5, 0.2, 1.2, 0.1, 0, 0, 0)]
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.push(box(0.14, 1.7, 0.14, sx * px, 0.2, sz * pz))
  body.push(box(1.44, 0.14, 0.14, 0, 1.76, -pz), box(1.44, 0.14, 0.14, 0, 1.76, pz), box(0.14, 0.14, 1.14, -px, 1.76, 0), box(0.14, 0.14, 1.14, px, 1.76, 0))
  body.push(box(0.8, 0.5, 0.6, 0, 0.2, -0.05))
  // The beam the carriage rides on: across the portal at z 0, between the two side bars.
  body.push(box(2 * px - 0.14, 0.14, 0.14, 0, 1.76, 0))
  // The carriage hangs from the beam: built 0.3 m west of the centre, so its 0.6 m travel (translateX) ends 0.3 m east and
  // the head (0.5 m wide) stays between the portal posts (x +-0.58) the whole way.
  const cx = -0.3
  return {
    body,
    panel: [box(1.2, 0.08, 0.08, 0, 1.0, pz), box(0.5, 0.18, 0.04, 0, 0.35, 0.28)],
    far: [box(1.5, 0.2, 1.2, 0, 0, 0), box(0.8, 0.5, 0.6, 0, 0.2, 0), box(1.44, 0.2, 1.14, 0, 1.7, 0)],
    moving: [
      {
        key: 'carriage',
        geometry: merge([box(0.1, 0.7, 0.1, cx, 1.06, 0), chamfer(0.5, 0.3, 0.4, 0.08, cx, 0.76, 0)]),
        role: 'machinePanel',
        stroke: { kind: 'translateX', amount: 0.6 }
      }
    ]
  }
}

const BUILDERS: Record<0 | 1 | 2 | 3, () => Pieces> = { 0: tower, 1: boom, 2: post, 3: frame }

export function machine(variant: 0 | 1 | 2 | 3): ObjectKit {
  const pieces = BUILDERS[variant]()
  const k = `machine.${variant}`
  return {
    name: k,
    parts: [
      part(`${k}.body`, merge(pieces.body), 'machine', { lods: NEAR_MID }),
      part(`${k}.panel`, merge(pieces.panel), 'machinePanel', { lods: NEAR_MID }),
      ...pieces.moving.map((m) => part(`${k}.${m.key}`, m.geometry, m.role, { lods: NEAR_MID, cast: false, stroke: m.stroke })),
      part(`${k}.far`, merge(pieces.far), 'machine', { lods: FAR_ONLY })
    ],
    anchors: {
      // Where a worker stands to use the machine, in the machine's frame (a metre in front of its centre).
      work: { x: 0, y: 0, z: 1.1, rotY: Math.PI },
      top: { x: 0, y: 1.9, z: 0, rotY: 0 }
    }
  }
}
