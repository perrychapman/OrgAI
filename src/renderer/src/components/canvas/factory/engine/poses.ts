// Robot pose joint tables (docs/design/factory-floor.md sections 1.4 and 4.4, slice 3): the seven static end-state poses
// of a worker. Pure data plus matrix maths (three's math classes only, no scene objects). A pose says where the robot
// stands in its station's frame (a station kit anchor, or the 'robot' anchor plus an offset when the kit does not name
// that anchor), which way it faces, and how its joints bend about the robot kit's pivots ('pivot.head',
// 'pivot.shoulder.l/r', 'pivot.elbow.l/r' in builders/robot.ts). The engine draws each robot part with
// objectMatrix * bodyMatrix * partMatrix(part); the far capsule takes the body matrix and a small tilt only.
//
// Robot frame: +z is the front (the visor), +x the east (r) side, +y up, origin on the floor under the body.
import { Matrix4, Vector3 } from 'three'
import type { Pose } from '../../../../lib/factory/types'
import type { Anchor } from '../builders/types'

export const POSE_NAMES: readonly Pose[] = ['console', 'machine', 'dispatch', 'signal', 'rest', 'docked', 'down']

/** One arm: swing forward (towards +z) and outward (away from the body) at the shoulder, then bend at the elbow. */
export interface ArmPose {
  /** Radians the upper arm swings forward from hanging (positive raises it in front). */
  forward: number
  /** Radians the upper arm swings out sideways (positive lifts it away from the body, mirrored per side). */
  out: number
  /** Radians the lower arm bends forward and up at the elbow. */
  bend: number
}

export interface JointPose {
  /** Whole-body forward lean about the axle (everything but the wheels), radians; positive leans forward. */
  lean: number
  /** Head pitch about 'pivot.head', radians; positive nods forward and down. */
  head: number
  armL: ArmPose
  armR: ArmPose
  /** Forward tilt of the far LOD capsule about its base (cheap stand-in for lean and head). */
  farTilt: number
}

export interface PoseSpec {
  /** Station kit anchor the robot stands at. */
  anchor: string
  /** Facing: 'anchor' takes the anchor's rotY; a number is a fixed yaw (0 faces south, PI faces north). */
  yaw: 'anchor' | number
  /** When the kit does not name `anchor`: offset from the 'robot' anchor (station frame) and a yaw. */
  fallback: { dx: number; dz: number; yaw: number }
  joints: JointPose
}

const HANG: ArmPose = { forward: 0, out: 0, bend: 0 }
/** The axle height the lean pivots about (builders/robot.ts wheels: radius 0.16). */
const LEAN_PIVOT_Y = 0.16

/**
 * The seven poses. console and machine reach forward into their object; dispatch points at the desk with one arm;
 * signal faces the camera with the east arm raised high above the head; rest stands with arms at the sides; docked
 * lowers the head; down slumps forward with the head and both arms hanging.
 */
export const POSES: Readonly<Record<Pose, PoseSpec>> = {
  console: {
    anchor: 'robot',
    // The console is north of the 'robot' anchor; the anchor's rotY is the slice 2 rest facing (south).
    yaw: Math.PI,
    fallback: { dx: 0, dz: 0, yaw: Math.PI },
    joints: { lean: 0.06, head: 0.22, armL: { forward: 0.95, out: 0.05, bend: 0.35 }, armR: { forward: 0.95, out: 0.05, bend: 0.35 }, farTilt: 0 }
  },
  machine: {
    anchor: 'robot.machine',
    yaw: 'anchor',
    // In front of the machine's west flank, turned towards it (machine centre (0.1, -0.45) in the station frame).
    fallback: { dx: 0.5, dz: -0.15, yaw: 2.6 },
    joints: { lean: 0.1, head: 0.3, armL: { forward: 1.25, out: 0.1, bend: 0.15 }, armR: { forward: 1.0, out: 0.0, bend: 0.5 }, farTilt: 0 }
  },
  dispatch: {
    anchor: 'robot.dispatch',
    yaw: 'anchor',
    fallback: { dx: 0, dz: 0, yaw: Math.PI },
    joints: { lean: 0, head: 0.05, armL: { forward: 0.35, out: 0.05, bend: 0.4 }, armR: { forward: 1.45, out: 0.1, bend: -0.15 }, farTilt: 0 }
  },
  signal: {
    anchor: 'robot',
    yaw: 0,
    fallback: { dx: 0, dz: 0, yaw: 0 },
    // The east arm swings up and out past the shoulder with the elbow straightened (the rest arm bends forward at the
    // elbow, which would waste its reach), leaning a little north: the 55 degree camera then sees it about 35 percent
    // longer than a vertical arm (measured: hand 0.57 m east, 1.56 m up, 0.17 m north of the body centre).
    joints: { lean: 0, head: -0.12, armL: HANG, armR: { forward: -0.4, out: 2.65, bend: -0.7 }, farTilt: 0 }
  },
  rest: {
    anchor: 'robot.rest',
    yaw: 'anchor',
    fallback: { dx: 0, dz: 0, yaw: 0 },
    joints: { lean: 0, head: 0, armL: HANG, armR: HANG, farTilt: 0 }
  },
  docked: {
    anchor: 'robot.dock',
    yaw: 'anchor',
    fallback: { dx: 0, dz: -0.2, yaw: 0 },
    joints: { lean: 0.05, head: 0.6, armL: { forward: 0.1, out: -0.04, bend: 0.1 }, armR: { forward: 0.1, out: -0.04, bend: 0.1 }, farTilt: 0.12 }
  },
  down: {
    anchor: 'robot',
    yaw: 0,
    fallback: { dx: 0, dz: 0, yaw: 0 },
    // Arms swing back a little against the lean so they hang straight down, limp and slightly out.
    joints: { lean: 0.32, head: 0.65, armL: { forward: -0.25, out: 0.18, bend: -0.25 }, armR: { forward: -0.25, out: 0.18, bend: -0.25 }, farTilt: 0.28 }
  }
}

