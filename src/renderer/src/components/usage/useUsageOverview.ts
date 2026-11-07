import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunStatus, UsageOverview, UsageProjectRollup } from '@shared/types'
import { USAGE_STATS_MAX_LIMIT } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { overviewQuery, periodSpan, previousQuery, queryKey, type PeriodSpan, type UsageBucket, type UsageFilters } from '../../lib/usageOverview'
import {
  FILTER_DEBOUNCE_MS,
  LIVE_POLL_MS,
  anyLiveRow,
  endedRefetchDelay,
  livePollDue,
  settledStatus,
  staleRunIds,
  type RunStatusFact
} from '../../lib/usagePage'

/** What the displayed overview was fetched for: its span and `now`, so the page never mixes new filters with an old span. */
export interface FetchContext {
  now: number
  span: PeriodSpan
  bucket: UsageBucket
}

export interface UsageOverviewState {
  overview: UsageOverview | null
  /** The span and bucket the overview answers. */
  context: FetchContext | null
  /** queryKey of the displayed overview; equals the current key once the page has caught up with the filters. */
  settledKey: string | null
  /** A first load that failed (no data to keep on screen). */
  error: string | null
  /** A refetch failed while data is shown: the time of the data still on screen. */
  refreshFailedFrom: number | null
  /** A non-silent fetch is pending (aria-busy; nothing is dimmed). */
  busy: boolean
  /** The previous equal span (same kinds and projects), fetched after the main data settled; null when unavailable. */
  previous: { overview: UsageOverview; key: string } | null
  updatedAt: number | null
  /** Per-project rollups of the period for the Projects popover, kept while a project narrowing hides the others. */
  projectStats: ReadonlyMap<string, UsageProjectRollup>
  retry: () => void
}

/**
 * Fetches runs:usageOverview for the filters (docs/design/usage-app.md 10): on mount, on a period / kinds / projects /
 * bucket change (debounced 150 ms), on Retry, silently when a run in scope ends or pauses (at most once per 5 s, trailing)
 * and every 30 s while a listed run is live and the window is focused. A silent refetch keeps the data on screen, sets no
 * busy state, and never touches focus or scroll. Never on a timer otherwise.
 */
