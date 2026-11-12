/**
 * HostActivityTracker (cli-spec 3.2(4), Wave 1): leases and polled sources that keep a host from going idle, the idle
 * exit timer and the drain. Electron-free; relative imports only.
 *
 * Wave 7 (cli-standalone.md 4.3): the drain never releases ownership. It marks the host draining, quiesces background
 * work, stops runs (when forced, and whenever a live run is left: a run only waiting on the user does not keep the host
 * busy, so a non-forced drain may start with it), then waits until no writer is in flight (SETTLE_KINDS) with no deadline of its own, and
 * calls onDrained from setImmediate. The shutdown coordinator (shutdown.ts) closes the socket, releases ownership and
 * ends the process, or takes over at its hard limit (abandonSettle).
 *
 * Sources (RunManager, services) are injected by the bootstrap; this module imports no service.
 */
import { ACTIVITY_LEASE_KINDS, DEFAULT_DAEMON_IDLE_MINUTES } from '../../shared/types'
import type { ActivityLeaseKind, HostActivitySnapshot, HostState, HostStopInput, HostStopResult } from '../../shared/types'
import type { HostActivityTrackerApi } from './types'

export interface HostActivityOptions {
  /**
   * The host's ownership (ownership.ts): markDraining flips daemon.json to 'draining'. The tracker never releases it
   * (Wave 7): the shutdown coordinator does, once the writers settled.
   */
  ownership?: { markDraining(): boolean }
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
  /**
   * Stop every run (bootstrap: RunManager.stopAll({ reason: 'quit' })): a forced drain always runs it, and so does every
   * other drain while `liveRuns` counts any, so a run that was only waiting on the user (idle, a card open, held: not
   * busy, so a non-forced drain or the idle exit starts with it) is ended and written as cut by the app before the
   * writers settle and the data folder is given up.
   */
  forceStop?: () => Promise<void>
  /**
   * Runs the drain must end (bootstrap: RunManager.liveRunCount, waiting runs included). Read once the drain started
   * (after quiesce); any count above 0 makes a non-forced drain run forceStop too. Absent = 0.
   */
  liveRuns?: () => number
  /**
   * A forced drain gives forceStop at most this long. Default DEFAULT_FORCE_STOP_MS (as the desktop quit's
   * QUIT_STOP_DEADLINE_MS).
   */
  forceStopMs?: number
  /**
   * Called when forceStop passes forceStopMs or throws (bootstrap: RunManager.markQuit, which synchronously refuses new
   * work and writes every live run as cut by the app).
   */
  forceStopFallback?: () => void
  /**
   * Called (from setImmediate, never inside requestDrain) once the drain finished: no writer is in flight. The shutdown
   * coordinator then closes the socket and releases ownership. Never called after abandonSettle.
   */
  onDrained?: () => void
  /** Called synchronously when a drain starts (whoever asked: requestDrain or the idle exit), before quiesce. */
  onDrainStart?: (force: boolean) => void
  /** Called once when the drain starts waiting for in-flight writers (none are in flight: never called). */
  onSettling?: () => void
  /**
   * How long the drain waits for in-flight writers (SETTLE_KINDS) before it logs that it is still waiting (once). It
   * keeps waiting: ownership stays until they finish or the coordinator's hard limit. Default DEFAULT_SETTLE_LOG_MS.
   */
  settleLogMs?: number
  /** How often the drain re-reads the writer counts while it waits. Default DEFAULT_SETTLE_POLL_MS. */
  settlePollMs?: number
  /**
   * Work the drain awaits after quiesce but that never causes a stop refusal and is not in any snapshot (bootstrap:
   * `claude auth status` children, which hold the data folder as their cwd and are aborted at quiesce). Counted like a
   * writer in the settle phase only, so ownership is not released before it is 0.
   */
  settleOnly?: () => number
  log?: (m: string) => void
}

/** Default interval of the idle-exit poll. */
export const DEFAULT_ACTIVITY_POLL_MS = 15_000

/** A forced drain gives forceStop at most this long, then calls forceStopFallback and goes on. */
export const DEFAULT_FORCE_STOP_MS = 3_000

/** After this long with writers still in flight, the drain logs that it is still waiting (it keeps waiting). */
export const DEFAULT_SETTLE_LOG_MS = 10_000
export const DEFAULT_SETTLE_POLL_MS = 50

/**
 * What every drain waits on (after forceStop, which runs when forced or while any run is live) before the coordinator
 * gives up the data folder: work that writes the stores and finishes by itself. Not liveRuns / pausedAutoResumes
 * (forceStop stopped and wrote them; a non-forced drain started with none busy), not activeOAuthFlows (a sign-in can wait on the user forever; quiesce
 * aborts them, and mcp:authorize leases only its final commit), not interactiveClients (open windows).
 */
export const SETTLE_KINDS: readonly ActivityLeaseKind[] = ['inFlightRpcMutations', 'activeWorktreeOps', 'backgroundTasks']

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
 * shared promise: state 'draining', onDrainStart, ownership.markDraining, quiesce, (forced, or any live run left:
 * forceStop bounded by forceStopMs with forceStopFallback past it), a wait with no deadline until no SETTLE_KINDS work is in flight, then
 * onDrained once from setImmediate. A forced request while a non-forced drain waits upgrades it (forceStop runs once).
 * Ownership is never released here (the shutdown coordinator does). Leases still work after the drain; the state stays.
 */
