import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, Matrix4, Vector3 } from 'three'
import { factoryKits } from '../builders'
import type { ObjectKit, PartSpec } from '../builders/types'
import { CAPSULE_COALESCED_SCALE } from '../builders/types'
import { EMPTY_LAYOUT_MEMORY, GANTRY_TOP, layoutFloor } from '../../../../lib/factory/layout'
import { ARRIVE_SCALE_FROM, PART_BELT_M, PART_MS, PART_POP_MS, SCREEN_GLOW_MAX, SCREEN_GLOW_MIN } from '../../../../lib/factory/motion'
import { arcApex } from '../../../../lib/factory/routes'
import type { ActiveCue, FactoryAgentInput, FloorModel, WorkerModel } from '../../../../lib/factory/types'
import { subKit } from './instancing'
import { floorInstances, type FloorContext, type KitName } from './floorInstances'
import { PoseLibrary } from './poses'
import { BARRIER_RAISE, CARRIER_LIFT, CueRenderer, cycleFraction, groundY, isFullTurn, PART_OUTFEED, screenLevel, STATION_POOLS, strokeMatrix, type AmbientMap, type CueRenderContext } from './cueRender'

const agent = (id: string, parentId: string | null, startedAt: number): FactoryAgentInput => ({
  id, name: id, parentId, roleKey: id, state: 'idle', statusWord: 'Idle', activity: '', toolCalls: 0, startedAt, session: 'current'
})
/** Root R in the booth; leads A and B on line 1; A's reports A1..A3 (benches) on line 2. */
const AGENTS = [agent('R', null, 0), agent('A', 'R', 1), agent('B', 'R', 2), ...[1, 2, 3].map((i) => agent(`A${i}`, 'A', 2 + i))]
const LAYOUT = layoutFloor({ runKey: 'run', agents: AGENTS }, EMPTY_LAYOUT_MEMORY).layout

const worker = (id: string, patch: Partial<WorkerModel> = {}): WorkerModel => ({
  id, name: id, kind: LAYOUT.stations[id].kind, statusWord: 'Idle', activity: '', lamp: 'off', pose: 'rest', ambient: 'none',
  shutter: false, barrier: false, fenced: false, stepIds: [], ...patch
})
function model(workers: Record<string, Partial<WorkerModel>> = {}, patch: Partial<FloorModel> = {}): FloorModel {
  const all: Record<string, WorkerModel> = {}
  for (const a of AGENTS) all[a.id] = worker(a.id, workers[a.id])
  return { mode: 'live', layout: LAYOUT, workers: all, hall: 'on', dockCrates: 0, earlier: [], ...patch }
}

const box = (key: string, extra: Partial<PartSpec> = {}): PartSpec => ({
  key, geometry: new BoxGeometry(0.4, 0.4, 0.4).translate(0, 0.2, 0), role: 'r', castShadow: false, receiveShadow: false, lods: ['near', 'mid', 'far'], ...extra
})

