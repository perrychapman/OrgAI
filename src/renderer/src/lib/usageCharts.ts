/**
 * Pure scale, tick, bucket and series helpers for the Usage page's inline SVG charts (docs/design/usage-app.md
 * section 5). No DOM and no React: the panels draw what these functions decide, and the tests pin the decisions.
 *
 * Encoding (5): known = solid, partial = solid with a hatch and "+", unknown = a dashed stub that adds nothing to the
 * scale, nothing spent = no mark. A figure carries "+" iff a run folded into it has unknown cost.
 */
import type { TokenUsage, UsageOverviewTrendPoint, UsageProjectRollup, UsageTrendProjectSlice } from '@shared/types'
import { costView, formatTokens, type CostInput } from './cost'
import { bucketEnd, bucketPickOf, type UsageBucket } from './usageOverview'

/** Series assignment for one period: project id -> 0..4 (s1..s5); the rest fold into "Other". */
export interface SeriesState {
  /** The period key the assignment belongs to. */
  key: string
  map: ReadonlyMap<string, number>
}

/**
 * Keeps a period's assignment while the period is unchanged (a drilled view never recolours, 5.2); a new period
 * ranks the projects by cost (unknown after known, then tokens) and gives the top 5 s1..s5.
 */
export function assignSeries(prev: SeriesState | null, projects: readonly UsageProjectRollup[], periodKey: string): SeriesState {
  if (prev && prev.key === periodKey) {
    // Projects new to the period (a refetch after a run ended) take free slots, never another project's.
    const used = new Set(prev.map.values())
    let map: Map<string, number> | null = null
    for (const p of projects) {
      if (prev.map.has(p.projectId)) continue
      const free = [0, 1, 2, 3, 4].find((i) => !used.has(i))
      if (free === undefined) break
      map ??= new Map(prev.map)
      map.set(p.projectId, free)
      used.add(free)
    }
    return map ? { key: periodKey, map } : prev
  }
  const map = new Map<string, number>()
  projects.slice(0, 5).forEach((p, i) => map.set(p.projectId, i))
  return { key: periodKey, map }
}

// ---------- ticks and scale ----------

export interface Ticks {
  /** The axis maximum (the last tick). */
  max: number
  /** 3 to 5 values including 0 and `max`. */
  ticks: number[]
}

const STEPS = [1, 2, 2.5, 5, 10]