export class HostActivityTracker implements HostActivityTrackerApi {
  private readonly leases = zeroCounts()
  private readonly sources = new Set<Source>()
  private readonly listeners = new Set<(s: HostActivitySnapshot) => void>()
  private hostState: HostState = 'ready'
  private idleSince: number | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined
  /** A forced request reached a drain (at its start or later): forceStop runs once, before the writers settle. */
  private forceRequested = false
  private forceStopped = false
  /** The coordinator's hard limit took over: the writer wait ends and onDrained is never called. */
  private abandoned = false
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
   * forceStopFallback). Either way the drain then waits until no writer is in flight and resolves; onDrained follows
   * from setImmediate. A call made while a drain is under way joins it; a forced one upgrades a non-forced drain.
   * `handoff` is the shutdown coordinator's (shutdown.ts); this tracker ignores it.
   */
  requestDrain(input: HostStopInput = {}): Promise<HostStopResult> {
    if (this.draining) {
      if (input.force) this.forceRequested = true
      return this.draining.then(() => ({ stopping: true }))
    }
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
    if (force) this.forceRequested = true
    let done!: () => void
    this.draining = new Promise<void>((r) => (done = r))
    try {
      this.opts.onDrainStart?.(force)
    } catch (e) {
      this.log(`Activity: onDrainStart failed: ${errText(e)}`)
    }
    // runDrain never rejects; this.draining is set before its synchronous part runs.
    void this.runDrain().finally(done)
    return this.draining
  }

  /**
   * The coordinator's hard limit took over: stop waiting for writers. The drain promise resolves and onDrained is never
   * called (the coordinator releases and exits itself). Idempotent; nothing happens without a drain.
   */
  abandonSettle(): void {
    if (this.draining) this.abandoned = true
  }

  private async runDrain(): Promise<void> {
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
    // A non-forced drain starts only with no busy run, but runs that only wait on the user (idle, a card open, held) are
    // still live: they end here too, written as cut by the app (as the desktop quit always did), before the writers
    // settle, so no session of this host is left running or writing once the data folder is given up.
    if (this.forceRequested || this.liveRunsLeft() > 0) await this.forceStopOnce()
    // Forced or not: nothing that writes the stores may still be running once the coordinator releases ownership.
    await this.settleWriters()
    if (this.abandoned) return
    // From setImmediate, never inside requestDrain: a host.stop reply (a microtask chain on the socket) is queued first.
    globalThis.setImmediate(() => {
      if (this.abandoned) return
      try {
        this.opts.onDrained?.()
      } catch (e) {
        this.log(`Activity: onDrained failed: ${errText(e)}`)
      }
    })
  }

  /** opts.liveRuns, 0 when absent; a throw or a non-count counts as 1 (end them: the safe side), logged. */
  private liveRunsLeft(): number {
    if (!this.opts.liveRuns) return 0
    try {
      const n = this.opts.liveRuns()
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
      throw new Error(`not a count: ${String(n)}`)
    } catch (e) {
      this.log(`Activity: reading the live runs failed, stopping them anyway: ${errText(e)}`)
      return 1
    }
  }

  /** forceStop at most once per drain (at the start of a forced drain, when a forced request upgrades one, or when live runs remain). */
  private async forceStopOnce(): Promise<void> {
    if (this.forceStopped) return
    this.forceStopped = true
    await this.boundedForceStop()
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

  /**
   * Every drain: wait until no SETTLE_KINDS work is in flight, so nothing writes after the coordinator releases
   * ownership. No deadline here (logged once after settleLogMs); the coordinator's hard limit ends it (abandonSettle).
   * A forced request that arrives meanwhile runs forceStop first.
   */
  private async settleWriters(): Promise<void> {
    const logAfter = this.opts.settleLogMs ?? DEFAULT_SETTLE_LOG_MS
    const pollMs = this.opts.settlePollMs ?? DEFAULT_SETTLE_POLL_MS
    const start = this.now()
    let announced = false
    let logged = false
    for (;;) {
      if (this.abandoned) return
      if (this.forceRequested && !this.forceStopped) await this.forceStopOnce()
      const { counts } = this.take().snap
      const busy: string[] = SETTLE_KINDS.filter((k) => counts[k] > 0).map((k) => `${k} ${counts[k]}`)
      const extra = this.settleOnlyCount()
      if (extra > 0) busy.push(`probes ${extra}`)
      if (!busy.length) return
      if (!announced) {
        announced = true
        try {
          this.opts.onSettling?.()
        } catch (e) {
          this.log(`Activity: onSettling failed: ${errText(e)}`)
        }
      }
      if (!logged && this.now() - start >= logAfter) {
        logged = true
        this.log(`Activity: still waiting for in-flight work before giving up the data folder: ${busy.join(', ')}`)
      }
      // Through globalThis at call time, so vi.useFakeTimers() replaces it.
      await new Promise<void>((r) => globalThis.setTimeout(r, pollMs))
    }
  }

  /** opts.settleOnly, 0 when absent; a throw or a non-count counts as 1 (keep waiting; the hard limit ends it). */
  private settleOnlyCount(): number {
    if (!this.opts.settleOnly) return 0
    try {
      const n = this.opts.settleOnly()
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
      return 1
    } catch {
      return 1
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
