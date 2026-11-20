import { describe, expect, it } from 'vitest'
// Section 2: the agreement test may import three's math (camera.ts itself never does).
import { PerspectiveCamera, Vector3 } from 'three'
import {
  FOV_DEG,
  PERSPECTIVE_LIMITS,
  PLAN_LIMITS,
  cameraPose,
  clampTarget,
  distanceForPpm,
  easeOut,
  fitView,
  lerpView,
  lodBand,
  panByScreen,
  panIntoView,
  ppmForDistance,
  project,
  projectFootprint,
  unproject,
  wheelFactor,
  zoomAbout,
  type Box3,
  type CameraView,
  type Stage
} from './camera'

const STAGE: Stage = { width: 1200, height: 700, projection: 'perspective' }
const PLAN: Stage = { width: 1200, height: 700, projection: 'plan' }

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function threeProject(view: CameraView, stage: Stage, p: { x: number; y: number; z: number }): { x: number; y: number } {
  const cam = new PerspectiveCamera(FOV_DEG, stage.width / stage.height, 0.5, 2000)
  const pose = cameraPose(view, stage)
  cam.position.set(pose.position.x, pose.position.y, pose.position.z)
  cam.lookAt(pose.target.x, pose.target.y, pose.target.z)
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  const v = new Vector3(p.x, p.y, p.z).project(cam)
  return { x: ((v.x + 1) / 2) * stage.width, y: ((1 - v.y) / 2) * stage.height }
}

describe('camera: perspective projection', () => {
  it('agrees with three Vector3.project within 0.5 px for 50 points', () => {
    const rnd = mulberry32(42)
    const views: CameraView[] = [
      { ppm: 20, targetX: 15, targetZ: -4 },
      { ppm: 7, targetX: 19, targetZ: 18 },
      { ppm: 60, targetX: 6, targetZ: 1.5 }
    ]
    let checked = 0
    for (let i = 0; i < 50; i++) {
      const view = views[i % views.length]
      const stage: Stage = i % 2 ? STAGE : { width: 1024, height: 240, projection: 'perspective' }
      // Points around the target, inside the view, heights 0 to 4 m.
      const span = stage.width / view.ppm / 2.5
      const p = { x: view.targetX + (rnd() - 0.5) * span, y: rnd() * 4, z: view.targetZ + (rnd() - 0.5) * span * 0.6 }
      const ours = project(view, stage, p)
      const theirs = threeProject(view, stage, p)
      expect(ours.depth).toBeGreaterThan(0)
      expect(Math.abs(ours.x - theirs.x)).toBeLessThan(0.5)
      expect(Math.abs(ours.y - theirs.y)).toBeLessThan(0.5)
      checked++
    }
    expect(checked).toBe(50)
  })

  it('ppm is pixels per metre east-west at the target', () => {
    const view = { ppm: 20, targetX: 10, targetZ: 3 }
    const a = project(view, STAGE, { x: 10, y: 0, z: 3 })
    const b = project(view, STAGE, { x: 11, y: 0, z: 3 })
    expect(a.x).toBeCloseTo(600, 6)
    expect(a.y).toBeCloseTo(350, 6)
    expect(b.x - a.x).toBeCloseTo(20, 6)
    expect(ppmForDistance(distanceForPpm(20, 700), 700)).toBeCloseTo(20, 9)
  })

  it('north is up and height is up on screen', () => {
    const view = { ppm: 20, targetX: 10, targetZ: 3 }
    const c = project(view, STAGE, { x: 10, y: 0, z: 3 })
    expect(project(view, STAGE, { x: 10, y: 0, z: 2 }).y).toBeLessThan(c.y)
    expect(project(view, STAGE, { x: 10, y: 1, z: 3 }).y).toBeLessThan(c.y)
  })

  it('unproject inverts project on the ground and at a height', () => {
    const view = { ppm: 13, targetX: 4, targetZ: 9 }
    for (const p of [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 30 }, { x: 7, y: 1.5, z: -6 }]) {
      const s = project(view, STAGE, p)
      const back = unproject(view, STAGE, s, p.y)!
      expect(back.x).toBeCloseTo(p.x, 6)
      expect(back.z).toBeCloseTo(p.z, 6)
    }
  })
})

