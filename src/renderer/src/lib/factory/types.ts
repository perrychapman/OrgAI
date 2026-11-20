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
  vacant: { line: number; row: number; slot: number; center: Vec2 }[]
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
export interface Cue {
  id: string
  kind: CueKind
  /** Station the cue belongs to (arrive, leave, part, shutter, barrier, pose) or starts from (tote, capsule, crate). */
  from?: string
  /** Target station; null for a capsule leaving the floor; 'dock' for a crate merged into the main checkout. */
  to?: string | null | 'dock'
  count?: number
  start: number
  duration: number
}
export interface ActiveCue extends Cue {
  progress: number
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
    ambient: Ambient
  }[]
  lines: { number: number; leadId: string; rows: number[] }[]
  vacant: number
  cues: { kind: CueKind; from?: string; to?: string | null }[]
  cuesStarted: number
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
