import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, Matrix4, Vector3 } from 'three'
import { factoryKits } from '../builders'
import { CRATE_PITCH, type Anchor, type ObjectKit } from '../builders/types'
import { EMPTY_LAYOUT_MEMORY, layoutFloor } from '../../../../lib/factory/layout'
import type { FactoryAgentInput, FloorModel, WorkerModel } from '../../../../lib/factory/types'
import { subKit } from './instancing'
import { BOARD_LAMP_COUNT, DOCK_CRATES, floorInstances, INBOX_CRATES, type BoardLampState, type FloorContext, type KitName } from './floorInstances'
import { PoseLibrary, POSES } from './poses'

const agent = (id: string, parentId: string | null, startedAt: number): FactoryAgentInput => ({
  id, name: id, parentId, roleKey: id, state: 'idle', statusWord: 'Idle', activity: '', toolCalls: 0, startedAt, session: 'current'
})

/** Root R; leads A and B on line 1; A's reports A1..A5 on line 2. */
const AGENTS = [agent('R', null, 0), agent('A', 'R', 1), agent('B', 'R', 2), ...[1, 2, 3, 4, 5].map((i) => agent(`A${i}`, 'A', 2 + i))]
const LAYOUT = layoutFloor({ runKey: 'run', agents: AGENTS }, EMPTY_LAYOUT_MEMORY).layout

const worker = (id: string, patch: Partial<WorkerModel> = {}): WorkerModel => ({
  id, name: id, kind: LAYOUT.stations[id].kind, statusWord: 'Idle', activity: '', lamp: 'off', pose: 'rest', ambient: 'none',
  shutter: false, barrier: false, fenced: false, stepIds: [], ...patch
})

function model(patch: Partial<FloorModel> = {}, workers: Record<string, Partial<WorkerModel>> = {}): FloorModel {
  const all: Record<string, WorkerModel> = {}
  for (const a of AGENTS) all[a.id] = worker(a.id, workers[a.id])
  return { mode: 'live', layout: LAYOUT, workers: all, hall: 'on', dockCrates: 0, earlier: [], ...patch }
}

const box = (key: string, h: number, instanceColor = false): ObjectKit['parts'][number] => {
  const g = new BoxGeometry(0.6, h, 0.6).translate(0, h / 2, 0)
  return { key, geometry: g, role: 'r', castShadow: false, receiveShadow: false, lods: ['near', 'mid', 'far'], ...(instanceColor ? { instanceColor: true } : {}) }
}

const SLICE3_ANCHORS: Record<string, Anchor> = {
  shutter: { x: 0.1, y: 0.1, z: -0.45, rotY: 0 },
  barrier: { x: 0, y: 0, z: 1.5, rotY: 0 },
  pad: { x: 0.1, y: 0.1, z: 1.6, rotY: 0 },
  hold: { x: 1.1, y: 0, z: 2.0, rotY: 0 },
  inbox: { x: -1.1, y: 0.1, z: 1.2, rotY: 0 },
  'robot.machine': { x: -0.4, y: 0.1, z: 0.4, rotY: Math.PI },
  'robot.rest': { x: -1.3, y: 0.1, z: 1.1, rotY: 0 }
}

function context(options: { slice3Anchors?: boolean; boothInbox?: boolean } = {}): FloorContext {
  const props = factoryKits.props()
  const kits: Partial<Record<KitName, ObjectKit>> = {
    booth: factoryKits.booth(), dock: factoryKits.dock(), board: factoryKits.board(), lead: factoryKits.station('lead'), bench: factoryKits.station('bench'),
    machine0: factoryKits.machine(0), machine1: factoryKits.machine(1), machine2: factoryKits.machine(2), machine3: factoryKits.machine(3),
    stack: factoryKits.stackLight(), robot: factoryKits.robot(),
    paint: subKit(props, 'paint')!, vacant: subKit(props, 'vacant')!, ring: subKit(props, 'ring')!, blob: subKit(props, 'blob')!,
    shutter: { name: 'shutter', parts: [box('shutter', 1)] },
    barrier: { name: 'barrier', parts: [box('barrier', 0.9)] },
    fence: { name: 'fence', parts: [box('fence', 0.6)] },
    crate: { name: 'crate', parts: [box('crate.body', 0.5), box('crate.lamp', 0.05, true)] },
    holdPad: { name: 'hold', parts: [box('hold.pad', 0.04)] },
    holdPadStriped: { name: 'hold', parts: [box('hold.pad', 0.04), box('hold.stripes', 0.05)] },
    boardLamp: { name: 'boardLamp', parts: [box('boardLamp.lens', 0.05, true)] }
  }
  if (options.slice3Anchors) {
    for (const k of ['lead', 'bench'] as const) kits[k] = { ...kits[k]!, anchors: { ...kits[k]!.anchors, ...SLICE3_ANCHORS } }
  }
  if (options.boothInbox) kits.booth = { ...kits.booth!, anchors: { ...kits.booth!.anchors, inbox: { x: 2, y: 0.15, z: 1, rotY: 0 }, pad: { x: 1, y: 0.15, z: 1, rotY: 0 } } }
  const robot = kits.robot!
  const boardColours: Record<BoardLampState, Color> = {
    pending: new Color('#111111'), skipped: new Color('#111111'), active: new Color('#00ff00'), done: new Color('#aaffaa'), blocked: new Color('#ffaa00')
  }
  return {
    kit: (name) => kits[name] ?? { name, parts: [] },
    top: (name) => {
      let top = 0
      for (const p of kits[name]?.parts ?? []) {
        p.geometry.computeBoundingBox()
        top = Math.max(top, p.geometry.boundingBox!.max.y)
      }
      return top
    },
    band: 'near',
    lamps: { off: new Color('#333333'), running: new Color('#00ff00'), 'needs-you': new Color('#ffaa00'), failed: new Color('#ff0000') },
    boardLamp: (s) => boardColours[s],
    poses: new PoseLibrary(robot.anchors, robot.parts.map((p) => p.key))
  }
}

