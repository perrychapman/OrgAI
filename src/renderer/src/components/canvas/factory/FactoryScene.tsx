// Factory Floor, the public component (docs/design/factory-floor.md section 10.2). Probes WebGL2, chooses the 3D view or
// the floor plan, lazy-loads the three chunk (FactoryCanvas), shows the section 8 notices, lays the floor out
// (lib/factory/layout.ts, append-only memory per run), owns the camera controller, the DOM mirror, the labels and the
// test state, and exposes the zoom / fit / focus handle. Slice 2: layout, stations, static lamps, camera, keyboard,
// labels; slice 3 the floor model. Slice 4: one CueScheduler per mount and run id fed by diffCues on every model change
// (never at mount), the floor log, announcements, the ambient set, Pause motion and the CueFeed the engine draws from.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import type { AgentMessage, RunPlan, RunStatus, WorktreeStatus } from '@shared/types'
import type { ActiveCue, Ambient, CueFeed, FactoryAgentInput, FactoryTestState, FloorEvent, FloorFrame, FloorLayout, FloorLogEntry, LayoutMemory } from '../../../lib/factory/types'
import { CueScheduler, diffCues } from '../../../lib/factory/cues'
import { ambientSet, motionSession } from '../../../lib/factory/motion'
import { AnnounceGate, appendLog } from '../../../lib/factory/floorLog'
import { projectFootprint } from '../../../lib/factory/camera'
import {
  CONTEXT_RESTORE_TIMEOUT_MS,
  cachedWebGL2Probe,
  factorySession,
  readForcedRenderer,
  recordContextLoss,
  resetWebGL2Probe,
  type ProbeCanvas,
  type WebGL2Probe
} from '../../../lib/factory/capability'
import { TEST_STATE_INTERVAL_MS, factoryTestState, motionState, type FactoryReason } from '../../../lib/factory/snapshot'
import {
  BOARD_CENTER,
  BOARD_SIZE,
  BOOTH_CENTER,
  BOOTH_SIZE,
  DOCK_CENTER,
  DOCK_SIZE,
  EMPTY_LAYOUT_MEMORY,
  GANTRY_TOP,
  HEAD_W,
  STATION_SIZE,
  layoutFloor,
  layoutTeam,
  lineSigns,
  pickRoot
} from '../../../lib/factory/layout'
import { PLAN_BOARD_ID, nextFocus, tabStop, floorKeyAction } from '../../../lib/factory/navigation'
import type { Box3, CameraView, Stage } from '../../../lib/factory/camera'
import { buildFloorModel } from '../../../lib/factory/model'
import { useReducedMotion } from '../../../lib/canvas'
import { tokenMs } from '../../../lib/useExitPresence'
import { useFrameAnnounce } from '../../layout/CanvasFrame'
import { FactoryMirror, placeAll, type MirrorBoard, type MirrorEntry, type PlacementRegistry, type PlanSign } from './FactoryMirror'
import { FactoryLabels, type FactoryLabelsHandle, type NameplateData, type SignData } from './FactoryLabels'
import { FactoryNotice, type FactoryNoticeKind } from './FactoryNotice'
import { FactoryControls } from './FactoryControls'
import { FactoryFind } from './FactoryFind'
import { FactoryLog } from './FactoryLog'
import { CameraController } from './cameraController'
import type { FactoryCanvasHandle, FactoryCanvasProps } from './FactoryCanvas'
import type { EngineFloor, FactoryEngineStats, KitHeights } from './engine/FactoryEngine'
import '../../../styles/factory.css'

export interface FactorySceneHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  /** Focuses the worker's button and pans it into view; false when the id is not on the floor. */
  focusWorker(id: string): boolean
}

export interface FactorySceneProps {
  mode: 'live' | 'team'
  agents: readonly FactoryAgentInput[]
  messages: readonly AgentMessage[]
  plan?: RunPlan | null
  runStatus?: RunStatus
  /** Agent ids named by open decisions (permission, question, rules, merge review); proposals count as the root. */
  needsYouIds?: readonly string[]
  runId?: string
  /** Team mode: memory key. */
  projectId?: string
  selectedId?: string
  onSelect(id: string): void
  onRemove?(id: string): void
  onOpenPlan?(): void
  /** Fallback banners' "Use Graph". */
  onUseGraph(): void
  controlRef?: Ref<FactorySceneHandle>
}

/** One row of Find a worker (the chrome's FactoryFindEntry shape): current session in layout order, then earlier ones. */
export interface FindEntry {
  id: string
  name: string
  handle?: string
  statusWord: string
  line?: number
  session: 'current' | 'earlier'
}

/** Section 8: more current-session agents than this show the floor plan. */
export const FACTORY_3D_MAX_AGENTS = 120

/**
 * Heights used before the 3D kits report theirs (and always in the floor plan, which ignores height): booth and
 * stations of about the procedural kits' size, rounded up. The engine replaces them with the kits' real heights.
 */
const DEFAULT_HEIGHTS: KitHeights = {
  boothTop: GANTRY_TOP + 3,
  stationTop: 2.4,
  dockTop: GANTRY_TOP + 0.5,
  boardTop: GANTRY_TOP + 3.2,
  boothPlate: GANTRY_TOP + 3.2,
  stationPlate: 2.6,
  // Plate 3 x 3 m plus the outfeed belt (z 3 to 4 of the row).
  stationExtent: { minX: -1.5, maxX: 1.5, minZ: -1.5, maxZ: 2.5 }
}
/** Worker buttons cover the station footprint up to this height (robot and console; the stack light rises above). */
const BUTTON_TOP = 1.8
const NO_SIGNS: readonly PlanSign[] = []
/** Nameplate anchors sit this far north of the station / booth centre (metres; see plateAnchors). */
const PLATE_BACK_Z = -0.75
const BOOTH_PLATE_BACK_Z = -1

