import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { ConnectionId, RateLimitWindow, UsageSpend, UsageStatus } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

import { formatUntil } from '../lib/layout'
import { CONNECTION_LABEL, connectionOrder, connectionsInUse, spendAria, spendLevel, spendPct, spendText } from '../lib/usage'

/** Renderer-side auto-refresh: at most one read per minute, never overlapping, failures included. */
const REFRESH_EVERY_MS = 60_000
let lastAttempt = 0
let inFlight = false

function refreshIfStale(current: ConnectionId): Promise<void> | null {
  if (inFlight) return null
  const state = useAppStore.getState()
  const t = Date.now()
  if (t - lastAttempt < REFRESH_EVERY_MS) return null
  // Only the current connection and connections in use count: a stale report nobody shows never forces a read.
  const inUse = connectionsInUse(state.connections, state.defaultConnection, state.projects)
  const reports = (Object.entries(state.usageByConnection) as [ConnectionId, UsageStatus][]).filter(([id]) => id === current || inUse.has(id)).map(([, u]) => u)
  if (reports.length > 0 && reports.every((u) => u.available && t - u.updatedAt < REFRESH_EVERY_MS)) return null
  lastAttempt = t
  inFlight = true
  const p = state.refreshUsage().finally(() => {
    inFlight = false
  })
  return p
}

/** A successful reading older than this gets an "out of date" cue. */
const OUT_OF_DATE_MS = 15 * 60_000

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
export function tightestWindow(usage: UsageStatus | null | undefined): { label: string; pct: number; level: UsageLevel } | null {
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
export function UsageBar({ usage }: { usage: UsageStatus | null | undefined }): ReactElement | null {
  const t = tightestWindow(usage)
  if (!t) return null
  const shown = t.level === 'danger' ? 100 : Math.min(100, Math.max(0, t.pct))
  return (
    <span className={`usage-mini ${t.level}`} role="img" aria-label={`${t.label} usage ${Math.round(t.pct)} percent`} data-testid="usage-mini">
      <i style={{ width: `${shown}%` }} />
    </span>
  )
}

/** The 4 px footer bar for a LiteLLM key's spend against its budget; nothing without a budget. */
export function SpendBar({ spend }: { spend: UsageSpend | undefined }): ReactElement | null {
  const pct = spend ? spendPct(spend) : null
  if (!spend || pct === null) return null
  const level = spendLevel(spend)
  return (
    <span className={`usage-mini ${level}`} role="img" aria-label={spendAria(spend)} data-testid="usage-mini">
      <i style={{ width: `${level === 'danger' ? 100 : Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  )
}

function Stale({ usage, now }: { usage: UsageStatus; now: number }): ReactElement | null {
  if (now - usage.updatedAt <= OUT_OF_DATE_MS) return null
  return (
    <div className="usage-hint usage-stale" title={`Last updated ${new Date(usage.updatedAt).toLocaleTimeString()}`}>
      Out of date · updated {formatUntil(now, usage.updatedAt)} ago
    </div>
  )
}

/** LiteLLM: the key's spend against its budget. Says "spend", never "usage" or "limit". */
function SpendSection({ usage, now, reading }: { usage: UsageStatus | undefined; now: number; reading: boolean }): ReactElement {
  const spend = usage?.spend
  if (!usage?.available || !spend) {
    return (
      <div className="usage-empty" role="status" title="Spend is read from the proxy's key info.">
        {reading || inFlight ? 'Reading spend…' : 'Spend unavailable'}
      </div>
    )
  }
  const pct = spendPct(spend)
  const level = spendLevel(spend)
  return (
    <div className={`usage-row ${level}`} data-testid="spend-row">
      <div className="usage-head">
        <span>Spend</span>
        <span className="usage-pct">{level === 'danger' ? 'Budget used up' : spendText(spend)}</span>
      </div>
      {pct !== null && (
        <div className="usage-bar" role="img" aria-label={spendAria(spend)}>
          <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      )}
      {level === 'danger' && <div className="usage-hint">{spendText(spend)}</div>}
      {pct === null && <div className="usage-hint">No budget set on this key</div>}
      {spend.resetsAt !== null && (
        <div className="usage-reset" title={new Date(spend.resetsAt).toLocaleString()}>
          {spend.resetsAt > now ? `Resets in ${formatUntil(spend.resetsAt, now)}` : 'Reset due'}
        </div>
      )}
      <Stale usage={usage} now={now} />
    </div>
  )
}

/** Plan windows of Claude or Codex: one thin bar per window with its reset time. */
function PlanSection({ usage, now, reading }: { usage: UsageStatus | undefined; now: number; reading: boolean }): ReactElement {
  if (usage?.authMode === 'apiKey') return <div className="usage-empty">API key in use: no plan limits</div>
  if (!usage?.available) {
    return (
      <div className="usage-empty" title="Plan usage refreshes on its own." role="status">
        {reading || inFlight ? 'Reading usage…' : 'Usage not reported yet'}
      </div>
    )
  }
  const list = usageRows(usage)
  return (
    <div className="usage-plan" title={usage.subscriptionType ? `Plan: ${usage.subscriptionType}` : undefined}>
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
      <Stale usage={usage} now={now} />
      {usage.overageInUse && <div className="usage-hint">Extra usage in use</div>}
    </div>
  )
}

/**
 * Inside the account popover: the current connection first, then one quiet section per other connection
 * that is in use (`connectionInUse`) and has a report. A LiteLLM connection in use but without a report
 * still gets its section and says "Spend unavailable".
 */
export default function UsageMeter({ current }: { current: ConnectionId }): ReactElement {
  const byConnection = useAppStore((s) => s.usageByConnection)
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const inUse = useMemo(() => connectionsInUse(connections, defaultConnection, projects), [connections, defaultConnection, projects])
  const [now, setNow] = useState(() => Date.now())
  const [reading, setReading] = useState(inFlight)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Mounted only while the account popover is open: read now if the data is stale, then every minute.
  useEffect(() => {
    let alive = true
    const run = (): void => {
      const p = refreshIfStale(current)
      if (!p) return
      setReading(true)
      void p.finally(() => {
        if (alive) setReading(false)
      })
    }
    run()
    const t = setInterval(run, REFRESH_EVERY_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [current])

  const order = connectionOrder(current, byConnection, (id) => inUse.has(id))
  if (inUse.has('litellm') && !order.includes('litellm')) order.push('litellm')
  const headed = order.length > 1
  return (
    <div className="usage-meter">
      {order.map((id) => (
        <section key={id} className="usage-section" aria-label={`${CONNECTION_LABEL[id]} ${id === 'litellm' ? 'spend' : 'plan usage'}`} data-testid={`usage-${id}`}>
          {headed && <h3 className="usage-section-title">{CONNECTION_LABEL[id]}</h3>}
          {id === 'litellm' ? <SpendSection usage={byConnection.litellm} now={now} reading={reading} /> : <PlanSection usage={byConnection[id]} now={now} reading={reading} />}
        </section>
      ))}
    </div>
  )
}
