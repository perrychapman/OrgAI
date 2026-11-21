import type { ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VIRTUAL_PROJECT_LABELS, USAGE_REMOVED_PROJECT_NAME, isVirtualProjectId } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import AppNavigateBanner from '../components/AppNavigateBanner'
import { joinAnnouncement } from '../components/layout/CanvasFrame'
import { connectionLabel } from '../lib/connectionLabel'
import { scrollWithin } from '../lib/scrollWithin'
import { allUnpriced, assignSeries, axisLabel, fillBuckets, OTHER_KEY, type Metric, type SeriesState } from '../lib/usageCharts'
import { metricAnnouncement, resolveMetric, seriesAnnouncement, sparkSeries, sparkSignal, toggleSeries, type SparkPoint } from '../lib/usageDashboard'
import {
  addedChips,
  clearedFilters,
  narrowFilters,
  previousPeriodWords,
  periodLabel,
  previousSpan,
  effectiveBucket,
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
  updatedText,
  type SummarySignal
} from '../lib/usagePage'
import type { WastefulSort } from '../components/usage/panelProps'
import SpendPanel from '../components/usage/SpendPanel'
import BreakdownCard from '../components/usage/BreakdownCard'
import EfficiencyPanel from '../components/usage/EfficiencyPanel'
import StaffingPanel from '../components/usage/StaffingPanel'
import WastefulRuns from '../components/usage/WastefulRuns'
import AllRuns from '../components/usage/AllRuns'
import UsageHeader, { UsageTopbarActions } from '../components/usage/UsageHeader'
import UsageFilterBar, { BucketControl } from '../components/usage/UsageFilterBar'
import UsageChips from '../components/usage/UsageChips'
import UsageSummary from '../components/usage/UsageSummary'
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
  const stickyRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [wastefulSort, setWastefulSort] = useState<WastefulSort>('no-result')
  const [wastefulFocus, setWastefulFocus] = useState(0)
  const [runsOpen, setRunsOpen] = useState(filters.projectIds.length > 0)
  // Dashboard interactions (docs/design/usage-app.md "Dashboard rework"): view-owned so the KPI tiles, the chart and the
  // breakdown card stay in step. None of them is persisted; legend toggles reset when the period or projects change.
  const [chosenMetric, setChosenMetric] = useState<Metric | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [overlay, setOverlay] = useState(false)
  const [pointed, setHighlight] = useState<string | null>(null)
  // A hidden series is never "highlighted": pressing its legend chip to hide it must not dim the rest (walk M).
  const highlight = pointed !== null && hidden.has(pointed) ? null : pointed
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
  // The period is the Period control's own state and the date text says it, so it gets no chip (walk M2); `chips`
  // still carries it for the announcement of a period change and for the empty state's cause.
  const shownChips = useMemo(() => chips.filter((c) => c.kind !== 'period'), [chips])
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
    // The sticky block is the filter bar plus the chips line under it.
    const bar = stickyRef.current
    const root = rootRef.current
    if (!bar || !root) return
    const apply = (): void => root.style.setProperty('--usage-filters-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`)
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    apply()
    // The bar's bottom hairline shows once the page has scrolled (an attribute, no React state per scroll).
    const scroller = scrollRef.current
    const onScroll = (): void => {
      const on = (scroller?.scrollTop ?? 0) > 0 ? 'true' : 'false'
      if (bar.dataset.scrolled !== on) bar.dataset.scrolled = on
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      ro.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [emptyAll])

  // The sparkline bucket under the pointer (shared with the chart's crosshair) and the KPI number tween's trigger:
  // only a filter or metric change the user made bumps it, never first paint or the periodic refresh.
  const [scrub, setScrub] = useState<number | null>(null)
  const [tweenKey, setTweenKey] = useState(0)

  // ---- filter changes ----
  const applyFilters = useCallback(
    (next: UsageFilters, opts?: { moved?: string; cleared?: boolean; scrollRuns?: boolean }) => {
      setTweenKey((k) => k + 1)
      const before = chips
      const after = usageChips(next, chipNames)
      const added = addedChips(before, after)
      const removed = addedChips(after, before)
      // The period chip's key never changes, so a move between two non-default periods is announced from the period
      // itself (its chip is hidden; Reviewer recheck).
      const periodMoved = JSON.stringify(next.period) !== JSON.stringify(filters.period)
      const periodText = after.find((c) => c.kind === 'period')?.text ?? null
      const lead: Pending['lead'] = opts?.cleared
        ? { kind: 'cleared', chip: null }
        : added.length > 0
          ? { kind: 'added', chip: added[0]!.text }
          : removed.length > 0
            ? { kind: 'removed', chip: removed[0]!.text }
            : periodMoved && periodText
              ? { kind: 'added', chip: periodText }
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
    [chips, chipNames, filters, setStoreFilters, say]
  )

  const onNarrow = useCallback(
    (n: UsageNarrowing) => {
      const next = narrowFilters(useAppStore.getState().usageFilters, n)
      // Only the "N of M priced" link opens All runs (it asks for those runs); a row, segment or bar narrowing leaves the
      // page where it is, so the chart and tiles the user just narrowed stay in view (post-rebuild walk H1).
      if (n.noPrice) setRunsOpen(true)
      applyFilters(next)
    },
    [applyFilters]
  )

  const onRemoveChip = useCallback(
    (chip: UsageChip) => {
      // Indices over the chips actually shown (the period has none), so focus lands on a real remove button.
      const visible = (cs: UsageChip[]): UsageChip[] => cs.filter((c) => c.kind !== 'period')
      const i = visible(chips).findIndex((c) => c.key === chip.key)
      const next = withoutChip(filters, chip)
      const after = visible(usageChips(next, chipNames))
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
    ;(chipBtn ?? first)?.focus({ preventScroll: true })
  }, [filters])


  // The data caught up with a change: announce it, keep or restore focus, scroll to All runs after a project drilldown.
  useEffect(() => {
    const p = pending.current
    if (!p || !data || state.settledKey !== p.key) return
    pending.current = null
    if (p.lead) say(filterAnnouncement(p.lead.kind, p.lead.chip, data.matchedRuns, data.totals.cost))
    if (p.chipKey && p.focusEl && !p.focusEl.isConnected) {
      rootRef.current?.querySelector<HTMLElement>(`[data-testid="usage-chip-remove"][data-chip="${CSS.escape(p.chipKey)}"]`)?.focus({ preventScroll: true })
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

  // ---- dashboard interactions ----
  const chartTrend = periodTrend ?? data?.trend
  const unpriced = useMemo(() => (chartTrend ? allUnpriced(chartTrend) : false), [chartTrend])
  const metric = resolveMetric(chosenMetric, unpriced)
  const onMetric = useCallback(
    (m: Metric) => {
      // No tween key here: the KPI figures do not depend on the chart metric (Reviewer M1).
      setChosenMetric(m)
      say(metricAnnouncement(m))
    },
    [say]
  )
  const legendKeys = useMemo(() => {
    const ps = data?.projects ?? []
    const own = ps.filter((p) => series.has(p.projectId)).map((p) => p.projectId)
    return ps.some((p) => !series.has(p.projectId)) ? [...own, OTHER_KEY] : own
  }, [data, series])
  const onToggleSeries = useCallback(
    (key: string, name: string) => {
      const r = toggleSeries(hidden, key, legendKeys)
      setHidden(r.hidden)
      say(seriesAnnouncement(name, r.hidden.has(key), r.refused))
    },
    [hidden, legendKeys, say]
  )
  const projectsKey = filters.projectIds.join('\u0000')
  const periodKey = JSON.stringify(filters.period)
  useEffect(() => {
    setHidden(new Set())
    setHighlight(null)
  }, [periodKey, projectsKey])
  const onOverlay = useCallback(
    (on: boolean) => {
      setOverlay(on)
      say(on ? 'Previous period shown as dashed outlines.' : 'Previous period hidden.')
    },
    [say]
  )
  const prevSpan = useMemo(() => (previousData && context ? previousSpan(filters.period, context.now) : null), [previousData, context, filters.period])
  const sparkData = useMemo(() => {
    const out: Partial<Record<SummarySignal, SparkPoint[]>> = {}
    if (!chartTrend || !span || !bucket || !summary) return { spark: out, labels: [] as string[] }
    const slots = fillBuckets(chartTrend, span.since, span.until, bucket)
    for (const i of summary) {
      const s = sparkSignal(i.signal)
      if (s) out[i.signal] = sparkSeries(slots, s)
    }
    return { spark: out, labels: slots.map((s) => axisLabel(s.start, bucket)) }
  }, [chartTrend, span, bucket, summary])
  // The band shows four headline figures; cost per run and cache hit live in the Efficiency strip.
  const kpiItems = useMemo(() => (summary ?? []).filter((i) => i.signal === 'cost' || i.signal === 'tokens' || i.signal === 'runs' || i.signal === 'wall'), [summary])

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
              <div className="usage-sticky" ref={stickyRef}>
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
                {/* Always present: the date and run count, then the chips, so adding a chip shifts nothing (walk H1). */}
                <div className="usage-scope-row">
                  <p className="usage-period-label" data-testid="usage-period-label">
                    {periodLabel(filters.period, barNow)}
                    {data && <span className="usage-period-runs"> · {data.matchedRuns} {data.matchedRuns === 1 ? 'run' : 'runs'}</span>}
                  </p>
                  <UsageChips chips={shownChips} onRemove={onRemoveChip} onClear={onClearAll} />
                </div>
              </div>
              {notes?.truncated && <TruncatedBanner note={notes.truncated} onUseThirtyDays={useThirtyDays} />}
              {state.refreshFailedFrom !== null && <RefreshFailed text={refreshFailedText(state.refreshFailedFrom)} onRetry={retry} />}
              {state.error && !overview && <LoadError message={state.error} onRetry={retry} />}
              {!overview && !state.error && <LoadingSkeleton />}
              {panelProps && summary && data && notes && (
                <>
                  <UsageSummary
                    items={kpiItems}
                    coverage={costCoverage(data.totals)}
                    modelChip={filters.model}
                    onNoPrice={() => onNarrow({ noPrice: true })}
                    spark={sparkData.spark}
                    bucketLabels={sparkData.labels}
                    onScrub={setScrub}
                    tweenKey={tweenKey}
                    unpricedNote={notes.partial ?? notes.unpriced}
                    bucketWord={`per ${bucket}`}
                    metric={metric}
                    onMetric={onMetric}
                    tokens={data.totals.tokens}
                  />
                  {/* The partial-cost caveat is said once, by the coverage line under Estimated cost (walkthrough finding 5). */}
                  <SummaryNotes notes={{ partial: null, unpriced: notes.unpriced }} />
                  {noRuns ? (
                    <EmptyFiltered model={emptyModel(filters, chips, anyRuns?.lastAt ?? null, barNow)} onClear={onClearAll} onUseThirtyDays={useThirtyDays} />
                  ) : (
                    <>
                      <div className="usage-hero">
                        <SpendPanel
                          {...panelProps}
                          periodTrend={periodTrend}
                          onClearBucket={filters.bucketPick ? onClearBucket : undefined}
                          metric={metric}
                          onMetric={onMetric}
                          unpriced={unpriced}
                          hidden={hidden}
                          onToggleSeries={onToggleSeries}
                          overlay={overlay}
                          onOverlay={onOverlay}
                          // A folded, truncated previous span is only a lower bound: no overlay then (Compare says why).
                          previousTrend={previousData && !previousData.data.lowerBound ? previousData.data.trend : null}
                          previousSpan={prevSpan}
                          highlight={highlight}
                          onHighlight={setHighlight}
                          scrubIndex={scrub}
                          groupBy={
                            span && bucket ? (
                              <BucketControl value={effectiveBucket(filters, barNow)} days={span.days} onChange={(b) => applyFilters({ ...filters, bucket: b })} />
                            ) : undefined
                          }
                        />
                        <BreakdownCard {...panelProps} highlight={highlight} onHighlight={setHighlight} />
                      </div>
                      <EfficiencyPanel
                        {...panelProps}
                        onPickSignal={(s) => {
                          setWastefulSort(s)
                          setWastefulFocus((n) => n + 1)
                        }}
                      />
                      <div className="usage-pair">
                        <WastefulRuns {...panelProps} sort={wastefulSort} onSort={setWastefulSort} focusSeq={wastefulFocus} />
                        <StaffingPanel {...panelProps} />
                      </div>
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