type CanvasComponent = (props: FactoryCanvasProps) => ReactElement
let loadedCanvas: CanvasComponent | null = null

/** The three chunk. The developer switch 'chunk-failed' makes it fail like a rejected import. */
function loadCanvas(forceFail: boolean): Promise<CanvasComponent> {
  if (forceFail) return Promise.reject(new Error('Factory renderer chunk forced to fail'))
  if (loadedCanvas) return Promise.resolve(loadedCanvas)
  return import('./FactoryCanvas').then((m) => {
    loadedCanvas = m.FactoryCanvas
    return m.FactoryCanvas
  })
}

const NO_PROBE: WebGL2Probe = { ok: false, software: false, quality: 'minimal' }

function readSwitch(): ReturnType<typeof readForcedRenderer> {
  try {
    return readForcedRenderer((k) => window.localStorage.getItem(k))
  } catch {
    return null
  }
}

type LostState = 'none' | 'restoring' | 'gave-up' | 'third'

type AmbientMap = ReadonlyMap<string, { kind: Exclude<Ambient, 'none'>; phase: number }>
const NO_AMBIENT: AmbientMap = new Map()
const NO_ACTIVE: readonly ActiveCue[] = []
/** Cue pump: when no active cue has an end time yet (queued, fading), look again after this long. */
const PUMP_IDLE_MS = 100

/** Per mount and per run id: the scheduler and the baselines of section 5.4. */
interface CueHolder {
  run: string | null
  scheduler: CueScheduler
  /** The frame the last diff saw (null until the baseline is taken). */
  prev: FloorFrame | null
  cursor: string | null
  gate: AnnounceGate
  logId: number
  /** Most stations looping at once since mount (test state cuePeaks.ambient). */
  ambientPeak: number
}
function newCueHolder(run: string | null): CueHolder {
  return { run, scheduler: new CueScheduler(), prev: null, cursor: null, gate: new AnnounceGate(), logId: 0, ambientPeak: 0 }
}
function sameAmbient(a: AmbientMap, b: AmbientMap): boolean {
  if (a.size !== b.size) return false
  for (const [id, v] of a) {
    const w = b.get(id)
    if (!w || w.kind !== v.kind || w.phase !== v.phase) return false
  }
  return true
}

/**
 * Section 7.1 worktree phrases. "Branch held" (held) and "No changes" (empty) are additions to the spec's list; removed
 * says nothing (the branch is gone).
 */
export const WORKTREE_PHRASE: Partial<Record<WorktreeStatus, string>> = {
  active: 'Working in its own branch',
  merging: 'Working in its own branch',
  'waiting-children': 'Working in its own branch',
  held: 'Branch held',
  merged: 'Branch merged',
  conflict: 'Merge conflict',
  review: 'Waiting for your review',
  empty: 'No changes'
}

/** The hidden description's cap (section 7.1). */
const DESCRIPTION_MAX = 200

/**
 * Section 7.1 description: activity; line and station or the line it runs; who it reports to; the worktree phrase; a
 * paused run (booth); each plan step the worker owns. Agent text is untrusted: it only ever reaches React text.
 */
