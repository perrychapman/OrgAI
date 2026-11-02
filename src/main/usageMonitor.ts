import type { ProviderAuth, RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'

const BOOT_DELAY_MS = 1500
const IDLE_INTERVAL_MS = 10 * 60_000

/** An extra usage probe. The keyed form can also be run on its own (refreshProbe). */
export type ExtraProbe = (() => Promise<UsageStatus | null>) | { key: string; probe: () => Promise<UsageStatus | null> }

/**
 * Keeps the plan usage meter fresh when no run is open. Live runs report usage themselves every
 * minute, so the monitor only probes while the app is idle: once shortly after boot, then every
 * ten minutes, plus whenever the renderer asks.
 */
export class UsageMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<UsageStatus | null> | null = null
  private last: UsageStatus | null = null
  private extraLast: (UsageStatus | null)[] = []
  /** At most one call in flight per extra probe, shared by refresh() and refreshProbe(). */
  private extraInFlight = new Map<number, Promise<void>>()

  constructor(
    private opts: {
      adapter: RuntimeAdapter
      auth: () => ProviderAuth
      broadcast: (e: RunEvent) => void
      liveRuns: () => number
      /**
       * Additional probes (the Codex rate limits, the LiteLLM key spend). Each runs on every refresh and is broadcast
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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The latest Claude report (unchanged behaviour). */
  latest(): UsageStatus | null {
    return this.last
  }

  /** The latest report of every probe, Claude first. */
  latestAll(): UsageStatus[] {
    return [this.last, ...this.extraLast].filter((u): u is UsageStatus => !!u)
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
        if (usage) {
          this.last = usage
          this.opts.broadcast({ type: 'usage.status', runId: '', usage })
        }
        return usage
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  /** Run one keyed extra probe now (e.g. 'litellm' after a LiteLLM run ended). Shares a call already in flight. */
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
      .then((usage) => {
        if (usage) {
          this.extraLast[i] = usage
          this.opts.broadcast({ type: 'usage.status', runId: '', usage })
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