/** Real kits for the floor, simple boxes for the carriers; a stroke machine and a glowing screen for the ambient tests. */
function kits(): Record<KitName, ObjectKit> {
  const props = factoryKits.props()
  const crate = factoryKits.crate?.() ?? { name: 'crate', parts: [box('crate.body'), box('crate.lamp', { instanceColor: true })] }
  const bench = factoryKits.station('bench')
  const withScreen: ObjectKit = { ...bench, parts: bench.parts.map((p) => (p.key === 'station.screen' ? { ...p, instanceColor: true, screen: true } : p)) }
  // Every variant gets a test stroke part of its own (the tests do not depend on the Technical Artist's kits having one).
  const stroked = (v: 0 | 1 | 2 | 3): ObjectKit => {
    const k = factoryKits.machine(v)
    return { ...k, parts: [...k.parts.filter((p) => !p.stroke), box(`machine.${v}.test`, { stroke: { kind: 'rotateY', amount: 0.698, pivot: { x: -0.2, y: 0, z: 0 } } })] }
  }
  const all: Partial<Record<KitName, ObjectKit>> = {
    booth: factoryKits.booth(), dock: factoryKits.dock(), board: factoryKits.board(), lead: factoryKits.station('lead'), bench: withScreen,
    machine0: stroked(0), machine1: stroked(1), machine2: stroked(2), machine3: stroked(3),
    stack: factoryKits.stackLight(), robot: factoryKits.robot(),
    paint: subKit(props, 'paint')!, vacant: subKit(props, 'vacant')!, ring: subKit(props, 'ring')!, blob: subKit(props, 'blob')!,
    shutter: factoryKits.shutter?.() ?? { name: 'shutter', parts: [box('shutter')] },
    barrier: factoryKits.barrier?.() ?? { name: 'barrier', parts: [box('barrier')] },
    fence: { name: 'fence', parts: [box('fence')] },
    crate,
    holdPad: { name: 'hold', parts: [box('hold.pad')] },
    holdPadStriped: { name: 'hold', parts: [box('hold.pad')] },
    boardLamp: { name: 'boardLamp', parts: [box('lens', { instanceColor: true })] },
    tote: { name: 'tote', parts: [box('tote')] },
    capsule: { name: 'capsule', parts: [box('capsule')] },
    part: { name: 'part', parts: [box('part')] },
    crateFlight: crate
  }
  return all as Record<KitName, ObjectKit>
}

const KITS = kits()
const robotKit = KITS.robot
const POSES = new PoseLibrary(robotKit.anchors, robotKit.parts.map((p) => p.key))
const LAMPS = { off: new Color('#333333'), running: new Color('#00ff00'), 'needs-you': new Color('#ffaa00'), failed: new Color('#ff0000') }

function floorCtx(band: 'near' | 'mid' | 'far' = 'near'): FloorContext {
  return {
    kit: (n) => KITS[n],
    top: (n) => {
      let t = 0
      for (const p of KITS[n].parts) {
        p.geometry.computeBoundingBox()
        t = Math.max(t, p.geometry.boundingBox!.max.y)
      }
      return t
    },
    band,
    lamps: LAMPS,
    boardLamp: () => LAMPS.off,
    poses: POSES
  }
}
const cueCtx = (band: 'near' | 'mid' | 'far' = 'near'): CueRenderContext => ({ kit: (n) => KITS[n], poses: POSES, band, offLamp: LAMPS.off })

function setup(m: FloorModel = model(), band: 'near' | 'mid' | 'far' = 'near') {
  const floor = { model: m, selectedId: null }
  const base = floorInstances(floor, floorCtx(band))
  const r = new CueRenderer()
  r.observe(base, m)
  return { floor, base, r }
}

let seq = 0
const cue = (c: Partial<ActiveCue> & Pick<ActiveCue, 'kind'>): ActiveCue => ({ id: `c${++seq}`, start: 0, duration: 1000, progress: 0.5, opacity: 1, ...c })
const NONE: AmbientMap = new Map()
const centre = (id: string) => LAYOUT.stations[id].center
const at = (m: Matrix4): Vector3 => new Vector3().setFromMatrixPosition(m)
/** Every entry keyed to a station across the station pools. */
const stationKeys = (lists: Partial<Record<KitName, { key: string }[]>>, base: Record<KitName, { key: string }[]>, id: string): number =>
  STATION_POOLS.reduce((n, p) => n + (lists[p] ?? base[p]).filter((s) => s.key === id).length, 0)
const scaleY = (m: Matrix4): number => new Vector3(m.elements[4], m.elements[5], m.elements[6]).length()

