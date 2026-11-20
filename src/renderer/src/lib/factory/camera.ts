// Factory Floor camera maths (docs/design/factory-floor.md section 2). Pure, with its own small vector types so its
// tests need no three. The engine copies the view into a three PerspectiveCamera with the same formulas
// (cameraPose); a test checks `project` against three's Vector3.project.
//
// Two projections share one view ({ ppm, targetX, targetZ }):
// - 'perspective': the 3D view. Vertical FOV 28 degrees, pitch 55 degrees below horizontal, yaw 0 (looking north).
//   ppm is pixels per metre at the ground point under the stage centre (the target).
// - 'plan': the floor plan fallback, a straight top-down orthographic view; ppm is pixels per metre everywhere.

export interface Vec3 {
  x: number
  y: number
  z: number
}
export interface CameraView {
  ppm: number
  targetX: number
  targetZ: number
}
export type Projection = 'perspective' | 'plan'
export interface Stage {
  width: number
  height: number
  projection: Projection
}
export interface Box3 {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}
export interface ScreenPoint {
  x: number
  y: number
}
export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Projected extends ScreenPoint {
  /** Distance in front of the camera along its view axis (perspective); 1 in the plan. Not positive: behind. */
  depth: number
}
export interface FloorBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export const FOV_DEG = 28
export const PITCH_DEG = 55
const TAN_HALF_FOV = Math.tan((FOV_DEG / 2) * (Math.PI / 180))
const PITCH = PITCH_DEG * (Math.PI / 180)
const SIN_P = Math.sin(PITCH)
const COS_P = Math.cos(PITCH)

export interface CameraLimits {
  /** Zoom range. */
  min: number
  max: number
  /** Fit range: fit never goes above fitMax (a one-agent floor) nor below fitMin (then it shows the top and the user pans). */
  fitMin: number
  fitMax: number
}
/** Section 2: 7 to 60 px per metre, fit clamped to 7..32. */
export const PERSPECTIVE_LIMITS: CameraLimits = { min: 7, max: 60, fitMin: 7, fitMax: 32 }
/**
 * Floor plan: tiles carry text, so fit never goes below 22 px per metre (a 66 px tile) and zoom stops at 12 (36 px
 * tiles, icon and short name). Deviation from section 2, which only defines the 3D range.
 */
export const PLAN_LIMITS: CameraLimits = { min: 12, max: 60, fitMin: 22, fitMax: 40 }
export function limitsFor(projection: Projection): CameraLimits {
  return projection === 'plan' ? PLAN_LIMITS : PERSPECTIVE_LIMITS
}

/** Section 2 constants. */
export const FIT_PADDING = 0.08
export const ZOOM_STEP = 1.25
export const WHEEL_STEP = 1.1
export const WHEEL_UNIT = 100
export const KEY_PAN_M = 4
export const CLAMP_MARGIN_M = 8
export const FOCUS_EDGE_PX = 48
export const FOCUS_INSET_PX = 96
/** A press that moves further than this becomes a pan. */
export const DRAG_THRESHOLD_PX = 4

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Camera distance from the target that gives `ppm` at the target on a stage `stageHeightPx` tall. */
export function distanceForPpm(ppm: number, stageHeightPx: number): number {
  return stageHeightPx / (2 * ppm * TAN_HALF_FOV)
}
export function ppmForDistance(distance: number, stageHeightPx: number): number {
  return stageHeightPx / (2 * distance * TAN_HALF_FOV)
}

/** The perspective camera's position and look-at point for a view (the engine copies these into three). */
export function cameraPose(view: CameraView, stage: Stage): { position: Vec3; target: Vec3; distance: number } {
  const d = distanceForPpm(view.ppm, Math.max(1, stage.height))
  return {
    position: { x: view.targetX, y: d * SIN_P, z: view.targetZ + d * COS_P },
    target: { x: view.targetX, y: 0, z: view.targetZ },
    distance: d
  }
}

