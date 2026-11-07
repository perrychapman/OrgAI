import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionId, UsageStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { isDevBuild } from '../../lib/buildChannel'
import { connectionLabel, isProxyId } from '../../lib/connectionLabel'
import { clockLabel, pausedRuns, resetsAtText, resetsInLabel, sinceLastSeen, statusSentence } from '../../lib/dashboard'
import { bandWorkFacts } from '../../lib/dashboardBand'
import { connectionsInUse, reportsSpend, spendLevel, spendRowLabel, spendSentence } from '../../lib/usage'
import { SpendBar, tightestWindowRow, usageRows } from '../UsageMeter'
import { usageIsStale, windowLabel } from './dashboardProjects'
import { useAllSummaries, useBandSnapshot, useNow } from './useDashboardData'

/**
 * The Dashboard's status bar (docs/design/dashboard-2.md section 4): one sentence about the work, the plan limits in use
 * and the quiet app facts. No buttons. The polite live region `dashboard-live` is the page's only one: a visually
 * hidden sibling that stays empty on mount and speaks only the messages passed in `announce` (never the sentence,
 * never limits, counts or times); messages within 1.5 s are spoken as one.
 */

/** A message for the page's one live region; `seq` rises with every message so a repeated text still speaks. */
export interface DashboardAnnouncement {
  text: string
  seq: number
}

const TOGETHER_MS = 1500
/** Limit entries shown before "+N more". */
const LIMITS_MAX = 2

/** One usage refresh at a time across mounts. */
let refreshing = false

interface LimitEntry {
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

function windowEntry(id: ConnectionId, usage: UsageStatus, now: number): LimitEntry | null {
  const t = tightestWindowRow(usage)
  if (!t) return null
  const name = `${connectionLabel(id)} plan`
  const title = windowsTitle(usage, now)
  if (usage.status === 'rejected' && t.row.limited) {
    const until = clockLabel(usage.limitedUntil)
    return { id, kind: 'window', level: 'danger', name, main: until ? `limited until ${until}` : 'limited', resets: '', pct: 100, title }
  }
  const resets = resetsInLabel(t.row.window.resetsAt, now)
  return { id, kind: 'window', level: t.level, name, main: `${windowLabel(t.label)} ${Math.round(t.pct)}%`, resets, pct: Math.min(100, Math.max(0, t.pct)), title }
}

export function HeroBand({
  firstLaunch,
  announce,
  lastSeen,
  clearedAt
}: {
  firstLaunch: boolean
  announce: DashboardAnnouncement | null
  lastSeen: number
  clearedAt: number
}): ReactElement {
  const appInfo = useAppStore((s) => s.appInfo)
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const usageByConnection = useAppStore((s) => s.usageByConnection)
  const snap = useBandSnapshot()
  const live = snap.runs
  const summaries = useAllSummaries()
  const now = useNow()

  // One source with the band (walk-3 M1): a run waiting on a decision is never "working", nor are its agents.
  const counts = useMemo(() => {
    const facts = bandWorkFacts(snap.runs, snap.projects, snap.virtualProjects)
    return { workingAgents: facts.workingAgents, agentRuns: facts.counts.working, workingRuns: facts.counts.working }
  }, [snap])

  const paused = useMemo(() => pausedRuns(summaries), [summaries])
  const pausedUntil = useMemo(() => {
    const times = paused.filter((r) => r.autoResume && typeof r.pausedUntil === 'number').map((r) => r.pausedUntil as number)
    return times.length > 0 ? Math.min(...times) : null
  }, [paused])
  const closedWaiting = useMemo(
    () => sinceLastSeen(summaries, lastSeen, now, { cap: Number.MAX_SAFE_INTEGER, clearedAt }).items.filter((it) => it.kind === 'closed-waiting').length,
    [summaries, lastSeen, clearedAt, now]
  )

  const sentence = statusSentence({ firstLaunch, ...counts, openRuns: live.length, pausedRuns: paused.length, pausedUntil, closedWaiting })

  // Limits: one entry per connection in use that reports something, none under the mock adapter or for API keys.
  const entries = useMemo<LimitEntry[]>(() => {
    if (firstLaunch || appInfo?.mockAdapter) return []
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
  }, [firstLaunch, appInfo?.mockAdapter, connections, defaultConnection, projects, usageByConnection, now])
  const shown = entries.slice(0, LIMITS_MAX)
  const more = entries.length - shown.length

  // Mount only: ask for a fresh reading when the newest one is older than a minute. No timer while the page is open.
  useEffect(() => {
    const state = useAppStore.getState()
    if (refreshing || !usageIsStale(Object.values(state.usageByConnection) as UsageStatus[], Date.now())) return
    refreshing = true
    void state.refreshUsage().finally(() => {
      refreshing = false
    })
  }, [])

  // The one live region speaks only what `announce` carries; messages within one beat join into one sentence.
  const [spoken, setSpoken] = useState('')
  const lastAnnounce = useRef(announce)
  const spokenRef = useRef('')
  const announceAt = useRef(0)
  useEffect(() => {
    if (lastAnnounce.current?.seq === announce?.seq) return
    lastAnnounce.current = announce
    if (!announce) return
    const t = Date.now()
    const text = t - announceAt.current < TOGETHER_MS && spokenRef.current ? `${spokenRef.current} ${announce.text}` : announce.text
    announceAt.current = t
    spokenRef.current = text
    setSpoken(text)
  }, [announce])

  const version = appInfo?.version
  return (
    <section className="dash-hero" data-testid="dashboard-hero" aria-label="Overview">
      <p className="dash-status-line" data-testid="dash-status-line" data-working={counts.workingAgents} data-open={live.length} data-paused={paused.length}>
        {sentence}
      </p>
      {shown.length > 0 && (
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
              {e.kind === 'window' && e.pct !== null && (
                <span className={`usage-mini ${e.level}`} aria-hidden="true">
                  <i style={{ width: `${e.pct}%` }} />
                </span>
              )}
              {e.kind === 'spend' && <SpendBar spend={e.spend} id={e.id} />}
            </li>
          ))}
          {more > 0 && <li className="dash-limit-more">+{more} more</li>}
        </ul>
      )}
      <div className="dash-hero-facts" data-testid="dashboard-app-facts">
        {version && <span className="dash-num">OrgAI {version}</span>}
        {isDevBuild(version) && <Badge tone="info">Dev</Badge>}
        {appInfo?.mockAdapter && <Badge tone="warning">Mock adapter</Badge>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="dashboard-live">
        {spoken}
      </div>
    </section>
  )
}
