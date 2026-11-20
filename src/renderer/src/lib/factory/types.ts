// Factory Floor scene contract (docs/design/factory-floor.md section 10.3). Pure types: no three, no DOM.
import type { AgentState, WorktreeStatus } from '@shared/types'
import type { StatusWord } from '../runStatus'

export interface FactoryAgentInput {
  id: string
  name: string
  parentId: string | null
  /** roleSlug (live) or role.id (team): equal keys share a machine silhouette. */
  roleKey: string
  handle?: string
  /** 'role' in team mode. */
  state: AgentState | 'role'
  statusWord: StatusWord | 'Role'
  activity: string
  toolCalls: number
  worktree?: { status: WorktreeStatus; mergeTarget: 'main' | 'parent' }
  startedAt: number
  session: 'current' | 'earlier'
}

export interface Vec2 {
  x: number
  z: number
}
export type StationKind = 'booth' | 'lead' | 'bench'
export interface PlacedStation {
  id: string
  kind: StationKind
  variant: 0 | 1 | 2 | 3
  line: number
  row: number
  slot: number
  center: Vec2
}
export interface FloorLine {
  number: number
  leadId: string
  rows: number[]
  count: number
}
export interface FloorRoute {
  line: number
  points: Vec2[]
  lane: number
}
export interface Bounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}
export interface FloorLayout {
  stations: Record<string, PlacedStation>
  /** Reading order: booth first, then rows north to south, slots west to east. */
  order: string[]
  lines: FloorLine[]
  /** Slots of agents that left the floor (never reused within a session); `id` is the agent that held the slot. */
  vacant: { id: string; line: number; row: number; slot: number; center: Vec2 }[]
  routes: FloorRoute[]
  rows: number
  hall: Bounds
  /** Fit target: booth, dock, board and stations. */
  content: Bounds
  booth: Vec2 | null
  dock: Vec2
  board: Vec2
}
export interface LayoutMemory {
  runKey: string
  lines: Record<string, { number: number; rows: number[]; count: number }>
  slots: Record<string, { lead: string; slot: number }>
  nextLine: number
  nextRow: number
}

export type Lamp = 'off' | 'running' | 'needs-you' | 'failed'
export type Pose = 'console' | 'machine' | 'dispatch' | 'signal' | 'rest' | 'docked' | 'down'
export type Ambient = 'none' | 'screen' | 'machine'
export type CrateAt = 'pad' | 'hold' | 'hold-striped' | 'dock' | 'parent-pad'
export interface WorkerModel {
  id: string
  name: string
  kind: StationKind
  statusWord: StatusWord | 'Role'
  activity: string
  lamp: Lamp
  pose: Pose
  ambient: Ambient
  shutter: boolean
  barrier: boolean
  fenced: boolean
  crate?: { at: CrateAt; lamp: Lamp }
  stepIds: string[]
}
export interface FloorModel {
  mode: 'live' | 'team'
  layout: FloorLayout
  workers: Record<string, WorkerModel>
  hall: 'on' | 'paused' | 'ended'
  board?: {
    total: number
    done: number
    blocked: number
    lamps: ('pending' | 'active' | 'done' | 'blocked' | 'skipped')[]
    overflow: number
  }
  dockCrates: number
  earlier: { id: string; name: string; statusWord: StatusWord }[]
}

export type CueKind = 'arrive' | 'leave' | 'tote' | 'capsule' | 'part' | 'crate' | 'shutter' | 'barrier' | 'pose' | 'hall'
/** Carriers count against the shared carrier cap of section 5.2 (6 in flight). */
export type CarrierKind = 'tote' | 'capsule'

/**
 * Slice 4 contract (section 5). A cue as `diffCues` asks for it, before the scheduler gives it an id and a start time.
 * Durations are already computed from distance and speed (lib/factory/motion.ts); `delay` is milliseconds after push
 * (an arrive that waits for its tote). Everything else the renderer needs to draw the cue is in here, so
 * engine/cueRender.ts never reads the model's history.
 */
export interface CueRequest {
  kind: CueKind
  /** Station the cue belongs to (arrive, leave, part, shutter, barrier, pose, hall: none) or starts from (tote, capsule, crate). */
  from?: string
  /** Target station; null for a capsule leaving the floor; 'dock' for a crate merged into the main checkout. */
  to?: string | null | 'dock'
  /** Coalesced messages in one capsule, or tool-call increases in one part (at least 1). */
  count?: number
  duration: number
  delay?: number
  /** World points (metres) resolved by diffCues from the layout, so a cue keeps its path after its stations leave. */
  path?: { from: Vec2; to: Vec2; fromY: number; toY: number }
  /** pose: the joint blend's start and end pose. */
  pose?: { from: Pose; to: Pose }
  /** shutter, barrier: true lowers it (the end state is down), false raises it. */
  lower?: boolean
  /** hall: light level tween. */
  hall?: { from: FloorModel['hall']; to: FloorModel['hall'] }
  /** crate: where it lands ('hold' slides to the hold pad, conflict and held). */
  dest?: 'dock' | 'parent-pad' | 'hold'
  /** crate: dock slot index it lands in (0 to 8), when `dest` is 'dock'. */
  slot?: number
}
export interface Cue extends CueRequest {
  id: string
  /** Absolute start time (the scheduler's clock: performance.now() milliseconds). */
  start: number
}
export interface ActiveCue extends Cue {
  /** Linear progress 0 to 1 (easing is applied by the renderer through motion.ts `cueEase`). */
  progress: number
  /** 1 normally; a cue cancelled because its station left fades to 0 over CANCEL_FADE_MS where it stopped. */
  opacity: number
}