/** Screen position (CSS px from the stage's top left) of a world point. */
export function project(view: CameraView, stage: Stage, p: Vec3): Projected {
  const W = Math.max(1, stage.width)
  const H = Math.max(1, stage.height)
  if (stage.projection === 'plan') {
    return { x: W / 2 + (p.x - view.targetX) * view.ppm, y: H / 2 + (p.z - view.targetZ) * view.ppm, depth: 1 }
  }
  const { position } = cameraPose(view, stage)
  const vx = p.x - position.x
  const vy = p.y - position.y
  const vz = p.z - position.z
  // Camera basis for yaw 0 and pitch p: right (1, 0, 0), up (0, cos p, -sin p), back (0, sin p, cos p).
  const yc = vy * COS_P - vz * SIN_P
  const depth = -(vy * SIN_P + vz * COS_P)
  const aspect = W / H
  const ndcX = vx / (depth * TAN_HALF_FOV * aspect)
  const ndcY = yc / (depth * TAN_HALF_FOV)
  return { x: ((ndcX + 1) / 2) * W, y: ((1 - ndcY) / 2) * H, depth }
}

/** The world point at height `y` under a screen point, or null when the ray does not reach that plane. */
export function unproject(view: CameraView, stage: Stage, s: ScreenPoint, y = 0): Vec3 | null {
  const W = Math.max(1, stage.width)
  const H = Math.max(1, stage.height)
  if (stage.projection === 'plan') {
    return { x: view.targetX + (s.x - W / 2) / view.ppm, y, z: view.targetZ + (s.y - H / 2) / view.ppm }
  }
  const { position } = cameraPose(view, stage)
  const ndcX = (s.x / W) * 2 - 1
  const ndcY = 1 - (s.y / H) * 2
  const cx = ndcX * TAN_HALF_FOV * (W / H)
  const cy = ndcY * TAN_HALF_FOV
  // dir = cx * right + cy * up - back
  const dir = { x: cx, y: cy * COS_P - SIN_P, z: -cy * SIN_P - COS_P }
  if (Math.abs(dir.y) < 1e-9) return null
  const t = (y - position.y) / dir.y
  if (t <= 0) return null
  return { x: position.x + dir.x * t, y, z: position.z + dir.z * t }
}

export function boxCorners(b: Box3): Vec3[] {
  const out: Vec3[] = []
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ, b.maxZ]) out.push({ x, y, z })
  return out
}

/** Screen bounding rectangle of world points (all assumed in front of the camera). */
export function projectPoints(view: CameraView, stage: Stage, points: readonly Vec3[]): ScreenRect {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const p of points) {
    const s = project(view, stage, p)
    left = Math.min(left, s.x)
    right = Math.max(right, s.x)
    top = Math.min(top, s.y)
    bottom = Math.max(bottom, s.y)
  }
  return { left, top, right, bottom }
}

/** Screen bounding rectangle of a box (a station's footprint with its height, the booth). */
export function projectFootprint(view: CameraView, stage: Stage, box: Box3): ScreenRect {
  return projectPoints(view, stage, boxCorners(box))
}

/**
 * Moves the target so the world point now under `from` appears under `to` (a camera translation; the ground point under
 * every screen point moves by the same amount). Exact on the ground plane.
 */
function shiftScreen(view: CameraView, stage: Stage, from: ScreenPoint, to: ScreenPoint): CameraView {
  const a = unproject(view, stage, from)
  const b = unproject(view, stage, to)
  if (!a || !b) return view
  return { ppm: view.ppm, targetX: view.targetX + (a.x - b.x), targetZ: view.targetZ + (a.z - b.z) }
}

/** The view at `ppm` that centres the screen rectangle of `points` on the stage (fixed-point iteration). */
function centred(points: readonly Vec3[], stage: Stage, ppm: number, start: CameraView): { view: CameraView; rect: ScreenRect } {
  let view: CameraView = { ppm, targetX: start.targetX, targetZ: start.targetZ }
  let rect = projectPoints(view, stage, points)
  for (let i = 0; i < 40; i++) {
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    if (Math.abs(cx - stage.width / 2) < 0.01 && Math.abs(cy - stage.height / 2) < 0.01) break
    view = shiftScreen(view, stage, { x: cx, y: cy }, { x: stage.width / 2, y: stage.height / 2 })
    rect = projectPoints(view, stage, points)
  }
  return { view, rect }
}

