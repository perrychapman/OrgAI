import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { RateLimitWindow, UsageStatus } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

import { formatUntil } from '../lib/layout'

/** Renderer-side auto-refresh: at most one read per minute, never overlapping, failures included. */
const REFRESH_EVERY_MS = 60_000
let lastAttempt = 0
let inFlight = false

function refreshIfStale(): void {
  if (inFlight) return
  const state = useAppStore.getState()
  const t = Date.now()
  if (t - lastAttempt < REFRESH_EVERY_MS) return
  if (state.usage?.available && t - state.usage.updatedAt < REFRESH_EVERY_MS) return
  if (state.usage?.authMode === 'apiKey') return
  lastAttempt = t
  inFlight = true
  void state.refreshUsage().finally(() => {
    inFlight = false
  })
}

const WARN_AT = 80

export type Row = { key: string; label: string; window: RateLimitWindow; limited: boolean }

/** The plan windows to show, in a fixed order; per-model windows without a dedicated slot come last. */
export function usageRows(usage: UsageStatus): Row[] {
  const w = usage.windows
  const out: Row[] = []
  const add = (key: string, label: string, window: RateLimitWindow | undefined, provider: string): void => {
    if (window) out.push({ key, label, window, limited: usage.status === 'rejected' && usage.limitedWindow === provider })
  }
  add('fiveHour', 'Five-hour', w.fiveHour, 'five_hour')
  add('sevenDay', 'Seven-day', w.sevenDay, 'seven_day')
  add('sevenDayOpus', 'Opus weekly', w.sevenDayOpus, 'seven_day_opus')
  add('sevenDaySonnet', 'Sonnet weekly', w.sevenDaySonnet, 'seven_day_sonnet')
  for (const m of usage.modelWindows ?? []) {
    if (/opus/i.test(m.model) && w.sevenDayOpus) continue
    if (/sonnet/i.test(m.model) && w.sevenDaySonnet) continue
    add(`model-${m.model}`, `${m.model} weekly`, m, '')
  }
  return out
}

export type UsageLevel = '' | 'warn' | 'danger'

/** The window closest to its limit (the one the footer bar shows), or null when no plan window is reported. */
export function tightestWindow(usage: UsageStatus | null): { label: string; pct: number; level: UsageLevel } | null {
  if (!usage || usage.authMode === 'apiKey' || !usage.available) return null
  let best: { label: string; pct: number; level: UsageLevel } | null = null
  for (const r of usageRows(usage)) {
    const pct = r.window.utilization
    if (pct === null) continue
    const level: UsageLevel = r.limited ? 'danger' : pct >= WARN_AT || usage.status === 'allowed_warning' ? 'warn' : ''
    // A limited window always wins; otherwise the highest utilization.
    if (!best || (level === 'danger' && best.level !== 'danger') || (best.level !== 'danger' && pct > best.pct)) best = { label: r.label, pct, level }
  }
  return best
}

/** The 4 px footer bar: the brand gradient, solid warning from 80 percent, solid danger at the limit. */
export function UsageBar({ usage }: { usage: UsageStatus | null }): ReactElement | null {
  const t = tightestWindow(usage)
  if (!t) return null
  const shown = t.level === 'danger' ? 100 : Math.min(100, Math.max(0, t.pct))
  return (
    <span className={`usage-mini ${t.level}`} role="img" aria-label={`${t.label} usage ${Math.round(t.pct)} percent`} data-testid="usage-mini">
      <i style={{ width: `${shown}%` }} />
    </span>
  )
}

/** Subscription plan windows (inside the account popover): one thin bar per window with its reset time. */
export default function UsageMeter(): ReactElement {
  const usage = useAppStore((s) => s.usage)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Mounted only while the account popover is open: read now if the data is stale, then every minute.
  useEffect(() => {
    refreshIfStale()
    const t = setInterval(refreshIfStale, REFRESH_EVERY_MS)
    return () => clearInterval(t)
  }, [])

  if (usage?.authMode === 'apiKey') {
    return (
      <div className="usage-meter">
        <div className="usage-empty">API key in use: no plan limits</div>
      </div>
    )
  }
  if (!usage?.available) {
    return (
      <div className="usage-meter">
        <div className="usage-empty" title="Plan usage refreshes on its own.">
          Usage not reported yet
        </div>
      </div>
    )
  }

  const list = usageRows(usage)
  return (
    <div className="usage-meter" title={usage.subscriptionType ? `Plan: ${usage.subscriptionType}` : undefined}>
      {list.length === 0 && <div className="usage-empty">No plan windows reported</div>}
      {list.map((r) => {
        const pct = r.window.utilization
        const level = r.limited ? 'danger' : (pct ?? 0) >= WARN_AT || usage.status === 'allowed_warning' ? 'warn' : ''
        return (
          <div key={r.key} className={`usage-row ${level}`} title={r.window.resetsAt !== null ? `${r.label}: resets ${new Date(r.window.resetsAt).toLocaleString()}` : undefined}>
            <div className="usage-head">
              <span>{r.label}</span>
              <span className="usage-pct">{pct === null ? '–' : `${Math.round(pct)}%`}</span>
            </div>
            <div className="usage-bar">
              <i style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
            </div>
            {r.window.resetsAt !== null && (
              <div className="usage-reset" title={new Date(r.window.resetsAt).toLocaleString()}>
                {r.window.resetsAt > now ? `Resets in ${formatUntil(r.window.resetsAt, now)}` : 'Reset due'}
              </div>
            )}
          </div>
        )
      })}
      {usage.overageInUse && <div className="usage-hint">Extra usage in use</div>}
    </div>
  )
}
