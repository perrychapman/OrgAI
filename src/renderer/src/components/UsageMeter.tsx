import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { RateLimitWindow, UsageStatus } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/Button'

function RefreshButton(): ReactElement {
  const refreshUsage = useAppStore((s) => s.refreshUsage)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={RefreshCw}
      loading={busy}
      title="Read plan usage now"
      onClick={() => {
        setBusy(true)
        void refreshUsage().finally(() => setBusy(false))
      }}
    >
      Refresh
    </Button>
  )
}
import { formatUntil } from '../lib/layout'

const WARN_AT = 80

type Row = { key: string; label: string; window: RateLimitWindow; limited: boolean }

/** The plan windows to show, in a fixed order; per-model windows without a dedicated slot come last. */
function rows(usage: UsageStatus): Row[] {
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

/** Subscription plan windows under the auth pill: one thin bar per window with its reset time. */
export default function UsageMeter(): ReactElement {
  const usage = useAppStore((s) => s.usage)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
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
        <div className="usage-empty" title="Plan usage is read at startup, every 10 minutes while idle, and every minute during a run.">
          Usage not reported yet
        </div>
        <div className="usage-foot">
          <span className="usage-hint">Read at startup and every 10 minutes.</span>
          <RefreshButton />
        </div>
      </div>
    )
  }

  const list = rows(usage)
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
      <div className="usage-foot">
        <span className="usage-hint" title={new Date(usage.updatedAt).toLocaleString()}>
          Updated {new Date(usage.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
        <RefreshButton />
      </div>
    </div>
  )
}
