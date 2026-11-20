// Factory Floor cue drawing (docs/design/factory-floor.md sections 5.1 to 5.3, slice 4). Each frame the engine hands this
// module the end-state instance lists (engine/floorInstances.ts), the active cues and the ambient set from its CueFeed;
// it returns replacement lists for the pools a cue or a loop touches this frame. Three's math classes only: no scene, no
// renderer, no clock of its own (`now` comes in), no cue timing (lib/factory/cues.ts owns that).
//
// While a cue covers an end state, that end state is taken out of the lists (the child station while its work-order tote
// flies or its arrive waits; a crate at its destination before it lands). Moving things are drawn in their own pools
// ('tote', 'capsule', 'part', 'crateFlight') that never cast shadows; each gets a blob instead. There is no per-instance
// opacity with shared materials, so every fade (a capsule into the roof, a part into its bin, a cancelled cue, a leaving
// station) is a fade by scale.
import { Color, Matrix4, Vector3 } from 'three'
import type { ActiveCue, Ambient, FloorModel } from '../../../../lib/factory/types'
import {
  AMBIENT_PHASE_MS,
  ambientWave,
  ARRIVE_SCALE_FROM,
  FACTORY_CYCLE_MS,
  CRATE_APEX,
  cueEase,
  PART_BELT_M,
  PART_DROP_MS,
  PART_MS,
  PART_POP_MS,
  PART_RIDE_MS,
  SCREEN_GLOW_MAX,
  SCREEN_GLOW_MIN
} from '../../../../lib/factory/motion'
import { arcApex } from '../../../../lib/factory/routes'
import { GANTRY_MAX_Z, GANTRY_MIN_Z, GANTRY_TOP } from '../../../../lib/factory/layout'
import { CAPSULE_COALESCED_SCALE, type Anchor, type LodBand, type ObjectKit, type PartSpec } from '../builders/types'
import type { InstanceSpec } from './instancing'
import { anchorMatrix, CRATE_BLOB, ROBOT_BLOB, stationFrame, type EngineFloor, type KitName } from './floorInstances'
import { bodyMatrix, type PoseLibrary } from './poses'

export type AmbientMap = ReadonlyMap<string, { kind: Exclude<Ambient, 'none'>; phase: number }>
export type BaseLists = Readonly<Record<KitName, readonly InstanceSpec[]>>

/** Pools whose instances belong to one station (keyed by the agent id; the booth body is keyed 'booth'). */
export const STATION_POOLS: readonly KitName[] = [
  'booth', 'lead', 'bench', 'machine0', 'machine1', 'machine2', 'machine3', 'stack', 'robot',
  'shutter', 'barrier', 'fence', 'holdPad', 'holdPadStriped'
]

/** Carriers fly this far above their stations' floor (or deck) height at both ends, metres (out of the desk, into it). */
export const CARRIER_LIFT = 1
/** A barrier drops from this far above its end state (section 5.2: "drops across the station front"). */
export const BARRIER_RAISE = 0.6
/** A shutter unrolls from this fraction of its height (never a zero scale, which would make a degenerate matrix). */
const SHUTTER_FROM = 0.04
/** Blob sizes under carriers and parts, metres across. */
export const CARRIER_BLOB = 0.7
export const PART_BLOB = 0.3
/** Where a tool part pops when the station kit names no 'outfeed' anchor: on the belt in front of the machine (station frame). */
export const PART_OUTFEED: Anchor = { x: 0.1, y: 0.28, z: 0.6, rotY: 0 }
/** From the end of its ride, a part drops this far down and forward into the bin (outfeed frame). */
const PART_DROP = { y: -0.22, z: 0.5 }

export interface CueRenderContext {
  kit(name: KitName): ObjectKit
  poses: PoseLibrary
  band: LodBand
  /** Lamp colour of a crate in flight whose end state was not found (the lamp-off colour). */
  offLamp: Color
}

export interface CueOverlay {
  /** Replacement lists for the pools touched this frame; every other pool draws its base list. */
  lists: Partial<Record<KitName, InstanceSpec[]>>
  /** The hall dim tween at this frame (eased), or null. */
  hall: { from: FloorModel['hall']; to: FloorModel['hall']; t: number } | null
}

const EMPTY: CueOverlay = { lists: {}, hall: null }

/** Floor height under a world point: the gantry deck's top between its z limits, else the hall floor. */
export function groundY(z: number): number {
  return z >= GANTRY_MIN_Z && z <= GANTRY_MAX_Z ? GANTRY_TOP : 0
}

