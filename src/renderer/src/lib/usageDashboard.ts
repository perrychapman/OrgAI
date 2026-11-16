/**
 * Pure models for the Usage page's dashboard layer (docs/design/usage-app.md "Dashboard rework", option D of
 * docs/design/usage-dashboard-options.md): KPI sparklines, the KPI metric switch, legend toggles, the previous-period
 * overlay and table sorting. No DOM, no React; the components draw what these decide and the tests pin it.
 *
 * Unknown is never zero: a sparkline bucket whose cost is unknown is a gap with a hollow dot, an overlay bucket whose
 * cost is unknown is reported as unknown, and a table cell with no value sorts after every value in both directions.
 */
import type { UsageOverviewTrendPoint } from '@shared/types'
import { formatTokens } from './cost'
import { cacheHit, segmentsOf, tokenSum, type BucketSlot, type Metric, type Segment } from './usageCharts'
import type { SummarySignal } from './usagePage'

// ---------- metric switch ----------

/** The KPI tiles that also choose what the spend chart stacks. */
export const KPI_METRIC: Partial<Record<SummarySignal, Metric>> = { cost: 'cost', tokens: 'tokens', runs: 'runs' }

/** The metric in force: the user's choice, else tokens when no bucket has a known price, else cost. */
export function resolveMetric(chosen: Metric | null, unpriced: boolean): Metric {
  return chosen ?? (unpriced ? 'tokens' : 'cost')
}

export const METRIC_WORD: Record<Metric, string> = { cost: 'Cost', tokens: 'Tokens', runs: 'Runs' }

/** "Chart shows runs." */
export function metricAnnouncement(m: Metric): string {
  return `Chart shows ${METRIC_WORD[m].toLowerCase()}.`
}

// ---------- deltas ----------

export type DeltaDirection = 'up' | 'down' | 'same'

/** The direction a summary delta sentence states ("up 12% on ...", "down 3 points ...", "about the same as ..."). */
export function deltaDirection(delta: string | null): DeltaDirection | null {
  if (!delta) return null
  if (delta.startsWith('up ')) return 'up'
  if (delta.startsWith('down ')) return 'down'
  if (delta.startsWith('about the same')) return 'same'
  return null
}

// ---------- sparklines ----------

/** The KPI signals a trend point can draw; cost per run is a median of rows and has no per-bucket figure. */
export type SparkSignal = 'cost' | 'tokens' | 'runs' | 'cache' | 'wall'

export function sparkSignal(s: SummarySignal): SparkSignal | null {
  return s === 'cost-per-run' ? null : s
}

/**
 * One bucket of a sparkline. `value` null is a gap. Kinds: known, partial (a lower bound), unknown (runs with no
 * price, drawn as a hollow dot on the baseline, never as zero), empty (no runs: zero for counts, a gap for cache),
 * gap (runs, but nothing to report: cache not reported).
 */
export interface SparkPoint {
  value: number | null
  kind: 'known' | 'partial' | 'unknown' | 'empty' | 'gap'
}

function sparkPoint(p: UsageOverviewTrendPoint | null, signal: SparkSignal): SparkPoint {
  if (!p || p.runs === 0) return signal === 'cache' ? { value: null, kind: 'empty' } : { value: 0, kind: 'empty' }
  switch (signal) {
    case 'runs':
      return { value: p.runs, kind: 'known' }
    case 'tokens':
      return { value: tokenSum(p.tokens), kind: 'known' }
    case 'wall':
      return { value: p.wallMs, kind: 'known' }
    case 'cache': {
      const c = cacheHit(p.tokens)
      return c === null ? { value: null, kind: 'gap' } : { value: c, kind: 'known' }
    }
    case 'cost':
      if (p.costUsd === null) return p.costUnknownRuns > 0 ? { value: null, kind: 'unknown' } : { value: 0, kind: 'known' }
      return { value: p.costUsd, kind: p.costUnknownRuns > 0 ? 'partial' : 'known' }
  }
}

/** One point per bucket slot (the same slots the spend chart draws, empty ones included). */
export function sparkSeries(slots: readonly BucketSlot[], signal: SparkSignal): SparkPoint[] {
  return slots.map((s) => sparkPoint(s.point, signal))
}

