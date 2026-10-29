import type { ProviderAuth, RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'

const BOOT_DELAY_MS = 1500
const IDLE_INTERVAL_MS = 10 * 60_000

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
  private extraInFlight: Promise<void> | null = null

  constructor(
    private opts: {
      adapter: RuntimeAdapter
      auth: () => ProviderAuth
      broadcast: (e: RunEvent) => void
      liveRuns: () => number
      /**
       * Additional probes (the Codex rate limits). Each runs on every refresh and is broadcast as usage.status
       * with its own provider/connection. They never affect latest() or the return value of refresh().
       */
      extraProbes?: (() => Promise<UsageStatus | null>)[]
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

  /** Run the extra probes; concurrent callers share one pass. Failures are ignored. */
  private refreshExtras(): Promise<void> {
    const probes = this.opts.extraProbes
    if (!probes?.length) return Promise.resolve()
    if (this.extraInFlight) return this.extraInFlight
    this.extraInFlight = Promise.all(
      probes.map(async (probe, i) => {
        try {
          const usage = await probe()
          if (usage) {
            this.extraLast[i] = usage
            this.opts.broadcast({ type: 'usage.status', runId: '', usage })
          }
        } catch {
          // a failing probe must not break the Claude meter
        }
      })
    ).then(
      () => {
        this.extraInFlight = null
      }
    )
    return this.extraInFlight
  }
}
