/**
 * The outputs watcher (outputs-2 section 16.5): outside edits to an output's file become 'external' versions without a
 * resident fs.watch. A watched output (outputs:watch; at most OUTPUT_WATCH_MAX per owner, expiring after
 * OUTPUT_WATCH_TTL_MS unless the owner watches again or opens the file) is stat-checked once a second by ONE timer that
 * exists only while some watch does. A window focus (checkProjects) does a stat-only pass over the outputs the user
 * opened or previewed this session plus the project's 20 newest and hands any that moved to the same poller for a short
 * while. A change is accepted when size and mtime stayed the same for OUTPUT_EXTERNAL_SETTLE_MS (the editor finished
 * saving), then OutputsServiceApi.captureExternal does the real work (path rules, digest compare, snapshot, index) and
 * raises the 'version' push itself through its onChange; this module emits only 'watch' (a file gone for 5 s, back
 * again, a watch that expired). Nothing here throws out of the timer. Electron-free; the clock and timers are injected.
 */
import { OUTPUT_EXTERNAL_SETTLE_MS, OUTPUT_WATCH_MAX, OUTPUT_WATCH_TTL_MS } from '../../shared/types'
import type { OutputRef, OutputWatchResult, OutputsChangedEvent } from '../../shared/types'
import { log } from '../log'
import type { OutputScope, OutputsServiceApi } from './api'

/** A file that stays gone this long is reported (outputs:changed 'watch'). */
export const OUTPUT_WATCH_MISSING_MS = 5000
/** Poll period while any watch exists. */
export const OUTPUT_WATCH_POLL_MS = 1000
/** How long a focus check keeps a moved output on the poller (long enough to settle and capture). */
export const OUTPUT_FOCUS_TTL_MS = OUTPUT_EXTERNAL_SETTLE_MS * 4
/** Outputs per project a focus check looks at besides the ones opened this session. */
export const OUTPUT_FOCUS_NEWEST = 20
/** Opened-this-session set cap (oldest dropped). */
const OPENED_MAX = 400
/** The pseudo owner of focus checks: never counted against OUTPUT_WATCH_MAX, never reported when it lapses. */
const FOCUS_OWNER = '\u0000focus'

