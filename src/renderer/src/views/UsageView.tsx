import type { ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VIRTUAL_PROJECT_LABELS, USAGE_REMOVED_PROJECT_NAME, isVirtualProjectId } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import AppNavigateBanner from '../components/AppNavigateBanner'
import { joinAnnouncement } from '../components/layout/CanvasFrame'
import { connectionLabel } from '../lib/connectionLabel'
import { scrollWithin } from '../lib/scrollWithin'
import { assignSeries, type SeriesState } from '../lib/usageCharts'
import {
  addedChips,
  clearedFilters,
  narrowFilters,
  previousPeriodWords,
  queryKey,
  usageChips,
  usageData,
  withoutChip,
  type UsageChip,
  type UsageFilters,
  type UsageNarrowing
} from '../lib/usageOverview'
import {
  ANNOUNCE_GAP_MS,
  COMPACT_FILTERS_PX,
  costCoverage,
  dataNotes,
  emptyModel,
  filterAnnouncement,
  liveNote,
  loadFailedAnnouncement,
  loadedAnnouncement,
  projectOptionGroups,
  refreshFailedText,
  scopeLine,
  summaryModel,
  updatedText
} from '../lib/usagePage'
import type { WastefulSort } from '../components/usage/panelProps'
import SpendPanel from '../components/usage/SpendPanel'
import ProjectsPanel from '../components/usage/ProjectsPanel'
import ModelsPanel from '../components/usage/ModelsPanel'
import RolesPanel from '../components/usage/RolesPanel'
import EfficiencyPanel from '../components/usage/EfficiencyPanel'
import WastefulRuns from '../components/usage/WastefulRuns'
import AllRuns from '../components/usage/AllRuns'
import UsageHeader, { UsageTopbarActions } from '../components/usage/UsageHeader'
import UsageFilterBar from '../components/usage/UsageFilterBar'
import UsageChips from '../components/usage/UsageChips'
import UsageSummary from '../components/usage/UsageSummary'
import UsageDefinitions from '../components/usage/UsageDefinitions'
import { LegacyNote, SummaryNotes, TruncatedBanner } from '../components/usage/UsageNotes'
import { EmptyAll, EmptyFiltered, LoadError, LoadingSkeleton, RefreshFailed } from '../components/usage/UsageStates'
import { useUsageCsv } from '../components/usage/useUsageCsv'
import { useUsageOverview } from '../components/usage/useUsageOverview'

/** The usageFocus request already handled; module level so a remount never replays an old request. */
let handledFocusSeq = -1

const connectionName = (id: string | null): string => (id ? connectionLabel(id) : 'Unknown connection')

interface Pending {
  /** queryKey the change waits for. */
  key: string
  lead: { kind: 'added' | 'removed' | 'cleared'; chip: string | null } | null
  /** The element that had focus when the change was made, kept if it is still connected. */
  focusEl: Element | null
  chipKey: string | null
  scrollRuns: boolean
}

/**
 * The app-wide Usage page (docs/design/usage-app.md). Owns the filters' effects (announcements, focus, narrowing), the
 * states and the live policy; the panels get their data and a narrowing callback and nothing else.
 */
