/**
 * HostActivityTracker (cli-spec 3.2(4), Wave 1): leases and polled sources that keep a host from going idle, the idle
 * exit timer and the ownership-safe drain. Electron-free; relative imports only.
 *
 * Sources (RunManager, services) are injected by the bootstrap; this module imports no service.
 */
import { ACTIVITY_LEASE_KINDS, DEFAULT_DAEMON_IDLE_MINUTES } from '../../shared/types'
import type { ActivityLeaseKind, HostActivitySnapshot, HostState, HostStopInput, HostStopResult } from '../../shared/types'
import type { HostActivityTrackerApi } from './types'

export interface HostActivityOptions {
  /** The host's ownership (ownership.ts): markDraining flips daemon.json to 'draining', release removes our files only. */
  ownership?: { markDraining(): boolean; release(): void }
  /** Idle time before an armed idle exit drains the host. */
  idleMs?: number
  /** How often polled sources are read. */
  pollMs?: number
  now?: () => number
  /** host.stop with force: stop every run first. */
  forceStop?: () => Promise<void>
  /** Called once the drain finished (the process may exit). */
  onDrained?: () => void
  log?: (m: string) => void
}

/** Default interval of the idle-exit poll. */
export const DEFAULT_ACTIVITY_POLL_MS = 15_000

function zeroCounts(): Record<ActivityLeaseKind, number> {
  const counts = {} as Record<ActivityLeaseKind, number>
  for (const k of ACTIVITY_LEASE_KINDS) counts[k] = 0
  return counts
}