/** Where a posed robot stands in its station's frame: position on the floor or plate and facing. */
export interface PoseBody {
  x: number
  y: number
  z: number
  yaw: number
}

/** The body placement of `pose` against a station (or booth) kit's anchors; fallback to the 'robot' anchor, then the origin. */
export function poseBody(pose: Pose, anchors: Readonly<Record<string, Anchor>> | undefined): PoseBody {
  const spec = POSES[pose]
  const own = anchors?.[spec.anchor]
  if (own) return { x: own.x, y: own.y, z: own.z, yaw: spec.yaw === 'anchor' ? own.rotY : spec.yaw }
  const base = anchors?.robot
  return {
    x: (base?.x ?? 0) + spec.fallback.dx,
    y: base?.y ?? 0,
    z: (base?.z ?? 0) + spec.fallback.dz,
    yaw: spec.fallback.yaw
  }
}

/** Body matrix in the station frame (translate, then yaw). */
export function bodyMatrix(body: PoseBody): Matrix4 {
  const m = new Matrix4().makeRotationY(body.yaw)
  m.setPosition(body.x, body.y, body.z)
  return m
}

/** Robot part keys whose matrices follow a joint (other parts follow the lean, wheels nothing). */
const WHEEL_KEY = 'robot.wheels'
const FAR_PREFIX = 'robot.far.'

function pivot(anchors: Readonly<Record<string, Anchor>> | undefined, name: string, fallback: [number, number, number]): Vector3 {
  const a = anchors?.[name]
  return a ? new Vector3(a.x, a.y, a.z) : new Vector3(...fallback)
}

/** T(p) * R * T(-p): a rotation about the point p. */
function about(p: Vector3, r: Matrix4): Matrix4 {
  return new Matrix4().makeTranslation(p.x, p.y, p.z).multiply(r).multiply(new Matrix4().makeTranslation(-p.x, -p.y, -p.z))
}

function rotX(a: number): Matrix4 {
  return new Matrix4().makeRotationX(a)
}

/** Shoulder rotation: swing forward (about -x), then out (about z, mirrored per side). */
function shoulderRotation(arm: ArmPose, side: -1 | 1): Matrix4 {
  return new Matrix4().makeRotationZ(side * arm.out).multiply(rotX(-arm.forward))
}

/**
 * Per-part local matrices (robot frame, before the body matrix) for `pose`, keyed by robot part key. Head and visor
 * nod about 'pivot.head'; each upper arm turns about its shoulder and each lower arm about its elbow, chained to the
 * upper arm; everything but the wheels leans about the axle; far parts tilt about their base.
 */
export function posePartMatrices(pose: Pose, pivots: Readonly<Record<string, Anchor>> | undefined, partKeys: readonly string[]): Record<string, Matrix4> {
  const j = POSES[pose].joints
  const lean = about(new Vector3(0, LEAN_PIVOT_Y, 0), rotX(j.lean))
  const head = lean.clone().multiply(about(pivot(pivots, 'pivot.head', [0, 0.98, 0]), rotX(j.head)))
  const arm = (side: -1 | 1, a: ArmPose): { upper: Matrix4; lower: Matrix4 } => {
    const s = side < 0 ? 'l' : 'r'
    const shoulder = pivot(pivots, `pivot.shoulder.${s}`, [side * 0.4, 0.88, 0])
    const elbow = pivot(pivots, `pivot.elbow.${s}`, [side * 0.47, 0.62, 0.1])
    const upper = lean.clone().multiply(about(shoulder, shoulderRotation(a, side)))
    const lower = upper.clone().multiply(about(elbow, rotX(-a.bend)))
    return { upper, lower }
  }
  const l = arm(-1, j.armL)
  const r = arm(1, j.armR)
  const far = rotX(j.farTilt)
  const out: Record<string, Matrix4> = {}
  for (const key of partKeys) {
    if (key === WHEEL_KEY) out[key] = new Matrix4()
    else if (key.startsWith(FAR_PREFIX)) out[key] = far.clone()
    else if (key === 'robot.head' || key === 'robot.visor') out[key] = head.clone()
    else if (key === 'robot.arm.l.upper') out[key] = l.upper.clone()
    else if (key === 'robot.arm.l.lower') out[key] = l.lower.clone()
    else if (key === 'robot.arm.r.upper') out[key] = r.upper.clone()
    else if (key === 'robot.arm.r.lower') out[key] = r.lower.clone()
    else out[key] = lean.clone()
  }
  return out
}

/** Per-pose part matrices for one robot kit, computed once per engine. */
export class PoseLibrary {
  private readonly cache = new Map<Pose, Record<string, Matrix4>>()
  private readonly pivots: Readonly<Record<string, Anchor>> | undefined
  private readonly partKeys: readonly string[]

  constructor(pivots: Readonly<Record<string, Anchor>> | undefined, partKeys: readonly string[]) {
    this.pivots = pivots
    this.partKeys = partKeys
  }

  parts(pose: Pose): Readonly<Record<string, Matrix4>> {
    let m = this.cache.get(pose)
    if (!m) this.cache.set(pose, (m = posePartMatrices(pose, this.pivots, this.partKeys)))
    return m
  }
}
