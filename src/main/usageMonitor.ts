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

  constructor(
    private opts: {
      adapter: RuntimeAdapter
      auth: () => ProviderAuth
      broadcast: (e: RunEvent) => void
      liveRuns: () => number
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

  latest(): UsageStatus | null {
    return this.last
  }

  /** Probe now. Concurrent callers share one probe. */
  refresh(): Promise<UsageStatus | null> {
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
}