const pos = (m: Matrix4): { x: number; y: number; z: number } => {
  const v = new Vector3().setFromMatrixPosition(m)
  return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) }
}
const keys = (list: { key: string }[]): string[] => list.map((i) => i.key).sort()

describe('floorInstances', () => {
  it('poses every robot: the part matrices of its pose, its body at the pose anchor', () => {
    const ctx = context({ slice3Anchors: true })
    const out = floorInstances({ model: model({}, { A: { pose: 'signal' }, B: { pose: 'machine' }, A1: { pose: 'down' } }), selectedId: null }, ctx)
    const robot = (id: string) => out.robot.find((r) => r.key === id)!
    expect(robot('A').parts).toBe(ctx.poses.parts('signal'))
    expect(robot('A1').parts).toBe(ctx.poses.parts('down'))
    expect(robot('A2').parts).toBe(ctx.poses.parts('rest'))
    // B at its 'robot.machine' anchor facing north; A at the console spot ('robot') facing south.
    const b = LAYOUT.stations.B.center
    expect(pos(robot('B').matrix)).toEqual({ x: b.x - 0.4, y: 0.1, z: b.z + 0.4 })
    const front = new Vector3(0, 0, 1).transformDirection(robot('B').matrix)
    expect(front.z).toBeCloseTo(-1)
    const signalFront = new Vector3(0, 0, 1).transformDirection(robot('A').matrix)
    expect(signalFront.z).toBeCloseTo(1)
    // The booth robot is the root's and takes its pose too.
    expect(robot('R').parts).toBe(ctx.poses.parts('rest'))
  })

  it('without the slice 3 anchors a pose falls back to the robot anchor plus its offset', () => {
    const ctx = context()
    const out = floorInstances({ model: model({}, { B: { pose: 'machine' } }), selectedId: null }, ctx)
    const robotAnchor = ctx.kit('lead').anchors!.robot
    const b = LAYOUT.stations.B.center
    const fb = POSES.machine.fallback
    const r = out.robot.find((i) => i.key === 'B')!
    expect(pos(r.matrix)).toEqual({ x: +(b.x + robotAnchor.x + fb.dx).toFixed(4), y: robotAnchor.y, z: +(b.z + robotAnchor.z + fb.dz).toFixed(4) })
  })

  it('draws shutter, barrier and fence for the flagged workers only, at their anchors', () => {
    const out = floorInstances({ model: model({}, { A1: { shutter: true }, A2: { barrier: true }, B: { fenced: true }, R: { shutter: true, barrier: true, fenced: true } }), selectedId: null }, context({ slice3Anchors: true }))
    // The booth names no shutter or barrier anchor and has no fence: the root gets none.
    expect(keys(out.shutter)).toEqual(['A1'])
    expect(keys(out.barrier)).toEqual(['A2'])
    expect(keys(out.fence)).toEqual(['B'])
    const a1 = LAYOUT.stations.A1.center
    expect(pos(out.shutter[0].matrix)).toEqual({ x: +(a1.x + 0.1).toFixed(4), y: 0.1, z: +(a1.z - 0.45).toFixed(4) })
    expect(pos(out.fence[0].matrix)).toEqual({ x: LAYOUT.stations.B.center.x, y: 0, z: LAYOUT.stations.B.center.z })
  })

  it('places crates on the pad, on a hold pad (plain or striped) and in the parent inbox, with the needs-you lamp', () => {
    const ctx = context({ slice3Anchors: true })
    const out = floorInstances({
      model: model({}, {
        A1: { crate: { at: 'pad', lamp: 'needs-you' } },
        A2: { crate: { at: 'hold-striped', lamp: 'off' } },
        A3: { crate: { at: 'hold', lamp: 'off' } },
        A4: { crate: { at: 'parent-pad', lamp: 'off' } },
        A5: { crate: { at: 'parent-pad', lamp: 'off' } },
        B: { crate: { at: 'dock', lamp: 'off' } }
      }),
      selectedId: null
    }, ctx)
    expect(keys(out.crate)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5'])
    expect(keys(out.holdPadStriped)).toEqual(['A2'])
    expect(keys(out.holdPad)).toEqual(['A3'])
    const crate = (id: string) => out.crate.find((c) => c.key === id)!
    const a1 = LAYOUT.stations.A1.center
    expect(pos(crate('A1').matrix)).toEqual({ x: +(a1.x + 0.1).toFixed(4), y: 0.1, z: +(a1.z + 1.6).toFixed(4) })
    expect(crate('A1').colours!['crate.lamp']).toBe(ctx.lamps['needs-you'])
    expect(crate('A2').colours!['crate.lamp']).toBe(ctx.lamps.off)
    // On the hold pad's top surface.
    expect(pos(crate('A2').matrix).y).toBeCloseTo(0.05)
    // A's inbox: first crate at the anchor, the second one CRATE_PITCH east.
    const a = LAYOUT.stations.A.center
    expect(pos(crate('A4').matrix)).toEqual({ x: +(a.x - 1.1).toFixed(4), y: 0.1, z: +(a.z + 1.2).toFixed(4) })
    expect(pos(crate('A5').matrix).x).toBeCloseTo(a.x - 1.1 + CRATE_PITCH)
    // Crates have blob shadows.
    expect(out.blob.some((b) => b.key === 'crate:A1')).toBe(true)
  })

  it('draws at most four crates per inbox, and none where the parent has no inbox (the booth without the anchor)', () => {
    const merged = { crate: { at: 'parent-pad' as const, lamp: 'off' as const } }
    const m = model({}, { A1: merged, A2: merged, A3: merged, A4: merged, A5: merged, A: merged, B: merged })
    const out = floorInstances({ model: m, selectedId: null }, context({ slice3Anchors: true }))
    expect(keys(out.crate)).toEqual(['A1', 'A2', 'A3', 'A4'].slice(0, INBOX_CRATES))
    const withBooth = floorInstances({ model: m, selectedId: null }, context({ slice3Anchors: true, boothInbox: true }))
    expect(keys(withBooth.crate)).toEqual(['A', 'A1', 'A2', 'A3', 'A4', 'B'])
  })

  it('fills the dock slots up to nine and colours the twelve board lamps by step state', () => {
    const ctx = context()
    const out = floorInstances({
      model: model({ dockCrates: 12, board: { total: 14, done: 2, blocked: 1, lamps: ['done', 'done', 'active', 'blocked', 'pending', 'skipped'], overflow: 2 } }),
      selectedId: null
    }, ctx)
    expect(out.crate.map((c) => c.key)).toEqual(Array.from({ length: DOCK_CRATES }, (_, i) => `dock:${i}`))
    expect(out.boardLamp).toHaveLength(BOARD_LAMP_COUNT)
    const lens = out.boardLamp.map((l) => l.colours!['boardLamp.lens'])
    expect(lens.slice(0, 6)).toEqual(['done', 'done', 'active', 'blocked', 'pending', 'skipped'].map((s) => ctx.boardLamp(s as BoardLampState)))
    for (const c of lens.slice(6)) expect(c).toBe(ctx.lamps.off)
    const few = floorInstances({ model: model({ dockCrates: 3 }), selectedId: null }, ctx)
    expect(few.crate).toHaveLength(3)
    expect(few.boardLamp).toHaveLength(0)
  })

  it('team mode draws no lamps, dock, board or crates', () => {
    const out = floorInstances({ model: model({ mode: 'team', dockCrates: 4 }, { A1: { crate: { at: 'pad', lamp: 'off' } } }), selectedId: null }, context({ slice3Anchors: true }))
    expect(out.stack).toHaveLength(0)
    expect(out.dock).toHaveLength(0)
    expect(out.boardLamp).toHaveLength(0)
    // The model decides crates; in team mode it never sets one, but the engine draws what the model says.
    expect(out.crate.map((c) => c.key)).toEqual(['A1'])
  })
})
