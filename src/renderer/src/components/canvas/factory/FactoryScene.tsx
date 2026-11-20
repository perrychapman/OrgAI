// Factory Floor, the public component (docs/design/factory-floor.md section 10.2). Probes WebGL2, chooses the 3D view or
// the floor plan, lazy-loads the three chunk (FactoryCanvas), shows the section 8 notices, lays the floor out
// (lib/factory/layout.ts, append-only memory per run), owns the camera controller, the DOM mirror, the labels and the
// test state, and exposes the zoom / fit / focus handle. Slice 2: layout, stations, static lamps, camera, keyboard,
// labels; the model, cues and log arrive in later slices.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import type { AgentMessage, RunPlan, RunStatus } from '@shared/types'
import type { FactoryAgentInput, FloorLayout, LayoutMemory, Lamp } from '../../../lib/factory/types'
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
import { TEST_STATE_INTERVAL_MS, factoryTestState, motionState, type FactoryReason, type WorkerSummary } from '../../../lib/factory/snapshot'
import {
  BOARD_CENTER,
  BOARD_SIZE,
  BOOTH_CENTER,
  BOOTH_SIZE,
  DOCK_CENTER,
  DOCK_SIZE,
  EMPTY_LAYOUT_MEMORY,
  GANTRY_TOP,
  STATION_SIZE,
  layoutFloor,
  layoutTeam,
  lineSigns,
  pickRoot
} from '../../../lib/factory/layout'
import { nextFocus, tabStop, floorKeyAction } from '../../../lib/factory/navigation'
import type { Box3, CameraView, Stage } from '../../../lib/factory/camera'
import { factoryLamp, factoryWord } from '../../../lib/factory/agentView'
import { useReducedMotion } from '../../../lib/canvas'
import { tokenMs } from '../../../lib/useExitPresence'
import { useFrameAnnounce } from '../../layout/CanvasFrame'
import { FactoryMirror, placeAll, type MirrorEntry, type PlacementRegistry, type PlanSign } from './FactoryMirror'
import { FactoryLabels, type FactoryLabelsHandle, type NameplateData, type SignData } from './FactoryLabels'
import { FactoryNotice, type FactoryNoticeKind } from './FactoryNotice'
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
 * stations as built by the slice 2 placeholder kits, rounded up.
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

const WORKTREE_PHRASE: Partial<Record<string, string>> = {
  active: 'Working in its own branch',
  merged: 'Branch merged',
  conflict: 'Merge conflict',
  review: 'Waiting for your review'
}

