import { useRef } from 'react'

/**
 * The arrival rule (docs/design/motion.md 2.2): entry motion only for items that arrive while the user is looking.
 * Ids present at the first render of a surface, or right after its scope changes (another project, run or filter),
 * are "seen" and never animate. Ids added later are new for `windowMs` after they were first observed, then seen; the
 * window keeps an entry class stable across re-renders while its animation plays, and a later remount of the row
 * (windowing, a re-key) does not replay it. A whole surface remount starts again with everything seen.
 */
export interface ArrivalOptions {
  /** How long an arrived id stays new (ms). Longer than the longest entry animation. Default 1000. */
  windowMs?: number
  /**
   * When more than this many ids arrive in one update, none of them animate (a burst, a chain load, a prepend).
   * Default Infinity.
   */
  maxPerBatch?: number
}

export const ARRIVAL_WINDOW_MS = 1000

/** Pure tracker behind `useArrival`; unit-tested in useArrival.test.ts. */
export class ArrivalTracker {
  private scope: string | undefined
  private initialised = false
  private readonly seen = new Set<string>()
  private readonly arrived = new Map<string, number>()
  private readonly windowMs: number
  private readonly maxPerBatch: number

  constructor(options: ArrivalOptions = {}) {
    this.windowMs = options.windowMs ?? ARRIVAL_WINDOW_MS
    this.maxPerBatch = options.maxPerBatch ?? Number.POSITIVE_INFINITY
  }

  /** Feed the ids currently shown. Idempotent for the same ids (safe under StrictMode double render). */
  update(ids: Iterable<string>, scope: string, now: number): void {
    const list = [...ids]
    if (!this.initialised || scope !== this.scope) {
      this.initialised = true
      this.scope = scope
      this.seen.clear()
      this.arrived.clear()
      for (const id of list) this.seen.add(id)
      return
    }
    const fresh = list.filter((id) => !this.seen.has(id))
    for (const id of fresh) this.seen.add(id)
    if (fresh.length === 0 || fresh.length > this.maxPerBatch) return
    for (const id of fresh) this.arrived.set(id, now)
    // Forget expired arrivals so the map stays small on long-lived surfaces.
    for (const [id, at] of this.arrived) if (now - at >= this.windowMs) this.arrived.delete(id)
  }

  /** True while `id` arrived after the surface was shown and its window has not passed. */
  isNew(id: string, now: number): boolean {
    const at = this.arrived.get(id)
    return at !== undefined && now - at < this.windowMs
  }

  /** Marks ids as arriving now regardless of the first-render rule (an expand that reveals rows the user asked for). */
  markArrived(ids: Iterable<string>, now: number): void {
    for (const id of ids) {
      this.seen.add(id)
      this.arrived.set(id, now)
    }
  }
}

/**
 * Returns `isNew(id)` for the ids rendered this time. `scope` resets the surface: pass the project / run / filter key so
 * switching never animates the restored list.
 *
 *   const isNew = useArrival(rows.map((r) => r.id), runId)
 *   <li className={isNew(row.id) ? 'motion-enter' : undefined}>
 */
export function useArrival(ids: readonly string[], scope = '', options?: ArrivalOptions): (id: string) => boolean {
  const ref = useRef<ArrivalTracker | null>(null)
  if (!ref.current) ref.current = new ArrivalTracker(options)
  const tracker = ref.current
  const now = Date.now()
  tracker.update(ids, scope, now)
  return (id: string) => tracker.isNew(id, now)
}