/**
 * Fit (section 2): the largest ppm within the fit range at which the projected boxes (heights included: booth top,
 * stack lights, gantry) fit inside the stage less `padding` on every side, centred. When even fitMin does not fit,
 * fitMin with the content's top edge at the top padding and centred across (the gantry and the top rows show).
 */
export function fitView(boxes: readonly Box3[], stage: Stage, padding = FIT_PADDING): CameraView {
  const limits = limitsFor(stage.projection)
  const points = boxes.flatMap(boxCorners)
  if (points.length === 0 || stage.width < 2 || stage.height < 2) return { ppm: limits.fitMax, targetX: 15, targetZ: -4 }
  const xs = points.map((p) => p.x)
  const zs = points.map((p) => p.z)
  const start: CameraView = { ppm: limits.fitMin, targetX: (Math.min(...xs) + Math.max(...xs)) / 2, targetZ: (Math.min(...zs) + Math.max(...zs)) / 2 }
  const usableW = stage.width * (1 - 2 * padding)
  const usableH = stage.height * (1 - 2 * padding)
  const fits = (r: ScreenRect): boolean => r.right - r.left <= usableW + 0.01 && r.bottom - r.top <= usableH + 0.01

  const atMax = centred(points, stage, limits.fitMax, start)
  if (fits(atMax.rect)) return atMax.view
  let lo = centred(points, stage, limits.fitMin, start)
  if (!fits(lo.rect)) {
    // Top-aligned at fitMin: shift until the content's top sits at the padding. Across, the target sits on the content's
    // middle x (the projected rectangle is skewed by rows far below the stage, so it is not used to centre).
    const midX = start.targetX
    let view: CameraView = { ...lo.view, targetX: midX }
    let rect = projectPoints(view, stage, points)
    for (let i = 0; i < 40; i++) {
      const dy = stage.height * padding - rect.top
      if (Math.abs(dy) < 0.01) break
      const from = { x: stage.width / 2, y: stage.height / 2 }
      view = { ...shiftScreen(view, stage, from, { x: from.x, y: from.y + dy }), targetX: midX }
      rect = projectPoints(view, stage, points)
    }
    return view
  }
  let loPpm = limits.fitMin
  let hiPpm = limits.fitMax
  for (let i = 0; i < 40 && hiPpm - loPpm > 0.005; i++) {
    const mid = (loPpm + hiPpm) / 2
    const c = centred(points, stage, mid, lo.view)
    if (fits(c.rect)) {
      loPpm = mid
      lo = c
    } else hiPpm = mid
  }
  return lo.view
}

/** Section 2: the target stays within the floor bounds plus 8 m. */
export function clampTarget(view: CameraView, bounds: FloorBounds, margin = CLAMP_MARGIN_M): CameraView {
  return {
    ppm: view.ppm,
    targetX: clamp(view.targetX, bounds.minX - margin, bounds.maxX + margin),
    targetZ: clamp(view.targetZ, bounds.minZ - margin, bounds.maxZ + margin)
  }
}

export function clampPpm(ppm: number, projection: Projection): number {
  const l = limitsFor(projection)
  return clamp(ppm, l.min, l.max)
}

/** Zoom by `factor` keeping the ground point under `at` fixed (wheel about the cursor; buttons about the centre). */
export function zoomAbout(view: CameraView, factor: number, at: ScreenPoint, stage: Stage): CameraView {
  const ppm = clampPpm(view.ppm * factor, stage.projection)
  if (ppm === view.ppm) return view
  const before = unproject(view, stage, at)
  const next: CameraView = { ppm, targetX: view.targetX, targetZ: view.targetZ }
  const after = unproject(next, stage, at)
  if (!before || !after) return next
  return { ppm, targetX: view.targetX + (before.x - after.x), targetZ: view.targetZ + (before.z - after.z) }
}