export function useUsageOverview(filters: UsageFilters): UsageOverviewState {
  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [context, setContext] = useState<FetchContext | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshFailedFrom, setRefreshFailedFrom] = useState<number | null>(null)
  const [busy, setBusy] = useState(true)
  const [previous, setPrevious] = useState<UsageOverviewState['previous']>(null)
  const [projectStats, setProjectStats] = useState<ReadonlyMap<string, UsageProjectRollup>>(() => new Map())

  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const seq = useRef(0)
  const overviewRef = useRef<UsageOverview | null>(null)
  const sinceRef = useRef(0)
  const lastFetchAt = useRef(0)
  const statsCtx = useRef('')
  const endedTimer = useRef<number | null>(null)
  const handled = useRef(new Set<string>())
  const checkRef = useRef<() => void>(() => undefined)
  const previousFetched = useRef('')

  const run = useCallback(async (silent: boolean): Promise<void> => {
    const f = filtersRef.current
    const now = Date.now()
    const q = overviewQuery(f, now)
    const key = queryKey(f, now)
    const my = ++seq.current
    if (!silent) setBusy(true)
    try {
      const o = await window.orgai.runs.usageOverview(q)
      if (my !== seq.current) return
      lastFetchAt.current = Date.now()
      overviewRef.current = o
      const span = periodSpan(f.period, now)
      sinceRef.current = span.since
      setOverview(o)
      setContext({ now, span, bucket: o.query.bucket })
      setSettledKey(key)
      setError(null)
      setRefreshFailedFrom(null)
      const ctx = JSON.stringify([f.period, q.kinds ?? []])
      setProjectStats((prev) => {
        // A query over every project is authoritative; a narrowed one only refreshes the projects it covers.
        const replace = !q.projectIds || ctx !== statsCtx.current
        statsCtx.current = ctx
        const next = new Map(replace ? [] : prev)
        for (const p of o.projects) next.set(p.projectId, p)
        return next
      })
      checkRef.current()
    } catch (e) {
      if (my !== seq.current) return
      if (overviewRef.current) setRefreshFailedFrom(overviewRef.current.generatedAt)
      else setError(cleanIpcError(e, 'Could not load usage.'))
    } finally {
      if (my === seq.current) setBusy(false)
    }
  }, [])

  // Period, kinds, projects or bucket changed: refetch (immediately the first time, then debounced).
  const key = queryKey(filters, Date.now())
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      void run(false)
      return
    }
    setBusy(true)
    const t = window.setTimeout(() => void run(false), FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [key, run])

  // A run in scope ended or paused: one trailing silent refetch, at most once per 5 s.
  useEffect(() => {
    const check = (): void => {
      const o = overviewRef.current
      if (!o) return
      const facts: RunStatusFact[] = Object.values(useAppStore.getState().runs).map((r) => ({
        id: r.summary.id,
        status: r.summary.status,
        startedAt: r.summary.startedAt,
        ...(r.summary.endedAt !== undefined ? { endedAt: r.summary.endedAt } : {})
      }))
      // A run that went live again (a resume) forgets its ended / paused marks, so its next pause or end refetches again.
      for (const f of facts) {
        if (settledStatus(f.status)) continue
        for (const k of [...handled.current]) {
          if (k.startsWith(`${f.id}:`) && settledStatus(k.slice(f.id.length + 1) as RunStatus)) handled.current.delete(k)
        }
      }
      const ids = staleRunIds(o.runs, facts, o.generatedAt, sinceRef.current).filter((id) => {
        const status = facts.find((f) => f.id === id)?.status
        return !handled.current.has(`${id}:${status}`)
      })
      if (ids.length === 0 || endedTimer.current !== null) return
      for (const id of ids) handled.current.add(`${id}:${facts.find((f) => f.id === id)?.status}`)
      endedTimer.current = window.setTimeout(() => {
        endedTimer.current = null
        void run(true)
      }, endedRefetchDelay(lastFetchAt.current, Date.now()))
    }
    checkRef.current = check
    let last = useAppStore.getState().runs
    const unsub = useAppStore.subscribe((s) => {
      if (s.runs === last) return
      last = s.runs
      check()
    })
    return () => {
      unsub()
      if (endedTimer.current !== null) window.clearTimeout(endedTimer.current)
      endedTimer.current = null
      checkRef.current = () => undefined
    }
  }, [run])

  // While a listed run is live: every 30 s, only with the window focused and visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      const rows = overviewRef.current?.runs ?? []
      if (livePollDue({ anyLive: anyLiveRow(rows), focused: document.hasFocus(), visible: document.visibilityState === 'visible' })) void run(true)
    }, LIVE_POLL_MS)
    return () => window.clearInterval(id)
  }, [run])

  // The previous equal span, once the main data settled (never delays first paint; a failure leaves it out).
  useEffect(() => {
    if (!settledKey) return
    const f = filtersRef.current
    if (f.bucketPick) {
      // A day is not comparable with a whole earlier span: no deltas; the next unpicked state fetches again.
      previousFetched.current = ''
      setPrevious(null)
      return
    }
    // The earlier span does not change while the page stays on it, so a silent refetch of the current span (a new
    // settledKey) reuses what was fetched. The rows are kept (limit max) because the cost-per-run delta is a median.
    const query = { ...previousQuery(f, Date.now()), limit: USAGE_STATS_MAX_LIMIT }
    const pk = JSON.stringify(query)
    if (pk === previousFetched.current) {
      setPrevious((p) => (p ? { ...p, key: settledKey } : p))
      return
    }
    let live = true
    window.orgai.runs
      .usageOverview(query)
      .then((o) => {
        if (!live) return
        previousFetched.current = pk
        setPrevious({ overview: o, key: settledKey })
      })
      .catch(() => {
        if (live) setPrevious(null)
      })
    return () => {
      live = false
    }
  }, [settledKey, filters.bucketPick])

  const retry = useCallback(() => void run(false), [run])

  return {
    overview,
    context,
    settledKey,
    error,
    refreshFailedFrom,
    busy,
    previous: previous && previous.key === settledKey ? previous : null,
    updatedAt: overview?.generatedAt ?? null,
    projectStats,
    retry
  }
}
