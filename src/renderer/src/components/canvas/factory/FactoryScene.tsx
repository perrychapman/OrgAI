// Factory Floor, the public component (docs/design/factory-floor.md section 10.2). Probes WebGL2, chooses the 3D view or
// the floor plan, lazy-loads the three chunk (FactoryCanvas), shows the section 8 notices, owns the DOM mirror and the
// test state, and exposes the zoom / fit / focus handle. Slice 1: the empty hall; layout, labels, controls, log and
// cues arrive in later slices.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement, type Ref } from 'react'
import type { AgentMessage, RunPlan, RunStatus } from '@shared/types'
import type { FactoryAgentInput } from '../../../lib/factory/types'
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
import { useReducedMotion } from '../../../lib/canvas'
import { useFrameAnnounce } from '../../layout/CanvasFrame'
import { FactoryMirror, floorRoot, mirrorEntries } from './FactoryMirror'
import { FactoryNotice, type FactoryNoticeKind } from './FactoryNotice'
import type { FactoryCanvasHandle, FactoryCanvasProps } from './FactoryCanvas'
import type { FactoryEngineStats } from './engine/FactoryEngine'
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

/** Section 8: more current-session agents than this show the floor plan. */
export const FACTORY_3D_MAX_AGENTS = 120

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

export function FactoryScene(props: FactorySceneProps): ReactElement {
  const { mode, agents, needsYouIds, selectedId, onSelect, onRemove, onUseGraph, controlRef } = props
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

  const entries = useMemo(() => mirrorEntries(agents, needsYouIds), [agents, needsYouIds])
  const hasRoot = useMemo(() => floorRoot(agents) !== null, [agents])
  const count = entries.length

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

  // ---- test state (section 10.3): on every change of what it shows, and at most twice a second for frames ----
  const outRef = useRef<HTMLOutputElement>(null)
  const statsRef = useRef<FactoryEngineStats | null>(null)
  const shown = { renderer, reason, quality, mode, motion } as const
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
        ...s,
        view: stats?.view ?? null,
        loop: stats?.loop ?? 'stopped',
        frames: stats?.frames ?? 0,
        engines: factorySession.engines,
        perf: stats?.perf ?? null
      })
    )
  }, [])
  const onStats = useCallback((stats: FactoryEngineStats) => {
    statsRef.current = stats
    if (writeTimer.current) return
    const wait = Math.max(0, lastWrite.current + TEST_STATE_INTERVAL_MS - performance.now())
    writeTimer.current = setTimeout(writeState, wait)
  }, [writeState])
  useEffect(() => {
    if (renderer !== 'webgl2') statsRef.current = null
    writeState()
  }, [renderer, reason, quality, mode, motion, entries, writeState])
  useEffect(() => () => {
    if (writeTimer.current) clearTimeout(writeTimer.current)
  }, [])

  // ---- handle ----
  const canvasRef = useRef<FactoryCanvasHandle>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(controlRef, () => ({
    zoomIn: () => canvasRef.current?.zoomIn(),
    zoomOut: () => canvasRef.current?.zoomOut(),
    fit: () => canvasRef.current?.fit(),
    focusWorker: (id: string) => {
      const el = mirrorRef.current?.querySelector<HTMLButtonElement>(`[data-factory-worker-id="${CSS.escape(id)}"]`)
      if (!el) return false
      el.focus()
      return true
    }
  }), [])

  const Canvas = wants3D && chunk.status === 'ready' ? chunk.Canvas : null

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
      <div className="factory-stage" data-renderer={renderer}>
        {Canvas && (
          <Canvas
            key={attempt}
            quality={quality}
            booth={hasRoot}
            mountedAt={mountedAt.current}
            onStats={onStats}
            onFailed={onCanvasFailed}
            onContextLost={onContextLost}
            onContextRestored={onContextRestored}
            handleRef={canvasRef}
          />
        )}
        <FactoryMirror
          mode={mode}
          entries={entries}
          renderer={renderer}
          selectedId={selectedId}
          onSelect={onSelect}
          onRemove={onRemove}
          mirrorRef={mirrorRef}
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
      <output hidden data-testid="factory-state" ref={outRef} />
    </div>
  )
}
