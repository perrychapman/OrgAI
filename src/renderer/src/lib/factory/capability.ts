// WebGL2 capability probe, the developer switch and the per-session renderer facts of the Factory Floor
// (docs/design/factory-floor.md section 8). No three, no DOM globals: the canvas factory and the storage are injected.

/** Developer switch read at scene mount (documented in the agent notes only, never user-facing). */
export const FACTORY_RENDERER_KEY = 'orgai.factory.renderer'

/**
 * Values of the developer switch:
 * - 'floor-plan': the floor plan, reason 'forced', no notice (spec section 8).
 * - 'no-webgl2': behave as if the probe found no WebGL2 (the "3D view unavailable" notice).
 * - 'chunk-failed': behave as if the three chunk failed to load (the "3D view did not load" notice).
 */
export type ForcedRenderer = 'floor-plan' | 'no-webgl2' | 'chunk-failed'

const FORCED: readonly ForcedRenderer[] = ['floor-plan', 'no-webgl2', 'chunk-failed']

/** The switch's value, or null when unset, unknown or unreadable (storage can throw). */
export function readForcedRenderer(getItem: ((key: string) => string | null) | null | undefined): ForcedRenderer | null {
  if (!getItem) return null
  let raw: string | null
  try {
    raw = getItem(FACTORY_RENDERER_KEY)
  } catch {
    return null
  }
  return raw !== null && (FORCED as readonly string[]).includes(raw) ? (raw as ForcedRenderer) : null
}

/** The part of a WebGL2 context the probe touches. */
export interface ProbeContext {
  getExtension(name: string): unknown
}
/** The part of an HTMLCanvasElement the probe touches. */
export interface ProbeCanvas {
  getContext(contextId: 'webgl2', options?: { failIfMajorPerformanceCaveat?: boolean }): ProbeContext | null
}

export interface WebGL2Probe {
  /** WebGL2 is available at all. */
  ok: boolean
  /** A context only came without failIfMajorPerformanceCaveat: software rendering (SwiftShader and the like). */
  software: boolean
  /** Starting quality step (section 9.2): software starts at minimal. */
  quality: 'high' | 'minimal'
}

const NO_WEBGL2: WebGL2Probe = { ok: false, software: false, quality: 'minimal' }

function tryContext(createCanvas: () => ProbeCanvas, strict: boolean): ProbeContext | null {
  try {
    // A fresh canvas per attempt: a canvas whose first getContext failed may not be asked again with other options.
    return createCanvas().getContext('webgl2', strict ? { failIfMajorPerformanceCaveat: true } : {})
  } catch {
    return null
  }
}

/** Frees the probe context at once (Chromium caps live contexts per page). */
function release(ctx: ProbeContext): void {
  try {
    const ext = ctx.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null
    ext?.loseContext?.()
  } catch {
    // Nothing to free.
  }
}

/**
 * Asks for WebGL2 with failIfMajorPerformanceCaveat, then without it (a software context: quality 'minimal', no
 * notice). Null both times means no WebGL2. Every probe context is released with WEBGL_lose_context.
 */
export function probeWebGL2(createCanvas: () => ProbeCanvas): WebGL2Probe {
  const hw = tryContext(createCanvas, true)
  if (hw) {
    release(hw)
    return { ok: true, software: false, quality: 'high' }
  }
  const sw = tryContext(createCanvas, false)
  if (sw) {
    release(sw)
    return { ok: true, software: true, quality: 'minimal' }
  }
  return NO_WEBGL2
}

let cachedProbe: WebGL2Probe | null = null

/** probeWebGL2 once per app session ("Try 3D again" clears the cache with resetWebGL2Probe). */
export function cachedWebGL2Probe(createCanvas: () => ProbeCanvas): WebGL2Probe {
  if (!cachedProbe) cachedProbe = probeWebGL2(createCanvas)
  return cachedProbe
}

export function resetWebGL2Probe(): void {
  cachedProbe = null
}

/** Context losses within this window count toward the third-loss rule (section 8). */
export const CONTEXT_LOSS_WINDOW_MS = 10 * 60_000
/** A lost context that has not come back within this time gives up on 3D. */
export const CONTEXT_RESTORE_TIMEOUT_MS = 5_000
/** The loss that switches to the floor plan for the session. */
export const CONTEXT_LOSS_LIMIT = 3

/** Records one context loss at `now`; `third` is true when it is the third within ten minutes. */
export function recordContextLoss(history: readonly number[], now: number): { history: number[]; third: boolean } {
  const kept = history.filter((t) => now - t < CONTEXT_LOSS_WINDOW_MS)
  kept.push(now)
  return { history: kept, third: kept.length >= CONTEXT_LOSS_LIMIT }
}

/**
 * Facts that live for the app session (not saved): context-loss history, the third-loss switch, whether the
 * "3D view unavailable" notice was dismissed, and how many engines are alive (the leak check in the test state).
 */
export const factorySession = {
  losses: [] as number[],
  floorPlanForSession: false,
  noWebGL2Dismissed: false,
  engines: 0
}
