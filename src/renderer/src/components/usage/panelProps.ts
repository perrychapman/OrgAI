/**
 * Props every Usage page panel takes (docs/design/usage-app.md sections 6, 7). UsageView owns the state and passes
 * these down; panels never read the store's usage filters themselves, so a panel renders from its props alone.
 */
import type { ReactNode } from 'react'
import type { UsageOverview, UsageOverviewTrendPoint } from '@shared/types'
import type { PeriodSpan, UsageBucket, UsageData, UsageFilters, UsageNarrowing } from '../../lib/usageOverview'
import type { Metric } from '../../lib/usageCharts'

/** "Runs worth a look" sort (6.6). 'no-result' is the default when the data carries noResultCostUsd. */
export type WastefulSort = 'no-result' | 'cost' | 'cache' | 'retries' | 'nudges' | 'idle'

/** Efficiency instruments (6.5), also their data-signal values. */
export type EfficiencySignal = 'cache' | 'cost-per-run' | 'tokens-per-turn' | 'retries' | 'no-result' | 'nudges' | 'idle' | 'team-vs-ask'

export interface UsagePanelProps {
  /** The data under every filter and narrowing (lib/usageOverview.ts usageData). */
  data: UsageData
  /** The overview as main answered it (for connection names, truncation, the query main ran). */
  overview: UsageOverview
  filters: UsageFilters
  /** The bucket in force (effectiveBucket). */
  bucket: UsageBucket
  span: PeriodSpan
  /** Project id -> series index 0..4 (s1..s5); absent = folded into "Other". Stable while the period is unchanged. */
  series: ReadonlyMap<string, number>
  /** Apply a drilldown narrowing (7.1). The view adds the chip, refetches when needed, announces and keeps focus. */
  onNarrow: (n: UsageNarrowing) => void
  /** Say one sentence through the page's polite region (usage-live); at most one per 2 s, the view joins. */
  announce: (text: string) => void
  /** SpendPanel only: the trend without the day pick, so the chart keeps its context after a bucket click. */
  periodTrend?: UsageOverviewTrendPoint[]
  /** SpendPanel only: Esc on a bar while a day is picked removes the day chip. */
  onClearBucket?: () => void
  /**
   * Draw motion (dashboard-usage-redesign usage.md "Draw motion"): true while the page stages its arrival
   * (usePageArrival). Charts draw (areas wipe, arcs trace, bars fill) once on mount while it is true.
   */
  arriving?: boolean
  /**
   * Bumped by the view for each filter or metric change the person makes (never a background refresh). A panel draws
   * once when it changes and its new data has rendered; background updates only tween figures.
   */
  drawSeq?: number
}

/**
 * Row-to-series highlight (dashboard increment 2): a project id (or OTHER_KEY) the user is pointing at or focusing in
 * the "Where it went" card or the legend; the spend chart dims every other series. Null when nothing is pointed at.
 * Owned by UsageView; never announced (the row or legend entry under focus already says its name).
 */
export interface SeriesHighlightProps {
  highlight: string | null
  onHighlight: (key: string | null) => void
}

/** What UsageView passes to SpendPanel on top of UsagePanelProps (all state lives in the view). */
export interface SpendInteractionProps extends SeriesHighlightProps {
  /** The metric in force (lib/usageDashboard.ts resolveMetric); the KPI tiles and the chart's own switch both set it. */
  metric: Metric
  onMetric: (m: Metric) => void
  /** True when no bucket has a known price (usageCharts allUnpriced on the period trend). */
  unpriced: boolean
  /** Legend keys (project ids, OTHER_KEY) hidden from the stack; the scale recomputes from what is shown. */
  hidden: ReadonlySet<string>
  /** Toggle one legend series; the view refuses hiding the last one and announces through usage-live. */
  onToggleSeries: (key: string, name: string) => void
  /** Previous-period overlay on (off by default, not persisted). */
  overlay: boolean
  onOverlay: (on: boolean) => void
  /** The previous equal span's trend (already fetched by useUsageOverview) and its span; null while unknown. */
  previousTrend: UsageOverviewTrendPoint[] | null
  previousSpan: PeriodSpan | null
  /** Increment 3: the Group by control, rendered by the view (it changes filters) and placed in the chart header. */
  groupBy?: ReactNode
  /**
   * Increment 3 sparkline scrub: a bucket slot index (the same fillBuckets slots the chart draws) a KPI sparkline is
   * pointing at, or null. The chart shows its crosshair and tooltip there while it is set (pointer only, instant).
   */
  scrubIndex: number | null
}
