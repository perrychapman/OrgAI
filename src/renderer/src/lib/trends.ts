import type { RunKind, RunUsageRow, TokenUsage, UsageStats, UsageTrendPoint } from '@shared/types'
import { sumCosts } from './cost'

type RoleRow = UsageStats['roles'][number]

/**
 * One row per role: rows that share a slug (name when the slug is missing) are summed, so a role used in three runs
 * is one row. Cost follows `sumCosts` (an unknown part makes the sum a lower bound, all unknown stays unknown).
 * The first row's id and name win; order of first appearance is kept.
 */
export function mergeRoleRows(rows: readonly RoleRow[]): RoleRow[] {
  const groups = new Map<string, RoleRow[]>()
  for (const r of rows) {
    const key = (r.roleSlug || r.roleName).toLowerCase()
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0]!
    const first = g[0]!
    const cost = sumCosts(g.map((r) => ({ costUsd: r.costUsd, costSource: r.costSource, ...(r.costPartial ? { costPartial: true } : {}) })))
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const r of g) {
      tokens.input += r.tokens.input
      tokens.output += r.tokens.output
      tokens.cacheRead += r.tokens.cacheRead
      tokens.cacheWrite += r.tokens.cacheWrite
    }
    const merged: RoleRow = {
      ...first,
      roleId: g.every((r) => r.roleId === first.roleId) ? first.roleId : null,
      agents: g.reduce((n, r) => n + r.agents, 0),
      tokens,
      costUsd: cost.costUsd,
      costSource: cost.costSource,
      turns: g.reduce((n, r) => n + r.turns, 0),
      toolCalls: g.reduce((n, r) => n + r.toolCalls, 0),
      retries: g.reduce((n, r) => n + r.retries, 0),
      agentWallMs: g.reduce((n, r) => n + r.agentWallMs, 0),
      agentsWithoutResult: g.reduce((n, r) => n + r.agentsWithoutResult, 0),
      noResultTokens: g.reduce((n, r) => n + r.noResultTokens, 0),
      models: [...new Set(g.flatMap((r) => r.models))],
      runs: g.reduce((n, r) => n + r.runs, 0),
    }
    if (cost.costPartial) merged.costPartial = true
    else delete merged.costPartial
    return merged
  })
}

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

// ---------- ranges: 7 | 30 | 90 days or a calendar month ----------

export type TrendsRange = { kind: 'days'; days: 7 | 30 | 90 } | { kind: 'month'; month: string }

export const TRENDS_MONTHS_BACK = 24
export const DEFAULT_TRENDS_RANGE: TrendsRange = { kind: 'days', days: 30 }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** The range as stored: "7", "30", "90" or "month:YYYY-MM". */
export function rangeToKey(r: TrendsRange): string {
  return r.kind === 'days' ? String(r.days) : `month:${r.month}`
}

/** Parses a stored key; anything else (junk, a month outside the list) is the default. */
export function parseRangeKey(raw: string | null | undefined, now: number): TrendsRange {
  if (raw === '7' || raw === '30' || raw === '90') return { kind: 'days', days: Number(raw) as 7 | 30 | 90 }
  if (typeof raw === 'string' && raw.startsWith('month:')) {
    const month = raw.slice(6)
    if (monthOptions(now).some((o) => o.value === month)) return { kind: 'month', month }
  }
  return DEFAULT_TRENDS_RANGE
}

const storageKey = (projectId: string): string => `orgai.trendsRange.${projectId}`

export function loadRange(projectId: string, now = Date.now()): TrendsRange {
  try {
    return parseRangeKey(window.localStorage.getItem(storageKey(projectId)), now)
  } catch {
    return DEFAULT_TRENDS_RANGE
  }
}

export function saveRange(projectId: string, r: TrendsRange): void {
  try {
    window.localStorage.setItem(storageKey(projectId), rangeToKey(r))
  } catch {
    // storage unavailable: the choice just is not remembered
  }
}

/** "November 2026" for a 'YYYY-MM'. */
export function monthName(month: string): string {
  const m = MONTH_RE.exec(month)
  if (!m) return month
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** The current month ("November 2026, so far") first, then the 23 before it. */
export function monthOptions(now: number): { value: string; label: string }[] {
  const d = new Date(now)
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < TRENDS_MONTHS_BACK; i++) {
    const v = monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime())
    out.push({ value: v, label: i === 0 ? `${monthName(v)}, so far` : monthName(v) })
  }
  return out
}

