import type { ProviderAuth, RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'
import { mergeUsage, reconcileUsage } from './runtime/usage'

const BOOT_DELAY_MS = 1500
const IDLE_INTERVAL_MS = 10 * 60_000
/** While a run is live the proxies' key spend is re-read this often (key-info HTTP read, no model call). */
export const LIVE_PROXY_INTERVAL_MS = 60_000
/** An unchanged Claude status is still broadcast this often so the renderer's updatedAt cue stays correct. */
const UNCHANGED_REBROADCAST_MS = 60_000

function sameFigures(a: UsageStatus, b: UsageStatus): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }, replacer) === JSON.stringify({ ...b, updatedAt: 0 }, replacer)
}

/** Sort object keys so two structurally equal statuses serialise alike. */
function replacer(_k: string, v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
}

/**
 * What an extra probe answers: one status, null (nothing to report, the previous report stays), or a list (the
 * proxies' spend: one status per connection; the list replaces the probe's earlier one, so the report of a removed
 * proxy is dropped at the next probe).
 */
export type ExtraProbeResult = UsageStatus | UsageStatus[] | null

/** An extra usage probe. The keyed form can also be run on its own (refreshProbe). */
export type ExtraProbe = (() => Promise<ExtraProbeResult>) | { key: string; probe: () => Promise<ExtraProbeResult> }

/**
 * Keeps the plan usage meter fresh when no run is open. Live runs report usage themselves every
 * minute, so the monitor only probes while the app is idle: once shortly after boot, then every
 * ten minutes, plus whenever the renderer asks.
 *
 * The idle probe is folded onto the newest Claude status known (observe() records every usage.status broadcast,
 * live runs' included) through mergeUsage, so a window only a run's rate_limit_event reported (five_hour since
 * 2026-11-04) survives between runs until its reset passes instead of being wiped by the next probe.
 */
export class UsageMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<UsageStatus | null> | null = null
  private liveTimer: ReturnType<typeof setInterval> | null = null
  private last: UsageStatus | null = null
  private lastSent: UsageStatus | null = null
  private lastSentAt = 0
  private extraLast: UsageStatus[][] = []
  /** At most one call in flight per extra probe, shared by refresh() and refreshProbe(). */
  private extraInFlight = new Map<number, Promise<void>>()

  constructor(
    private opts: {
      adapter: RuntimeAdapter
      auth: () => ProviderAuth
      broadcast: (e: RunEvent) => void
      liveRuns: () => number
      /**
       * Additional probes (the Codex rate limits, the proxies' key spend). Each runs on every refresh and is broadcast
       * as usage.status with its own provider/connection. They never affect latest() or the return value of refresh().
       */
      extraProbes?: ExtraProbe[]
    }
  ) {}

  start(): void {
    setTimeout(() => void this.refresh(), BOOT_DELAY_MS)
    this.timer = setInterval(() => {
      if (this.opts.liveRuns() === 0) void this.refresh()
    }, IDLE_INTERVAL_MS)
    // While a run is live nothing else reads a proxy's key spend: re-read it (only that probe) about every minute.
    this.liveTimer = setInterval(() => {
      if (this.opts.liveRuns() > 0) void this.refreshProbe('proxies')
    }, LIVE_PROXY_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.liveTimer) clearInterval(this.liveTimer)
    this.liveTimer = null
  }

  /** The newest Claude status known, from the probe or a run. */
  latest(): UsageStatus | null {
    return this.last
  }

  /**
   * Record a broadcast usage.status for the Claude connection (connection unset or 'anthropic') as the newest
   * Claude status. Other connections' reports are ignored; the monitor's own broadcasts pass through here too,
   * which is harmless.
   */
  observe(event: RunEvent): void {
    void this.gate(event)
  }

  /**
   * The choke point for every broadcast event (bootstrap's emitRun). A Claude usage.status is reconciled onto the
   * newest known status (reconcileUsage), which becomes latest(); the returned event carries the reconciled status.
   * Returns null when the same figures were already broadcast less than a minute ago (the renderer needs a fresh
   * updatedAt about once a minute for its "out of date" cue). Everything else passes through unchanged.
   */
  gate(event: RunEvent, now = Date.now()): RunEvent | null {
    if (event.type !== 'usage.status') return event
    const usage = event.usage
    if (!usage || typeof usage !== 'object') return event
    if (usage.connection !== undefined && usage.connection !== 'anthropic') return event
    const reconciled = reconcileUsage(this.last, usage)
    this.last = reconciled
    const sent = this.lastSent
    if (sent && now - this.lastSentAt < UNCHANGED_REBROADCAST_MS && sameFigures(sent, reconciled)) return null
    this.lastSent = reconciled
    this.lastSentAt = now
    return reconciled === usage ? event : { ...event, usage: reconciled }
  }

  /** The latest report of every probe, Claude first. */
  latestAll(): UsageStatus[] {
    return [this.last, ...this.extraLast.flat()].filter((u): u is UsageStatus => !!u)
  }

  /** Probe now. Concurrent callers share one probe. */
  refresh(): Promise<UsageStatus | null> {
    void this.refreshExtras()
    if (this.inFlight) return this.inFlight
    const probe = this.opts.adapter.probeUsage
    if (!probe) return Promise.resolve(null)
    this.inFlight = probe
      .call(this.opts.adapter, this.opts.auth())
      .then((usage) => {
        if (!usage) return usage
        // Fold the probe onto what runs reported, so an event-only window outlives the run until its reset.
        // reconcile keeps the higher figure inside a period; the broadcast goes through the host's gate again (idempotent).
        const merged = reconcileUsage(this.last, mergeUsage(this.last, usage))
        this.last = merged
        this.opts.broadcast({ type: 'usage.status', runId: '', usage: merged })
        return merged
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  /** Run one keyed extra probe now (e.g. 'proxies' after a proxy run ended). Shares a call already in flight. */
  refreshProbe(key: string): Promise<void> {
    const i = (this.opts.extraProbes ?? []).findIndex((p) => typeof p !== 'function' && p.key === key)
    return i < 0 ? Promise.resolve() : this.runExtra(i)
  }

  /** Run every extra probe. Failures are ignored. */
  private refreshExtras(): Promise<void> {
    const probes = this.opts.extraProbes ?? []
    return Promise.all(probes.map((_, i) => this.runExtra(i))).then(() => undefined)
  }

  private runExtra(i: number): Promise<void> {
    const running = this.extraInFlight.get(i)
    if (running) return running
    const entry = this.opts.extraProbes?.[i]
    if (!entry) return Promise.resolve()
    const probe = typeof entry === 'function' ? entry : entry.probe
    const p = Promise.resolve()
      .then(() => probe())
      .then((result) => {
        if (Array.isArray(result)) {
          this.extraLast[i] = result.filter((u) => !!u)
          for (const usage of this.extraLast[i]) this.opts.broadcast({ type: 'usage.status', runId: '', usage })
        } else if (result) {
          this.extraLast[i] = [result]
          this.opts.broadcast({ type: 'usage.status', runId: '', usage: result })
        }
      })
      .catch(() => {
        // a failing probe must not break the Claude meter
      })
      .finally(() => {
        this.extraInFlight.delete(i)
      })
    this.extraInFlight.set(i, p)
    return p
  }
}