describe('camera: plan projection', () => {
  it('is a straight top-down scale about the target', () => {
    const view = { ppm: 30, targetX: 10, targetZ: 0 }
    expect(project(view, PLAN, { x: 10, y: 5, z: 0 })).toEqual({ x: 600, y: 350, depth: 1 })
    expect(project(view, PLAN, { x: 12, y: 0, z: 1 })).toEqual({ x: 660, y: 380, depth: 1 })
    expect(unproject(view, PLAN, { x: 660, y: 380 })).toEqual({ x: 12, y: 0, z: 1 })
  })
})

const box = (minX: number, maxX: number, minZ: number, maxZ: number, minY = 0, maxY = 0): Box3 => ({ minX, maxX, minY, maxY, minZ, maxZ })

describe('camera: fit', () => {
  // The booth (on the deck, 2.6 m tall), dock and board, and one row of stations.
  const content = [box(4, 10, -8, -4, 1.5, 4.1), box(14, 20, -8, -4, 1.5, 2.7), box(22, 28, -10, -9, 1.5, 5), box(4.5, 35.5, 0, 3, 0, 2.6)]

  for (const stage of [
    { width: 1024, height: 240, projection: 'perspective' },
    { width: 1270, height: 660, projection: 'perspective' },
    { width: 1024, height: 400, projection: 'plan' },
    { width: 1270, height: 760, projection: 'plan' }
  ] as Stage[]) {
    it(`frames every corner inside the 8 percent padding at ${stage.width}x${stage.height} ${stage.projection}`, () => {
      const view = fitView(content, stage)
      const limits = stage.projection === 'plan' ? PLAN_LIMITS : PERSPECTIVE_LIMITS
      expect(view.ppm).toBeGreaterThanOrEqual(limits.fitMin)
      expect(view.ppm).toBeLessThanOrEqual(limits.fitMax)
      const rects = content.map((b) => projectFootprint(view, stage, b))
      const left = Math.min(...rects.map((r) => r.left))
      const right = Math.max(...rects.map((r) => r.right))
      const top = Math.min(...rects.map((r) => r.top))
      const bottom = Math.max(...rects.map((r) => r.bottom))
      if (view.ppm > limits.fitMin + 0.01) {
        const padX = stage.width * 0.08
        const padY = stage.height * 0.08
        expect(left).toBeGreaterThanOrEqual(padX - 1)
        expect(right).toBeLessThanOrEqual(stage.width - padX + 1)
        expect(top).toBeGreaterThanOrEqual(padY - 1)
        expect(bottom).toBeLessThanOrEqual(stage.height - padY + 1)
        // Tight on at least one axis.
        expect(Math.min(left - padX, stage.width - padX - right, top - padY, stage.height - padY - bottom)).toBeLessThan(2)
      } else {
        // Too big at fitMin: top-aligned, centred across.
        expect(top).toBeCloseTo(stage.height * 0.08, 0)
        expect((left + right) / 2).toBeCloseTo(stage.width / 2, 0)
      }
    })
  }

  it('one-agent floor stops at fitMax 32', () => {
    expect(fitView([box(4, 10, -8, -4, 1.5, 4)], { width: 1600, height: 900, projection: 'perspective' }).ppm).toBe(32)
  })

  it('a deep floor that does not fit at 7 shows the gantry and the top rows', () => {
    const stage: Stage = { width: 1024, height: 240, projection: 'perspective' }
    const view = fitView([...content, box(4.5, 35.5, 0, 50, 0, 2.6)], stage)
    expect(view.ppm).toBe(7)
    const boothTop = project(view, stage, { x: 7, y: 4.1, z: -8 })
    expect(boothTop.y).toBeGreaterThan(0)
  })
})