export default function UsageView(): ReactElement {
  const filters = useAppStore((s) => s.usageFilters)
  const setStoreFilters = useAppStore((s) => s.setUsageFilters)
  const projects = useAppStore((s) => s.projects)
  const focusReq = useAppStore((s) => s.usageFocus)
  const state = useUsageOverview(filters)
  const csv = useUsageCsv(filters)
  const { overview, context } = state

  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [wastefulSort, setWastefulSort] = useState<WastefulSort>('no-result')
  const [wastefulFocus, setWastefulFocus] = useState(0)
  const [runsOpen, setRunsOpen] = useState(filters.projectIds.length > 0)
  const seriesRef = useRef<SeriesState | null>(null)
  const pending = useRef<Pending | null>(null)
  const pendingFocus = useRef<{ chipKey: string | null } | null>(null)
  const loadedSaid = useRef(false)
  const h1Ref = useRef<HTMLHeadingElement>(null)
  // A button that disappears when it is used (Retry, Use 30 days) hands focus to the page heading, never to body.
  const focusHeading = useCallback(() => h1Ref.current?.focus({ preventScroll: true }), [])

  // ---- one polite region, at most one announcement per 2 s ----
  const [said, setSaid] = useState<{ text: string; seq: number }>({ text: '', seq: 0 })
  const lastSaid = useRef(0)
  const queued = useRef<string | null>(null)
  const sayTimer = useRef<number | null>(null)
  const emit = useCallback((text: string) => {
    lastSaid.current = Date.now()
    setSaid((s) => ({ text, seq: s.seq + 1 }))
  }, [])
  const say = useCallback(
    (text: string) => {
      const wait = ANNOUNCE_GAP_MS - (Date.now() - lastSaid.current)
      if (wait <= 0 && queued.current === null) {
        emit(text)
        return
      }
      // Within the gap: join with what is already waiting and say it all once, when the gap is over.
      queued.current = queued.current === null ? text : joinAnnouncement({ text: queued.current, at: Date.now() }, text, Date.now())
      if (sayTimer.current === null) {
        sayTimer.current = window.setTimeout(() => {
          sayTimer.current = null
          const t = queued.current
          queued.current = null
          if (t) emit(t)
        }, Math.max(0, wait))
      }
    },
    [emit]
  )
  useEffect(
    () => () => {
      if (sayTimer.current !== null) window.clearTimeout(sayTimer.current)
    },
    []
  )

  // ---- sizes: the sticky bar's height (scroll-padding-top) and the page width (More filters under 880 px) ----
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setCompact(e.contentRect.width < COMPACT_FILTERS_PX)
    })
    ro.observe(root)
    setCompact(root.getBoundingClientRect().width < COMPACT_FILTERS_PX)
    return () => ro.disconnect()
  }, [])

  // ---- names ----
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of overview?.projects ?? []) m.set(p.projectId, p.projectName)
    for (const [id, p] of state.projectStats) m.set(id, p.projectName)
    for (const p of projects) if (!isVirtualProjectId(p.id)) m.set(p.id, p.name)
    for (const [id, label] of Object.entries(VIRTUAL_PROJECT_LABELS)) m.set(id, label)
    return m
  }, [overview, state.projectStats, projects])
  const projectName = useCallback((id: string) => names.get(id) ?? USAGE_REMOVED_PROJECT_NAME, [names])
  const chipNames = useMemo(() => ({ project: projectName, connection: (id: string) => connectionLabel(id) }), [projectName])

  // ---- data ----
  const now = useMemo(() => context?.now ?? Date.now(), [context])
  const barNow = useMemo(() => Date.now(), [filters.period, filters.bucket])
  const data = useMemo(() => (overview ? usageData(overview, filters, connectionName) : null), [overview, filters])
  const previousData = useMemo(
    () => (state.previous ? { data: usageData(state.previous.overview, { ...filters, bucketPick: null }, connectionName), truncated: !!state.previous.overview.truncated } : null),
    [state.previous, filters]
  )
  // The spend chart's trend without the day pick (M3): only a pick changes it, so the same data is reused otherwise.
  const periodTrend = useMemo(
    () => (overview && filters.bucketPick ? usageData(overview, { ...filters, bucketPick: null }, connectionName).trend : undefined),
    [overview, filters]
  )
  const series = useMemo(() => {
    if (!overview) return new Map<string, number>()
    seriesRef.current = assignSeries(seriesRef.current, overview.projects, JSON.stringify(filters.period))
    return seriesRef.current.map
  }, [overview, filters.period])
  const chips = useMemo(() => usageChips(filters, chipNames), [filters, chipNames])
  const groups = useMemo(() => projectOptionGroups(projects, state.projectStats), [projects, state.projectStats])

  // Does any run exist at all? Asked once, and only when the current answer is empty (the cheapest correct test).
  const [anyRuns, setAnyRuns] = useState<{ has: boolean; lastAt: number | null } | null>(null)
  const emptyStamp = overview && overview.matchedRuns === 0 ? overview.generatedAt : null
  useEffect(() => {
    if (overview && overview.matchedRuns > 0) {
      setAnyRuns({ has: true, lastAt: null })
      return
    }
    if (emptyStamp === null) return
    let live = true
    window.orgai.runs
      .usageOverview({ limit: 1, bucket: 'month' })
      .then((o) => {
        if (live) setAnyRuns({ has: o.matchedRuns > 0, lastAt: o.runs[0]?.startedAt ?? null })
      })
      .catch(() => {
        if (live) setAnyRuns({ has: true, lastAt: null })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyStamp, overview?.matchedRuns])
  const emptyAll = !!overview && overview.matchedRuns === 0 && anyRuns?.has === false

  // The sticky bar's height feeds the scroller's scroll-padding-top; the bar mounts again when the empty-all state ends.
  useLayoutEffect(() => {
    const bar = barRef.current
    const root = rootRef.current
    if (!bar || !root) return
    const apply = (): void => root.style.setProperty('--usage-filters-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`)
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    apply()
    return () => ro.disconnect()
  }, [emptyAll])

  // ---- filter changes ----
  const applyFilters = useCallback(
    (next: UsageFilters, opts?: { moved?: string; cleared?: boolean; scrollRuns?: boolean }) => {
      const before = chips
      const after = usageChips(next, chipNames)
      const added = addedChips(before, after)
      const removed = addedChips(after, before)
      const lead: Pending['lead'] = opts?.cleared
        ? { kind: 'cleared', chip: null }
        : added.length > 0
          ? { kind: 'added', chip: added[0]!.text }
          : removed.length > 0
            ? { kind: 'removed', chip: removed[0]!.text }
            : null
      const active = document.activeElement
      pending.current = {
        key: queryKey(next, Date.now()),
        lead,
        focusEl: active && active !== document.body ? active : null,
        chipKey: added[0]?.key ?? null,
        scrollRuns: !!opts?.scrollRuns
      }
      setStoreFilters(next)
      if (opts?.moved) say(opts.moved)
    },
    [chips, chipNames, setStoreFilters, say]
  )

  const onNarrow = useCallback(
    (n: UsageNarrowing) => {
      const next = narrowFilters(useAppStore.getState().usageFilters, n)
      const opensRuns = !!n.projectId || !!n.noPrice
      if (opensRuns) setRunsOpen(true)
      applyFilters(next, { scrollRuns: opensRuns })
    },
    [applyFilters]
  )

  const onRemoveChip = useCallback(
    (chip: UsageChip) => {
      const i = chips.findIndex((c) => c.key === chip.key)
      const next = withoutChip(filters, chip)
      const after = usageChips(next, chipNames)
      pendingFocus.current = { chipKey: after.length > 0 ? after[Math.min(i, after.length - 1)]!.key : null }
      applyFilters(next)
    },
    [chips, filters, chipNames, applyFilters]
  )

  const onClearAll = useCallback(() => {
    pendingFocus.current = { chipKey: null }
    applyFilters(clearedFilters(filters), { cleared: true })
  }, [filters, applyFilters])

  const useThirtyDays = useCallback(() => {
    applyFilters({ ...filters, period: { kind: 'days', days: 30 }, bucketPick: null })
    focusHeading()
  }, [filters, applyFilters, focusHeading])
  const retry = useCallback(() => {
    focusHeading()
    state.retry()
  }, [focusHeading, state])

  // Esc at bucket level clears the day chip (spec 7.4) with the chip-removal focus and announcement path.
  const onClearBucket = useCallback(() => {
    const chip = chips.find((c) => c.kind === 'bucket')
    if (chip) onRemoveChip(chip)
  }, [chips, onRemoveChip])

  // Focus after a removal: the next chip's remove button, else the filter bar's first control; never body.
  useLayoutEffect(() => {
    const f = pendingFocus.current
    if (!f) return
    pendingFocus.current = null
    const root = rootRef.current
    const chipBtn = f.chipKey ? root?.querySelector<HTMLElement>(`[data-testid="usage-chip-remove"][data-chip="${CSS.escape(f.chipKey)}"]`) : null
    const first = barRef.current?.querySelector<HTMLElement>('[data-testid="usage-period"] input:checked, button, select')
    ;(chipBtn ?? first)?.focus()
  }, [filters])

  // The data caught up with a change: announce it, keep or restore focus, scroll to All runs after a project drilldown.
  useEffect(() => {
    const p = pending.current
    if (!p || !data || state.settledKey !== p.key) return
    pending.current = null
    if (p.lead) say(filterAnnouncement(p.lead.kind, p.lead.chip, data.matchedRuns, data.totals.cost))
    if (p.chipKey && p.focusEl && !p.focusEl.isConnected) {
      rootRef.current?.querySelector<HTMLElement>(`[data-testid="usage-chip-remove"][data-chip="${CSS.escape(p.chipKey)}"]`)?.focus()
    }
    if (p.scrollRuns) window.requestAnimationFrame(() => scrollWithin(rootRef.current?.querySelector('[data-testid="usage-runs"]')))
  }, [data, state.settledKey, say])

  // First load and failures.
  useEffect(() => {
    if (data && !loadedSaid.current) {
      loadedSaid.current = true
      say(loadedAnnouncement(data.matchedRuns, data.totals.cost))
    }
  }, [data, say])
  useEffect(() => {
    if (state.error || state.refreshFailedFrom !== null) {
      pending.current = null
      say(loadFailedAnnouncement)
    }
  }, [state.error, state.refreshFailedFrom, say])

  // A deep link to a section (usageFocus): its heading takes focus once the data rendered; "All runs" opens first.
  useEffect(() => {
    if (!focusReq || focusReq.seq === handledFocusSeq || !data) return
    handledFocusSeq = focusReq.seq
    const section = focusReq.section
    if (!section) return
    if (section === 'usage-runs') setRunsOpen(true)
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const h = rootRef.current?.querySelector<HTMLElement>(`[data-testid="${section}"] h2`)
        if (!h) return
        h.tabIndex = -1
        scrollWithin(h)
        h.focus({ preventScroll: true })
      })
    )
  }, [focusReq, data])

  // ---- derived view state ----
  const span = context?.span
  const bucket = context?.bucket
  const scope = scopeLine(filters, data ? data.matchedRuns : null, projectName, barNow)
  const noRuns = !!data && data.matchedRuns === 0
  const summary = useMemo(
    () => (data && overview ? summaryModel(data, previousData, { truncated: !!overview.truncated, words: previousPeriodWords(filters.period), model: filters.model }) : null),
    [data, overview, previousData, filters.period, filters.model]
  )
  const notes = useMemo(
    () =>
      data && overview && span
        ? dataNotes({ data, truncated: !!overview.truncated, ...(overview.oldestIncludedAt !== undefined ? { oldestIncludedAt: overview.oldestIncludedAt } : {}), matchedRuns: overview.matchedRuns, spanDays: span.days, now })
        : null,
    [data, overview, span, now]
  )

  const panelProps = data && overview && span && bucket ? { data, overview, filters, bucket, span, series, onNarrow, announce: say } : null

  return (
    <div className="usage-view" ref={rootRef} data-testid="usage-view" aria-busy={state.busy}>
      <div className="topbar">
        <h1 ref={h1Ref} tabIndex={-1}>Usage</h1>
        <div className="spacer" />
        {!emptyAll && <UsageTopbarActions csv={csv} disabled={!data || noRuns} liveNote={data ? liveNote(data.totals.liveRuns) : null} updated={state.updatedAt ? updatedText(state.updatedAt) : null} />}
      </div>
      <AppNavigateBanner />
      <div className="usage-scroll" ref={scrollRef}>
        <div className="usage-page">
          {emptyAll ? (
            <EmptyAll onDashboard={() => useAppStore.getState().setView('projects')} />
          ) : (
            <>
              <UsageHeader scope={scope} csv={csv} />
              <UsageFilterBar
                filters={filters}
                onChange={(next, moved) => applyFilters(next, moved ? { moved } : undefined)}
                now={barNow}
                compact={compact}
                groups={groups}
                connections={overview?.connections ?? []}
                projectName={projectName}
                scope={scope}
                barRef={barRef}
              />
              <UsageChips chips={chips} onRemove={onRemoveChip} onClear={onClearAll} />
              {notes?.truncated && <TruncatedBanner note={notes.truncated} onUseThirtyDays={useThirtyDays} />}
              {state.refreshFailedFrom !== null && <RefreshFailed text={refreshFailedText(state.refreshFailedFrom)} onRetry={retry} />}
              {state.error && !overview && <LoadError message={state.error} onRetry={retry} />}
              {!overview && !state.error && <LoadingSkeleton />}
              {panelProps && summary && data && notes && (
                <>
                  <UsageSummary
                    items={summary}
                    coverage={costCoverage(data.totals)}
                    modelChip={filters.model}
                    onNoPrice={() => onNarrow({ noPrice: true })}
                  />
                  <SummaryNotes notes={notes} />
                  {noRuns ? (
                    <EmptyFiltered model={emptyModel(filters, chips, anyRuns?.lastAt ?? null, barNow)} onClear={onClearAll} onUseThirtyDays={useThirtyDays} />
                  ) : (
                    <>
                      <SpendPanel {...panelProps} periodTrend={periodTrend} onClearBucket={filters.bucketPick ? onClearBucket : undefined} />
                      <div className="usage-where">
                        <ProjectsPanel {...panelProps} />
                        <ModelsPanel {...panelProps} />
                        <RolesPanel {...panelProps} />
                      </div>
                      <EfficiencyPanel
                        {...panelProps}
                        onPickSignal={(s) => {
                          setWastefulSort(s)
                          setWastefulFocus((n) => n + 1)
                        }}
                      />
                      <WastefulRuns {...panelProps} sort={wastefulSort} onSort={setWastefulSort} focusSeq={wastefulFocus} />
                      <AllRuns {...panelProps} open={runsOpen} onToggle={setRunsOpen} />
                    </>
                  )}
                </>
              )}
              <footer className="usage-footer">
                {!overview && !state.error && (
                  <p className="usage-loading" role="status" data-testid="usage-loading">
                    Loading usage...
                  </p>
                )}
                <LegacyNote text={notes?.legacy ?? null} />
                <UsageDefinitions />
              </footer>
            </>
          )}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-testid="usage-live">
        <span key={said.seq}>{said.text}</span>
      </p>
    </div>
  )
}