describe('cueRender helpers', () => {
  it('stroke matrices: rest at wave 0, the full amount at wave 1 about the pivot', () => {
    expect(strokeMatrix({ kind: 'translateY', amount: -0.3 }, 0).equals(new Matrix4())).toBe(true)
    expect(at(strokeMatrix({ kind: 'translateY', amount: -0.3 }, 1)).y).toBeCloseTo(-0.3)
    expect(at(strokeMatrix({ kind: 'translateX', amount: 0.6 }, 0.5)).x).toBeCloseTo(0.3)
    // A quarter turn about (1, 0, 0) takes the origin to (1, 0, 1).
    const p = new Vector3(0, 0, 0).applyMatrix4(strokeMatrix({ kind: 'rotateY', amount: Math.PI / 2, pivot: { x: 1, y: 0, z: 0 } }, 1))
    expect(p.x).toBeCloseTo(1)
    expect(p.z).toBeCloseTo(1)
    const q = new Vector3(1, 0, 0).applyMatrix4(strokeMatrix({ kind: 'rotateZ', amount: Math.PI / 2 }, 1))
    expect(q.y).toBeCloseTo(1)
  })

  it('a full-turn stroke (the spindle) runs one way round over the cycle', () => {
    const spin = { kind: 'rotateY' as const, amount: 2 * Math.PI }
    expect(isFullTurn(spin)).toBe(true)
    expect(isFullTurn({ kind: 'rotateY', amount: 0.698 })).toBe(false)
    expect(cycleFraction(0, 0)).toBe(0)
    expect(cycleFraction(1400, 0)).toBeCloseTo(0.5)
    expect(cycleFraction(150, 1)).toBe(0)
    // Monotonic through the cycle (never turning back), unlike the 0..1..0 wave.
    expect(cycleFraction(2000, 0)).toBeGreaterThan(cycleFraction(1400, 0))
  })

  it('screen glow runs between the min and max levels; the gantry has its own ground height', () => {
    expect(screenLevel(0)).toBe(SCREEN_GLOW_MIN)
    expect(screenLevel(1)).toBe(SCREEN_GLOW_MAX)
    expect(screenLevel(2)).toBe(SCREEN_GLOW_MAX)
    expect(groundY(-6)).toBe(GANTRY_TOP)
    expect(groundY(5)).toBe(0)
  })
})