/** A machine part's ambient stroke at wave w (0 to 1) as a local matrix about its pivot (builders/types.ts PartSpec.stroke). */
export function strokeMatrix(stroke: NonNullable<PartSpec['stroke']>, w: number): Matrix4 {
  const a = stroke.amount * w
  switch (stroke.kind) {
    case 'translateY':
      return new Matrix4().makeTranslation(0, a, 0)
    case 'translateX':
      return new Matrix4().makeTranslation(a, 0, 0)
    default: {
      const p = stroke.pivot ?? { x: 0, y: 0, z: 0 }
      const r = stroke.kind === 'rotateY' ? new Matrix4().makeRotationY(a) : new Matrix4().makeRotationZ(a)
      return new Matrix4().makeTranslation(p.x, p.y, p.z).multiply(r).multiply(new Matrix4().makeTranslation(-p.x, -p.y, -p.z))
    }
  }
}

/**
 * A rotation of a whole turn (the spindle) runs one way round: a sawtooth over the cycle instead of the 0..1..0 wave, so
 * it never turns back. Seamless, since a full turn ends where it started.
 */
export function isFullTurn(stroke: NonNullable<PartSpec['stroke']>): boolean {
  return (stroke.kind === 'rotateY' || stroke.kind === 'rotateZ') && Math.abs(stroke.amount) >= 2 * Math.PI - 1e-6
}
/** Linear position 0 to 1 in the ambient cycle at `now` for phase index `phase` (same clock and offset as ambientWave). */
export function cycleFraction(now: number, phase: number): number {
  return ((((now - phase * AMBIENT_PHASE_MS) % FACTORY_CYCLE_MS) + FACTORY_CYCLE_MS) % FACTORY_CYCLE_MS) / FACTORY_CYCLE_MS
}

/** Screen glow level at wave w: SCREEN_GLOW_MIN at rest to SCREEN_GLOW_MAX (the static level). */
export function screenLevel(w: number): number {
  return SCREEN_GLOW_MIN + (SCREEN_GLOW_MAX - SCREEN_GLOW_MIN) * Math.min(1, Math.max(0, w))
}

/** Translation, yaw about +y, uniform scale. */
function trs(x: number, y: number, z: number, yaw: number, s: number): Matrix4 {
  const m = new Matrix4().makeRotationY(yaw)
  if (s !== 1) m.multiply(new Matrix4().makeScale(s, s, s))
  m.setPosition(x, y, z)
  return m
}

/** Scale about a point: T(c) * S * T(-c). */
function scaleAbout(c: Vector3, sx: number, sy: number, sz: number): Matrix4 {
  return new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeScale(sx, sy, sz)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z))
}

const blobAt = (key: string, x: number, z: number, size: number): InstanceSpec => ({
  key,
  matrix: new Matrix4().makeScale(size, 1, size).setPosition(x, groundY(z), z)
})

/** Yaw that turns +x along the horizontal direction (dx, dz) (routes.ts uses the same convention). */
const yawAlong = (dx: number, dz: number): number => (Math.abs(dx) + Math.abs(dz) < 1e-9 ? 0 : -Math.atan2(dz, dx))

/** Ghost data of a station that was on the floor: its base entries per pool and its centre. */
interface Known {
  centre: Vector3
  pools: Map<KitName, InstanceSpec[]>
}

export class CueRenderer {
  /** The last end-state entries of every station seen, so a leaving station or a raising shutter can still be drawn. */
  private readonly known = new Map<string, Known>()
  private readonly tops = new WeakMap<ObjectKit, number>()

  /** Records the end-state entries of every station in `base` (call after each floorInstances). */
  observe(base: BaseLists, model: FloorModel): void {
    const fresh = new Map<string, Known>()
    const { layout } = model
    const boothId = layout.order.find((i) => layout.stations[i]?.kind === 'booth')
    const entry = (id: string): Known | null => {
      let k = fresh.get(id)
      if (!k) {
        const st = layout.stations[id]
        if (!st) return null
        const booth = st.kind === 'booth'
        const c = booth ? (layout.booth ?? st.center) : st.center
        k = { centre: new Vector3(c.x, booth ? GANTRY_TOP : 0, c.z), pools: new Map() }
        fresh.set(id, k)
      }
      return k
    }
    const add = (id: string, pool: KitName, spec: InstanceSpec): void => {
      const k = entry(id)
      if (!k) return
      const list = k.pools.get(pool) ?? []
      list.push(spec)
      k.pools.set(pool, list)
    }
    for (const pool of STATION_POOLS) {
      for (const spec of base[pool]) {
        const id = pool === 'booth' && spec.key === 'booth' ? boothId : spec.key
        if (id) add(id, pool, spec)
      }
    }
    for (const spec of base.blob) if (spec.key.startsWith('robot:')) add(spec.key.slice(6), 'blob', spec)
    for (const [id, k] of fresh) this.known.set(id, k)
  }

