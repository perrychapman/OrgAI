import type { ReactElement } from 'react'
import { useEffect, useMemo } from 'react'
import type { ConnectionId, UsageStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel, isProxyId } from '../../lib/connectionLabel'
import { clockLabel, resetsAtText, resetsInLabel } from '../../lib/dashboard'
import { connectionsInUse, reportsSpend, spendLevel, spendRowLabel, spendSentence } from '../../lib/usage'
import { SpendBar, UsageBar, tightestWindowRow, usageRows } from '../UsageMeter'
import { usageIsStale, windowLabel } from './dashboardProjects'
import { useNow } from './useDashboardData'

/**
 * The plan limits in use (docs/design/dashboard-overhaul.md 7.7, moved from the old status bar into Your week): one entry per
 * connection in use that reports something, none under the mock adapter or for API keys, at most 2 and "+N more".
 */

/** Limit entries shown before "+N more". */
const LIMITS_MAX = 2

/** One usage refresh at a time across mounts. */
let refreshing = false

export interface LimitEntry {
  id: ConnectionId
  kind: 'window' | 'spend'
  level: '' | 'warn' | 'danger'
  /** Parts of the visible text. */
  name: string
  main: string
  resets: string
  /** Bar fill, 0..100; null = no bar. */
  pct: number | null
  title: string
  /** The spend bar element, for a proxy with a budget. */
  spend?: UsageStatus['spend']
  /** The plan report behind a window entry: `UsageBar` draws its tightest window as the meter. */
  usage?: UsageStatus
}

/** The full window list of a connection: "5-hour window 62%, resets 14:10. 7-day window 41%, resets Thu 09:00." */
function windowsTitle(usage: UsageStatus, now: number): string {
  return usageRows(usage)
    .filter((r) => r.window.utilization !== null)
    .map((r) => {
      const at = resetsAtText(r.window.resetsAt, now)
      return `${windowLabel(r.label)} ${Math.round(r.window.utilization ?? 0)}%${at ? `, resets ${at}` : ''}.`
    })
    .join(' ')
}

export function windowEntry(id: ConnectionId, usage: UsageStatus, now: number): LimitEntry | null {
  const t = tightestWindowRow(usage)
  if (!t) return null
  const name = `${connectionLabel(id)} plan`
  const title = windowsTitle(usage, now)
  if (usage.status === 'rejected' && t.row.limited) {
    const until = clockLabel(usage.limitedUntil)
    return { id, kind: 'window', level: 'danger', name, main: until ? `limited until ${until}` : 'limited', resets: '', pct: 100, title, usage }
  }
  const resets = resetsInLabel(t.row.window.resetsAt, now)
  return { id, kind: 'window', level: t.level, name, main: `${windowLabel(t.label)} ${Math.round(t.pct)}%`, resets, pct: Math.min(100, Math.max(0, t.pct)), title, usage }
}

/** The limit entries for the connections in use; empty under the mock adapter. */
export function useLimitEntries(): LimitEntry[] {
  const appInfo = useAppStore((s) => s.appInfo)
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const usageByConnection = useAppStore((s) => s.usageByConnection)
  const now = useNow()
  const mock = !!appInfo?.mockAdapter
  const entries = useMemo<LimitEntry[]>(() => {
    if (mock) return []
    const inUse = connectionsInUse(connections, defaultConnection, projects)
    const out: LimitEntry[] = []
    for (const c of connections ?? []) {
      const id = c.connection.id
      if (!inUse.has(id)) continue
      const usage = usageByConnection[id]
      if (!usage?.available) continue
      if (isProxyId(id)) {
        if (c.status.state !== 'connected' || !reportsSpend(c) || !usage.spend) continue
        const spend = usage.spend
        out.push({ id, kind: 'spend', level: spendLevel(spend), name: '', main: spendRowLabel(spend, id), resets: '', pct: null, title: spendSentence(spend, id), spend })
      } else {
        const e = windowEntry(id, usage, now)
        if (e) out.push(e)
      }
    }
    return out
  }, [mock, connections, defaultConnection, projects, usageByConnection, now])

  // Mount only: ask for a fresh reading when the newest one is older than a minute. No timer while the page is open.
  useEffect(() => {
    if (mock) return
    const state = useAppStore.getState()
    if (refreshing || !usageIsStale(Object.values(state.usageByConnection) as UsageStatus[], Date.now())) return
    refreshing = true
    void state.refreshUsage().finally(() => {
      refreshing = false
    })
  }, [mock])
  return entries
}

/** The limits list (`dash-limits`); renders nothing without entries. */
export function WeekLimits({ entries }: { entries: readonly LimitEntry[] }): ReactElement | null {
  const shown = entries.slice(0, LIMITS_MAX)
  const more = entries.length - shown.length
  if (shown.length === 0) return null
  return (
    <ul className="dash-limits" data-testid="dash-limits">
      {shown.map((e) => (
        <li key={e.id} className="dash-limit" data-testid="dash-limit" data-connection={e.id} data-kind={e.kind} data-level={e.level} title={e.title}>
          {e.name && (
            <>
              <span className="dash-limit-name">{e.name}</span>
              <span className="dash-sep" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span className="dash-limit-main">{e.main}</span>
          {e.resets && (
            <>
              <span className="dash-sep" aria-hidden="true">
                ·
              </span>
              <span className="dash-limit-resets">{e.resets}</span>
            </>
          )}
          {e.kind === 'window' && <UsageBar usage={e.usage} />}
          {e.kind === 'spend' && <SpendBar spend={e.spend} id={e.id} />}
        </li>
      ))}
      {more > 0 && <li className="dash-limit-more">+{more} more</li>}
    </ul>
  )
}