/** Local midnight of the 1st and of the next month's 1st (the [start, end) window of a 'YYYY-MM'). */
export function monthBounds(month: string): { start: number; end: number } {
  const m = MONTH_RE.exec(month)
  const y = m ? Number(m[1]) : 1970
  const mo = m ? Number(m[2]) - 1 : 0
  return { start: new Date(y, mo, 1).getTime(), end: new Date(y, mo + 1, 1).getTime() }
}

/**
 * Chart buckets for a month fill the whole month: the last bucket is the month's last day (or week), so days after
 * today are empty columns. Days ranges run from `rangeSince` to `now`.
 */
export function chartSpan(r: TrendsRange, now: number): { since: number; until: number } {
  if (r.kind === 'days') return { since: rangeSince(now, r.days), until: now }
  const { start, end } = monthBounds(r.month)
  return { since: start, until: end - 1 }
}

/** Download name: "<project> usage 2026-11.csv" or "<project> usage last 30 days.csv"; no path characters. */
export function csvFileName(projectName: string, r: TrendsRange): string {
  const what = r.kind === 'month' ? r.month : `last ${r.days} days`
  const name = projectName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Project'
  return `${name} usage ${what}.csv`
}

/** Data rows in CSV text: records minus the header; quoted line breaks do not count. */
export function csvRowCount(csv: string): number {
  let records = 0
  let inQuotes = false
  let pending = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (c === '"') {
      inQuotes = !inQuotes
      pending = true
    } else if (!inQuotes && (c === '\n' || c === '\r')) {
      if (c === '\r' && csv[i + 1] === '\n') i++
      if (pending) records++
      pending = false
    } else {
      pending = true
    }
  }
  if (pending) records++
  return Math.max(0, records - 1)
}

/** "Copied 23 runs as CSV." / "Copied 1 run as CSV." */
export function copiedText(n: number): string {
  return `Copied ${n} ${n === 1 ? 'run' : 'runs'} as CSV.`
}

// ---------- kinds ----------

/** Kind words of the "By kind" table. A work run whose summary is a single-agent Ask run reads "Ask"; a quick run "Chat". */
export function kindLabel(kind: RunKind, summary?: { team?: string; quick?: unknown }): string {
  if (kind === 'work') {
    if (summary?.quick) return 'Chat'
    return summary?.team === 'single' ? 'Ask' : 'Work'
  }
  if (kind === 'setup') return 'Setup'
  if (kind === 'mcp-assist') return 'MCP assistant'
  return 'Skill assistant'
}

export const KIND_ORDER = ['Work', 'Ask', 'Chat', 'Setup', 'MCP assistant', 'Skill assistant']

export interface KindRow {
  label: string
  runs: number
  tokens: TokenUsage
  costUsd: number | null
  costUnknownRuns: number
}

/** Groups usage rows by kind label in KIND_ORDER; cost is the sum of known costs, null when no run had one. */
export function groupByKind(rows: RunUsageRow[], summaryOf: (runId: string) => { team?: string; quick?: unknown } | undefined): KindRow[] {
  const map = new Map<string, KindRow>()
  for (const r of rows) {
    const label = kindLabel(r.kind, summaryOf(r.runId))
    const row = map.get(label) ?? { label, runs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, costUnknownRuns: 0 }
    row.runs++
    row.tokens.input += r.usage.tokens.input
    row.tokens.output += r.usage.tokens.output
    row.tokens.cacheRead += r.usage.tokens.cacheRead
    row.tokens.cacheWrite += r.usage.tokens.cacheWrite
    if (r.usage.costUsd === null) row.costUnknownRuns++
    else {
      row.costUsd = (row.costUsd ?? 0) + r.usage.costUsd
      if (r.usage.costPartial) row.costUnknownRuns++
    }
    map.set(label, row)
  }
  return [...map.values()].sort((a, b) => KIND_ORDER.indexOf(a.label) - KIND_ORDER.indexOf(b.label))
}

/** Short bucket label: "Mar 4" for a day, "Wk Mar 4" for a week. */
export function bucketLabel(p: Pick<UsageTrendPoint, 'start'>, bucket: TrendBucket): string {
  const text = new Date(p.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return bucket === 'week' ? `Wk ${text}` : text
}