/** Wheel zoom factor: 1.1 per 100 units of deltaY (negative deltaY zooms in). */
export function wheelFactor(deltaY: number): number {
  return Math.pow(WHEEL_STEP, -deltaY / WHEEL_UNIT)
}

/**
 * Pan so the ground under `from` (default the stage centre) moves by (dx, dy) px. A drag passes the pointer's previous
 * position so the floor under the pointer follows it exactly (perspective moves other depths slightly differently).
 */
export function panByScreen(view: CameraView, stage: Stage, dx: number, dy: number, from?: ScreenPoint): CameraView {
  const c = from ?? { x: stage.width / 2, y: stage.height / 2 }
  return shiftScreen(view, stage, c, { x: c.x + dx, y: c.y + dy })
}

/** Pan the target by world metres (Shift+Arrow). */
export function panByMetres(view: CameraView, dx: number, dz: number): CameraView {
  return { ppm: view.ppm, targetX: view.targetX + dx, targetZ: view.targetZ + dz }
}

/**
 * Focus into view (section 2): when the footprint's screen rectangle is off-stage or within 48 px of an edge, the view
 * that pans (never zooms) it to 96 px inside; null when no pan is needed. A footprint wider or taller than the room
 * keeps its left or top edge in.
 */
export function panIntoView(view: CameraView, footprint: Box3, stage: Stage, edge = FOCUS_EDGE_PX, inset = FOCUS_INSET_PX): CameraView | null {
  const W = stage.width
  const H = stage.height
  type Side = 'low' | 'high' | null
  const side = (lo: number, hi: number, size: number): Side => (lo < edge ? 'low' : hi > size - edge ? 'high' : null)
  const delta = (s: Side, lo: number, hi: number, size: number): number => {
    const ins = Math.min(inset, Math.max(0, (size - (hi - lo)) / 2))
    if (s === 'low') return ins - lo
    if (s === 'high') return Math.max(ins - lo, size - ins - hi)
    return 0
  }
  const first = projectFootprint(view, stage, footprint)
  const sx = side(first.left, first.right, W)
  const sy = side(first.top, first.bottom, H)
  if (!sx && !sy) return null
  // Perspective: the ground under the footprint's screen centre is not its centre, so converge in a few steps.
  let next = view
  let rect = first
  for (let i = 0; i < 8; i++) {
    const dx = delta(sx, rect.left, rect.right, W)
    const dy = delta(sy, rect.top, rect.bottom, H)
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) break
    const centre = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
    const exact = panByScreen(next, stage, dx, dy, centre)
    next = exact !== next ? exact : panByScreen(next, stage, dx, dy)
    rect = projectFootprint(next, stage, footprint)
  }
  return next
}

export type LodBand = 'near' | 'mid' | 'far'
/** Section 4.5: near at 24 and above, mid 12 to 24, far below 12. */
export function lodBand(ppm: number): LodBand {
  if (ppm >= 24) return 'near'
  if (ppm >= 12) return 'mid'
  return 'far'
}

/** Linear interpolation of two views (tweens); ppm interpolates in log space so zooming feels even. */
export function lerpView(a: CameraView, b: CameraView, t: number): CameraView {
  const s = clamp(t, 0, 1)
  return {
    ppm: Math.exp(Math.log(a.ppm) + (Math.log(b.ppm) - Math.log(a.ppm)) * s),
    targetX: a.targetX + (b.targetX - a.targetX) * s,
    targetZ: a.targetZ + (b.targetZ - a.targetZ) * s
  }
}

/** Ease-out cubic (camera tweens). */
export function easeOut(t: number): number {
  const s = clamp(t, 0, 1)
  return 1 - Math.pow(1 - s, 3)
}

export function sameView(a: CameraView, b: CameraView): boolean {
  return Math.abs(a.ppm - b.ppm) < 1e-6 && Math.abs(a.targetX - b.targetX) < 1e-6 && Math.abs(a.targetZ - b.targetZ) < 1e-6
}
