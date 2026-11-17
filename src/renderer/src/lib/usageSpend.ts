/**
 * Pure helpers for the spend chart's dashboard layer (docs/design/usage-dashboard-options.md option D): totals under
 * hidden legend series, the summary sentence, the compact bar value label, the overlay's cost text and the table's
 * "Previous" cell. No DOM, no React.
 *
 * Unknown is never zero: a total with no known cost stays unknown, a total with an unpriced run carries "+".
 */
import type { UsageOverviewTrendPoint } from '@shared/types'
import { costView, formatTokens, type CostInput } from './cost'
import { axisLabel, costFigureText, OTHER_KEY, rollupCost, tokenSum, type Metric, type Segment } from './usageCharts'
import type { OverlayFigure } from './usageDashboard'
import type { SortValue } from './usageDashboard'
import type { UsageBucket } from './usageOverview'

export interface SpendTotals {
  runs: number
  tokens: number
  cost: CostInput
}

/** The legend key a trend slice belongs to: its project id when it has a series colour, else Other. */
export const sliceKey = (projectId: string, series: ReadonlyMap<string, number>): string => (series.has(projectId) ? projectId : OTHER_KEY)

/** Runs, tokens and cost of the given points over the series that are not hidden (all of them when none is hidden). */
export function visibleTotals(points: readonly UsageOverviewTrendPoint[], series: ReadonlyMap<string, number>, hidden: ReadonlySet<string>): SpendTotals {
  let runs = 0
  let tokens = 0
  let sum = 0
  let anyKnown = false
  let known = 0
  let unknown = 0
  for (const p of points) {
    if (hidden.size === 0) {
      runs += p.runs
      tokens += tokenSum(p.tokens)
      if (p.costUsd !== null) {
        anyKnown = true
        sum += p.costUsd
      }
      known += p.costKnownRuns
      unknown += p.costUnknownRuns
      continue
    }
    for (const s of p.byProject) {
      if (hidden.has(sliceKey(s.projectId, series))) continue
      runs += s.runs
      tokens += tokenSum(s.tokens)
      if (s.costUsd !== null) {
        anyKnown = true
        sum += s.costUsd
      }
      known += s.costKnownRuns
      unknown += s.costUnknownRuns
    }
  }
  return { runs, tokens, cost: rollupCost({ costUsd: anyKnown ? sum : null, costKnownRuns: known, costUnknownRuns: unknown }) }
}

/** How many of the legend's keys are hidden (stale keys do not count). */
export function hiddenCount(hidden: ReadonlySet<string>, keys: readonly string[]): number {
  return keys.filter((k) => hidden.has(k)).length
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

export interface SpendSummaryInput {
  metric: Metric
  bucket: UsageBucket
  totals: SpendTotals
  /** The largest visible bucket on the metric's scale, or null when none has a value. */
  busiest: { start: number; value: number } | null
  /** Legend series hidden. */
  hidden: number
}

/** The chart's finding in words: "14 runs; busiest day 3 Nov, 5 runs." */
export function spendSummary(i: SpendSummaryInput): string {
  const { metric, bucket, totals, busiest } = i
  const tail = i.hidden > 0 ? ` ${i.hidden} hidden.` : ''
  if (totals.runs === 0) return i.hidden > 0 ? `No runs in the series shown.${tail}` : 'No runs in this period.'
  const when = busiest ? `; busiest ${bucket} ${bucket === 'week' ? 'from ' : ''}${axisLabel(busiest.start, bucket)}, ` : ''
  const at = (figure: string): string => (busiest ? `${when}${figure}` : '')
  if (metric === 'runs') return `${plural(totals.runs, 'run')}${at(plural(busiest?.value ?? 0, 'run'))}.${tail}`
  if (metric === 'tokens') return `${formatTokens(totals.tokens)} tokens across ${plural(totals.runs, 'run')}${at(`${formatTokens(busiest?.value ?? 0)} tokens`)}.${tail}`
  const total = costView(totals.cost, { precision: 'page' })
  if (total.kind === 'unknown') return `Cost unknown for ${plural(totals.runs, 'run')}: no price is known. Tokens are counted.${tail}`
  const best = busiest ? costView({ costUsd: busiest.value, costSource: 'computed' }, { precision: 'page' }).text : ''
  return `Estimated ${total.text} across ${plural(totals.runs, 'run')}${at(best)}.${tail}`
}

/** The visible stack's figure under the bar-top label: "$9.80", "$4.20+", "12k", "5", or "No price". */
export function barValueLabel(metric: Metric, segments: readonly Segment[]): string {
  const value = segments.reduce((n, s) => n + s.value, 0)
  if (metric === 'runs') return String(value)
  if (metric === 'tokens') return formatTokens(value)
  const partial = segments.some((s) => s.state === 'partial' || s.state === 'unknown')
  if (value <= 0) return segments.some((s) => s.state === 'unknown') ? 'No price' : ''
  return costFigureText({ costUsd: value, costSource: 'computed', sourceMixed: true, ...(partial ? { costPartial: true } : {}) })
}

/** The overlay figure as a cost input (lower bound when partial). */
export function overlayCost(f: OverlayFigure): CostInput {
  return { costUsd: f.value, costSource: 'computed', sourceMixed: true, ...(f.state === 'partial' ? { costPartial: true } : {}) }
}

export function overlayCostText(f: OverlayFigure): string {
  return costView(overlayCost(f), { precision: 'page' }).text
}

/** The table's Previous column sort key: the figure under the metric; unknown and empty have none. */
export function previousSortValue(f: OverlayFigure, metric: Metric): SortValue {
  if (f.state === 'unknown' || f.state === 'empty') return null
  return metric === 'runs' ? f.runs : f.value
}

/** Plain text of the table's Previous cell for the metric. */
export function previousCellText(f: OverlayFigure, metric: Metric): string {
  if (f.state === 'empty') return '—'
  if (metric === 'runs') return String(f.runs)
  if (metric === 'tokens') return formatTokens(f.value)
  return f.state === 'unknown' ? 'No price' : overlayCostText(f)
}

/** Why the overlay toggle is disabled, or null when it can be used. */
export function overlayDisabledReason(hasPrevious: boolean): string | null {
  return hasPrevious ? null : 'No previous period to compare with.'
}
