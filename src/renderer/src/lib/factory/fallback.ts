// Which renderer the Factory Floor shows and why, the section 8 notices and their exact copy, and the context-loss
// timing (docs/design/factory-floor.md section 8). Pure: no three, no DOM; timers and the session are injected.
import type { FactoryAgentInput } from './types'
import type { FactoryReason } from './snapshot'
import { CONTEXT_RESTORE_TIMEOUT_MS, recordContextLoss, type ForcedRenderer } from './capability'

/** Section 8: more current-session agents than this show the floor plan ("Large team"). */
export const FACTORY_3D_MAX_AGENTS = 120

/** Agents of the current session (earlier sessions are listed in Find a worker only and never count). */
export function currentAgentCount(agents: readonly Pick<FactoryAgentInput, 'session'>[]): number {
  let n = 0
  for (const a of agents) if (a.session === 'current') n++
  return n
}

/** Context loss: none, waiting for a restore, gave up after the timeout, or the third loss in ten minutes. */
export type LostState = 'none' | 'restoring' | 'gave-up' | 'third'

export interface ReasonInput {
  forced: ForcedRenderer | null
  /** The probe found WebGL2 (false when forced to 'no-webgl2'). */
  webgl2: boolean
  /** The probe said yes but the renderer could not get a context. */
  rendererFailed: boolean
  currentAgents: number
  lost: LostState
  chunkFailed: boolean
}

/**
 * Why the floor plan shows, or undefined for the 3D view. Precedence: forced > no-webgl2 > too-many > context-lost >
 * chunk-failed.
 */
export function factoryReason(i: ReasonInput): FactoryReason | undefined {
  if (i.forced === 'floor-plan') return 'forced'
  if (i.forced === 'no-webgl2' || !i.webgl2 || i.rendererFailed) return 'no-webgl2'
  if (i.currentAgents > FACTORY_3D_MAX_AGENTS) return 'too-many'
  if (i.lost === 'gave-up' || i.lost === 'third') return 'context-lost'
  // The 'chunk-failed' developer value makes the lazy import reject, which arrives here as chunkFailed.
  if (i.chunkFailed) return 'chunk-failed'
  return undefined
}

export type FactoryNoticeKind = 'no-webgl2' | 'chunk-failed' | 'lost' | 'third-loss' | 'too-many'

/** The banner for a reason ('forced' has none; the no-WebGL2 one can be dismissed for the session). */
export function factoryNotice(reason: FactoryReason | undefined, lost: LostState, noWebGL2Dismissed: boolean): FactoryNoticeKind | null {
  if (reason === 'no-webgl2') return noWebGL2Dismissed ? null : 'no-webgl2'
  if (reason === 'too-many') return 'too-many'
  if (reason === 'context-lost') return lost === 'third' ? 'third-loss' : 'lost'
  if (reason === 'chunk-failed') return 'chunk-failed'
  return null
}

export interface NoticeCopy {
  tone: 'info' | 'warning'
  title: string
  body: string
  /** "Try 3D again" is offered ("Use Graph" always is). */
  retry: boolean
  /** Dismissible for the session. */
  dismissible: boolean
}

/** Section 8's exact copy. `count` is the current-session agents (the large-team body). */
export function noticeCopy(kind: FactoryNoticeKind, count: number): NoticeCopy {
  switch (kind) {
    case 'no-webgl2':
      return { tone: 'info', title: '3D view unavailable', body: 'This computer did not give OrgAI WebGL 2, so the factory is shown as a floor plan.', retry: false, dismissible: true }
    case 'chunk-failed':
      return { tone: 'warning', title: '3D view did not load', body: 'OrgAI could not load the 3D renderer. Showing the floor plan.', retry: true, dismissible: false }
    case 'lost':
      return { tone: 'warning', title: '3D view stopped', body: 'The graphics context was lost and did not come back. Showing the floor plan.', retry: true, dismissible: false }
    case 'third-loss':
      return { tone: 'warning', title: '3D view stopped', body: 'The 3D view stopped 3 times, so OrgAI switched to the floor plan for this session.', retry: true, dismissible: false }
    case 'too-many':
      return { tone: 'info', title: 'Large team', body: `This team has ${count} agents. The 3D floor shows up to ${FACTORY_3D_MAX_AGENTS}, so the floor plan is shown.`, retry: false, dismissible: false }
  }
}

/** The stage note while a lost context may still come back (announced once through the frame). */
export const RESTORING_TEXT = 'The 3D view stopped. Restoring…'

export interface ContextLossDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** The app session's loss history and third-loss switch (capability.ts factorySession). */
  session: { losses: number[]; floorPlanForSession: boolean }
  /** Every state change. */
  onChange(state: LostState): void
}

/**
 * Section 8's context-loss rules: a loss waits CONTEXT_RESTORE_TIMEOUT_MS (5 s) for the restore, then gives up; the
 * third loss within ten minutes gives up at once and for the app session. A restore counts only while waiting.
 */
export class ContextLossWatch {
  private readonly deps: ContextLossDeps
  private timer: unknown = null
  private current: LostState

  constructor(deps: ContextLossDeps) {
    this.deps = deps
    this.current = deps.session.floorPlanForSession ? 'third' : 'none'
  }

  get state(): LostState {
    return this.current
  }

  /** webglcontextlost. Returns the new state ('restoring' or 'third'). */
  lost(): LostState {
    const r = recordContextLoss(this.deps.session.losses, this.deps.now())
    this.deps.session.losses = r.history
    this.clear()
    if (r.third) {
      this.deps.session.floorPlanForSession = true
      this.set('third')
      return this.current
    }
    this.set('restoring')
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      if (this.current === 'restoring') this.set('gave-up')
    }, CONTEXT_RESTORE_TIMEOUT_MS)
    return this.current
  }

  /** webglcontextrestored: back to 3D, but only while still waiting (a late restore after giving up changes nothing). */
  restored(): void {
    if (this.current !== 'restoring') return
    this.clear()
    this.set('none')
  }

  /** "Try 3D again": forgets the losses and the session switch. */
  reset(): void {
    this.clear()
    this.deps.session.losses = []
    this.deps.session.floorPlanForSession = false
    this.set('none')
  }

  /** Unmount: no timer outlives the scene. */
  dispose(): void {
    this.clear()
  }

  private clear(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  private set(state: LostState): void {
    if (state === this.current) return
    this.current = state
    this.deps.onChange(state)
  }
}
