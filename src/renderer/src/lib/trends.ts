import type { TokenUsage, UsageTrendPoint } from '@shared/types'

export type TrendBucket = 'day' | 'week'
export type TrendMetric = 'tokens' | 'cost'

/** All four token kinds. */
export function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

function localMidnight(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Local midnight `days - 1` days before `now`, so a "7 days" range covers today and the six days before. */
export function rangeSince(now: number, days: number): number {
  const d = localMidnight(now)
  d.setDate(d.getDate() - Math.max(0, days - 1))
  return d.getTime()
}

/** Start of the bucket holding `ms`: local midnight, or the Monday of that week. */
export function bucketStart(ms: number, bucket: TrendBucket): number {
  const d = localMidnight(ms)
  if (bucket === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

function nextStart(ms: number, bucket: TrendBucket): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + (bucket === 'week' ? 7 : 1))
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "YYYY-MM-DD" of a local date, the format of UsageTrendPoint.bucket. */
export function bucketKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyPoint(start: number): UsageTrendPoint {
  return {
    bucket: bucketKey(start),
    start,
    runs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    costUnknownRuns: 0,
    turns: 0,
    toolCalls: 0,
    nudges: 0,
    retries: 0,
    wallMs: 0,
    waitingMs: 0,
    noResultTokens: 0
  }
}

/**
 * Fills the buckets without runs (the contract returns only buckets with runs) so the chart's x axis is even.
 * Runs from `since` to `now`; points outside that span are kept. Oldest first.
 */
export function fillBuckets(trend: UsageTrendPoint[], since: number, now: number, bucket: TrendBucket): UsageTrendPoint[] {
  const byStart = new Map(trend.map((p) => [bucketStart(p.start, bucket), p]))
  const first = Math.min(bucketStart(since, bucket), ...trend.map((p) => bucketStart(p.start, bucket)))
  const last = Math.max(bucketStart(now, bucket), ...trend.map((p) => bucketStart(p.start, bucket)))
  const out: UsageTrendPoint[] = []
  for (let t = first, guard = 0; t <= last && guard < 4000; t = nextStart(t, bucket), guard++) {
    out.push(byStart.get(t) ?? emptyPoint(t))
  }
  return out
}

/** A point's value on the chosen metric. null = nothing known (cost with no priced run). */
export function pointValue(p: UsageTrendPoint, metric: TrendMetric): number | null {
  return metric === 'tokens' ? totalTokens(p.tokens) : p.costUsd
}

/**
 * Bar heights as fractions 0..1 of the largest value. Unknown (null) and zero values give 0. A tiny positive value
 * gets at least `minFraction` so it stays visible.
 */
export function barFractions(values: (number | null)[], minFraction = 0.04): number[] {
  const max = values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0)
  if (max <= 0) return values.map(() => 0)
  return values.map((v) => (v === null || v <= 0 ? 0 : Math.max(minFraction, v / max)))
}

/** Each value's share of the total, 0..1; all zero when the total is 0. */
export function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  return values.map((v) => (total > 0 ? v / total : 0))
}

/** "42%", "<1%" for a nonzero share under one percent, "0%". */
export function formatShare(fraction: number): string {
  if (fraction <= 0) return '0%'
  const pct = fraction * 100
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

/** Short bucket label: "Mar 4" for a day, "Wk Mar 4" for a week. */
export function bucketLabel(p: Pick<UsageTrendPoint, 'start'>, bucket: TrendBucket): string {
  const text = new Date(p.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return bucket === 'week' ? `Wk ${text}` : text
}
