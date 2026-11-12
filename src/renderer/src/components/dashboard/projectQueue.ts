/**
 * The Dashboard's shared per-project call queue (docs/design/dashboard-2.md 10.4): `maintenance.listWorktrees`,
 * `seedTeamReview` and `mcp.list` go through here. At most `MAX_IN_FLIGHT` calls run at once; results are cached for
 * the session per kind and project, and a cached value is re-fetched only when it is older than the kind's max age.
 * Callers enqueue on Dashboard mount only (after first paint), never on a timer or a run event. A failed call caches
 * `null`. Nothing here touches the DOM or the store.
 */

export type ProjectCallKind = 'worktrees' | 'teamReview' | 'mcpList'

export const MAX_IN_FLIGHT = 3

/** How long a cached result counts as fresh. Team reviews: once per session (pushes keep them current). */
export const MAX_AGE_MS: Record<ProjectCallKind, number> = {
  worktrees: 10 * 60_000,
  teamReview: Number.POSITIVE_INFINITY,
  mcpList: 10 * 60_000
}

interface Entry {
  value: unknown
  at: number
}

export interface ProjectQueue {
  /**
   * Runs `fn` for (kind, projectId) unless a fresh cached value exists or the same call is already queued or running.
   * Resolves with the value (cached or new), `null` after a failure.
   */
  enqueue<T>(kind: ProjectCallKind, projectId: string, fn: () => Promise<T>): Promise<T | null>
  /** The cached value, or undefined when there is none. */
  cached<T>(kind: ProjectCallKind, projectId: string): T | null | undefined
  /** Calls running now (for tests). */
  inFlight(): number
  /** Drops a project's cached values (a deleted project). */
  forget(projectId: string): void
}

export function createProjectQueue(opts: { now?: () => number; max?: number } = {}): ProjectQueue {
  const now = opts.now ?? (() => Date.now())
  const max = opts.max ?? MAX_IN_FLIGHT
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Promise<unknown>>()
  const waiting: (() => void)[] = []
  let running = 0
  const key = (kind: ProjectCallKind, id: string): string => `${kind}\u0000${id}`

  const next = (): void => {
    while (running < max && waiting.length > 0) waiting.shift()?.()
  }

  return {
    enqueue<T>(kind: ProjectCallKind, projectId: string, fn: () => Promise<T>): Promise<T | null> {
      const k = key(kind, projectId)
      const hit = cache.get(k)
      if (hit && now() - hit.at < MAX_AGE_MS[kind]) return Promise.resolve(hit.value as T | null)
      const inflight = pending.get(k)
      if (inflight) return inflight as Promise<T | null>
      const p = new Promise<T | null>((resolve) => {
        waiting.push(() => {
          running++
          let out: Promise<T>
          try {
            out = fn()
          } catch (err) {
            out = Promise.reject(err)
          }
          out
            .then(
              (value) => {
                cache.set(k, { value, at: now() })
                resolve(value)
              },
              () => {
                cache.set(k, { value: null, at: now() })
                resolve(null)
              }
            )
            .finally(() => {
              running--
              pending.delete(k)
              next()
            })
        })
      })
      pending.set(k, p)
      next()
      return p
    },
    cached<T>(kind: ProjectCallKind, projectId: string): T | null | undefined {
      return cache.get(key(kind, projectId))?.value as T | null | undefined
    },
    inFlight: () => running,
    forget(projectId: string): void {
      for (const kind of Object.keys(MAX_AGE_MS) as ProjectCallKind[]) cache.delete(key(kind, projectId))
    }
  }
}

/** The one queue every Dashboard mount shares. */
export const projectQueue: ProjectQueue = createProjectQueue()

/** Runs `fn` once the page has painted (requestIdleCallback, else 500 ms). Returns a cancel function. */
export function afterFirstPaint(fn: () => void): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout: 2000 })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = window.setTimeout(fn, 500)
  return () => window.clearTimeout(t)
}