function describe(
  a: FactoryAgentInput,
  layout: FloorLayout,
  names: ReadonlyMap<string, string>,
  mode: 'live' | 'team',
  extra: { stepIds: readonly string[]; stepTitles: ReadonlyMap<string, string>; paused: boolean }
): string {
  const st = layout.stations[a.id]
  const parts: string[] = []
  if (mode === 'live' && a.activity) parts.push(a.activity)
  if (st && st.kind !== 'booth') parts.push(`Line ${st.line}, station ${st.slot + 1}`)
  const runs = layout.lines.find((l) => l.leadId === a.id)
  if (runs) parts.push(`Runs line ${runs.number}`)
  const parent = a.parentId ? names.get(a.parentId) : undefined
  if (parent) parts.push(`Reports to ${parent}`)
  const wt = mode === 'live' && a.worktree ? WORKTREE_PHRASE[a.worktree.status] : undefined
  if (wt) parts.push(wt)
  if (mode === 'live' && extra.paused && st?.kind === 'booth') parts.push('Run paused')
  for (const id of extra.stepIds) parts.push(`Plan step ${id}: ${extra.stepTitles.get(id) ?? ''}`.trimEnd())
  // A part that already ends a sentence ("Thinking…") is not given a second full stop.
  const text = parts.reduce((acc, p) => (acc ? `${acc}${/[.…!?]$/.test(acc) ? ' ' : '. '}${p}` : p), '')
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

export function FactoryScene(props: FactorySceneProps): ReactElement {
  const { mode, agents, plan, runStatus, needsYouIds, selectedId, onSelect, onRemove, onOpenPlan, onUseGraph, controlRef, runId, projectId } = props
  const mountedAt = useRef(performance.now())
  const [forced] = useState(readSwitch)
  const [attempt, setAttempt] = useState(0)
  const probe = useMemo<WebGL2Probe>(() => {
    if (forced === 'floor-plan' || forced === 'no-webgl2') return NO_PROBE
    return cachedWebGL2Probe(() => document.createElement('canvas') as unknown as ProbeCanvas)
    // `attempt` re-runs the probe after "Try 3D again" (which clears the cache).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced, attempt])
  const [chunk, setChunk] = useState<{ status: 'idle' | 'ready' | 'failed'; Canvas: CanvasComponent | null }>(() => ({
    status: loadedCanvas && forced !== 'chunk-failed' ? 'ready' : 'idle',
    Canvas: forced !== 'chunk-failed' ? loadedCanvas : null
  }))
  const [lost, setLost] = useState<LostState>(() => (factorySession.floorPlanForSession ? 'third' : 'none'))
  const [rendererFailed, setRendererFailed] = useState(false)
  const [noWebGL2Dismissed, setNoWebGL2Dismissed] = useState(factorySession.noWebGL2Dismissed)
  const reduced = useReducedMotion()
  const announce = useFrameAnnounce()
  // Pause motion (section 5.5): remembered for the app session (module-level), read on mount so a remount keeps it.
  const [paused, setPaused] = useState(() => motionSession.paused)
  const togglePause = useCallback(() => {
    setPaused((p) => {
      motionSession.paused = !p
      return !p
    })
  }, [])
  /** False once unmounted: late callbacks (the canvas's last stats on unmount) must not schedule timers (Reviewer L4). */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // ---- layout (section 3): live is append-only per run; team recomputes ----
  const runKey = mode === 'team' ? `team:${projectId ?? ''}` : (runId ?? '')
  const memory = useRef<LayoutMemory>(EMPTY_LAYOUT_MEMORY)
  const layout = useMemo<FloorLayout>(() => {
    if (mode === 'team') return layoutTeam(agents, runKey).layout
    const r = layoutFloor({ runKey, agents }, memory.current)
    memory.current = r.memory
    return r.layout
  }, [mode, agents, runKey])
  const current = useMemo(() => agents.filter((a) => a.session === 'current'), [agents])
  const hasRoot = useMemo(() => pickRoot(current) !== null, [current])
  const count = current.length

  const needsYouKey = (needsYouIds ?? []).join('\n')
  // ---- the pure floor model (section 1.4 end states): the engine, mirror, labels and test state all read it ----
  const floorModel = useMemo(
    () => buildFloorModel(agents, layout, needsYouKey ? needsYouKey.split('\n') : [], plan, runStatus, mode),
    [agents, layout, needsYouKey, plan, runStatus, mode]
  )
  const hall = floorModel.hall
  const { entries, plates } = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]))
    const names = new Map(agents.map((a) => [a.id, a.name]))
    const stepTitles = new Map((plan?.steps ?? []).map((s) => [s.id, s.title]))
    const list: MirrorEntry[] = []
    const plateList: NameplateData[] = []
    for (const id of layout.order) {
      const a = byId.get(id)
      const st = layout.stations[id]
      const w = floorModel.workers[id]
      if (!a || !st || !w) continue
      const e: MirrorEntry = {
        id,
        name: a.name,
        kind: st.kind,
        state: a.state,
        lamp: w.lamp,
        word: w.statusWord,
        line: st.line,
        slot: st.slot,
        description: describe(a, layout, names, mode, { stepIds: w.stepIds, stepTitles, paused: hall === 'paused' }),
        pose: w.pose,
        fenced: w.fenced,
        ...(w.crate ? { crate: w.crate.at, crateLamp: w.crate.lamp } : {}),
        stepIds: w.stepIds,
        // Section 1.4: the booth's plate (and floor plan tile) says "Paused" while the run is paused.
        ...(mode === 'live' && hall === 'paused' && st.kind === 'booth' ? { shownWord: 'Paused' as const } : {})
      }
      list.push(e)
      plateList.push({
        entry: e,
        activity: w.activity,
        anchor: { x: st.center.x, y: 0, z: st.center.z },
        conflict: a.worktree?.status === 'conflict'
      })
    }
    return { entries: list, plates: plateList }
  }, [agents, layout, floorModel, plan, hall, mode])

  let reason: FactoryReason | undefined
  if (forced === 'floor-plan') reason = 'forced'
  else if (!probe.ok || rendererFailed) reason = 'no-webgl2'
  else if (count > FACTORY_3D_MAX_AGENTS) reason = 'too-many'
  else if (lost === 'gave-up' || lost === 'third') reason = 'context-lost'
  else if (chunk.status === 'failed') reason = 'chunk-failed'
  const renderer = reason ? 'floor-plan' : 'webgl2'
  const wants3D = renderer === 'webgl2'
  const quality = probe.ok ? probe.quality : 'minimal'
  // Pause motion is hidden in team mode, where nothing moves.
  const motion = motionState(reduced, mode === 'live' && paused)
  const projection = renderer === 'webgl2' ? 'perspective' : 'plan'

  let notice: FactoryNoticeKind | null = null
  if (reason === 'no-webgl2') notice = noWebGL2Dismissed ? null : 'no-webgl2'
  else if (reason === 'too-many') notice = 'too-many'
  else if (reason === 'context-lost') notice = lost === 'third' ? 'third-loss' : 'lost'
  else if (reason === 'chunk-failed') notice = 'chunk-failed'

  // Load the three chunk when the 3D view is wanted.
  useEffect(() => {
    if (!wants3D || chunk.status !== 'idle') return
    let live = true
    loadCanvas(forced === 'chunk-failed').then(
      (Canvas) => live && setChunk({ status: 'ready', Canvas }),
      () => live && setChunk({ status: 'failed', Canvas: null })
    )
    return () => {
      live = false
    }
  }, [wants3D, chunk.status, forced])

  // ---- context loss (section 8) ----
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearRestoreTimer = (): void => {
    if (restoreTimer.current) clearTimeout(restoreTimer.current)
    restoreTimer.current = null
  }
  useEffect(() => clearRestoreTimer, [])
  const onContextLost = useCallback(() => {
    if (!alive.current) return
    const r = recordContextLoss(factorySession.losses, Date.now())
    factorySession.losses = r.history
    clearRestoreTimer()
    if (r.third) {
      factorySession.floorPlanForSession = true
      setLost('third')
      return
    }
    setLost('restoring')
    announce?.('The 3D view stopped. Restoring…')
    restoreTimer.current = setTimeout(() => {
      restoreTimer.current = null
      setLost('gave-up')
    }, CONTEXT_RESTORE_TIMEOUT_MS)
  }, [announce])
  const onContextRestored = useCallback(() => {
    clearRestoreTimer()
    setLost('none')
  }, [])
  const onCanvasFailed = useCallback(() => {
    // The probe said yes but the renderer could not get a context: the no-WebGL2 floor plan.
    setRendererFailed(true)
  }, [])

  const retry3D = useCallback(() => {
    // firstFrameMs of the new canvas counts from the retry.
    mountedAt.current = performance.now()
    resetWebGL2Probe()
    setRendererFailed(false)
    factorySession.losses = []
    factorySession.floorPlanForSession = false
    clearRestoreTimer()
    setLost('none')
    setChunk({ status: 'idle', Canvas: null })
    setAttempt((a) => a + 1)
  }, [])
  const dismissNoWebGL2 = useCallback(() => {
    factorySession.noWebGL2Dismissed = true
    setNoWebGL2Dismissed(true)
  }, [])

  // ---- camera (section 2): one controller for both renderers ----
  const heights = useRef<KitHeights>(DEFAULT_HEIGHTS)
  // Bumped when the kits report their heights, so the label anchors (which read them) are recomputed and re-placed.
  const [heightsVersion, setHeightsVersion] = useState(0)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const boardOn = mode === 'live' && !!plan
  const boardRef = useRef(boardOn)
  boardRef.current = boardOn
  const motionRef = useRef(motion)
  motionRef.current = motion
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  const boxFor = useCallback((id: string): Box3 => {
    const h = heights.current
    if (id === PLAN_BOARD_ID) {
      // The board's face on the gantry (3D), or its zone in the plan.
      const c = layoutRef.current.board
      const plan = projectionRef.current === 'plan'
      return {
        minX: c.x - BOARD_SIZE.w / 2,
        maxX: c.x + BOARD_SIZE.w / 2,
        minY: plan ? 0 : GANTRY_TOP,
        maxY: plan ? 0 : h.boardTop,
        minZ: c.z - BOARD_SIZE.d / 2,
        // The plan tile is deeper than the board so its count line fits (it stays clear of the dock zone).
        maxZ: c.z + BOARD_SIZE.d / 2 + (plan ? 1.2 : 0)
      }
    }
    const st = layoutRef.current.stations[id]
    if (!st) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
    if (st.kind === 'booth') {
      const plan = projectionRef.current === 'plan'
      return {
        minX: st.center.x - BOOTH_SIZE.w / 2,
        maxX: st.center.x + BOOTH_SIZE.w / 2,
        minY: plan ? 0 : GANTRY_TOP,
        maxY: plan ? 0 : Math.min(h.boothTop, GANTRY_TOP + 3),
        minZ: st.center.z - BOOTH_SIZE.d / 2,
        maxZ: st.center.z + BOOTH_SIZE.d / 2
      }
    }
    const half = STATION_SIZE / 2
    return { minX: st.center.x - half, maxX: st.center.x + half, minY: 0, maxY: projectionRef.current === 'plan' ? 0 : BUTTON_TOP, minZ: st.center.z - half, maxZ: st.center.z + half }
  }, [])

  const fitBoxes = useCallback((): Box3[] => {
    const l = layoutRef.current
    const h = heights.current
    const zone = (c: { x: number; z: number }, w: number, d: number, top: number, bottom = GANTRY_TOP): Box3 => ({ minX: c.x - w / 2, maxX: c.x + w / 2, minY: bottom, maxY: top, minZ: c.z - d / 2, maxZ: c.z + d / 2 })
    const boxes: Box3[] = [zone(BOOTH_CENTER, BOOTH_SIZE.w, BOOTH_SIZE.d, h.boothTop)]
    if (mode === 'live') boxes.push(zone(DOCK_CENTER, DOCK_SIZE.w, DOCK_SIZE.d, h.dockTop))
    if (boardRef.current) boxes.push(zone(BOARD_CENTER, BOARD_SIZE.w, BOARD_SIZE.d, h.boardTop))
    // The 3D view frames each station's whole kit (plate and belt); the plan frames the 3 x 3 m tiles.
    const half = STATION_SIZE / 2
    const ext = projectionRef.current === 'plan' ? { minX: -half, maxX: half, minZ: -half, maxZ: half } : h.stationExtent
    for (const id of l.order) {
      const st = l.stations[id]
      if (!st || st.kind === 'booth') continue
      boxes.push({ minX: st.center.x + ext.minX, maxX: st.center.x + ext.maxX, minY: 0, maxY: h.stationTop, minZ: st.center.z + ext.minZ, maxZ: st.center.z + ext.maxZ })
    }
    return boxes
  }, [mode])

  const registry = useRef<PlacementRegistry>(new Map()).current
  const buttons = useRef(new Map<string, HTMLButtonElement>()).current
  const canvasRef = useRef<FactoryCanvasHandle>(null)
  const labelsRef = useRef<FactoryLabelsHandle>(null)
  const focus = useRef({ focusedId: null as string | null, hoveredId: null as string | null })
  const selectedRef = useRef(selectedId ?? null)
  selectedRef.current = selectedId ?? null
  const viewRef = useRef<CameraView | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const scheduleWriteRef = useRef<() => void>(() => {})
  /** Re-picks the looping stations (section 5.1: on-screen ones first) after a camera move. */
  const ambientUpdateRef = useRef<() => void>(() => {})

  const refreshLabels = useCallback(() => {
    const c = controllerRef.current
    if (!c || !viewRef.current) return
    labelsRef.current?.update(viewRef.current, c.stageInfo, { selectedId: selectedRef.current, ...focus.current })
  }, [])

  const controllerRef = useRef<CameraController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new CameraController({
      projection,
      fitBoxes: () => fitBoxes(),
      hall: () => layoutRef.current.hall,
      // Reduced motion and Pause motion: camera moves are instant (section 5.5).
      tweenMs: () => (motionRef.current !== 'full' ? 0 : tokenMs('--dur-slow')),
      isControl: (target) => {
        const el = target as Element | null
        if (!el || typeof el.closest !== 'function') return false
        if (el.closest('.factory-worker')) return false
        return !!el.closest('button, input, select, textarea, a, [role="toolbar"], [role="dialog"], details, .factory-notice, [data-factory-control]')
      },
      onView: (view: CameraView, stage: Stage) => {
        viewRef.current = view
        canvasRef.current?.setView(view)
        placeAll(registry, view, stage)
        labelsRef.current?.update(view, stage, { selectedId: selectedRef.current, ...focus.current })
        ambientUpdateRef.current()
        scheduleWriteRef.current()
      }
    })
  }
  const controller = controllerRef.current

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    controller.attach(el)
    return () => controller.dispose()
  }, [controller])
  useLayoutEffect(() => {
    controller.setProjection(projection)
  }, [controller, projection])
  // New elements after a model change get their positions at once (the camera itself never moves for new stations).
  useLayoutEffect(() => {
    controller.reapply()
    // heightsVersion: the kits' real heights move the label anchors (Reviewer M1).
  }, [controller, entries, layout, renderer, boardOn, chunk.Canvas, heightsVersion])

  const onHeights = useCallback((h: KitHeights) => {
    heights.current = h
    setHeightsVersion((v) => v + 1)
    controller.refitIfUntouched()
    controller.reapply()
  }, [controller])

  const focusWorker = useCallback((id: string): boolean => {
    const el = buttons.get(id)
    if (!el) return false
    // preventScroll: the stage clips; the camera brings the worker into view instead.
    el.focus({ preventScroll: true })
    controller.panIntoView(boxFor(id))
    return true
  }, [buttons, controller, boxFor])

  const onKey = useCallback((id: string, e: KeyboardEvent<HTMLButtonElement>) => {
    const action = floorKeyAction(e, mode)
    if (!action) return
    e.preventDefault()
    if (action.type === 'focus') {
      const target = nextFocus(layoutRef.current, id, action.key, { board: boardRef.current })
      if (target) focusWorker(target)
    } else if (action.type === 'pan') controller.panMetres(action.dx, action.dz)
    else if (action.type === 'zoom') {
      if (action.direction === 'in') controller.zoomIn()
      else controller.zoomOut()
    } else if (action.type === 'fit') controller.fit()
    else if (action.type === 'remove') onRemove?.(id)
  }, [mode, controller, focusWorker, onRemove])

  const onFocusWorker = useCallback((id: string, pointer: boolean) => {
    focus.current.focusedId = id
    // Keyboard focus pans the worker into view; a click never moves the camera (section 2).
    if (!pointer) controller.panIntoView(boxFor(id))
    refreshLabels()
  }, [controller, boxFor, refreshLabels])
  const onBlurWorker = useCallback((id: string) => {
    if (focus.current.focusedId === id) focus.current.focusedId = null
    refreshLabels()
  }, [refreshLabels])
  const onHover = useCallback((id: string | null) => {
    focus.current.hoveredId = id
    refreshLabels()
  }, [refreshLabels])
  useEffect(() => {
    refreshLabels()
  }, [selectedId, refreshLabels])

  // ---- engine input (3D) ----
  // The engine draws the pure floor model (lib/factory/model.ts, built above).
  const engineFloor = useMemo<EngineFloor>(() => ({ model: floorModel, selectedId: selectedId ?? null }), [floorModel, selectedId])

  // ---- cues, ambient loops, floor log (section 5, 6.5, 7.5; slice 4) ----
  // One CueScheduler per mount and per run id; the previous frame and the message cursor are the baselines diffCues
  // compares against, so a remount or a run change never replays anything.
  const cueRef = useRef<CueHolder | null>(null)
  if (!cueRef.current) cueRef.current = newCueHolder(null)
  const [log, setLog] = useState<FloorLogEntry[]>([])
  const ambientRef = useRef<AmbientMap>(NO_AMBIENT)
  const modelRef = useRef(floorModel)
  modelRef.current = floorModel
  const pumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The engine's view of the cues (it never owns cue timing). Stable for the mount: it reads refs. */
  const feed = useRef<CueFeed | null>(null)
  if (!feed.current) {
    feed.current = {
      get motion() {
        return motionRef.current
      },
      active: (now: number) => (motionRef.current === 'full' ? cueRef.current!.scheduler.advance(now) : NO_ACTIVE),
      busy: (now: number) => motionRef.current === 'full' && cueRef.current!.scheduler.busy(now),
      ambient: () => (motionRef.current === 'full' ? ambientRef.current : NO_AMBIENT)
    }
  }

  // ---- labels ----
  const plateAnchors = useMemo<NameplateData[]>(() => {
    if (projection === 'plan') return []
    // Section 6.2 "above each station". Anchored at the station centre, the 55 degree pitch put the plate's bottom below
    // the projected top of the machine at the back of the plate, so plates hid machine tops; anchored at the plate's
    // north edge they floated nearer the row above (slice 2 screenshots). PLATE_BACK_Z moves the anchor north so its
    // projection matches the machine's back top edge (machine anchor z -0.45, depth 1.2, height 1.9 on the plate).
    const h = heights.current
    return plates.map((p) => ({
      ...p,
      anchor:
        p.entry.kind === 'booth'
          ? { x: p.anchor.x, y: h.boothPlate, z: BOOTH_CENTER.z + BOOTH_PLATE_BACK_Z }
          : { x: p.anchor.x, y: h.stationPlate, z: p.anchor.z + PLATE_BACK_Z }
    }))
    // heights.current changes only with the canvas; chunk.Canvas covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plates, projection, chunk.Canvas, heightsVersion])
  const planSigns = useMemo<PlanSign[]>(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]))
    return lineSigns(layout).map((s) => {
      const lead = names.get(s.leadId) ?? s.leadId
      return { key: `${s.line}:${s.row}`, line: s.line, lead: s.continued ? `${lead}, continued` : lead, z: s.at.z }
    })
  }, [agents, layout])
  const signs = useMemo<SignData[]>(() => {
    if (projection === 'plan') return []
    // Lead names are untrusted and unbounded: cut at 18 characters like nameplates (Reviewer L2).
    const CONT = ', continued'
    const cut = (t: string): string => {
      const more = t.endsWith(CONT)
      const name = more ? t.slice(0, -CONT.length) : t
      return `${name.length > 18 ? `${name.slice(0, 17)}…` : name}${more ? CONT : ''}`
    }
    return planSigns.map((s) => ({ key: s.key, line: s.line, text: `Line ${s.line} · ${cut(s.lead)}`, anchor: { x: layout.hall.minX + HEAD_W - 0.3, y: 0, z: s.z } }))
  }, [planSigns, projection, layout])
  const dockCrates = floorModel.dockCrates
  const dockLabel = useMemo(() => {
    if (mode !== 'live' || projection === 'plan') return null
    return { text: `Main checkout · ${dockCrates} merged`, count: dockCrates, anchor: { x: DOCK_CENTER.x, y: GANTRY_TOP + 0.8, z: DOCK_CENTER.z - DOCK_SIZE.d / 2 } }
  }, [mode, projection, dockCrates])
  const board = floorModel.board
  const boardCounts = useMemo<MirrorBoard | null>(
    () => (board ? { total: board.total, done: board.done, blocked: board.blocked } : null),
    [board]
  )
  const boardLabel = useMemo(() => {
    if (!boardCounts || projection === 'plan') return null
    const { total, done, blocked } = boardCounts
    return { text: `Plan · ${done} of ${total} done${blocked ? ` · ${blocked} blocked` : ''}`, anchor: { x: BOARD_CENTER.x, y: heights.current.boardTop + 0.2, z: BOARD_CENTER.z } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardCounts, projection, heightsVersion])
  const boardBox = useMemo(() => boxFor(PLAN_BOARD_ID), [boxFor, projection, heightsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Find a worker (chrome, slice 2c): entries and the choose handler ----
  const findEntries = useMemo<FindEntry[]>(() => {
    const cur: FindEntry[] = []
    const byId = new Map(agents.map((a) => [a.id, a]))
    for (const e of entries) {
      const a = byId.get(e.id)
      cur.push({ id: e.id, name: e.name, ...(a?.handle ? { handle: a.handle } : {}), statusWord: e.word, ...(e.kind !== 'booth' ? { line: e.line } : {}), session: 'current' })
    }
    const earlier: FindEntry[] = agents
      .filter((a) => a.session === 'earlier')
      .map((a) => ({ id: a.id, name: a.name, ...(a.handle ? { handle: a.handle } : {}), statusWord: a.statusWord, session: 'earlier' as const }))
    return [...cur, ...earlier]
  }, [agents, entries])
  const onFindChoose = useCallback((id: string, session: 'current' | 'earlier') => {
    // Current: focus the worker on the floor (pans into view), then select. Earlier: select only (the floor is untouched).
    if (session === 'current') focusWorker(id)
    onSelect(id)
  }, [focusWorker, onSelect])
  const findButtonRef = useRef<HTMLButtonElement>(null)

  // ---- test state (section 10.3): on every change of what it shows, and at most twice a second for frames ----
  const outRef = useRef<HTMLOutputElement>(null)
  const statsRef = useRef<FactoryEngineStats | null>(null)
  const shown = { renderer, reason, quality, mode, motion, layout, model: floorModel, logEntries: log.length } as const
  const shownRef = useRef(shown)
  shownRef.current = shown
  const lastWrite = useRef(0)
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeState = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current)
    writeTimer.current = null
    lastWrite.current = performance.now()
    const out = outRef.current
    if (!out) return
    const s = shownRef.current
    const stats = s.renderer === 'webgl2' ? statsRef.current : null
    // Slice 4: the cues active (or waiting) now, advanced at write time; ids, numbers and words only (never message text).
    const cues = cueRef.current!
    const active = s.motion === 'full' ? cues.scheduler.advance(performance.now()) : NO_ACTIVE
    const peaks: FactoryTestState['cuePeaks'] = { ...cues.scheduler.peaks(), ambient: cues.ambientPeak }
    out.textContent = JSON.stringify(
      factoryTestState({
        renderer: s.renderer,
        reason: s.reason,
        quality: s.quality,
        mode: s.mode,
        motion: s.motion,
        model: s.model,
        layout: s.layout,
        cues: active,
        cuesStarted: cues.scheduler.started,
        recentCues: cues.scheduler.recent(),
        cuePeaks: peaks,
        logEntries: s.logEntries,
        ambient: ambientRef.current,
        messageCursor: cues.cursor,
        view: viewRef.current,
        loop: stats?.loop ?? 'stopped',
        frames: stats?.frames ?? 0,
        engines: factorySession.engines,
        perf: stats?.perf ?? null
      })
    )
  }, [])
  const scheduleWrite = useCallback(() => {
    if (!alive.current || writeTimer.current) return
    const wait = Math.max(0, lastWrite.current + TEST_STATE_INTERVAL_MS - performance.now())
    writeTimer.current = setTimeout(writeState, wait)
  }, [writeState])
  scheduleWriteRef.current = scheduleWrite
  const onStats = useCallback((stats: FactoryEngineStats) => {
    statsRef.current = stats
    scheduleWrite()
  }, [scheduleWrite])
  useEffect(() => {
    if (renderer !== 'webgl2') statsRef.current = null
    writeState()
  }, [renderer, reason, quality, mode, motion, entries, layout, floorModel, log, writeState])
  useEffect(() => () => {
    if (writeTimer.current) clearTimeout(writeTimer.current)
    writeTimer.current = null
  }, [])

  // ---- cues: the pump, the ambient set, the model diff, finishAll triggers ----
  /**
   * Keeps the test state (and the floor plan, which has no engine) moving through the cues with timers, not a rAF loop:
   * writes the state at the next cue end until the scheduler is idle. The 3D engine advances the same scheduler per frame.
   */
  const pump = useCallback(() => {
    if (pumpTimer.current) clearTimeout(pumpTimer.current)
    pumpTimer.current = null
    if (!alive.current) return
    // Throttled to TEST_STATE_INTERVAL_MS; the write after the last cue's end shows `cues` empty.
    scheduleWriteRef.current()
    const now = performance.now()
    const s = cueRef.current!.scheduler
    if (motionRef.current !== 'full' || !s.busy(now)) return
    let next = Infinity
    for (const c of s.advance(now)) {
      const end = c.start + c.duration - now
      if (end > 0) next = Math.min(next, end)
    }
    // A cancelled cue (fading) or a queued one has no end here yet: look again shortly.
    const wait = Number.isFinite(next) ? Math.ceil(next) + 1 : PUMP_IDLE_MS
    pumpTimer.current = setTimeout(pump, Math.min(Math.max(16, wait), TEST_STATE_INTERVAL_MS))
  }, [])

  const finishCues = useCallback(() => {
    cueRef.current!.scheduler.finishAll()
    canvasRef.current?.invalidate()
    scheduleWriteRef.current()
  }, [])

  const updateAmbient = useCallback(() => {
    const model = modelRef.current
    let next: AmbientMap = NO_AMBIENT
    // Live, motion 'full', hall on (ambientSet checks those two). The floor plan draws end states only, but its test state
    // reports the same set (what loops in 3D), so both renderers answer "which stations run" alike.
    if (motionRef.current === 'full') {
      const view = viewRef.current
      const stage = controller.stageInfo
      const onScreen = (id: string): boolean => {
        if (!view || stage.width <= 0 || stage.height <= 0) return false
        const r = projectFootprint(view, stage, boxFor(id))
        return r.right > 0 && r.left < stage.width && r.bottom > 0 && r.top < stage.height
      }
      next = ambientSet(model, onScreen, selectedRef.current)
    }
    if (sameAmbient(ambientRef.current, next)) return
    ambientRef.current = next.size ? next : NO_AMBIENT
    const holder = cueRef.current!
    holder.ambientPeak = Math.max(holder.ambientPeak, next.size)
    canvasRef.current?.invalidate()
    scheduleWriteRef.current()
  }, [controller, boxFor])
  ambientUpdateRef.current = updateAmbient
  useEffect(() => {
    updateAmbient()
  }, [updateAmbient, floorModel, motion, renderer, selectedId])

  // The diff (section 1.4, 5.4): baseline at mount and on a run id change; every later model change cues what changed.
  const messages = props.messages
  useEffect(() => {
    const frame: FloorFrame = { model: floorModel, agents, messages }
    let holder = cueRef.current!
    if (holder.run !== runKey) {
      // A new run: a new scheduler (it never replays) and a new baseline; the old run's log goes.
      holder.scheduler.finishAll()
      holder = cueRef.current = newCueHolder(runKey)
      ambientRef.current = NO_AMBIENT
      if (log.length) setLog([])
    }
    if (!holder.prev) {
      holder.prev = frame
      holder.cursor = diffCues(null, frame, null).cursor
      writeState()
      return
    }
    if (mode !== 'live') {
      // Team mode never schedules cues (section 5.3) and has no log.
      holder.prev = frame
      return
    }
    const prevHall = holder.prev.model.hall
    const d = diffCues(holder.prev, frame, holder.cursor, Date.now())
    holder.prev = frame
    holder.cursor = d.cursor
    const now = performance.now()
    if (d.events.length) {
      setLog((l) => appendLog(l, d.events, () => `fl${++holder.logId}`))
      for (const e of d.events) if (e.kind === 'left') holder.scheduler.cancelFor(e.id, now)
      sayEvents(d.events)
    }
    // A run paused or ended: every cue jumps to its end state first, then this diff's cues (the hall tween) go in.
    const hallOn = floorModel.hall === 'on'
    if (prevHall === 'on' && !hallOn) holder.scheduler.finishAll()
    if (motionRef.current === 'full' && d.cues.length) {
      // While the hall is not on, only the hall's own tween runs (section 1.4: every cue stops at its end state).
      const cues = hallOn ? d.cues : d.cues.filter((c) => c.kind === 'hall')
      if (cues.length) {
        holder.scheduler.push(cues, now)
        canvasRef.current?.invalidate()
      }
    }
    // Written now, not only on the 500 ms timer, so short cues reach the test state; then pumped to their ends.
    writeState()
    pump()
    // `log` is read only to clear it on a run change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorModel, agents, messages, mode, runKey])

  // Announcements (section 7.5): through the frame only, never at mount, at most one per window; held text on a timer.
  const announceRef = useRef(announce)
  announceRef.current = announce
  const sayHeld = useCallback(() => {
    if (announceTimer.current) clearTimeout(announceTimer.current)
    announceTimer.current = null
    if (!alive.current) return
    const gate = cueRef.current!.gate
    const text = gate.due(Date.now())
    if (text) announceRef.current?.(text)
    const wait = gate.pendingIn(Date.now())
    if (wait !== null) announceTimer.current = setTimeout(sayHeld, Math.max(16, wait))
  }, [])
  const sayEvents = (events: readonly FloorEvent[]): void => {
    const gate = cueRef.current!.gate
    const text = gate.offer(events, Date.now())
    if (text) announceRef.current?.(text)
    const wait = gate.pendingIn(Date.now())
    if (wait !== null && !announceTimer.current) announceTimer.current = setTimeout(sayHeld, Math.max(16, wait))
  }

  // finishAll: motion leaves 'full' (Pause motion, reduced motion), and the hall leaves 'on' (in the diff above).
  useEffect(() => {
    if (motion !== 'full') finishCues()
    else canvasRef.current?.invalidate()
  }, [motion, finishCues])
  // ... and the document hidden or the stage off screen (both renderers; the canvas stops its own loop as well).
  useEffect(() => {
    const el = stageRef.current
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') finishCues()
    }
    document.addEventListener('visibilitychange', onVisibility)
    let io: IntersectionObserver | null = null
    if (el && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((list) => {
        const last = list[list.length - 1]
        if (last && !last.isIntersecting) finishCues()
      })
      io.observe(el)
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      io?.disconnect()
    }
  }, [finishCues])
  // ... and on unmount (with every cue timer).
  useEffect(() => () => {
    cueRef.current?.scheduler.finishAll()
    if (pumpTimer.current) clearTimeout(pumpTimer.current)
    if (announceTimer.current) clearTimeout(announceTimer.current)
    pumpTimer.current = null
    announceTimer.current = null
  }, [])

  // ---- handle ----
  useImperativeHandle(controlRef, () => ({
    zoomIn: () => controller.zoomIn(),
    zoomOut: () => controller.zoomOut(),
    fit: () => controller.fit(),
    focusWorker
  }), [controller, focusWorker])

  const Canvas = wants3D && chunk.status === 'ready' ? chunk.Canvas : null
  const tabStopId = tabStop(layout, selectedId)
  const initialView = viewRef.current ?? controller.view

  const zoomIn = useCallback(() => controller.zoomIn(), [controller])
  const zoomOut = useCallback(() => controller.zoomOut(), [controller])
  const fit = useCallback(() => controller.fit(), [controller])
  const pauseMotion = useMemo(() => ({ pressed: paused, onToggle: togglePause }), [paused, togglePause])

  return (
    <div
      className="factory-scene"
      data-testid="factory-scene"
      data-mode={mode}
      data-renderer={renderer}
      data-motion={motion}
      data-quality={quality}
      data-reason={reason}
      data-hall={hall}
    >
      {notice && (
        <FactoryNotice
          kind={notice}
          count={count}
          onUseGraph={onUseGraph}
          onRetry={retry3D}
          onDismiss={notice === 'no-webgl2' ? dismissNoWebGL2 : undefined}
        />
      )}
      <div className="factory-stage" data-renderer={renderer} ref={stageRef}>
        {Canvas && (
          <Canvas
            key={attempt}
            quality={quality}
            floor={engineFloor}
            feed={feed.current}
            initialView={initialView}
            mountedAt={mountedAt.current}
            onStats={onStats}
            onHeights={onHeights}
            onFailed={onCanvasFailed}
            onContextLost={onContextLost}
            onContextRestored={onContextRestored}
            handleRef={canvasRef}
          />
        )}
        <FactoryLabels mode={mode} plates={plateAnchors} signs={signs} dock={dockLabel} board={boardLabel} handleRef={labelsRef} />
        <FactoryMirror
          mode={mode}
          entries={entries}
          renderer={renderer}
          layout={layout}
          selectedId={selectedId}
          tabStopId={tabStopId}
          boxFor={boxFor}
          registry={registry}
          buttons={buttons}
          board={boardCounts}
          boardBox={boardBox}
          onOpenPlan={onOpenPlan}
          dockCount={mode === 'live' && projection === 'plan' ? dockCrates : null}
          planSigns={projection === 'plan' ? planSigns : NO_SIGNS}
          onSelect={onSelect}
          onKey={onKey}
          onFocusWorker={onFocusWorker}
          onBlurWorker={onBlurWorker}
          onHover={onHover}
        />
        {mode === 'live' && !hasRoot && (
          <p className="factory-stage-note" data-testid="factory-empty">
            <span>The floor opens when the run starts.</span>
          </p>
        )}
        {wants3D && lost === 'restoring' && (
          <div className="factory-stage-note" data-testid="factory-context-lost">
            <span>The 3D view stopped. Restoring…</span>
          </div>
        )}
      </div>
      {/* Scene controls (section 6.7), over the stage's bottom left; Pause motion in live mode only. */}
      <FactoryControls
        find={<FactoryFind entries={findEntries} onChoose={onFindChoose} buttonRef={findButtonRef} />}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fit}
        pauseMotion={mode === 'live' ? pauseMotion : undefined}
      />
      {/* Floor log (section 6.5), live only, over the stage's bottom right (placed by factory-chrome.css). Not a live region. */}
      {mode === 'live' && <FactoryLog entries={log} />}
      <output hidden data-testid="factory-state" ref={outRef} />
    </div>
  )
}