function idleSnapshot(state: HostState): HostActivitySnapshot {
  return { counts: zeroCounts(), total: 0, idle: true, state }
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

interface Source {
  kind: ActivityLeaseKind
  count: () => number
  /** Its failure was logged already (logged once per source). */
  warned: boolean
}

/**
 * Leases (acquire / track) and polled sources (addSource) per ActivityLeaseKind. The host is idle when every count is
 * 0; `idleSince` is when it last became idle (sources are re-read on every poll and every snapshot). An armed idle
 * exit drains once the host has been idle for idleMs without a break. The drain (requestDrain or idle exit) is one
 * shared promise: state 'draining', ownership.markDraining, ownership.release (HostOwnership removes only this host's
 * own files), then onDrained once. Leases still work after the drain (in-flight work finishes); the state stays.
 */
export class HostActivityTracker implements HostActivityTrackerApi {
  private readonly leases = zeroCounts()
  private readonly sources = new Set<Source>()
  private readonly listeners = new Set<(s: HostActivitySnapshot) => void>()
  private hostState: HostState = 'ready'
  private idleSince: number | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined
  private readonly now: () => number

  constructor(private readonly opts: HostActivityOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.idleSince = this.now()
  }

  acquire(kind: ActivityLeaseKind, _label?: string): () => void {
    this.leases[kind]++
    this.notify()
    let released = false
    return () => {
      if (released) return
      released = true
      this.leases[kind]--
      this.notify()
    }
  }

  track<T>(kind: ActivityLeaseKind, p: Promise<T>): Promise<T> {
    const release = this.acquire(kind)
    // Both handlers release, so this derived promise never rejects; the caller handles p itself.
    p.then(release, release)
    return p
  }

  addSource(kind: ActivityLeaseKind, count: () => number): () => void {
    const source: Source = { kind, count, warned: false }
    this.sources.add(source)
    this.notify()
    return () => {
      if (this.sources.delete(source)) this.notify()
    }
  }

  snapshot(): HostActivitySnapshot {
    return this.take().snap
  }

  isIdle(): boolean {
    return this.snapshot().idle
  }

  state(): HostState {
    return this.hostState
  }

  requestDrain(input: HostStopInput = {}): Promise<HostStopResult> {
    if (this.draining) return this.draining.then(() => ({ stopping: true }))
    if (input.force) {
      const forced = (async () => {
        try {
          await this.opts.forceStop?.()
        } catch (e) {
          this.log(`Activity: force stop failed, draining anyway: ${errText(e)}`)
        }
        await this.drain()
      })()
      return forced.then(() => ({ stopping: true }))
    }
    const { counts } = this.take().snap
    const busy: Partial<Record<ActivityLeaseKind, number>> = {}
    let refused = false
    for (const k of ACTIVITY_LEASE_KINDS) {
      if (counts[k] > 0) {
        busy[k] = counts[k]
        refused = true
      }
    }
    if (refused) return Promise.resolve({ stopping: false, refusedBecause: busy })
    return this.drain().then(() => ({ stopping: true }))
  }

  onChange(listener: (s: HostActivitySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Start the idle-exit poll (background hosts; the bootstrap never arms it for 'desktop' in Wave 1). An idleMs of
   * Infinity (ORGAI_DAEMON_IDLE_MINUTES=0) arms nothing.
   */
  armIdleExit(): void {
    if (this.poll || this.draining) return
    const idleMs = this.opts.idleMs ?? daemonIdleMs(process.env)
    if (!Number.isFinite(idleMs)) return
    const pollMs = this.opts.pollMs ?? DEFAULT_ACTIVITY_POLL_MS
    // Through globalThis at call time, so vi.useFakeTimers() replaces it.
    this.poll = globalThis.setInterval(() => this.pollOnce(idleMs), pollMs)
  }

  disarmIdleExit(): void {
    if (this.poll !== undefined) globalThis.clearInterval(this.poll)
    this.poll = undefined
  }

  private pollOnce(idleMs: number): void {
    const { snap, flipped } = this.take()
    // A polled source that went busy or idle is a state change listeners should see.
    if (flipped) this.emit(snap)
    if (!snap.idle || snap.idleSince === undefined) return
    if (this.now() - snap.idleSince >= idleMs) void this.drain()
  }

  /** The shared drain: concurrent and repeated calls get the same promise. Each step's throw is logged, never fatal. */
  private drain(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = (async () => {
      this.disarmIdleExit()
      this.hostState = 'draining'
      this.notify()
      try {
        this.opts.ownership?.markDraining()
      } catch (e) {
        this.log(`Activity: marking the host draining failed: ${errText(e)}`)
      }
      try {
        // HostOwnership.release takes startup.mkdir and removes daemon.json / daemon.secret only while daemon.json
        // still names this host, then closes its own socket and releases the mutex.
        this.opts.ownership?.release()
      } catch (e) {
        this.log(`Activity: releasing host ownership failed: ${errText(e)}`)
      }
      try {
        this.opts.onDrained?.()
      } catch (e) {
        this.log(`Activity: onDrained failed: ${errText(e)}`)
      }
    })()
    return this.draining
  }

  /** Read every count (sources re-read) and update idleSince; `flipped` when idle changed. */
  private take(): { snap: HostActivitySnapshot; flipped: boolean } {
    const counts = { ...this.leases }
    for (const s of this.sources) counts[s.kind] += this.read(s)
    let total = 0
    for (const k of ACTIVITY_LEASE_KINDS) total += counts[k]
    const idle = total === 0
    let flipped = false
    if (idle && this.idleSince === undefined) {
      this.idleSince = this.now()
      flipped = true
    } else if (!idle && this.idleSince !== undefined) {
      this.idleSince = undefined
      flipped = true
    }
    const snap: HostActivitySnapshot = { counts, total, idle, state: this.hostState }
    if (idle && this.idleSince !== undefined) snap.idleSince = this.idleSince
    return { snap, flipped }
  }

  /** A source's count; one that throws or answers something that is not a count counts as 1 (busy), logged once. */
  private read(s: Source): number {
    try {
      const n = s.count()
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
      throw new Error(`not a count: ${String(n)}`)
    } catch (e) {
      if (!s.warned) {
        s.warned = true
        this.log(`Activity: a ${s.kind} source failed, counting it as busy: ${errText(e)}`)
      }
      return 1
    }
  }

  /** A lease, source or state changed: re-read and tell the listeners. */
  private notify(): void {
    this.emit(this.take().snap)
  }

  private emit(snap: HostActivitySnapshot): void {
    for (const l of [...this.listeners]) {
      try {
        l(snap)
      } catch (e) {
        this.log(`Activity: a change listener failed: ${errText(e)}`)
      }
    }
  }

  private log(m: string): void {
    this.opts.log?.(m)
  }
}

/** A tracker that tracks nothing: always idle and ready, drain refused. For hosts and tests without activity tracking. */
export function noopActivity(): HostActivityTrackerApi {
  return {
    acquire: () => () => {},
    track: (_kind, p) => p,
    addSource: () => () => {},
    snapshot: () => idleSnapshot('ready'),
    isIdle: () => true,
    state: () => 'ready',
    requestDrain: () => Promise.resolve({ stopping: false }),
    onChange: () => () => {}
  }
}

/**
 * ORGAI_DAEMON_IDLE_MINUTES in ms: a positive finite number of minutes. '0' means never (Infinity: armIdleExit arms
 * nothing). Missing or invalid gives DEFAULT_DAEMON_IDLE_MINUTES.
 */
export function daemonIdleMs(env: NodeJS.ProcessEnv): number {
  const fallback = DEFAULT_DAEMON_IDLE_MINUTES * 60_000
  const raw = env.ORGAI_DAEMON_IDLE_MINUTES?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (n === 0) return Infinity
  if (!Number.isFinite(n) || n < 0) return fallback
  return n * 60_000
}
