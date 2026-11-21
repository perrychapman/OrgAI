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
import type { OverlayFigure, SortValue } from './usageDashboard'
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

/**
 * What the chart adds to the KPI band, in words: "Busiest day 3 Nov, 5 runs." The totals are already in the band, so
 * they are not repeated here (dashboard increment 3).
 */
export function spendSummary(i: SpendSummaryInput): string {
  const { metric, bucket, totals, busiest } = i
  const tail = i.hidden > 0 ? ` ${i.hidden} hidden.` : ''
  if (totals.runs === 0) return i.hidden > 0 ? `No runs in the series shown.${tail}` : 'No runs in this period.'
  if (metric === 'cost' && costView(totals.cost, { precision: 'page' }).kind === 'unknown') {
    return `Cost unknown for ${plural(totals.runs, 'run')}: no price is known. Tokens are counted.${tail}`
  }
  if (!busiest) return `${plural(totals.runs, 'run')}.${tail}`
  const when = `Busiest ${bucket} ${bucket === 'week' ? 'from ' : ''}${axisLabel(busiest.start, bucket)}, `
  if (metric === 'runs') return `${when}${plural(busiest.value, 'run')}.${tail}`
  if (metric === 'tokens') return `${when}${formatTokens(busiest.value)} tokens.${tail}`
  return `${when}${costView({ costUsd: busiest.value, costSource: 'computed' }, { precision: 'page' }).text}.${tail}`
}

/** One series' figure in the tooltip: "$6.10", "12k", "3", or "No price" for an unpriced cost. */
export function segmentFigure(metric: Metric, seg: Segment): string {
  if (metric === 'runs') return String(seg.value)
  if (metric === 'tokens') return formatTokens(seg.value)
  return costFigureText(seg.cost)
}

/** The tooltip's last line: "2 runs, 1 unpriced" (the unpriced part only when some of them have no price). */
export function runsLine(runs: number, unpriced: number): string {
  return unpriced > 0 ? `${plural(runs, 'run')}, ${unpriced} unpriced` : plural(runs, 'run')
}

/** Runs without a price among the series that are shown (legend keys not hidden). */
export function unpricedRuns(point: UsageOverviewTrendPoint, series: ReadonlyMap<string, number>, hidden: ReadonlySet<string>): number {
  if (hidden.size === 0) return point.costUnknownRuns
  return point.byProject.reduce((n, s) => (hidden.has(sliceKey(s.projectId, series)) ? n : n + s.costUnknownRuns), 0)
}

/** The tooltip's "Previous: ..." text for the overlay figure. */
export function previousTipText(f: OverlayFigure, metric: Metric): string {
  if (f.state === 'empty') return 'no runs'
  if (metric === 'runs') return plural(f.runs, 'run')
  if (metric === 'tokens') return `${formatTokens(f.value)} tokens`
  return f.state === 'unknown' ? 'cost unknown' : overlayCostText(f)
}

// ---------- tooltip geometry (the crosshair's index geometry is in usageAreas.ts) ----------

export interface TipPlacement {
  side: 'right' | 'left'
  /** The tooltip's left edge in the same coordinates as `viewLeft` / `viewRight`. */
  left: number
}

/**
 * Where the tooltip sits: right of the column (clear of the pointer bucket's own bar), flipped to its left when it would
 * pass `viewRight`, and clamped inside [viewLeft, viewRight] when neither side has room.
 */
export function tooltipPlacement(i: { cx: number; half: number; width: number; viewLeft: number; viewRight: number; gap?: number }): TipPlacement {
  const gap = i.gap ?? 8
  const right = i.cx + i.half + gap
  if (right + i.width <= i.viewRight) return { side: 'right', left: right }
  const left = i.cx - i.half - gap - i.width
  if (left >= i.viewLeft) return { side: 'left', left }
  const room = { right: i.viewRight - right, left: i.cx - i.half - gap - i.viewLeft }
  const side = room.right >= room.left ? 'right' : 'left'
  return { side, left: Math.max(i.viewLeft, Math.min(i.viewRight - i.width, side === 'right' ? right : left)) }
}

// ---------- set comparison ----------

export const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i])

export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k))

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
