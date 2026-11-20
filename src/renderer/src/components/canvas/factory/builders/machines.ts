// Machine silhouettes (Factory Floor sections 1.2 and 4.6). Four abstract shapes, chosen by a hash of the role: a stepped
// tower (0), a jointed boom (1), a post with collars (2) and an open portal frame (3). They are decoration only: no
// tool, nozzle, gripper or screen that would suggest a job. Origin at the footprint centre on the station plate's top
// surface; footprint within 1.5 x 1.2 m (x, z), height at most 1.9 m; the front faces +z.
//
// Parts per variant: 'machine.N.body' and 'machine.N.panel' in near and mid, 'machine.N.far' in far (the bounding
// shape with its top profile: two or three boxes).
import type { BufferGeometry } from 'three'
import { box, chamfer, cyl, merge, strut, taper } from './geo'
import { part, FAR_ONLY, NEAR_MID } from './common'
import type { ObjectKit } from './types'

interface Pieces {
  body: BufferGeometry[]
  panel: BufferGeometry[]
  far: BufferGeometry[]
}

function tower(): Pieces {
  return {
    body: [
      chamfer(1.5, 0.5, 1.2, 0.14, 0, 0, 0),
      chamfer(1.2, 0.7, 1.0, 0.12, 0, 0.5, 0),
      taper(1.1, 0.9, 0.7, 0.6, 0.5, 0, 1.2, 0),
      chamfer(0.8, 0.2, 0.6, 0.08, 0, 1.7, 0)
    ],
    panel: [
      // Front panel with three vents, a side duct and a hand-wheel stub on the lower block.
      box(0.9, 0.34, 0.04, 0, 0.62, 0.52),
      box(0.7, 0.05, 0.05, 0, 1.05, 0.5),
      box(0.7, 0.05, 0.05, 0, 0.98, 0.5),
      box(0.7, 0.05, 0.05, 0, 0.91, 0.5),
      box(0.12, 0.7, 0.12, 0.66, 0.5, -0.25)
    ],
    far: [box(1.5, 0.5, 1.2, 0, 0, 0), box(1.1, 1.0, 0.9, 0, 0.5, 0), box(0.8, 0.4, 0.6, 0, 1.5, 0)]
  }
}

function boom(): Pieces {
  return {
    body: [
      chamfer(1.3, 0.3, 1.1, 0.2, 0, 0, 0),
      cyl(0.4, 0.45, 0.2, 8, -0.2, 0.3, 0),
      box(0.35, 0.8, 0.35, -0.2, 0.5, 0),
      strut([-0.2, 1.45, 0], [0.4, 1.62, 0], 0.22),
      strut([0.4, 1.62, 0], [0.62, 1.15, 0], 0.2),
      box(0.3, 0.25, 0.3, 0.62, 0.9, 0),
      box(0.45, 0.4, 0.4, -0.5, 0.3, -0.05)
    ],
    panel: [
      chamfer(0.5, 0.36, 0.5, 0.1, -0.2, 1.3, 0),
      chamfer(0.34, 0.26, 0.34, 0.08, 0.4, 1.5, 0),
      box(0.22, 0.1, 0.04, -0.2, 0.9, 0.2),
      box(0.3, 0.12, 0.04, -0.5, 0.45, 0.17)
    ],
    far: [box(1.3, 0.3, 1.1, 0, 0, 0), box(0.4, 1.2, 0.4, -0.2, 0.3, 0), box(1.0, 0.45, 0.3, 0.2, 1.35, 0), box(0.3, 0.9, 0.3, 0.62, 0.9, 0)]
  }
}

function post(): Pieces {
  return {
    body: [
      chamfer(1.4, 0.35, 1.1, 0.18, 0, 0, 0),
      cyl(0.3, 0.34, 1.3, 10, 0, 0.35, 0),
      cyl(0.42, 0.3, 0.22, 10, 0, 1.65, 0)
    ],
    panel: [
      cyl(0.52, 0.52, 0.08, 10, 0, 0.75, 0),
      cyl(0.52, 0.52, 0.08, 10, 0, 1.25, 0),
      box(0.5, 0.2, 0.05, 0, 0.45, 0.35),
      box(0.3, 0.25, 0.3, 0.6, 0.35, -0.25)
    ],
    far: [box(1.4, 0.35, 1.1, 0, 0, 0), box(0.7, 1.3, 0.7, 0, 0.35, 0), box(0.85, 0.22, 0.85, 0, 1.65, 0)]
  }
}

function frame(): Pieces {
  const px = 0.65
  const pz = 0.5
  const body: BufferGeometry[] = [chamfer(1.5, 0.2, 1.2, 0.1, 0, 0, 0)]
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.push(box(0.14, 1.7, 0.14, sx * px, 0.2, sz * pz))
  body.push(box(1.44, 0.14, 0.14, 0, 1.76, -pz), box(1.44, 0.14, 0.14, 0, 1.76, pz), box(0.14, 0.14, 1.14, -px, 1.76, 0), box(0.14, 0.14, 1.14, px, 1.76, 0))
  body.push(box(0.8, 0.5, 0.6, 0, 0.2, -0.05))
  return {
    body,
    panel: [
      box(0.1, 0.7, 0.1, 0, 1.06, 0),
      chamfer(0.5, 0.3, 0.4, 0.08, 0, 0.76, 0),
      box(1.2, 0.08, 0.08, 0, 1.0, pz),
      box(0.5, 0.18, 0.04, 0, 0.35, 0.28)
    ],
    far: [box(1.5, 0.2, 1.2, 0, 0, 0), box(0.8, 0.5, 0.6, 0, 0.2, 0), box(1.44, 0.2, 1.14, 0, 1.7, 0)]
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
      part(`${k}.far`, merge(pieces.far), 'machine', { lods: FAR_ONLY })
    ],
    anchors: {
      // Where a worker stands to use the machine, in the machine's frame (a metre in front of its centre).
      work: { x: 0, y: 0, z: 1.1, rotY: Math.PI },
      top: { x: 0, y: 1.9, z: 0, rotY: 0 }
    }
  }
}