export interface OutputWatcherOptions {
  service: Pick<OutputsServiceApi, 'statCurrent' | 'captureExternal' | 'get' | 'list'>
  /** The folder scope of a stored project, or null when it is gone. */
  scopeOf(projectId: string): OutputScope | null
  emit(event: OutputsChangedEvent): void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface OutputWatcher {
  /** `owner` is a window's web contents id or a socket connection id, as a string. */
  watch(owner: string, ref: OutputRef): OutputWatchResult
  unwatch(owner: string, ref: OutputRef): OutputWatchResult
  /** The file was opened: extend its watches and remember it for the focus check. */
  touch(ref: OutputRef): void
  /** The output was previewed or opened this session (candidates of the focus check). */
  noteOpened(ref: OutputRef): void
  /** A window closed or a connection ended. */
  dropOwner(owner: string): void
  /** The output was forgotten or deleted: drop every watch on it (nothing to report). */
  release(ref: OutputRef): void
  /** Window focus: stat the opened outputs and the newest ones of these projects. */
  checkProjects(projectIds: readonly string[]): void
  /** Projects with an output opened or previewed this session (what a focus check covers besides scoped windows' projects). */
  openedProjectIds(): string[]
  /** One poll pass (the timer calls it; tests too). */
  tick(): Promise<void>
  /** Number of watched outputs (focus checks included). */
  size(): number
  dispose(): void
}

interface Stat {
  size: number
  mtimeMs: number
}

interface Entry {
  projectId: string
  outputId: string
  /** owner -> expiry (epoch ms). */
  owners: Map<string, number>
  last?: Stat
  /** When `last` was first seen unchanged. */
  stableSince: number
  /** A change (or the first look) still has to settle and be handed to the service. */
  pending: boolean
  missingSince?: number
  missingReported: boolean
  busy: boolean
}

const keyOf = (ref: OutputRef): string => `${ref.projectId}\u0000${ref.outputId}`
const sameStat = (a: Stat | undefined, b: Stat): boolean => !!a && a.size === b.size && a.mtimeMs === b.mtimeMs

export function createOutputWatcher(options: OutputWatcherOptions): OutputWatcher {
  const { service } = options
  const now = options.now ?? Date.now
  const startTimer = options.setInterval ?? ((fn, ms) => {
    const h = setInterval(fn, ms)
    // A watch never keeps the process alive.
    ;(h as { unref?: () => void }).unref?.()
    return h
  })
  const stopTimer = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const entries = new Map<string, Entry>()
  /** Stats seen by focus checks (and polls), per output key. */
  const seen = new Map<string, Stat | null>()
  const opened = new Map<string, OutputRef>()
  let timer: unknown
  let ticking = false

  const emit = (projectId: string, outputId: string): void => {
    try {
      options.emit({ projectId, ids: [outputId], what: 'watch' })
    } catch (e) {
      log.warn(`outputs watcher: push failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const ensureTimer = (): void => {
    if (timer === undefined && entries.size > 0) timer = startTimer(() => void tick(), OUTPUT_WATCH_POLL_MS)
  }
  const maybeStopTimer = (): void => {
    if (timer !== undefined && entries.size === 0) {
      stopTimer(timer)
      timer = undefined
    }
  }

  const ownedBy = (owner: string): number => {
    let n = 0
    for (const e of entries.values()) if (e.owners.has(owner)) n++
    return n
  }

  const add = (owner: string, ref: OutputRef, ttl: number): Entry => {
    const key = keyOf(ref)
    let e = entries.get(key)
    if (!e) {
      e = { projectId: ref.projectId, outputId: ref.outputId, owners: new Map(), stableSince: now(), pending: true, missingReported: false, busy: false }
      entries.set(key, e)
    }
    e.owners.set(owner, now() + ttl)
    ensureTimer()
    return e
  }

  const step = async (e: Entry): Promise<void> => {
    const scope = options.scopeOf(e.projectId)
    if (!scope) {
      entries.delete(keyOf(e))
      return
    }
    const t = now()
    const stat = service.statCurrent(scope, e.outputId)
    seen.set(keyOf(e), stat)
    if (!stat) {
      e.last = undefined
      e.pending = true
      e.missingSince ??= t
      if (!e.missingReported && t - e.missingSince >= OUTPUT_WATCH_MISSING_MS) {
        e.missingReported = true
        emit(e.projectId, e.outputId)
      }
      return
    }
    if (e.missingSince !== undefined) {
      const wasReported = e.missingReported
      e.missingSince = undefined
      e.missingReported = false
      if (wasReported) emit(e.projectId, e.outputId)
    }
    if (!sameStat(e.last, stat)) {
      e.last = stat
      e.stableSince = t
      e.pending = true
      return
    }
    if (e.pending && !e.busy && t - e.stableSince >= OUTPUT_EXTERNAL_SETTLE_MS) {
      e.pending = false
      e.busy = true
      try {
        // The service raises the 'version' push through its onChange; its result needs nothing from us.
        await service.captureExternal(scope, e.outputId)
      } finally {
        e.busy = false
      }
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const t = now()
      for (const [key, e] of [...entries]) {
        let reportExpiry = false
        for (const [owner, expiry] of [...e.owners]) {
          if (expiry > t) continue
          e.owners.delete(owner)
          if (owner !== FOCUS_OWNER) reportExpiry = true
        }
        if (e.owners.size === 0) {
          entries.delete(key)
          if (reportExpiry) emit(e.projectId, e.outputId)
          continue
        }
        try {
          await step(e)
        } catch (err) {
          log.warn(`outputs watcher: check failed for ${e.outputId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      ticking = false
      maybeStopTimer()
    }
  }

  const noteOpened = (ref: OutputRef): void => {
    const key = keyOf(ref)
    opened.delete(key)
    opened.set(key, { projectId: ref.projectId, outputId: ref.outputId })
    if (opened.size > OPENED_MAX) {
      const oldest = opened.keys().next().value
      if (oldest !== undefined) opened.delete(oldest)
    }
  }

  return {
    watch(owner, ref) {
      if (!service.get(ref.projectId, ref.outputId)) return { refused: 'That output is not in this project.' }
      if (!options.scopeOf(ref.projectId)) return { refused: 'Project not found' }
      const existing = entries.get(keyOf(ref))
      if (!existing?.owners.has(owner) && ownedBy(owner) >= OUTPUT_WATCH_MAX) {
        return { refused: `You can watch at most ${OUTPUT_WATCH_MAX} outputs at once. Close one first.` }
      }
      add(owner, ref, OUTPUT_WATCH_TTL_MS)
      noteOpened(ref)
      return { watched: true }
    },
    unwatch(owner, ref) {
      const key = keyOf(ref)
      const e = entries.get(key)
      if (e) {
        e.owners.delete(owner)
        if (e.owners.size === 0) entries.delete(key)
        maybeStopTimer()
      }
      return { watched: false }
    },
    touch(ref) {
      noteOpened(ref)
      const e = entries.get(keyOf(ref))
      if (!e) return
      const t = now()
      for (const [owner] of e.owners) e.owners.set(owner, t + (owner === FOCUS_OWNER ? OUTPUT_FOCUS_TTL_MS : OUTPUT_WATCH_TTL_MS))
    },
    noteOpened,
    dropOwner(owner) {
      for (const [key, e] of [...entries]) {
        if (e.owners.delete(owner) && e.owners.size === 0) entries.delete(key)
      }
      maybeStopTimer()
    },
    openedProjectIds: () => [...new Set([...opened.values()].map((r) => r.projectId))],
    release(ref) {
      const key = keyOf(ref)
      entries.delete(key)
      seen.delete(key)
      opened.delete(key)
      maybeStopTimer()
    },
    checkProjects(projectIds) {
      for (const projectId of projectIds) {
        try {
          const scope = options.scopeOf(projectId)
          if (!scope) continue
          const refs = new Map<string, OutputRef>()
          for (const r of opened.values()) if (r.projectId === projectId) refs.set(keyOf(r), r)
          for (const o of service.list(projectId).slice(0, OUTPUT_FOCUS_NEWEST)) refs.set(keyOf({ projectId, outputId: o.id }), { projectId, outputId: o.id })
          for (const [key, ref] of refs) {
            const stat = service.statCurrent(scope, ref.outputId)
            const before = seen.get(key)
            seen.set(key, stat)
            // Stat only: hand an output to the poller when it looks different from the last time (or is new to us).
            if (stat && (before === undefined || before === null || !sameStat(before, stat))) add(FOCUS_OWNER, ref, OUTPUT_FOCUS_TTL_MS)
          }
        } catch (e) {
          log.warn(`outputs watcher: focus check failed for ${projectId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    },
    tick,
    size: () => entries.size,
    dispose() {
      if (timer !== undefined) stopTimer(timer)
      timer = undefined
      entries.clear()
      seen.clear()
      opened.clear()
    }
  }
}
