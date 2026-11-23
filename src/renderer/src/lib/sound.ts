/**
 * Settings > General > Notifications "Play a sound" (AppSettings.playSound, default off). A short two-note chime made
 * with WebAudio (no asset file, no network, no CSP change), played when a new decision starts waiting. Pure decision
 * in `chimeDecision`; `playChime` is the only side effect; `useAttentionSound` (mounted once in App.tsx) wires them.
 */

/** Most one chime per this many ms, however many decisions arrive. */
export const CHIME_MIN_GAP_MS = 4000

export interface ChimeState {
  /** Decision keys seen so far (null until the first observation, which never chimes). */
  seen: ReadonlySet<string> | null
  /** Runs seen so far: a run that appears (loaded at start, opened from history) brings its waiting decisions silently. */
  runs: ReadonlySet<string>
  lastAt: number
}

export const EMPTY_CHIME: ChimeState = { seen: null, runs: new Set(), lastAt: 0 }

/**
 * Whether a new observation of the waiting decisions (`[runId, key]` pairs over every run in view, `runIds` every
 * run in view) should chime: only when the sound is on, never on the first observation, never for a run seen for the
 * first time (its decisions were already waiting when it loaded), only for a key not seen before on a known run, and at
 * most once per CHIME_MIN_GAP_MS. Returns the next state either way.
 */
export function chimeDecision(state: ChimeState, entries: readonly (readonly [string, string])[], runIds: readonly string[], enabled: boolean, now: number): { chime: boolean; next: ChimeState } {
  const seen = new Set(entries.map(([, k]) => k))
  const runs = new Set(runIds)
  if (state.seen === null || !enabled) return { chime: false, next: { seen, runs, lastAt: state.lastAt } }
  const fresh = entries.some(([run, k]) => state.runs.has(run) && !state.seen!.has(k))
  const chime = fresh && now - state.lastAt >= CHIME_MIN_GAP_MS
  return { chime, next: { seen, runs, lastAt: chime ? now : state.lastAt } }
}

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null

/** Two soft notes (about 0.35 s). Silent when WebAudio is unavailable. Exported for tests through `setAudioFactory`. */
export function playChime(): void {
  try {
    const Ctor = (audioFactory ?? (globalThis as unknown as { AudioContext?: AudioCtor }).AudioContext) as AudioCtor | undefined
    if (!Ctor) return
    ctx ??= new Ctor()
    const c = ctx
    // A context created before any user gesture can start suspended; resuming is a no-op otherwise.
    if (c.state === 'suspended') void c.resume?.().catch(() => undefined)
    const start = c.currentTime + 0.01
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      const t = start + i * 0.12
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.08, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain)
      gain.connect(c.destination)
      osc.start(t)
      osc.stop(t + 0.24)
    }
    chimeCount++
  } catch {
    // Audio is a nicety: never let it throw into the app.
  }
}

let audioFactory: AudioCtor | null = null
let chimeCount = 0
/** Tests and e2e: replace the AudioContext constructor. */
export function setAudioFactory(f: AudioCtor | null): void {
  audioFactory = f
  ctx = null
}
/** How many chimes this window played (useAttentionSound mirrors it on <html data-chime-count> for e2e). */
export function chimesPlayed(): number {
  return chimeCount
}