/** Nice ticks from 0 covering `maxValue`: 3 to 5 labels (0 and 2 to 4 steps). Nothing to draw gives 0 and 1. */
export function niceTicks(maxValue: number): Ticks {
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return { max: 1, ticks: [0, 0.5, 1] }
  const exp = Math.floor(Math.log10(maxValue / 4))
  for (let e = exp; e <= exp + 2; e++) {
    for (const m of STEPS) {
      const step = m * 10 ** e
      const n = Math.ceil(maxValue / step - 1e-9)
      if (n <= 4) {
        const count = Math.max(2, n)
        const ticks = Array.from({ length: count + 1 }, (_, i) => round(step * i))
        return { max: ticks[count]!, ticks }
      }
    }
  }
  return { max: maxValue, ticks: [0, maxValue / 2, maxValue] }
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

/** Axis label for a tick: "$5", "$12k", "$0.50"; tokens through formatTokens. Never a page-precision figure. */
export function formatTick(v: number, metric: 'cost' | 'tokens'): string {
  if (metric === 'tokens') return v === 0 ? '0' : formatTokens(v)
  if (v === 0) return '$0'
  if (v >= 1000) return `$${+(v / 1000).toFixed(1)}k`
  if (v >= 1) return `$${+v.toFixed(2)}`
  // Three decimals when the tick needs them ($0.015), never fewer than two ($0.02), so two ticks never read the same.
  if (v >= 0.01) {
    const t = String(+v.toFixed(3))
    return `$${t.length - t.indexOf('.') - 1 < 2 ? (+t).toFixed(2) : t}`
  }
  return `$${+v.toFixed(4)}`
}

/** Pixel height of a value on the scale: at least `minPx` for anything above zero so a small bucket never reads as empty. */
export function barHeight(value: number, axisMax: number, plotPx: number, minPx = 2): number {
  if (!(value > 0) || !(axisMax > 0)) return 0
  return Math.min(plotPx, Math.max(minPx, (value / axisMax) * plotPx))
}

/** Width of one drawn bar: 70% of its slot, never under 6 px (`minPx`) and never wider than the slot less a 2 px gap when that fits. */
export function barWidth(slotPx: number, minPx = 6): number {
  const w = Math.min(slotPx - 2, slotPx * 0.7)
  return Math.max(minPx, w)
}

/** Slot width for n buckets in a plot, never under 8 px (the bar's 6 px plus a 2 px gap); the chart then scrolls sideways. */
export function slotWidth(n: number, plotPx: number): number {
  return Math.max(8, n > 0 ? plotPx / n : plotPx)
}

// ---------- buckets ----------

export interface BucketSlot {
  /** Local midnight of the bucket's first day. */
  start: number
  key: string
  /** The trend point, or null for an empty slot (drawn as a label with no mark). */
  point: UsageOverviewTrendPoint | null
}

const MAX_SLOTS = 400

/** One slot per bucket from the span's first bucket to its last, empty ones included (the time axis never skips). */
export function fillBuckets(trend: readonly UsageOverviewTrendPoint[], since: number, until: number, size: UsageBucket): BucketSlot[] {
  const byStart = new Map<number, UsageOverviewTrendPoint>()
  for (const p of trend) byStart.set(bucketPickOf(p, size).start, p)
  const out: BucketSlot[] = []
  let cur = bucketPickOf({ start: since }, size).start
  while (cur < until && out.length < MAX_SLOTS) {
    const point = byStart.get(cur) ?? null
    out.push({ start: cur, key: point?.bucket ?? bucketPickOf({ start: cur }, size).key, point })
    cur = bucketEnd(cur, size)
  }
  // A trend point outside the span (a clamped query) still gets its slot, so nothing drawn is lost.
  for (const [start, point] of byStart) if (!out.some((s) => s.start === start) && out.length < MAX_SLOTS) out.push({ start, key: point.bucket, point })
  return out.sort((a, b) => a.start - b.start)
}

const loc = (ms: number, o: Intl.DateTimeFormatOptions): string => new Date(ms).toLocaleDateString('en-GB', o)

/** Short axis label: "3 Nov", "2 Nov" (week start), "Oct". */
export function axisLabel(start: number, size: UsageBucket): string {
  return size === 'month' ? loc(start, { month: 'short' }) : loc(start, { day: 'numeric', month: 'short' })
}

/** Readout label: "Tue 3 Nov", "Week of 2 Nov", "Oct 2026". */
export function bucketLabel(start: number, size: UsageBucket): string {
  if (size === 'day') return loc(start, { weekday: 'short', day: 'numeric', month: 'short' })
  if (size === 'week') return `Week of ${loc(start, { day: 'numeric', month: 'short' })}`
  return loc(start, { month: 'long', year: 'numeric' })
}

/** Indices that get an axis label: every Nth so labels never overlap, the first and the last always. */
export function thinLabels(count: number, slotPx: number, labelPx: number): Set<number> {
  const out = new Set<number>()
  if (count <= 0) return out
  const step = Math.max(1, Math.ceil(labelPx / Math.max(1, slotPx)))
  for (let i = 0; i < count; i += step) out.add(i)
  const last = count - 1
  if (!out.has(last)) {
    // The last label replaces the grid label before it when the two would touch (the first label always stays).
    const lastGrid = Math.max(...out)
    if (last - lastGrid < step && lastGrid !== 0) out.delete(lastGrid)
    out.add(last)
  }
  return out
}

/** "Billing assist..ant": the full name goes in the readout and the table. */
export function clipMiddle(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max || max < 5) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

// ---------- series folding ----------

export type SegmentState = 'known' | 'partial' | 'unknown' | 'none'
export const OTHER_KEY = 'other'

export interface Segment {
  /** A project id, or OTHER_KEY. */
  key: string
  /** 0..4, or -1 for Other. */
  series: number
  /** The value on the scale: cost (known part) or all tokens. 0 for unknown or nothing. */
  value: number
  state: SegmentState
  runs: number
  tokens: number
  /** The cost figure for costView (cost metric); null while the tokens metric is shown. */
  cost: CostInput
  /** How many projects an Other segment holds. */
  projects: number
}

export type Metric = 'cost' | 'tokens'

export const tokenSum = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite

function sliceState(costUsd: number | null, unknownRuns: number): SegmentState {
  if (costUsd === null) return unknownRuns > 0 ? 'unknown' : 'none'
  if (unknownRuns > 0) return 'partial'
  return costUsd > 0 ? 'known' : 'none'
}

function sliceCost(costUsd: number | null, unknownRuns: number): CostInput {
  if (costUsd === null) return unknownRuns > 0 ? { costUsd: null, costSource: 'unknown' } : { costUsd: 0, costSource: 'none' }
  return { costUsd, costSource: costUsd > 0 || unknownRuns > 0 ? 'computed' : 'none', sourceMixed: true, ...(unknownRuns > 0 ? { costPartial: true } : {}) }
}

/**
 * The segments of one bucket in stack order (series 0 at the base, Other last): projects with a series colour on their
 * own, the rest folded into one Other. With the tokens metric every segment is known (tokens are always counted).
 */
export function segmentsOf(slices: readonly UsageTrendProjectSlice[], series: ReadonlyMap<string, number>, metric: Metric): Segment[] {
  const own: Segment[] = []
  const rest: UsageTrendProjectSlice[] = []
  for (const s of slices) {
    const idx = series.get(s.projectId)
    if (idx === undefined) {
      rest.push(s)
      continue
    }
    own.push(segmentFrom(s.projectId, idx, [s], metric))
  }
  own.sort((a, b) => a.series - b.series)
  if (rest.length > 0) own.push(segmentFrom(OTHER_KEY, -1, rest, metric))
  return own.filter((s) => s.state !== 'none')
}

function segmentFrom(key: string, seriesIdx: number, parts: readonly UsageTrendProjectSlice[], metric: Metric): Segment {
  const tokens = parts.reduce((n, p) => n + tokenSum(p.tokens), 0)
  const runs = parts.reduce((n, p) => n + p.runs, 0)
  const unknownRuns = parts.reduce((n, p) => n + p.costUnknownRuns, 0)
  const anyKnown = parts.some((p) => p.costUsd !== null)
  const sum = parts.reduce((n, p) => n + (p.costUsd ?? 0), 0)
  const costUsd = anyKnown ? sum : null
  if (metric === 'tokens') {
    return { key, series: seriesIdx, value: tokens, state: tokens > 0 ? 'known' : 'none', runs, tokens, cost: sliceCost(costUsd, unknownRuns), projects: parts.length }
  }
  return { key, series: seriesIdx, value: costUsd ?? 0, state: sliceState(costUsd, unknownRuns), runs, tokens, cost: sliceCost(costUsd, unknownRuns), projects: parts.length }
}

export type BarState = 'known' | 'partial' | 'unknown' | 'empty'

/** The bar's state: empty (no runs, or nothing spent and nothing unknown), unknown (only unknown parts), partial, known. */
export function barState(segments: readonly Segment[], hasRuns: boolean): BarState {
  if (!hasRuns || segments.length === 0) return 'empty'
  const drawn = segments.filter((s) => s.state === 'known' || s.state === 'partial')
  const unknown = segments.some((s) => s.state === 'unknown')
  if (drawn.length === 0) return unknown ? 'unknown' : 'empty'
  return unknown || drawn.some((s) => s.state === 'partial') ? 'partial' : 'known'
}

/** The tallest stack on the scale: unknown parts add nothing. */
export function stackMax(bars: readonly (readonly Segment[])[]): number {
  let m = 0
  for (const segs of bars) m = Math.max(m, segs.reduce((n, s) => n + s.value, 0))
  return m
}

/** True when no bucket has any known cost although tokens were spent: the chart then offers tokens (6.1). */
export function allUnpriced(trend: readonly UsageOverviewTrendPoint[]): boolean {
  const withRuns = trend.filter((p) => p.runs > 0)
  return withRuns.length > 0 && withRuns.every((p) => p.costUsd === null || (p.costUsd === 0 && p.costUnknownRuns > 0))
}

// ---------- readouts and sentences ----------

function figure(c: CostInput): string {
  return costView(c, { precision: 'page' }).text
}

function metricFigure(seg: { value: number; cost: CostInput }, metric: Metric): string {
  return metric === 'tokens' ? `${formatTokens(seg.value)} tokens` : figure(seg.cost)
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "Tue 3 Nov: $9.80, 14 runs. Billing $6.10, Docs $3.70." Unknown parts read "Notes unknown". */
export function readoutText(label: string, bar: { runs: number; cost: CostInput; tokens: number }, segments: readonly Segment[], names: (key: string, seg: Segment) => string, metric: Metric): string {
  if (bar.runs === 0) return `${label}: no runs.`
  const total = metric === 'tokens' ? `${formatTokens(bar.tokens)} tokens` : figure(bar.cost)
  const parts = segments.map((s) => {
    const n = names(s.key, s)
    return s.state === 'unknown' && metric === 'cost' ? `${n} unknown` : `${n} ${metricFigure(s, metric)}`
  })
  return `${label}: ${total}, ${plural(bar.runs, 'run')}.${parts.length > 0 ? ` ${parts.join(', ')}.` : ''}`
}

/** A segment's own readout: "Tue 3 Nov, Billing: $6.10, 9 runs." */
export function segmentReadout(label: string, name: string, seg: Segment, metric: Metric): string {
  const v = seg.state === 'unknown' && metric === 'cost' ? 'cost unknown' : metricFigure(seg, metric)
  return `${label}, ${name}: ${v}, ${plural(seg.runs, 'run')}.`
}

/** A cost with no known value reads "No price" in compact places; the figure otherwise. */
export function costFigureText(c: CostInput): string {
  const v = costView(c, { precision: 'page' })
  return v.kind === 'unknown' ? 'No price' : v.text
}

/** The rollup's cost as a CostInput: "+" iff a run folded into it has unknown cost (the one partial rule, 5). */
export function rollupCost(r: { costUsd: number | null; costPartial?: boolean; costUnknownRuns: number; costKnownRuns: number }): CostInput {
  if (r.costUsd === null) return r.costUnknownRuns > 0 || r.costKnownRuns === 0 ? { costUsd: null, costSource: 'unknown' } : { costUsd: 0, costSource: 'none' }
  const partial = r.costUnknownRuns > 0
  return { costUsd: r.costUsd, costSource: r.costUsd === 0 && !partial ? 'none' : 'computed', sourceMixed: true, ...(partial ? { costPartial: true } : {}) }
}

/** A rollup's cost divided over its runs; unknown stays unknown and a lower bound stays a lower bound. */
export function perRunCost(c: CostInput, runs: number): CostInput {
  if (c.costUsd === null || c.costSource === 'unknown') return { costUsd: null, costSource: 'unknown' }
  if (runs <= 0) return { costUsd: 0, costSource: 'none' }
  return { ...c, costUsd: c.costUsd / runs }
}

/** "Code", "Engagement", "Assistant" for the project kind column. */
export function projectKindWord(kind: 'code' | 'engagement' | 'assistant'): string {
  return kind === 'engagement' ? 'Engagement' : kind === 'assistant' ? 'Assistant' : 'Code'
}

/** "14 runs". */
export const runsText = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`

/** Tokens in the period: all four kinds. */
export const tokensOfRollup = (t: TokenUsage): number => tokenSum(t)

/** Share of input tokens read from the cache; null when nothing says the provider reports it. */
export function cacheHit(t: TokenUsage): number | null {
  if (t.cacheRead + t.cacheWrite === 0) return null
  const all = t.input + t.cacheRead + t.cacheWrite
  return all > 0 ? t.cacheRead / all : null
}

export function percentText(p: number | null): string {
  return p === null ? 'Not reported' : `${Math.round(p * 100)}%`
}

// ---------- ranking ----------

export interface Rankable {
  costUsd: number | null
  tokens: number
}

/** Cost descending; rows with unknown cost after every known one, ordered by tokens. Stable for equal keys. */
export function rankByCost<T>(items: readonly T[], pick: (t: T) => Rankable): T[] {
  return items
    .map((t, i) => ({ t, i, r: pick(t) }))
    .sort((a, b) => {
      const ak = a.r.costUsd !== null
      const bk = b.r.costUsd !== null
      if (ak !== bk) return ak ? -1 : 1
      if (ak && b.r.costUsd !== a.r.costUsd) return (b.r.costUsd as number) - (a.r.costUsd as number)
      return b.r.tokens - a.r.tokens || a.i - b.i
    })
    .map((x) => x.t)
}

/** Bar length 0..1 for a value on the list's scale (cost, or tokens for rows with no cost). At least 2% for anything above zero. */
export function barFraction(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.max(0.02, Math.min(1, value / max))
}

/** "61%" of the total, rounded; 0 when the total is 0. */
export function sharePercent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

/** Names of the projects folded into Other (for its title), at most `limit`. */
export function otherNames(projects: readonly Pick<UsageProjectRollup, 'projectId' | 'projectName'>[], series: ReadonlyMap<string, number>, limit = 8): { count: number; names: string } {
  const rest = projects.filter((p) => !series.has(p.projectId))
  const shown = rest.slice(0, limit).map((p) => p.projectName)
  return { count: rest.length, names: shown.join(', ') + (rest.length > limit ? `, and ${rest.length - limit} more` : '') }
}
