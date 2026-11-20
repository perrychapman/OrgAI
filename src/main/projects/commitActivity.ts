import type { Project, ProjectCommitActivity } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { folderConfigLoadsNow } from '../runtime/folderConfigTrust'
import { gitCommitTimes } from '../runtime/worktrees'

/**
 * Commits per local day for the Dashboard chart (projects:commitActivity). Desktop IPC only: no agent tool and no host
 * dispatcher entry reads it. The handler takes no argument; the service reads the stored projects itself, so no
 * renderer-supplied path or id ever reaches git. Only commit timestamps are requested from git (never messages,
 * authors or paths).
 */

export const COMMIT_ACTIVITY_DAYS = 7
export const COMMIT_ACTIVITY_MAX_PROJECTS = 50
export const COMMIT_ACTIVITY_MAX_COMMITS = 5000
export const COMMIT_ACTIVITY_CONCURRENCY = 3
export const COMMIT_ACTIVITY_TIMEOUT_MS = 5000
export const COMMIT_ACTIVITY_CACHE_MS = 60_000

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** The local calendar day of a date as YYYY-MM-DD. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The seven local days ending today, oldest first. Calendar arithmetic, so a 23 or 25 hour day (DST) still counts as one day. */
export function lastSevenLocalDays(now: Date): Date[] {
  const out: Date[] = []
  for (let i = COMMIT_ACTIVITY_DAYS - 1; i >= 0; i--) out.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))
  return out
}

/** Local midnight six days ago, in epoch milliseconds: what `git log --since` should use. */
export function commitWindowStartMs(now: Date): number {
  return lastSevenLocalDays(now)[0].getTime()
}

/** Seven zeroes for the window ending at `now`. */
export function emptyDays(now: Date): ProjectCommitActivity['days'] {
  return lastSevenLocalDays(now).map((d) => ({ date: localDayKey(d), commits: 0 }))
}

/**
 * Pure bucketing: commit timestamps (unix seconds) into the seven local days ending at `now`. A timestamp outside the
 * window (before the first local midnight, or after the end of today) is ignored. Day boundaries are local midnight.
 */
export function bucketCommitDays(now: Date, timesSec: readonly number[]): ProjectCommitActivity['days'] {
  const days = emptyDays(now)
  const index = new Map(days.map((d, i) => [d.date, i]))
  for (const t of timesSec) {
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    const i = index.get(localDayKey(new Date(t * 1000)))
    if (i !== undefined) days[i].commits++
  }
  return days
}

function unavailable(projectId: string, now: Date): ProjectCommitActivity {
  return { projectId, available: false, days: emptyDays(now), total: 0 }
}

export interface CommitActivityDeps {
  /** The stored projects (ProjectStore.list). */
  listProjects(): Project[]
  /** Whether the folder's own agent config may load (folder trust). Default: folderConfigLoadsNow. */
  folderTrusted?(project: Project): boolean
  /** Commit timestamps from git; default: gitCommitTimes. */
  commitTimes?(root: string, sinceMs: number): Promise<{ ok: boolean; times: number[] }>
  now?(): Date
}

interface CacheEntry {
  /** When the value settled (the 60 s starts then, not when it was queued); null while it is still pending. */
  at: number | null
  value: Promise<ProjectCommitActivity>
}

export class CommitActivityService {
  private readonly cache = new Map<string, CacheEntry>()
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly deps: CommitActivityDeps) {}

  /** One entry per stored code project, in store order; engagements are left out. Never rejects. */
  async activity(): Promise<ProjectCommitActivity[]> {
    const now = (this.deps.now ?? (() => new Date()))()
    let code: Project[]
    try {
      code = this.deps.listProjects().filter((p) => projectKindOf(p) === 'code')
    } catch {
      return []
    }
    const live = new Set<string>()
    const out = await Promise.all(
      code.map((p, i) => {
        if (i >= COMMIT_ACTIVITY_MAX_PROJECTS) return Promise.resolve(unavailable(p.id, now))
        const key = `${p.id}\0${p.path}\0${localDayKey(now)}`
        live.add(key)
        return this.cached(key, now, () => this.compute(p, now))
      })
    )
    // Drop settled entries that are no longer listed and older than the cache time; a pending one is never dropped.
    for (const k of [...this.cache.keys()]) {
      const e = this.cache.get(k)
      if (e && e.at !== null && !live.has(k) && Date.now() - e.at > COMMIT_ACTIVITY_CACHE_MS) this.cache.delete(k)
    }
    return out
  }

  /**
   * One promise per key: while it is pending every caller gets the same one (a second call during a slow batch never
   * queues a second git run, so the waiting list is bounded by the number of distinct keys); once settled it is reused
   * for 60 s counted from settling.
   */
  private cached(key: string, now: Date, make: () => Promise<ProjectCommitActivity>): Promise<ProjectCommitActivity> {
    const hit = this.cache.get(key)
    if (hit && (hit.at === null || Date.now() - hit.at < COMMIT_ACTIVITY_CACHE_MS)) return hit.value
    const entry: CacheEntry = { at: null, value: undefined as unknown as Promise<ProjectCommitActivity> }
    entry.value = make()
      .catch(() => unavailable(key.split('\0')[0], now))
      .then((v) => {
        entry.at = Date.now()
        return v
      })
    this.cache.set(key, entry)
    return entry.value
  }

  private async compute(p: Project, now: Date): Promise<ProjectCommitActivity> {
    let trusted = false
    try {
      trusted = (this.deps.folderTrusted ?? folderConfigLoadsNow)(p)
    } catch {
      trusted = false
    }
    if (!trusted || typeof p.path !== 'string' || !p.path) return unavailable(p.id, now)
    await this.slot()
    try {
      const r = await (this.deps.commitTimes ?? ((root, since) => gitCommitTimes(root, since, { timeoutMs: COMMIT_ACTIVITY_TIMEOUT_MS, maxCommits: COMMIT_ACTIVITY_MAX_COMMITS })))(p.path, commitWindowStartMs(now))
      if (!r.ok) return unavailable(p.id, now)
      const days = bucketCommitDays(now, r.times.slice(0, COMMIT_ACTIVITY_MAX_COMMITS))
      return { projectId: p.id, available: true, days, total: days.reduce((n, d) => n + d.commits, 0) }
    } catch {
      return unavailable(p.id, now)
    } finally {
      this.release()
    }
  }

  private slot(): Promise<void> {
    if (this.running < COMMIT_ACTIVITY_CONCURRENCY) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(() => { this.running++; resolve() }))
  }

  private release(): void {
    this.running--
    this.waiting.shift()?.()
  }
}