/**
 * What one model change means (section 1.4, 6.5, 7.5), from `diffCues`: the cues to push (empty under reduced motion or
 * Pause motion is the caller's choice; diffCues always returns them), the floor log events and the new message cursor.
 */
export type FloorEvent =
  | { kind: 'assigned'; at: number; parent: string; child: string; childId: string }
  | { kind: 'started'; at: number; name: string }
  | { kind: 'message'; at: number; sender: string; recipient: string; text: string; offFloor: boolean }
  | { kind: 'state'; at: number; id: string; name: string; word: string }
  | { kind: 'merged'; at: number; name: string; into: 'main' | string }
  | { kind: 'branch'; at: number; id: string; name: string; status: 'conflict' | 'review' | 'held' | 'empty' }
  | { kind: 'plan'; at: number; done: number; total: number }
  | { kind: 'run'; at: number; status: 'paused' | 'resumed' | 'ended' }
  | { kind: 'left'; at: number; id: string; name: string }

/** One floor log line (section 6.5): `text` has no time; the strip prefixes the formatted `at`. Untrusted agent text is React text only. */
export interface FloorLogEntry {
  id: string
  at: number
  text: string
}

/** diffCues input: one moment of the floor. `agents` are current-session inputs; `messages` the store's last 100. */
export interface FloorFrame {
  model: FloorModel
  agents: readonly FactoryAgentInput[]
  messages: readonly { from: string; to: string | null; toHandle?: string; text: string; at: number }[]
}

/**
 * What the engine reads each frame (built by FactoryScene around its CueScheduler; the engine never owns cue timing).
 * `motion` other than 'full' means: draw end states, no cues, no ambient, render on demand only.
 */
export interface CueFeed {
  motion: 'full' | 'reduced' | 'paused'
  /** Active cues at `now` (performance.now() clock); advances the scheduler. */
  active(now: number): readonly ActiveCue[]
  /** True while a cue is active or waiting for its delay at `now`. */
  busy(now: number): boolean
  /** Looping stations (section 5.1) and their phase index (0 to 11; offset = index * AMBIENT_PHASE_MS). Empty unless motion is 'full'. */
  ambient(): ReadonlyMap<string, { kind: Exclude<Ambient, 'none'>; phase: number }>
}

/** The test hook, serialised into <output hidden data-testid="factory-state"> (lib/factory/snapshot.ts). */
export interface FactoryTestState {
  renderer: 'webgl2' | 'floor-plan'
  reason?: 'no-webgl2' | 'chunk-failed' | 'context-lost' | 'too-many' | 'forced'
  quality: 'high' | 'low' | 'minimal'
  mode: 'live' | 'team'
  motion: 'full' | 'reduced' | 'paused'
  workers: {
    id: string
    line: number
    row: number
    slot: number
    x: number
    z: number
    lamp: Lamp
    pose: Pose
    statusWord: string
    fenced: boolean
    crate?: CrateAt
    /** Slice 3: the crate's own lamp ('needs-you' for a merge review), present with `crate`. */
    crateLamp?: Lamp
    /** Slice 4: the loop this station runs NOW (inside the cap of 12, motion 'full' only); 'none' otherwise. */
    ambient: Ambient
    /** Slice 3: shutter down (finished) and striped barrier down (failed). */
    shutter: boolean
    barrier: boolean
    /** Slice 3: ids of the in-progress plan steps this worker owns (the nameplate chip). */
    stepIds: string[]
  }[]
  /** Slice 3: hall light level (section 1.4: paused dims, finished or error ends). */
  hall: 'on' | 'paused' | 'ended'
  /** Slice 3: the plan board (null without a plan or in team mode). */
  board: { total: number; done: number; blocked: number; lamps: ('pending' | 'active' | 'done' | 'blocked' | 'skipped')[]; overflow: number } | null
  /** Slice 3: crates merged into the main checkout (the dock's count, also beyond the nine drawn). */
  dockCrates: number
  /** Slice 3: agents of earlier sessions (listed in Find a worker only). */
  earlier: number
  lines: { number: number; leadId: string; rows: number[] }[]
  vacant: number
  /** Cues active (or waiting for their delay) at the write. Slice 4. */
  cues: { kind: CueKind; from?: string; to?: string | null; count?: number }[]
  /** Cues pushed into the scheduler since mount (0 under reduced motion, Pause motion and team mode). */
  cuesStarted: number
  /** Slice 4: the last 40 cues pushed since mount, oldest first (the test state is written at most twice a second, so short cues are read here). */
  recentCues: { kind: CueKind; from?: string; to?: string | null; count?: number }[]
  /**
   * Slice 4: the most seen at once since mount, for the caps of section 5.2: carriers in flight (cap 6), carriers in
   * flight from one sender (2), parts in flight (12), crates in flight (4), arrivals started in one 1 s window (12),
   * stations looping (12).
   */
  cuePeaks: { carriers: number; perSender: number; parts: number; crates: number; arrivalsPerSecond: number; ambient: number }
  /** Slice 4: floor log entries held (at most 50). */
  logEntries: number
  messageCursor: string | null
  view: { ppm: number; targetX: number; targetZ: number }
  loop: 'running' | 'idle' | 'stopped'
  frames: number
  engines: number
  perf?: {
    drawCalls: number
    shadowCalls: number
    triangles: number
    geometries: number
    textures: number
    frameP95Ms: number
    intervalP95Ms: number
    firstFrameMs: number
    gpu?: string
  }
}
