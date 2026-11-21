import { useEffect, useMemo } from 'react'
import type { ConnectionId, UsageStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel, isProxyId } from '../../lib/connectionLabel'
import { clockLabel, resetsAtText, resetsInLabel } from '../../lib/dashboard'
import { connectionsInUse, reportsSpend, spendLevel, spendPct, spendRowFigure, spendSentence } from '../../lib/usage'
import { tightestWindowRow, usageRows } from '../UsageMeter'
import { usageIsStale, windowLabel } from '../dashboard/dashboardProjects'
import { useNow } from '../dashboard/useDashboardData'

/**
 * The plan limits in use, shared by the Dashboard Briefing and the Usage Pacing header (PlanGauge README): one entry per
 * connection in use that reports something (its tightest window, or a proxy's budget), none under the mock adapter or
 * for API keys. Callers show at most `LIMITS_MAX` and "+N more".
 */

/** Gauges shown before "+N more". */
export const LIMITS_MAX = 2

/** One usage refresh at a time across mounts. */
let refreshing = false

export interface LimitEntry {
  id: ConnectionId
  kind: 'window' | 'spend'
  level: '' | 'warn' | 'danger'
  /** Parts of the visible text: "Claude plan", "5-hour window 62%", "resets in 2 h". */
  name: string
  main: string
  resets: string
  /** Arc fill, 0..100; null = no arc (a proxy without a budget). */
  pct: number | null
  /** The full sentence (every window, or the budget sentence): the gauge's text alternative. */
  title: string
  spend?: UsageStatus['spend']
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

export function spendEntry(id: ConnectionId, spend: NonNullable<UsageStatus['spend']>): LimitEntry {
  const pct = spendPct(spend)
  return {
    id,
    kind: 'spend',
    level: spendLevel(spend),
    name: `${connectionLabel(id)} budget`,
    main: spendRowFigure(spend),
    resets: '',
    pct: pct === null ? null : Math.min(100, Math.max(0, pct)),
    title: spendSentence(spend, id),
    spend
  }
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
        out.push(spendEntry(id, usage.spend))
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