  /** Forgets every station (engine dispose). */
  clear(): void {
    this.known.clear()
  }

  /**
   * The overlay for one frame. `cues` and `ambient` are empty unless motion is 'full' (the engine's CueFeed); with both
   * empty the result is empty and every pool draws its end state.
   */
  overlay(base: BaseLists, floor: EngineFloor, cues: readonly ActiveCue[], ambient: AmbientMap, now: number, ctx: CueRenderContext): CueOverlay {
    if (cues.length === 0 && ambient.size === 0) return EMPTY
    const { layout } = floor.model
    const work = new Map<KitName, InstanceSpec[]>()
    const touch = (name: KitName): InstanceSpec[] => {
      let l = work.get(name)
      if (!l) work.set(name, (l = base[name].slice()))
      return l
    }
    /** Rewrites (or with null removes) the entries of a pool with this key. */
    const edit = (name: KitName, key: string, fn: (s: InstanceSpec) => InstanceSpec | null): void => {
      if (!base[name].some((s) => s.key === key) && !work.has(name)) return
      const l = touch(name)
      for (let i = l.length - 1; i >= 0; i--) {
        if (l[i].key !== key) continue
        const r = fn(l[i])
        if (r) l[i] = r
        else l.splice(i, 1)
      }
    }
    const isBooth = (id: string): boolean => layout.stations[id]?.kind === 'booth'
    const keyIn = (pool: KitName, id: string): string => (pool === 'booth' ? (isBooth(id) ? 'booth' : '\u0000') : id)
    const centreOf = (id: string): Vector3 | null => {
      const st = layout.stations[id]
      if (!st) return null
      if (st.kind === 'booth') {
        const c = layout.booth ?? st.center
        return new Vector3(c.x, GANTRY_TOP, c.z)
      }
      return new Vector3(st.center.x, 0, st.center.z)
    }
    const kitOf = (name: KitName): ObjectKit => ctx.kit(name)
    let hall: CueOverlay['hall'] = null

    // ---- ambient loops (section 5.1): machine stroke and screen glow, only for the stations in the set ----
    for (const [id, a] of ambient) {
      const frame = stationFrame(layout, id, kitOf)
      if (!frame) continue
      const st = layout.stations[id]
      const w = ambientWave(now, a.phase)
      if (a.kind === 'machine' && st?.kind === 'bench') {
        const name = `machine${st.variant}` as KitName
        const strokes = ctx.kit(name).parts.filter((p) => p.stroke)
        if (strokes.length) {
          edit(name, id, (s) => {
            const parts: Record<string, Matrix4> = { ...(s.parts ?? {}) }
            for (const p of strokes) parts[p.key] = strokeMatrix(p.stroke!, isFullTurn(p.stroke!) ? cycleFraction(now, a.phase) : w)
            return { ...s, parts }
          })
          continue
        }
      }
      // Screen glow: starting, thinking, delegating; also a lead or the booth in a tool state (they have no machine).
      if (a.kind === 'machine' && st?.kind === 'bench') continue
      const screens = frame.kit.parts.filter((p) => p.screen && p.instanceColor)
      if (!screens.length) continue
      const level = screenLevel(w)
      const grey = new Color(level, level, level)
      edit(frame.kitName, keyIn(frame.kitName, id), (s) => {
        const colours: Record<string, Color> = { ...(s.colours ?? {}) }
        for (const p of screens) colours[p.key] = grey
        return { ...s, colours }
      })
    }

    // ---- what is hidden or growing this frame ----
    const hidden = new Set<string>()
    const arriving = new Map<string, number>()
    for (const c of cues) {
      if (c.kind === 'tote' && typeof c.to === 'string' && c.to !== 'dock') hidden.add(c.to)
      else if (c.kind === 'arrive' && c.from) {
        if (c.progress <= 0) hidden.add(c.from)
        else arriving.set(c.from, ARRIVE_SCALE_FROM + (1 - ARRIVE_SCALE_FROM) * cueEase('arrive', c.progress))
      }
    }
    for (const id of arriving.keys()) hidden.delete(id)

    for (const c of cues) {
      const fade = Math.max(0, Math.min(1, c.opacity))
      switch (c.kind) {
        case 'pose': {
          if (!c.from || !c.pose) break
          const id = c.from
          const frame = stationFrame(layout, id, kitOf)
          if (!frame) break
          const { body, parts } = ctx.poses.blend(c.pose.from, c.pose.to, cueEase('pose', c.progress), frame.kit.anchors)
          const m = frame.base.clone().multiply(bodyMatrix(body))
          edit('robot', id, (s) => ({ ...s, matrix: m, parts }))
          edit('blob', `robot:${id}`, (s) => ({ ...s, matrix: m.clone().multiply(new Matrix4().makeScale(ROBOT_BLOB, 1, ROBOT_BLOB)) }))
          break
        }
        case 'shutter':
        case 'barrier': {
          if (!c.from) break
          const id = c.from
          const pool: KitName = c.kind
          const e = cueEase(c.kind, c.progress)
          // Lowering: the end state is in the base list. Raising: the end state has none; the last known one goes up.
          const down = c.lower !== false
          const amount = down ? e : 1 - e
          const local = (s: InstanceSpec): Matrix4 => {
            if (pool === 'barrier') return s.matrix.clone().multiply(new Matrix4().makeTranslation(0, BARRIER_RAISE * (1 - amount), 0))
            const top = this.top(ctx.kit('shutter'))
            const sy = SHUTTER_FROM + (1 - SHUTTER_FROM) * amount
            return s.matrix.clone().multiply(scaleAbout(new Vector3(0, top, 0), 1, sy, 1))
          }
          if (down) edit(pool, id, (s) => ({ ...s, matrix: local(s) }))
          else if (!base[pool].some((s) => s.key === id)) {
            for (const s of this.known.get(id)?.pools.get(pool) ?? []) touch(pool).push({ ...s, key: `raise:${id}`, matrix: local(s) })
          }
          break
        }
        case 'leave': {
          if (!c.from || layout.stations[c.from]) break
          const k = this.known.get(c.from)
          if (!k) break
          const s = (1 - cueEase('leave', c.progress)) * fade
          if (s <= 1e-3) break
          const m = scaleAbout(k.centre, s, s, s)
          for (const [pool, specs] of k.pools) {
            const list = touch(pool)
            for (const spec of specs) list.push({ ...spec, key: `leave:${spec.key}`, matrix: m.clone().multiply(spec.matrix) })
          }
          break
        }
        case 'tote':
        case 'capsule': {
          if (!c.path) break
          const e = cueEase(c.kind, c.progress)
          const { from, to, fromY, toY } = c.path
          let scale = (c.kind === 'capsule' && (c.count ?? 1) > 1 ? CAPSULE_COALESCED_SCALE : 1) * fade
          let x: number
          let y: number
          let z: number
          let yaw: number
          if (c.kind === 'capsule' && c.to === null) {
            // Into the roof: straight up from the sender, shrinking away over the second half.
            x = from.x
            z = from.z
            y = fromY + (toY - fromY) * e + CARRIER_LIFT
            yaw = 0
            scale *= c.progress < 0.5 ? 1 : Math.max(0, 1 - (c.progress - 0.5) / 0.5)
          } else {
            const apex = arcApex(from, to)
            x = from.x + (to.x - from.x) * e
            z = from.z + (to.z - from.z) * e
            y = fromY + (toY - fromY) * e + CARRIER_LIFT + 4 * apex * e * (1 - e)
            yaw = yawAlong(to.x - from.x, to.z - from.z)
          }
          if (scale <= 1e-3) break
          touch(c.kind).push({ key: c.id, matrix: trs(x, y, z, yaw, scale) })
          const h = y - groundY(z)
          touch('blob').push(blobAt(`cue:${c.id}`, x, z, CARRIER_BLOB * scale * Math.min(1, Math.max(0.35, 1 - h / 10))))
          break
        }
        case 'crate': {
          if (!c.from) break
          const id = c.from
          const endKey = c.dest === 'dock' ? (c.slot !== undefined && c.slot < 9 ? `dock:${c.slot}` : null) : id
          // A dock crate with no slot lands at once (the dock's count says it).
          if (c.dest === 'dock' && endKey === null) break
          const endSpec = endKey ? base.crate.find((s) => s.key === endKey) : undefined
          if (endSpec) {
            edit('crate', endSpec.key, () => null)
            edit('blob', `crate:${endSpec.key}`, () => null)
          }
          const frame = stationFrame(layout, id, kitOf)
          const pad = frame?.kit.anchors?.pad
          const start = new Vector3()
          if (frame && (pad || !frame.booth)) start.setFromMatrixPosition(frame.base.clone().multiply(anchorMatrix(pad)))
          else if (c.path) start.set(c.path.from.x, c.path.fromY, c.path.from.z)
          else break
          const end = new Vector3()
          if (endSpec) end.setFromMatrixPosition(endSpec.matrix)
          else if (c.path) end.set(c.path.to.x, c.path.toY, c.path.to.z)
          else break
          const e = cueEase('crate', c.progress)
          const apex = c.dest === 'hold' ? 0 : CRATE_APEX
          const p = start.clone().lerp(end, e)
          p.y += 4 * apex * e * (1 - e)
          if (fade <= 1e-3) break
          const colours = endSpec?.colours ?? { 'crate.lamp': ctx.offLamp }
          touch('crateFlight').push({ key: c.id, matrix: trs(p.x, p.y, p.z, 0, fade), colours })
          touch('blob').push(blobAt(`cue:${c.id}`, p.x, p.z, CRATE_BLOB * fade))
          break
        }
        case 'part': {
          // Parts are not shown in the far band (section 4.5); the booth has no belt.
          if (!c.from || ctx.band === 'far') break
          const frame = stationFrame(layout, c.from, kitOf)
          if (!frame || frame.booth || hidden.has(c.from)) break
          const ms = Math.min(1, Math.max(0, c.progress)) * PART_MS
          let lz = 0
          let ly = 0
          let s = 1
          if (ms < PART_POP_MS) s = ms / PART_POP_MS
          else if (ms < PART_POP_MS + PART_RIDE_MS) lz = (PART_BELT_M * (ms - PART_POP_MS)) / PART_RIDE_MS
          else {
            const u = Math.min(1, (ms - PART_POP_MS - PART_RIDE_MS) / PART_DROP_MS)
            lz = PART_BELT_M + PART_DROP.z * u
            ly = PART_DROP.y * u
            s = 1 - u
          }
          s *= fade
          if (s <= 1e-3) break
          const outfeed = frame.kit.anchors?.outfeed ?? PART_OUTFEED
          const m = frame.base.clone().multiply(anchorMatrix(outfeed)).multiply(trs(0, ly, lz, 0, s))
          touch('part').push({ key: c.id, matrix: m })
          const at = new Vector3().setFromMatrixPosition(m)
          const blob = new Matrix4().makeScale(PART_BLOB * s, 1, PART_BLOB * s).setPosition(at.x, frame.base.elements[13] + outfeed.y + ly, at.z)
          touch('blob').push({ key: `cue:${c.id}`, matrix: blob })
          break
        }
        case 'hall':
          if (c.hall) hall = { from: c.hall.from, to: c.hall.to, t: cueEase('hall', c.progress) }
          break
        default:
          break
      }
    }

    // ---- stations rising (arrive) and stations not there yet (tote in flight, arrive waiting) ----
    for (const [id, s] of arriving) {
      const c = centreOf(id)
      if (!c) continue
      const m = scaleAbout(c, 1, s, 1)
      for (const pool of STATION_POOLS) edit(pool, keyIn(pool, id), (spec) => ({ ...spec, matrix: m.clone().multiply(spec.matrix) }))
    }
    for (const id of hidden) {
      for (const pool of STATION_POOLS) edit(pool, keyIn(pool, id), () => null)
      edit('blob', `robot:${id}`, () => null)
    }

    if (work.size === 0 && !hall) return EMPTY
    return { lists: Object.fromEntries(work) as Partial<Record<KitName, InstanceSpec[]>>, hall }
  }

  /** Top of a kit's geometry in its own frame (cached per kit). */
  private top(kit: ObjectKit): number {
    let t = this.tops.get(kit)
    if (t === undefined) {
      t = 0
      for (const p of kit.parts) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        t = Math.max(t, p.geometry.boundingBox!.max.y)
      }
      this.tops.set(kit, t)
    }
    return t
  }
}