describe('CueRenderer', () => {
  it('draws nothing extra with no cues and no loops (every pool keeps its end state)', () => {
    const { floor, base, r } = setup()
    const o = r.overlay(base, floor, [], NONE, 0, cueCtx())
    expect(o.lists).toEqual({})
    expect(o.hall).toBeNull()
  })

  it('a work-order tote hides its child station until it lands, then the arrive grows it from 0.2', () => {
    const { floor, base, r } = setup()
    const from = centre('A')
    const to = centre('A3')
    const tote = cue({ kind: 'tote', from: 'A', to: 'A3', progress: 0.5, path: { from, to, fromY: 0, toY: 0 } })
    const waiting = cue({ kind: 'arrive', from: 'A3', progress: 0 })
    const o = r.overlay(base, floor, [tote, waiting], NONE, 0, cueCtx())
    expect(stationKeys(o.lists, base, 'A3')).toBe(0)
    expect((o.lists.blob ?? base.blob).some((s) => s.key === 'robot:A3')).toBe(false)
    // Other stations untouched.
    expect(stationKeys(o.lists, base, 'A2')).toBe(stationKeys({}, base, 'A2'))
    // The tote at the middle of its arc: halfway along, apex plus the lift above the floor, with a blob under it.
    const t = o.lists.tote!
    expect(t).toHaveLength(1)
    const p = at(t[0].matrix)
    expect(p.x).toBeCloseTo((from.x + to.x) / 2)
    expect(p.y).toBeCloseTo(CARRIER_LIFT + arcApex(from, to))
    expect(o.lists.blob!.some((s) => s.key === `cue:${tote.id}`)).toBe(true)

    // Arrive under way: every station part keyed A3 is there, squashed in y about the floor.
    const growing = r.overlay(base, floor, [cue({ kind: 'arrive', from: 'A3', progress: 0.5 })], NONE, 0, cueCtx())
    expect(stationKeys(growing.lists, base, 'A3')).toBe(stationKeys({}, base, 'A3'))
    const plate = growing.lists.bench!.find((s) => s.key === 'A3')!
    const s = scaleY(plate.matrix)
    expect(s).toBeGreaterThan(ARRIVE_SCALE_FROM)
    expect(s).toBeLessThan(1)
    expect(at(plate.matrix).x).toBeCloseTo(centre('A3').x)
    expect(at(plate.matrix).y).toBeCloseTo(0)
  })

  it('capsules: coalesced ones are larger, a cancelled one shrinks with its opacity, one to null rises and fades', () => {
    const { floor, base, r } = setup()
    const path = { from: centre('A1'), to: centre('B'), fromY: 0, toY: 0 }
    const one = cue({ kind: 'capsule', from: 'A1', to: 'B', path, progress: 0.25 })
    const many = cue({ kind: 'capsule', from: 'A1', to: 'B', path, progress: 0.25, count: 3 })
    const fading = cue({ kind: 'capsule', from: 'A1', to: 'B', path, progress: 0.25, opacity: 0.5 })
    const o = r.overlay(base, floor, [one, many, fading], NONE, 0, cueCtx())
    const scale = (id: string) => new Vector3().setFromMatrixColumn(o.lists.capsule!.find((s) => s.key === id)!.matrix, 0).length()
    expect(scale(one.id)).toBeCloseTo(1)
    expect(scale(many.id)).toBeCloseTo(CAPSULE_COALESCED_SCALE)
    expect(scale(fading.id)).toBeCloseTo(0.5)
    // Yawed along its path: +x points from sender to recipient.
    const dir = new Vector3(1, 0, 0).transformDirection(o.lists.capsule!.find((s) => s.key === one.id)!.matrix)
    const want = new Vector3(path.to.x - path.from.x, 0, path.to.z - path.from.z).normalize()
    expect(dir.dot(want)).toBeCloseTo(1)

    const roofPath = { from: centre('A1'), to: centre('A1'), fromY: 0, toY: 4 }
    const early = r.overlay(base, floor, [cue({ kind: 'capsule', from: 'A1', to: null, path: roofPath, progress: 0.25 })], NONE, 0, cueCtx()).lists.capsule![0]
    const late = r.overlay(base, floor, [cue({ kind: 'capsule', from: 'A1', to: null, path: roofPath, progress: 0.75 })], NONE, 0, cueCtx()).lists.capsule![0]
    expect(at(late.matrix).y).toBeGreaterThan(at(early.matrix).y)
    expect(at(late.matrix).x).toBeCloseTo(centre('A1').x)
    expect(new Vector3().setFromMatrixColumn(late.matrix, 0).length()).toBeLessThan(1)
    const done = r.overlay(base, floor, [cue({ kind: 'capsule', from: 'A1', to: null, path: roofPath, progress: 1 })], NONE, 0, cueCtx())
    expect(done.lists.capsule ?? []).toHaveLength(0)
  })

  it('a tool part pops on the outfeed, rides the belt, and is not shown in the far band or at the booth', () => {
    const { floor, base, r } = setup()
    const at0 = (progress: number) => r.overlay(base, floor, [cue({ kind: 'part', from: 'A2', progress, duration: PART_MS })], NONE, 0, cueCtx()).lists.part ?? []
    const pop = at0(PART_POP_MS / PART_MS / 2)[0]
    expect(new Vector3().setFromMatrixColumn(pop.matrix, 0).length()).toBeCloseTo(0.5)
    expect(at(pop.matrix).z).toBeCloseTo(centre('A2').z + PART_OUTFEED.z)
    const ridden = at0((PART_POP_MS + 700) / PART_MS - 1e-6)[0]
    expect(at(ridden.matrix).z).toBeCloseTo(centre('A2').z + PART_OUTFEED.z + PART_BELT_M, 2)
    expect(at0(1)).toHaveLength(0)
    const far = setup(model(), 'far')
    expect(far.r.overlay(far.base, far.floor, [cue({ kind: 'part', from: 'A2' })], NONE, 0, cueCtx('far')).lists.part ?? []).toHaveLength(0)
    expect(r.overlay(base, floor, [cue({ kind: 'part', from: 'R' })], NONE, 0, cueCtx()).lists.part ?? []).toHaveLength(0)
  })

  it('a crate in flight hides its end state and lands exactly on it (dock slot, parent inbox, hold slide)', () => {
    const m = model({ A1: { crate: { at: 'parent-pad', lamp: 'off' } }, A2: { crate: { at: 'hold-striped', lamp: 'off' } } }, { dockCrates: 1 })
    const { floor, base, r } = setup(m)
    for (const [c, endKey] of [
      [cue({ kind: 'crate', from: 'B', to: 'dock', dest: 'dock', slot: 0 }), 'dock:0'],
      [cue({ kind: 'crate', from: 'A1', to: 'A', dest: 'parent-pad' }), 'A1'],
      [cue({ kind: 'crate', from: 'A2', to: 'A2', dest: 'hold' }), 'A2']
    ] as const) {
      const end = base.crate.find((s) => s.key === endKey)
      expect(end).toBeDefined()
      const mid = r.overlay(base, floor, [c], NONE, 0, cueCtx())
      expect(mid.lists.crate!.some((s) => s.key === endKey)).toBe(false)
      expect(mid.lists.blob!.some((s) => s.key === `crate:${endKey}`)).toBe(false)
      expect(mid.lists.crateFlight).toHaveLength(1)
      const landed = r.overlay(base, floor, [{ ...c, progress: 1 }], NONE, 0, cueCtx()).lists.crateFlight![0]
      expect(at(landed.matrix).distanceTo(at(end!.matrix))).toBeLessThan(1e-6)
    }
    // The hold slide stays on the floor (no arc); the others rise above the straight line.
    const slide = r.overlay(base, floor, [cue({ kind: 'crate', from: 'A2', to: 'A2', dest: 'hold' })], NONE, 0, cueCtx()).lists.crateFlight![0]
    expect(at(slide.matrix).y).toBeLessThan(0.3)
    // A dock crate with no slot lands at once: nothing in flight.
    const none = r.overlay(base, floor, [cue({ kind: 'crate', from: 'B', to: 'dock', dest: 'dock', slot: 9 })], NONE, 0, cueCtx())
    expect(none.lists.crateFlight ?? []).toHaveLength(0)
  })

  it('a leaving station is drawn from its last known state, shrinking about its centre', () => {
    const { base, r } = setup()
    // A3 leaves: the new layout has no station for it.
    const gone = layoutFloor({ runKey: 'run', agents: AGENTS.filter((a) => a.id !== 'A3') }, layoutFloor({ runKey: 'run', agents: AGENTS }, EMPTY_LAYOUT_MEMORY).memory).layout
    expect(gone.stations.A3).toBeUndefined()
    const m2: FloorModel = { ...model(), layout: gone, workers: Object.fromEntries(Object.entries(model().workers).filter(([id]) => id !== 'A3')) }
    const floor2 = { model: m2, selectedId: null }
    const base2 = floorInstances(floor2, floorCtx())
    r.observe(base2, m2)
    const o = r.overlay(base2, floor2, [cue({ kind: 'leave', from: 'A3', progress: 0.5 })], NONE, 0, cueCtx())
    const ghost = o.lists.bench!.find((s) => s.key === 'leave:A3')!
    expect(ghost).toBeDefined()
    expect(scaleY(ghost.matrix)).toBeCloseTo(0.5)
    expect(at(ghost.matrix).x).toBeCloseTo(at(base.bench.find((s) => s.key === 'A3')!.matrix).x)
    expect(r.overlay(base2, floor2, [cue({ kind: 'leave', from: 'A3', progress: 1 })], NONE, 0, cueCtx()).lists.bench ?? []).not.toContainEqual(expect.objectContaining({ key: 'leave:A3' }))
  })

  it('pose blends the robot between its two poses; shutter and barrier travel to their end states', () => {
    const m = model({ A2: { pose: 'down', shutter: true, barrier: true } })
    const { floor, base, r } = setup(m)
    const start = r.overlay(base, floor, [cue({ kind: 'pose', from: 'A2', pose: { from: 'rest', to: 'down' }, progress: 0 })], NONE, 0, cueCtx())
    const rest = setup(model()).base.robot.find((s) => s.key === 'A2')!
    const robot = start.lists.robot!.find((s) => s.key === 'A2')!
    expect(at(robot.matrix).distanceTo(at(rest.matrix))).toBeLessThan(1e-9)
    expect(robot.parts!['robot.head'].equals(rest.parts!['robot.head'])).toBe(true)
    const end = r.overlay(base, floor, [cue({ kind: 'pose', from: 'A2', pose: { from: 'rest', to: 'down' }, progress: 1 })], NONE, 0, cueCtx())
    const endRobot = end.lists.robot!.find((s) => s.key === 'A2')!
    const want = base.robot.find((s) => s.key === 'A2')!
    expect(endRobot.matrix.elements.every((e, i) => Math.abs(e - want.matrix.elements[i]) < 1e-9)).toBe(true)

    const lowering = r.overlay(base, floor, [cue({ kind: 'shutter', from: 'A2', lower: true, progress: 0 }), cue({ kind: 'barrier', from: 'A2', lower: true, progress: 0 })], NONE, 0, cueCtx())
    expect(scaleY(lowering.lists.shutter!.find((s) => s.key === 'A2')!.matrix)).toBeLessThan(0.1)
    const bar = lowering.lists.barrier!.find((s) => s.key === 'A2')!
    expect(at(bar.matrix).y - at(base.barrier.find((s) => s.key === 'A2')!.matrix).y).toBeCloseTo(BARRIER_RAISE)
    const down = r.overlay(base, floor, [cue({ kind: 'shutter', from: 'A2', lower: true, progress: 1 })], NONE, 0, cueCtx())
    expect(scaleY(down.lists.shutter!.find((s) => s.key === 'A2')!.matrix)).toBeCloseTo(1)
  })

  it('ambient: only the looping stations move (machine stroke, screen glow); the hall tween passes through', () => {
    const { floor, base, r } = setup()
    // A1..A3 are benches; give one a machine loop and one a screen loop (A1's variant decides its machine kit).
    const v = LAYOUT.stations.A1.variant
    const ambient: AmbientMap = new Map([
      ['A1', { kind: 'machine', phase: 0 }],
      ['A2', { kind: 'screen', phase: 1 }]
    ])
    // Half a cycle in: wave 1 for phase 0.
    const o = r.overlay(base, floor, [cue({ kind: 'hall', hall: { from: 'on', to: 'paused' }, progress: 0.5 })], ambient, 1400, cueCtx())
    expect(o.hall).toEqual({ from: 'on', to: 'paused', t: expect.any(Number) })
    const pool = `machine${v}` as KitName
    const machine = o.lists[pool]!.find((s) => s.key === 'A1')!
    expect(machine.parts?.[`machine.${v}.test`]).toBeDefined()
    const screen = o.lists.bench!.find((s) => s.key === 'A2')!
    const level = screen.colours!['station.screen']
    expect(level.r).toBeGreaterThanOrEqual(SCREEN_GLOW_MIN)
    expect(level.r).toBeLessThanOrEqual(SCREEN_GLOW_MAX)
    // A3 does not loop: its plate entry is the base one.
    expect(o.lists.bench!.find((s) => s.key === 'A3')).toBe(base.bench.find((s) => s.key === 'A3'))
  })

  it('the machine stroke follows the wave on a station whose variant has a stroke part', () => {
    const id = 'A3'
    const v = LAYOUT.stations[id].variant
    const pool = `machine${v}` as KitName
    const key = `machine.${v}.test`
    const { floor, base, r } = setup()
    const ambient: AmbientMap = new Map([[id, { kind: 'machine', phase: 0 }]])
    const rest = r.overlay(base, floor, [], ambient, 0, cueCtx()).lists[pool]!.find((s) => s.key === id)!
    expect(rest.parts![key].equals(new Matrix4())).toBe(true)
    const far = r.overlay(base, floor, [], ambient, 1400, cueCtx()).lists[pool]!.find((s) => s.key === id)!
    expect(far.parts![key].equals(new Matrix4())).toBe(false)
    // A machine loop on a lead (no machine) glows its screens instead; nothing else moves.
    const lead = r.overlay(base, floor, [], new Map([['A', { kind: 'machine', phase: 0 }]]), 1400, cueCtx())
    expect(Object.keys(lead.lists).filter((k) => k.startsWith('machine'))).toEqual([])
  })
})
