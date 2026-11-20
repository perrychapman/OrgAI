import { describe, expect, it } from 'vitest'
import { Matrix4, Vector3, type BufferGeometry } from 'three'
import { robot } from '../builders/robot'
import { STATION_ANCHORS } from '../builders/station'
import { bodyMatrix, POSE_NAMES, PoseLibrary, poseBody, posePartMatrices, POSES } from './poses'
import type { Pose } from '../../../../lib/factory/types'

const kit = robot()
const keys = kit.parts.map((p) => p.key)
const geometry = (key: string): BufferGeometry => kit.parts.find((p) => p.key === key)!.geometry

/** Extremes of a part's vertices after a matrix. */
function extent(key: string, m: Matrix4): { minY: number; maxY: number; maxZ: number } {
  const pos = geometry(key).getAttribute('position')
  const v = new Vector3()
  let minY = Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m)
    minY = Math.min(minY, v.y)
    maxY = Math.max(maxY, v.y)
    maxZ = Math.max(maxZ, v.z)
  }
  return { minY, maxY, maxZ }
}
const parts = (pose: Pose): Record<string, Matrix4> => posePartMatrices(pose, kit.anchors, keys)
const headTop = (pose: Pose): number => extent('robot.head', parts(pose)['robot.head']).maxY
/** Height of the visor's centre: where the robot "looks"; a nod lowers it even when the back of the head rises. */
const visorY = (pose: Pose): number => {
  const e = extent('robot.visor', parts(pose)['robot.visor'])
  return (e.minY + e.maxY) / 2
}
const handTop = (pose: Pose, side: 'l' | 'r'): number => extent(`robot.arm.${side}.lower`, parts(pose)[`robot.arm.${side}.lower`]).maxY
const handLow = (pose: Pose, side: 'l' | 'r'): number => extent(`robot.arm.${side}.lower`, parts(pose)[`robot.arm.${side}.lower`]).minY

describe('robot poses', () => {
  it('covers the seven poses and every robot part with finite matrices', () => {
    expect(Object.keys(POSES).sort()).toEqual([...POSE_NAMES].sort())
    for (const pose of POSE_NAMES) {
      const m = parts(pose)
      expect(Object.keys(m).sort()).toEqual([...keys].sort())
      for (const x of Object.values(m)) for (const e of x.elements) expect(Number.isFinite(e)).toBe(true)
    }
  })

  it('rest is the kit as built (identity for every part)', () => {
    const id = new Matrix4()
    for (const m of Object.values(parts('rest'))) expect(m.equals(id)).toBe(true)
  })

  it('signal raises one hand clearly above the head and keeps the other arm down', () => {
    // The head part's top includes the antenna (about 6 cm above the head block).
    expect(handTop('signal', 'r')).toBeGreaterThan(headTop('signal') + 0.08)
    expect(handTop('signal', 'l')).toBeLessThan(headTop('signal') - 0.4)
    expect(poseBody('signal', STATION_ANCHORS).yaw).toBe(0)
  })

  it('down slumps: the head is lower than at rest and the hands hang', () => {
    expect(headTop('down')).toBeLessThan(headTop('rest') - 0.1)
    expect(visorY('down')).toBeLessThan(visorY('rest') - 0.15)
    expect(handLow('down', 'l')).toBeLessThan(0.45)
    expect(handLow('down', 'r')).toBeLessThan(0.45)
    // Leans forward (towards the visor side).
    expect(extent('robot.head', parts('down')['robot.head']).maxZ).toBeGreaterThan(extent('robot.head', parts('rest')['robot.head']).maxZ + 0.1)
  })

  it('docked lowers the head; console and machine reach forward', () => {
    expect(visorY('docked')).toBeLessThan(visorY('rest') - 0.1)
    expect(visorY('signal')).toBeGreaterThan(visorY('rest') - 0.01)
    for (const pose of ['console', 'machine'] as const) {
      for (const side of ['l', 'r'] as const) {
        const m = parts(pose)[`robot.arm.${side}.lower`]
        expect(extent(`robot.arm.${side}.lower`, m).maxZ).toBeGreaterThan(extent(`robot.arm.${side}.lower`, new Matrix4()).maxZ + 0.1)
      }
    }
  })

  it('wheels never move; the far capsule tilts only for down and docked', () => {
    for (const pose of POSE_NAMES) expect(parts(pose)['robot.wheels'].equals(new Matrix4())).toBe(true)
    expect(parts('rest')['robot.far.body'].equals(new Matrix4())).toBe(true)
    expect(parts('down')['robot.far.body'].equals(new Matrix4())).toBe(false)
  })

  it('places the body at the named anchor, else at the robot anchor with the fallback offset', () => {
    const anchors = { ...STATION_ANCHORS, 'robot.machine': { x: 0.4, y: 0.1, z: 0.6, rotY: Math.PI } }
    expect(poseBody('machine', anchors)).toEqual({ x: 0.4, y: 0.1, z: 0.6, yaw: Math.PI })
    const r = STATION_ANCHORS.robot
    const fb = POSES.machine.fallback
    expect(poseBody('machine', STATION_ANCHORS)).toEqual({ x: r.x + fb.dx, y: r.y, z: r.z + fb.dz, yaw: fb.yaw })
    // console faces the console (north) whatever the anchor's rest facing.
    expect(poseBody('console', STATION_ANCHORS).yaw).toBe(Math.PI)
    expect(poseBody('rest', undefined)).toEqual({ x: 0, y: 0, z: 0, yaw: 0 })
    const m = bodyMatrix({ x: 1, y: 0.1, z: 2, yaw: Math.PI })
    const front = new Vector3(0, 0, 1).applyMatrix4(m)
    expect(front.x).toBeCloseTo(1)
    expect(front.z).toBeCloseTo(1)
  })

  it('PoseLibrary computes each pose once', () => {
    const lib = new PoseLibrary(kit.anchors, keys)
    expect(lib.parts('signal')).toBe(lib.parts('signal'))
    expect(lib.parts('signal')['robot.head'].equals(parts('signal')['robot.head'])).toBe(true)
  })
})
