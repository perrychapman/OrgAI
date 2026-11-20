// What the Factory Floor engine draws for a floor model (docs/design/factory-floor.md sections 1.4 "Static end state",
// 4.4 and 4.6): the instance list of every kit pool, computed from the pure FloorModel and the kits' anchors. No
// renderer, no scene: the engine hands each list to its KitPool (engine/instancing.ts), which writes only what changed.
// Slice 3: robots in their pose, stack lights per lamp, shutter, barrier, fence, crates (own pad, hold pad, the parent's
// inbox, the dock's slots) and the twelve plan-board step lamps. Nothing here moves; cues are slice 4.
import { Color, Matrix4 } from 'three'
import type { FloorModel, Lamp, Pose } from '../../../../lib/factory/types'
import { BOARD_CENTER, DOCK_CENTER, GANTRY_TOP } from '../../../../lib/factory/layout'
import { routeSegments, ROUTE_STRIPE_W } from '../../../../lib/factory/routes'
import { CRATE_PITCH, type Anchor, type LodBand, type ObjectKit } from '../builders/types'
import type { InstanceSpec } from './instancing'
import { bodyMatrix, poseBody, type PoseLibrary } from './poses'

/**
 * What the engine draws (slice 3 contract): the pure floor model (lib/factory/model.ts: layout, per-worker lamp, pose,
 * shutter, barrier, fence, crate; board; dock count; hall level) and the selection. The plan board is drawn when
 * `model.board` is present (live with a plan).
 */
export interface EngineFloor {
  model: FloorModel
  selectedId: string | null
}

export type KitName =
  | 'booth' | 'dock' | 'board' | 'lead' | 'bench' | 'machine0' | 'machine1' | 'machine2' | 'machine3' | 'stack' | 'robot'
  | 'paint' | 'vacant' | 'ring' | 'blob'
  | 'shutter' | 'barrier' | 'fence' | 'crate' | 'holdPad' | 'holdPadStriped' | 'boardLamp'

export const KIT_NAMES: readonly KitName[] = [
  'booth', 'dock', 'board', 'lead', 'bench', 'machine0', 'machine1', 'machine2', 'machine3', 'stack', 'robot',
  'paint', 'vacant', 'ring', 'blob',
  'shutter', 'barrier', 'fence', 'crate', 'holdPad', 'holdPadStriped', 'boardLamp'
]

export type BoardLampState = 'pending' | 'active' | 'done' | 'blocked' | 'skipped'

/** The selection ring around the booth is scaled to its 6 x 4 m footprint. */
export const BOOTH_RING_SCALE = 1.9
/** Stack lights are drawn this much larger in the far band (Technical Artist's advice: lamps 2 to 4 px at ppm 7 to 12). */
export const FAR_STACK_SCALE = 1.8
/** Crates drawn on one inbox (a 2 x 2 grid from the 'inbox' anchor); more are counted in the DOM only. */
export const INBOX_CRATES = 4
/** Crates drawn on the dock (its 3 x 3 slots); the tenth and later are counted on its label. */
export const DOCK_CRATES = 9
export const BOARD_LAMP_COUNT = 12
const ROBOT_BLOB = 1.1
const CRATE_BLOB = 0.9

export interface FloorContext {
  /** The kit for a pool (an empty kit when the kit source does not build it yet). */
  kit(name: KitName): ObjectKit
  /** Top of a kit's geometry in its own frame (a crate on a hold pad sits on it). */
  top(name: KitName): number
  band: LodBand
  /** Lit and off lamp colours (status tokens; 'off' is the theme's lamp-off colour). */
  lamps: Readonly<Record<Lamp, Color>>
  /** Plan step lamp colour per step state (the theme's boardLampColour, or the fallback). */
  boardLamp(state: BoardLampState): Color
  poses: PoseLibrary
}

export function emptyLists(): Record<KitName, InstanceSpec[]> {
  const out = {} as Record<KitName, InstanceSpec[]>
  for (const n of KIT_NAMES) out[n] = []
  return out
}

export function anchorMatrix(a: Anchor | undefined): Matrix4 {
  const m = new Matrix4()
  if (!a) return m
  m.makeRotationY(a.rotY)
  m.setPosition(a.x, a.y, a.z)
  return m
}

const place = (x: number, y: number, z: number): Matrix4 => new Matrix4().makeTranslation(x, y, z)

