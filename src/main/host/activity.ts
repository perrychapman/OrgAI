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
  /**
   * Every drain, synchronously, right after the state turns 'draining' and before forceStop: stop starting new
   * background work (bootstrap: CapabilityService.dispose, so a run that forceStop ends schedules no Team review).
   */
  quiesce?: () => void
  /** host.stop with force: stop every run first. */
  forceStop?: () => Promise<void>
  /**
   * A forced drain gives forceStop at most this long. Default DEFAULT_FORCE_STOP_MS (as the desktop quit's
   * QUIT_STOP_DEADLINE_MS).
   */
  forceStopMs?: number
  /**
   * Called when forceStop passes forceStopMs or throws (bootstrap: RunManager.markQuit, which synchronously refuses new
   * work and writes every live run as cut by the app), as quitGate does on the desktop quit.
   */
  forceStopFallback?: () => void
  /** Called once the drain finished (the process may exit). */
  onDrained?: () => void
  /**
   * A forced drain, after forceStop: the longest it waits for in-flight store writers (FORCE_SETTLE_KINDS) to reach 0
   * before it releases ownership anyway (logged). Default DEFAULT_FORCE_SETTLE_MS.
   */
  forceSettleMs?: number
  /** How often a forced drain re-reads the writer counts while it waits. Default DEFAULT_FORCE_SETTLE_POLL_MS. */
  forceSettlePollMs?: number
  log?: (m: string) => void
}

/** Default interval of the idle-exit poll. */
export const DEFAULT_ACTIVITY_POLL_MS = 15_000

/** A forced drain gives forceStop at most this long, then calls forceStopFallback and goes on. */
export const DEFAULT_FORCE_STOP_MS = 3_000

/** A forced drain waits at most this long for in-flight writers before it releases ownership anyway. */
export const DEFAULT_FORCE_SETTLE_MS = 10_000
export const DEFAULT_FORCE_SETTLE_POLL_MS = 50

/**
 * What a forced drain waits on after forceStop, before it gives up the data folder: work that writes the stores and
 * finishes by itself. Not liveRuns / pausedAutoResumes (forceStop stopped and wrote them), not activeOAuthFlows (a
 * sign-in can wait on the user forever), not interactiveClients (open windows).
 */
export const FORCE_SETTLE_KINDS: readonly ActivityLeaseKind[] = ['inFlightRpcMutations', 'activeWorktreeOps', 'backgroundTasks']

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
 * shared promise: state 'draining', ownership.markDraining, quiesce, (forced: forceStop bounded by forceStopMs with
 * forceStopFallback past it, then a bounded wait for in-flight writers), ownership.release (HostOwnership removes only this host's own files), then onDrained once. Leases still
 * work after the drain; the state stays.
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

  /**
   * Without force: refused (with the busy counts) unless every count is 0. With force: the host is 'draining' at once
   * (new mutations get host_draining), background work is quiesced, forceStop runs (at most forceStopMs, then
   * forceStopFallback), in-flight writers get up to forceSettleMs to finish, then
   * ownership is released. A call made while a drain (forced or not) is under way joins it.
   */
  requestDrain(input: HostStopInput = {}): Promise<HostStopResult> {
    if (this.draining) return this.draining.then(() => ({ stopping: true }))
    if (input.force) return this.drain(true).then(() => ({ stopping: true }))
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

  /**
   * The shared drain: concurrent and repeated calls get the same promise. The state turns 'draining' synchronously,
   * before any await, so a mutation that arrives while forceStop runs is refused. Each step's throw is logged, never
   * fatal.
   */
  private drain(force = false): Promise<void> {
    if (this.draining) return this.draining
    this.disarmIdleExit()
    this.hostState = 'draining'
    let done!: () => void
    this.draining = new Promise<void>((r) => (done = r))
    // runDrain never rejects; this.draining is set before its synchronous part runs.
    void this.runDrain(force).finally(done)
    return this.draining
  }

  private async runDrain(force: boolean): Promise<void> {
    this.notify()
    try {
      this.opts.ownership?.markDraining()
    } catch (e) {
      this.log(`Activity: marking the host draining failed: ${errText(e)}`)
    }
    try {
      this.opts.quiesce?.()
    } catch (e) {
      this.log(`Activity: quiescing background work failed: ${errText(e)}`)
    }
    if (force) {
      await this.boundedForceStop()
      await this.settleWriters()
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
  }

  /**
   * Forced drain: forceStop raced against forceStopMs. On the deadline or a throw, forceStopFallback runs (synchronous
   * writes of every live run) and the drain goes on; a forceStop that settles later is ignored.
   */
  private async boundedForceStop(): Promise<void> {
    if (!this.opts.forceStop) return
    const limit = this.opts.forceStopMs ?? DEFAULT_FORCE_STOP_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let started: Promise<void>
    try {
      started = Promise.resolve(this.opts.forceStop())
    } catch (e) {
      started = Promise.reject(e)
    }
    const stopped = started.then(
      () => 'done' as const,
      (e: unknown) => {
        this.log(`Activity: force stop failed, draining anyway: ${errText(e)}`)
        return 'failed' as const
      }
    )
    // Through globalThis at call time, so vi.useFakeTimers() replaces it.
    const timeout = new Promise<'timeout'>((r) => (timer = globalThis.setTimeout(() => r('timeout'), limit)))
    const outcome = await Promise.race([stopped, timeout])
    globalThis.clearTimeout(timer)
    if (outcome === 'done') return
    if (outcome === 'timeout') this.log(`Activity: force stop did not finish within ${limit} ms; writing the runs now and draining anyway`)
    try {
      this.opts.forceStopFallback?.()
    } catch (e) {
      this.log(`Activity: the force stop fallback failed: ${errText(e)}`)
    }
  }

  /** Forced drain: wait (bounded) until no FORCE_SETTLE_KINDS work is in flight, so nothing writes after the release. */
  private async settleWriters(): Promise<void> {
    const limit = this.opts.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS
    const pollMs = this.opts.forceSettlePollMs ?? DEFAULT_FORCE_SETTLE_POLL_MS
    const start = this.now()
    for (;;) {
      const { counts } = this.take().snap
      const busy = FORCE_SETTLE_KINDS.filter((k) => counts[k] > 0)
      if (!busy.length) return
      if (this.now() - start >= limit) {
        this.log(`Activity: forced drain releasing ownership with work still in flight: ${busy.map((k) => `${k} ${counts[k]}`).join(', ')}`)
        return
      }
      // Through globalThis at call time, so vi.useFakeTimers() replaces it.
      await new Promise<void>((r) => globalThis.setTimeout(r, pollMs))
    }
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
