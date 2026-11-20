// The Factory Floor test hook (docs/design/factory-floor.md section 10.3): ids, numbers and words only, never message
// text. Serialised into <output hidden data-testid="factory-state">. Pure.
import type { ActiveCue, Ambient, Cue, FactoryTestState, FloorLayout, FloorModel, Lamp } from './types'

export const NO_PEAKS: FactoryTestState['cuePeaks'] = { carriers: 0, perSender: 0, parts: 0, crates: 0, arrivalsPerSecond: 0, ambient: 0 }
const cueRef = (c: Pick<Cue, 'kind' | 'from' | 'to' | 'count'>): FactoryTestState['cues'][number] => ({
  kind: c.kind,
  ...(c.from !== undefined ? { from: c.from } : {}),
  ...(c.to !== undefined ? { to: c.to } : {}),
  ...(c.count !== undefined && c.count > 1 ? { count: c.count } : {})
})

export type FactoryRendererKind = FactoryTestState['renderer']
export type FactoryReason = NonNullable<FactoryTestState['reason']>
export type FactoryQuality = FactoryTestState['quality']
export type FactoryMotion = FactoryTestState['motion']
export type FactoryLoop = FactoryTestState['loop']
export type FactoryPerf = NonNullable<FactoryTestState['perf']>
export type FactoryView = FactoryTestState['view']

/** A worker's static state while there is no FloorModel yet (slice 2: lamp and word; pose, props and ambient come with slice 3). */
export interface WorkerSummary {
  lamp: Lamp
  statusWord: string
}

/** What the scene knows at one moment. Slice 2 has the layout and static lamps; the model, cues and cursor come later. */
export interface FactorySnapshotInput {
  renderer: FactoryRendererKind
  reason?: FactoryReason
  quality: FactoryQuality
  /** Slice 6: the quality the mount started at; defaults to quality. */
  qualityStart?: FactoryQuality
  mode: 'live' | 'team'
  motion: FactoryMotion
  model?: FloorModel | null
  /** Used when `model` is absent: the layout and each worker's lamp and word (pose 'rest', ambient 'none', not fenced). */
  layout?: FloorLayout | null
  summaries?: Readonly<Record<string, WorkerSummary>>
  cues?: readonly ActiveCue[]
  cuesStarted?: number
  /** Slice 4: last pushed cues (kept at most 40, oldest first). */
  recentCues?: readonly Pick<Cue, 'kind' | 'from' | 'to' | 'count'>[]
  cuePeaks?: FactoryTestState['cuePeaks']
  logEntries?: number
  /** Slice 4: stations looping now; when given, a worker's `ambient` is its entry here or 'none'. */
  ambient?: ReadonlyMap<string, { kind: Exclude<Ambient, 'none'>; phase: number }>
  messageCursor?: string | null
  view?: FactoryView | null
  loop: FactoryLoop
  frames: number
  engines: number
  perf?: FactoryPerf | null
}

/** Motion word: Pause motion wins over reduced motion, which wins over full. */
export function motionState(reduced: boolean, paused: boolean): FactoryMotion {
  if (paused) return 'paused'
  return reduced ? 'reduced' : 'full'
}

const round = (n: number, places = 2): number => {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** places
  return Math.round(n * f) / f
}

const EMPTY_VIEW: FactoryView = { ppm: 0, targetX: 0, targetZ: 0 }

/** Builds the test state. Workers follow the layout's reading order; numbers are rounded to 2 places. */
export function factoryTestState(input: FactorySnapshotInput): FactoryTestState {
  const model = input.model ?? null
  const workers: FactoryTestState['workers'] = []
  if (model) {
    for (const id of model.layout.order) {
      const st = model.layout.stations[id]
      const w = model.workers[id]
      if (!st || !w) continue
      workers.push({
        id,
        line: st.line,
        row: st.row,
        slot: st.slot,
        x: round(st.center.x),
        z: round(st.center.z),
        lamp: w.lamp,
        pose: w.pose,
        statusWord: w.statusWord,
        fenced: w.fenced,
        ...(w.crate ? { crate: w.crate.at, crateLamp: w.crate.lamp } : {}),
        ambient: input.ambient ? (input.ambient.get(id)?.kind ?? 'none') : w.ambient,
        shutter: w.shutter,
        barrier: w.barrier,
        stepIds: [...w.stepIds]
      })
    }
  } else if (input.layout) {
    for (const id of input.layout.order) {
      const st = input.layout.stations[id]
      const w = input.summaries?.[id]
      if (!st || !w) continue
      workers.push({ id, line: st.line, row: st.row, slot: st.slot, x: round(st.center.x), z: round(st.center.z), lamp: w.lamp, pose: 'rest', statusWord: w.statusWord, fenced: false, ambient: 'none', shutter: false, barrier: false, stepIds: [] })
    }
  }
  const layout = model?.layout ?? input.layout ?? null
  const view = input.view ?? EMPTY_VIEW
  const perf = input.perf ?? null
  const state: FactoryTestState = {
    renderer: input.renderer,
    quality: input.quality,
    qualityStart: input.qualityStart ?? input.quality,
    mode: input.mode,
    motion: input.motion,
    workers,
    hall: model?.hall ?? 'on',
    board: model?.board ? { ...model.board, lamps: [...model.board.lamps] } : null,
    dockCrates: model?.dockCrates ?? 0,
    earlier: model?.earlier.length ?? 0,
    lines: layout ? layout.lines.map((l) => ({ number: l.number, leadId: l.leadId, rows: [...l.rows] })) : [],
    vacant: layout ? layout.vacant.length : 0,
    cues: (input.cues ?? []).map(cueRef),
    cuesStarted: input.cuesStarted ?? 0,
    recentCues: (input.recentCues ?? []).slice(-40).map(cueRef),
    cuePeaks: { ...(input.cuePeaks ?? NO_PEAKS) },
    logEntries: input.logEntries ?? 0,
    messageCursor: input.messageCursor ?? null,
    view: { ppm: round(view.ppm), targetX: round(view.targetX), targetZ: round(view.targetZ) },
    loop: input.loop,
    frames: input.frames,
    engines: input.engines
  }
  if (input.reason) state.reason = input.reason
  if (perf) {
    state.perf = {
      drawCalls: perf.drawCalls,
      shadowCalls: perf.shadowCalls,
      triangles: perf.triangles,
      geometries: perf.geometries,
      textures: perf.textures,
      frameP95Ms: round(perf.frameP95Ms),
      intervalP95Ms: round(perf.intervalP95Ms),
      firstFrameMs: round(perf.firstFrameMs),
      memoryBytes: perf.memoryBytes,
      pixelRatio: round(perf.pixelRatio),
      ...(perf.gpu ? { gpu: perf.gpu } : {})
    }
  }
  return state
}

/** 95th percentile (nearest rank) of a sample; 0 for an empty one. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

/** Minimum time between two writes of the test state outside model changes (section 10.3: at most twice a second). */
export const TEST_STATE_INTERVAL_MS = 500