/** Instance lists of every pool for `floor`. Pure apart from three's math classes. */
export function floorInstances(floor: EngineFloor, ctx: FloorContext): Record<KitName, InstanceSpec[]> {
  const { layout, mode, workers } = floor.model
  const live = mode === 'live'
  const lists = emptyLists()
  const poseOf = (id: string): Pose => workers[id]?.pose ?? 'rest'
  const lampColours = (lamp: Lamp): Record<string, Color> => ({
    'lamp.top': lamp === 'failed' ? ctx.lamps.failed : ctx.lamps.off,
    'lamp.middle': lamp === 'needs-you' ? ctx.lamps['needs-you'] : ctx.lamps.off,
    'lamp.bottom': lamp === 'running' ? ctx.lamps.running : ctx.lamps.off
  })
  // Far band: stack lights grow so the 0.36 m lamps stay a few pixels wide (lamps stay readable, section 4.5).
  const s = ctx.band === 'far' ? FAR_STACK_SCALE : 1
  const stackScale = new Matrix4().makeScale(s, s, s)
  const stackAt = (base: Matrix4, a: Anchor | undefined): Matrix4 => base.clone().multiply(anchorMatrix(a)).multiply(stackScale)
  const blob = (key: string, m: Matrix4, size: number): void => {
    lists.blob.push({ key, matrix: m.clone().multiply(new Matrix4().makeScale(size, 1, size)) })
  }
  const robotAt = (id: string, key: string, base: Matrix4, kit: ObjectKit): void => {
    const pose = poseOf(id)
    const m = base.clone().multiply(bodyMatrix(poseBody(pose, kit.anchors)))
    lists.robot.push({ key, matrix: m, parts: ctx.poses.parts(pose) })
    blob(`robot:${key}`, m, ROBOT_BLOB)
  }
  const crateAt = (key: string, m: Matrix4, lamp: Lamp): void => {
    lists.crate.push({ key, matrix: m, colours: { 'crate.lamp': ctx.lamps[lamp] ?? ctx.lamps.off } })
    blob(`crate:${key}`, m, CRATE_BLOB)
  }

  /** Station frames by id (booth included), for the state props and the parents' inboxes. */
  const frames = new Map<string, { base: Matrix4; kit: ObjectKit; booth: boolean }>()
  const boothId = layout.booth ? layout.order.find((i) => layout.stations[i]?.kind === 'booth') : undefined
  if (layout.booth) {
    const kit = ctx.kit('booth')
    const base = place(layout.booth.x, GANTRY_TOP, layout.booth.z)
    if (boothId) frames.set(boothId, { base, kit, booth: true })
    lists.booth.push({ key: 'booth', matrix: base })
    if (kit.anchors?.robot) robotAt(boothId ?? '', boothId ?? 'booth', base, kit)
    if (live && kit.anchors?.stackLight) lists.stack.push({ key: boothId ?? 'booth', matrix: stackAt(base, kit.anchors.stackLight), colours: lampColours(workers[boothId ?? '']?.lamp ?? 'off') })
    if (boothId && floor.selectedId === boothId) lists.ring.push({ key: 'ring', matrix: base.clone().multiply(new Matrix4().makeScale(BOOTH_RING_SCALE, 1, BOOTH_RING_SCALE * 0.7)) })
  }
  if (live) {
    const dockBase = place(DOCK_CENTER.x, GANTRY_TOP, DOCK_CENTER.z)
    lists.dock.push({ key: 'dock', matrix: dockBase })
    const dockKit = ctx.kit('dock')
    const n = Math.min(Math.max(0, Math.floor(floor.model.dockCrates)), DOCK_CRATES)
    for (let i = 0; i < n; i++) {
      const a = dockKit.anchors?.[`slot.${i}`]
      if (a) crateAt(`dock:${i}`, dockBase.clone().multiply(anchorMatrix(a)), 'off')
    }
    const board = floor.model.board
    if (board) {
      const boardBase = place(BOARD_CENTER.x, GANTRY_TOP, BOARD_CENTER.z)
      // The slice 2 kit's merged 'board.lamps' part (if still present) stays off; the step lamps are boardLamp() instances.
      lists.board.push({ key: 'board', matrix: boardBase, colours: { 'board.lamps': ctx.lamps.off } })
      const boardKit = ctx.kit('board')
      for (let i = 0; i < BOARD_LAMP_COUNT; i++) {
        const a = boardKit.anchors?.[`lamp.${i}`]
        if (!a) continue
        const state = board.lamps[i]
        const colour = state ? ctx.boardLamp(state) : ctx.lamps.off
        // The lens geometry is already tilted onto the panel normal: translation only.
        const m = boardBase.clone().multiply(place(a.x, a.y, a.z))
        const lens: Record<string, Color> = {}
        for (const p of ctx.kit('boardLamp').parts) if (p.instanceColor) lens[p.key] = colour
        lists.boardLamp.push({ key: `lamp:${i}`, matrix: m, colours: lens })
      }
    }
  }
  for (const id of layout.order) {
    const st = layout.stations[id]
    if (!st || st.kind === 'booth') continue
    const kitName: KitName = st.kind === 'lead' ? 'lead' : 'bench'
    const kit = ctx.kit(kitName)
    const base = place(st.center.x, 0, st.center.z)
    frames.set(id, { base, kit, booth: false })
    lists[kitName].push({ key: id, matrix: base })
    if (st.kind === 'bench') lists[`machine${st.variant}` as KitName].push({ key: id, matrix: base.clone().multiply(anchorMatrix(kit.anchors?.machine)) })
    if (live) lists.stack.push({ key: id, matrix: stackAt(base, kit.anchors?.stackLight), colours: lampColours(workers[id]?.lamp ?? 'off') })
    robotAt(id, id, base, kit)
    if (floor.selectedId === id) lists.ring.push({ key: 'ring', matrix: base })
  }

  // State props of every worker on the floor (booth included where the booth kit names the anchor).
  const inbox = new Map<string, string[]>()
  for (const id of layout.order) {
    const w = workers[id]
    const frame = frames.get(id)
    if (!w || !frame) continue
    const { base, kit } = frame
    // Stations take a missing anchor as the station origin (builders/types.ts); the booth has no fallback spot.
    const at = (name: string): Matrix4 | null => {
      const a = kit.anchors?.[name]
      if (!a && frame.booth) return null
      return base.clone().multiply(anchorMatrix(a))
    }
    const prop = (pool: 'shutter' | 'barrier' | 'fence', anchor: string | null): void => {
      if (frame.booth && !anchor) return
      const m = anchor ? at(anchor) : base.clone()
      if (m) lists[pool].push({ key: id, matrix: m })
    }
    if (w.shutter) prop('shutter', 'shutter')
    if (w.barrier) prop('barrier', 'barrier')
    if (w.fenced) prop('fence', null)
    const crate = w.crate
    if (!crate) continue
    if (crate.at === 'pad') {
      const m = at('pad')
      if (m) crateAt(id, m, crate.lamp)
    } else if (crate.at === 'hold' || crate.at === 'hold-striped') {
      const m = at('hold')
      if (!m) continue
      const pad: KitName = crate.at === 'hold' ? 'holdPad' : 'holdPadStriped'
      lists[pad].push({ key: id, matrix: m })
      crateAt(id, m.clone().multiply(place(0, ctx.top(pad), 0)), crate.lamp)
    } else if (crate.at === 'parent-pad') {
      const st = layout.stations[id]
      const parent = st ? layout.lines.find((l) => l.number === st.line)?.leadId : undefined
      if (!parent || parent === id || !frames.has(parent)) continue
      const list = inbox.get(parent) ?? []
      list.push(id)
      inbox.set(parent, list)
    }
    // 'dock' crates are the dock's count, drawn on its slots above.
  }
  for (const [parent, ids] of inbox) {
    const frame = frames.get(parent)!
    const a = frame.kit.anchors?.inbox
    if (!a && frame.booth) continue
    const origin = frame.base.clone().multiply(anchorMatrix(a))
    ids.slice(0, INBOX_CRATES).forEach((id, i) => {
      const m = origin.clone().multiply(place((i % 2) * CRATE_PITCH, 0, Math.floor(i / 2) * CRATE_PITCH))
      crateAt(id, m, workers[id]?.crate?.lamp ?? 'off')
    })
  }

  for (const v of layout.vacant) lists.vacant.push({ key: v.id, matrix: place(v.center.x, 0, v.center.z) })
  routeSegments(layout.routes).forEach((seg, i) => {
    const m = new Matrix4().makeRotationY(seg.rotY)
    m.setPosition(seg.center.x, 0, seg.center.z)
    m.multiply(new Matrix4().makeScale(seg.length, 1, ROUTE_STRIPE_W))
    lists.paint.push({ key: `${seg.line}:${i}`, matrix: m })
  })
  return lists
}