/** Section 7.1 description: activity; line and station or the line it runs; who it reports to; the worktree phrase. */
function describe(a: FactoryAgentInput, layout: FloorLayout, names: ReadonlyMap<string, string>, mode: 'live' | 'team'): string {
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
  const text = parts.join('. ')
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

export function FactoryScene(props: FactorySceneProps): ReactElement {
  const { mode, agents, plan, needsYouIds, selectedId, onSelect, onRemove, onUseGraph, controlRef, runId, projectId } = props
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
  const { entries, summaries, plates } = useMemo(() => {
    const needs = new Set(needsYouKey ? needsYouKey.split('\n') : [])
    const byId = new Map(agents.map((a) => [a.id, a]))
    const names = new Map(agents.map((a) => [a.id, a.name]))
    const list: MirrorEntry[] = []
    const sums: Record<string, WorkerSummary> = {}
    const plateList: NameplateData[] = []
    for (const id of layout.order) {
      const a = byId.get(id)
      const st = layout.stations[id]
      if (!a || !st) continue
      const lamp: Lamp = factoryLamp(a, needs)
      const word = factoryWord(a, lamp)
      const e: MirrorEntry = { id, name: a.name, kind: st.kind, state: a.state, lamp, word, line: st.line, slot: st.slot, description: describe(a, layout, names, mode) }
      list.push(e)
      sums[id] = { lamp, statusWord: word }
      plateList.push({
        entry: e,
        activity: mode === 'live' ? a.activity : '',
        anchor: { x: st.center.x, y: 0, z: st.center.z },
        conflict: a.worktree?.status === 'conflict'
      })
    }
    return { entries: list, summaries: sums, plates: plateList }
  }, [agents, layout, needsYouKey, mode])

  let reason: FactoryReason | undefined
  if (forced === 'floor-plan') reason = 'forced'
  else if (!probe.ok || rendererFailed) reason = 'no-webgl2'
  else if (count > FACTORY_3D_MAX_AGENTS) reason = 'too-many'
  else if (lost === 'gave-up' || lost === 'third') reason = 'context-lost'
  else if (chunk.status === 'failed') reason = 'chunk-failed'
  const renderer = reason ? 'floor-plan' : 'webgl2'
  const wants3D = renderer === 'webgl2'
  const quality = probe.ok ? probe.quality : 'minimal'
  const motion = motionState(reduced, false)
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
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const boardOn = mode === 'live' && !!plan
  const boardRef = useRef(boardOn)
  boardRef.current = boardOn
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  const boxFor = useCallback((id: string): Box3 => {
    const st = layoutRef.current.stations[id]
    const h = heights.current
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
      tweenMs: () => (reducedRef.current ? 0 : tokenMs('--dur-slow')),
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
  }, [controller, entries, layout, renderer, boardOn, chunk.Canvas])

  const onHeights = useCallback((h: KitHeights) => {
    heights.current = h
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
      const target = nextFocus(layoutRef.current, id, action.key)
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
  const engineFloor = useMemo<EngineFloor>(() => {
    const lamps: Record<string, Lamp> = {}
    for (const e of entries) lamps[e.id] = e.lamp
    return { mode, layout, lamps, selectedId: selectedId ?? null, board: boardOn }
  }, [mode, layout, entries, selectedId, boardOn])

  // ---- labels ----
  const plateAnchors = useMemo<NameplateData[]>(() => {
    if (projection === 'plan') return []
    return plates.map((p) => ({
      ...p,
      anchor: { x: p.anchor.x, y: p.entry.kind === 'booth' ? heights.current.boothPlate : heights.current.stationPlate, z: p.entry.kind === 'booth' ? BOOTH_CENTER.z : p.anchor.z }
    }))
    // heights.current changes only with the canvas; chunk.Canvas covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plates, projection, chunk.Canvas])
  const planSigns = useMemo<PlanSign[]>(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]))
    return lineSigns(layout).map((s) => {
      const lead = names.get(s.leadId) ?? s.leadId
      return { key: `${s.line}:${s.row}`, line: s.line, lead: s.continued ? `${lead}, continued` : lead, z: s.at.z }
    })
  }, [agents, layout])
  const signs = useMemo<SignData[]>(() => {
    if (projection === 'plan') return []
    return planSigns.map((s) => ({ key: s.key, line: s.line, text: `Line ${s.line} · ${s.lead}`, anchor: { x: layout.hall.minX + 0.3, y: 0, z: s.z } }))
  }, [planSigns, projection, layout])
  const dockLabel = useMemo(() => {
    if (mode !== 'live' || projection === 'plan') return null
    const merged = current.filter((a) => a.worktree?.status === 'merged' && a.worktree.mergeTarget === 'main').length
    return { text: `Main checkout · ${merged} merged`, anchor: { x: DOCK_CENTER.x, y: GANTRY_TOP + 0.8, z: DOCK_CENTER.z - DOCK_SIZE.d / 2 } }
  }, [mode, projection, current])
  const boardLabel = useMemo(() => {
    if (!boardOn || !plan || projection === 'plan') return null
    const total = plan.steps.length
    const done = plan.steps.filter((s) => s.status === 'done').length
    const blocked = plan.steps.filter((s) => s.status === 'blocked').length
    return { text: `Plan · ${done} of ${total} done${blocked ? ` · ${blocked} blocked` : ''}`, anchor: { x: BOARD_CENTER.x, y: heights.current.boardTop + 0.2, z: BOARD_CENTER.z } }
  }, [boardOn, plan, projection])

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
  const shown = { renderer, reason, quality, mode, motion, layout, summaries } as const
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
    out.textContent = JSON.stringify(
      factoryTestState({
        renderer: s.renderer,
        reason: s.reason,
        quality: s.quality,
        mode: s.mode,
        motion: s.motion,
        layout: s.layout,
        summaries: s.summaries,
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
  }, [renderer, reason, quality, mode, motion, entries, layout, writeState])
  useEffect(() => () => {
    if (writeTimer.current) clearTimeout(writeTimer.current)
    writeTimer.current = null
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

  // Kept for the chrome mount below (Find a worker): read so the values stay wired until the UI Lead drops it in.
  void findEntries
  void onFindChoose
  void findButtonRef

  return (
    <div
      className="factory-scene"
      data-testid="factory-scene"
      data-mode={mode}
      data-renderer={renderer}
      data-motion={motion}
      data-quality={quality}
      data-reason={reason}
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
          board={boardOn}
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
      {/*
        slice 2 chrome mount: the UI Lead drops the scene controls here, for example
        <FactoryControls
          find={<FactoryFind entries={findEntries} onChoose={onFindChoose} buttonRef={findButtonRef} />}
          onZoomIn={() => controller.zoomIn()}
          onZoomOut={() => controller.zoomOut()}
          onFit={() => controller.fit()}
        />
        (no pauseMotion until slice 4). The toolbar sits over the stage's bottom left (section 6.7); give it
        data-factory-control or role="toolbar" so a press on it never starts a pan.
      */}
      <output hidden data-testid="factory-state" ref={outRef} />
    </div>
  )
}