describe('camera: zoom, pan, clamp, focus', () => {
  it('zoomAbout keeps the ground point under the cursor fixed and clamps ppm', () => {
    const view = { ppm: 20, targetX: 10, targetZ: 5 }
    const at = { x: 300, y: 200 }
    const before = unproject(view, STAGE, at)!
    const next = zoomAbout(view, wheelFactor(-100), at, STAGE)
    expect(next.ppm).toBeCloseTo(22, 9)
    const after = unproject(next, STAGE, at)!
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.z).toBeCloseTo(before.z, 6)
    expect(zoomAbout(view, 100, at, STAGE).ppm).toBe(60)
    expect(zoomAbout(view, 0.01, at, STAGE).ppm).toBe(7)
    expect(zoomAbout({ ...view, ppm: 60 }, 2, at, STAGE)).toEqual({ ...view, ppm: 60 })
  })

  it('wheel factor is 1.1 per 100 units of deltaY', () => {
    expect(wheelFactor(-100)).toBeCloseTo(1.1, 9)
    expect(wheelFactor(200)).toBeCloseTo(1 / 1.21, 9)
  })

  it('panByScreen moves the ground under the cursor with it', () => {
    const view = { ppm: 20, targetX: 10, targetZ: 5 }
    const g = unproject(view, STAGE, { x: 500, y: 300 })!
    const next = panByScreen(view, STAGE, 40, -25, { x: 500, y: 300 })
    const s = project(next, STAGE, g)
    expect(s.x).toBeCloseTo(540, 6)
    expect(s.y).toBeCloseTo(275, 6)
  })

  it('clampTarget keeps the target within the floor plus 8 m', () => {
    const hall = { minX: 0, maxX: 30, minZ: -10, maxZ: 2 }
    expect(clampTarget({ ppm: 9, targetX: -20, targetZ: 40 }, hall)).toEqual({ ppm: 9, targetX: -8, targetZ: 10 })
    expect(clampTarget({ ppm: 9, targetX: 5, targetZ: 0 }, hall)).toEqual({ ppm: 9, targetX: 5, targetZ: 0 })
  })

  it('panIntoView pans an off-stage or edge footprint to 96 px inside, never zooms, and leaves inner ones alone', () => {
    const view = { ppm: 20, targetX: 10, targetZ: 5 }
    expect(panIntoView(view, box(8.5, 11.5, 3.5, 6.5, 0, 1.6), STAGE)).toBeNull()
    const st = box(40.5, 43.5, 0, 3, 0, 1.6)
    const before = projectFootprint(view, STAGE, st)
    expect(before.right).toBeGreaterThan(STAGE.width - 48)
    const next = panIntoView(view, st, STAGE)!
    expect(next.ppm).toBe(20)
    const after = projectFootprint(next, STAGE, st)
    expect(after.right).toBeCloseTo(STAGE.width - 96, 0)
    const north = box(5, 8, -40, -37, 0, 1.6)
    const up = projectFootprint(panIntoView(view, north, STAGE)!, STAGE, north)
    expect(up.top).toBeCloseTo(96, 0)
    expect(up.left).toBeGreaterThan(48)
  })

  it('LOD bands follow section 4.5', () => {
    expect(lodBand(60)).toBe('near')
    expect(lodBand(24)).toBe('near')
    expect(lodBand(23.9)).toBe('mid')
    expect(lodBand(12)).toBe('mid')
    expect(lodBand(11.9)).toBe('far')
  })

  it('tween helpers', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
    const mid = lerpView({ ppm: 10, targetX: 0, targetZ: 0 }, { ppm: 40, targetX: 10, targetZ: -10 }, 0.5)
    expect(mid.ppm).toBeCloseTo(20, 9)
    expect(mid.targetX).toBe(5)
    expect(mid.targetZ).toBe(-5)
  })
})