export interface SparkShape {
  /** SVG polyline `points` strings, one per run of drawable buckets (a gap splits the line). */
  lines: string[]
  /** Unknown-cost buckets: a hollow dot on the baseline. */
  hollow: { x: number; y: number }[]
  /** Lower-bound buckets: a small tick above the point. */
  partial: { x: number; y: number }[]
  /** The newest drawable point (a filled dot). */
  last: { x: number; y: number } | null
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Geometry of a sparkline in a `w` x `h` box with `pad` px inside each edge. Linear from zero; anything above zero is at
 * least 2 px above the baseline. Null when fewer than two buckets carry a value (a single point is no trend).
 */
export function sparkShape(points: readonly SparkPoint[], w: number, h: number, pad = 2): SparkShape | null {
  const drawable = points.filter((p) => p.value !== null).length
  if (drawable < 2 || points.length < 2) return null
  const max = points.reduce((m, p) => Math.max(m, p.value ?? 0), 0)
  const base = h - pad
  const span = base - pad
  const x = (i: number): number => r1(pad + (i * (w - 2 * pad)) / (points.length - 1))
  const y = (v: number): number => {
    if (!(v > 0) || !(max > 0)) return r1(base)
    return r1(base - Math.max(2, (v / max) * span))
  }
  const lines: string[] = []
  const hollow: SparkShape['hollow'] = []
  const partial: SparkShape['partial'] = []
  let cur: string[] = []
  let last: SparkShape['last'] = null
  points.forEach((p, i) => {
    if (p.value === null) {
      if (cur.length > 1) lines.push(cur.join(' '))
      else if (cur.length === 1) lines.push(`${cur[0]} ${cur[0]}`)
      cur = []
      if (p.kind === 'unknown') hollow.push({ x: x(i), y: r1(base) })
      return
    }
    const pt = { x: x(i), y: y(p.value) }
    cur.push(`${pt.x},${pt.y}`)
    if (p.kind === 'partial') partial.push(pt)
    last = pt
  })
  if (cur.length > 1) lines.push(cur.join(' '))
  else if (cur.length === 1) lines.push(`${cur[0]} ${cur[0]}`)
  return { lines, hollow, partial, last }
}

// ---------- legend toggles ----------

/** The segments still drawn with some series hidden (keys are project ids or OTHER_KEY). */
export function visibleSegments(segments: readonly Segment[], hidden: ReadonlySet<string>): Segment[] {
  return hidden.size === 0 ? [...segments] : segments.filter((s) => !hidden.has(s.key))
}

/**
 * Hides or shows one legend series. Hiding the last visible one is refused (an empty chart answers nothing).
 * `keys` are the legend's keys in order.
 */
export function toggleSeries(hidden: ReadonlySet<string>, key: string, keys: readonly string[]): { hidden: Set<string>; refused: boolean } {
  const next = new Set([...hidden].filter((k) => keys.includes(k)))
  if (next.has(key)) {
    next.delete(key)
    return { hidden: next, refused: false }
  }
  const visible = keys.filter((k) => !next.has(k))
  if (visible.length <= 1 && visible[0] === key) return { hidden: next, refused: true }
  next.add(key)
  return { hidden: next, refused: false }
}

export function seriesAnnouncement(name: string, nowHidden: boolean, refused = false): string {
  if (refused) return `${name} stays: at least one series stays on the chart.`
  return nowHidden ? `${name} hidden from the chart.` : `${name} shown on the chart.`
}

// ---------- previous-period overlay ----------

/** Previous-period slots aligned to the current ones by position (bucket 1 to bucket 1); missing ones are null. */
export function alignPrevious(current: readonly BucketSlot[], previous: readonly BucketSlot[]): (BucketSlot | null)[] {
  return current.map((_, i) => previous[i] ?? null)
}

export interface OverlayFigure {
  /** The value on the chart's scale (known part only for cost). */
  value: number
  /** known, partial (lower bound), unknown (runs but no price), empty (no runs). */
  state: 'known' | 'partial' | 'unknown' | 'empty'
  runs: number
}

/** A previous bucket's total under the chart's metric, series map and hidden series (so it compares like with like). */
export function overlayFigure(slot: BucketSlot | null, series: ReadonlyMap<string, number>, metric: Metric, hidden: ReadonlySet<string>): OverlayFigure {
  const p = slot?.point
  if (!p || p.runs === 0) return { value: 0, state: 'empty', runs: 0 }
  const segs = visibleSegments(segmentsOf(p.byProject, series, metric), hidden)
  const value = segs.reduce((n, s) => n + s.value, 0)
  const runs = segs.reduce((n, s) => n + s.runs, 0)
  if (metric !== 'cost') return { value, state: value > 0 ? 'known' : 'empty', runs }
  const unknown = segs.some((s) => s.state === 'unknown' || s.state === 'partial')
  if (value <= 0) return { value: 0, state: unknown ? 'unknown' : 'empty', runs }
  return { value, state: unknown ? 'partial' : 'known', runs }
}

/** The overlay's maximum, so the chart's scale covers both periods. */
export function overlayMax(figures: readonly OverlayFigure[]): number {
  return figures.reduce((m, f) => Math.max(m, f.value), 0)
}

/** "Previous period: $4.20+" for the readout; costs come in already formatted by the caller. */
export function overlayReadout(f: OverlayFigure, metric: Metric, costText: string): string {
  if (f.state === 'empty') return 'Previous period: no runs.'
  if (metric === 'runs') return `Previous period: ${f.runs} ${f.runs === 1 ? 'run' : 'runs'}.`
  if (metric === 'tokens') return `Previous period: ${formatTokens(f.value)} tokens.`
  if (f.state === 'unknown') return 'Previous period: cost unknown.'
  return `Previous period: ${costText}.`
}

// ---------- table sorting ----------

export type SortDir = 'asc' | 'desc'
export interface SortState {
  key: string
  dir: SortDir
}
/** A cell's sort key; null (unknown, not reported) sorts after every value in both directions. */
export type SortValue = number | string | null

/** A header press: the same column flips; a new one starts high-to-low for numbers and A-to-Z for text. */
export function nextSort(cur: SortState | null, key: string, numeric: boolean): SortState {
  if (cur && cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: numeric ? 'desc' : 'asc' }
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Stable sort by one value; nulls last whatever the direction. */
export function sortRows<T>(rows: readonly T[], valueOf: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: valueOf(row) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v))
      return c !== 0 ? c * sign : a.i - b.i
    })
    .map((x) => x.row)
}

export function ariaSort(cur: SortState | null, key: string): 'ascending' | 'descending' | 'none' {
  if (!cur || cur.key !== key) return 'none'
  return cur.dir === 'asc' ? 'ascending' : 'descending'
}

/** "Sorted by Cost, highest first." / "Sorted by Project, A to Z." */
export function sortAnnouncement(label: string, dir: SortDir, numeric: boolean): string {
  const how = numeric ? (dir === 'desc' ? 'highest first' : 'lowest first') : dir === 'asc' ? 'A to Z' : 'Z to A'
  return `Sorted by ${label}, ${how}.`
}
