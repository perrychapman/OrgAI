/**
 * The app-wide Usage page's filters and data (docs/design/usage-app.md sections 3, 7, 10). Pure: no store, DOM or
 * React. The page queries runs:usageOverview for the period, kinds and projects; every other narrowing (model, role,
 * bucket, connection, Ask / Chat inside work runs, "no price") is applied here on the returned rows, and the rollups
 * are then recomputed from those rows (`usageData`). Unknown cost stays null, never 0.
 */
import type {
  CostSource,
  ModelUsageEntry,
  PriceSource,
  RoleUsage,
  RunKind,
  TokenUsage,
  UsageOverview,
  UsageOverviewConnection,
  UsageOverviewModel,
  UsageOverviewQuery,
  UsageOverviewRole,
  UsageOverviewRow,
  UsageOverviewTrendPoint,
  UsageProjectRollup,
  UsageTrendProjectSlice
} from '@shared/types'
import { USAGE_STATS_MAX_LIMIT } from '@shared/types'
import { sumCosts, type CostInput } from './cost'
import { bucketKey, monthBounds, monthKey, monthName, monthOptions, rangeSince, totalTokens } from './trends'

// ---------- filters ----------

export type UsagePeriod =
  | { kind: 'days'; days: 7 | 30 }
  | { kind: 'this-month' }
  | { kind: 'last-month' }
  /** A span of whole months, 'YYYY-MM', from <= to. */
  | { kind: 'months'; from: string; to: string }

export type UsageBucket = 'day' | 'week' | 'month'

/** The page's run kinds (section 8). Ask and Chat are work runs told apart by team 'single' / quick. */
export type UsageKind = 'work' | 'setup' | 'ask' | 'chat' | 'assistants'
export const USAGE_KINDS: readonly UsageKind[] = ['work', 'setup', 'ask', 'chat', 'assistants']
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  work: 'Work runs',
  setup: 'Setup',
  ask: 'Ask',
  chat: 'Chat',
  assistants: 'Assistants'
}

/** A drilled bucket: [start, end) in epoch ms, the bucket size it was drawn at and its key (YYYY-MM-DD). */
export interface UsageBucketPick {
  key: string
  start: number
  end: number
  size: UsageBucket
}

/** A drilled role of one project. `roleKey` is roleId ?? roleSlug, as main keys UsageOverview.roles. */
export interface UsageRolePick {
  projectId: string
  roleKey: string
  /** "Billing / Reviewer" as the chip shows it. */
  label: string
}

export interface UsageFilters {
  period: UsagePeriod
  /** null = automatic (follows the span, `autoBucket`). */
  bucket: UsageBucket | null
  /** Empty = every project (the query omits projectIds). */
  projectIds: string[]
  /** Empty = every kind. */
  kinds: UsageKind[]
  /** The filter bar's Connection select; null = all. '' never appears (runs without a connection are not selectable). */
  connection: string | null
  /** Drilldown narrowings (chips). */
  model: string | null
  role: UsageRolePick | null
  bucketPick: UsageBucketPick | null
  /** "Cost: no price": only runs whose cost is unknown or a lower bound. */
  noPrice: boolean
}

export const DEFAULT_USAGE_PERIOD: UsagePeriod = { kind: 'days', days: 30 }

export function defaultUsageFilters(): UsageFilters {
  return { period: DEFAULT_USAGE_PERIOD, bucket: null, projectIds: [], kinds: [], connection: null, model: null, role: null, bucketPick: null, noPrice: false }
}

/** Drilldown narrowings and the bar's project, kind and connection back to all; period and bucket stay (3.5). */
export function clearedFilters(f: UsageFilters): UsageFilters {
  return { ...defaultUsageFilters(), period: f.period, bucket: f.bucket }
}

// ---------- period and bucket ----------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface PeriodSpan {
  /** Local midnight of the first day. */
  since: number
  /** Exclusive end: now for running periods, local midnight after the last day otherwise. */
  until: number
  /** Calendar days covered (today counts). */
  days: number
}

function addMonths(month: string, n: number): string {
  const { start } = monthBounds(month)
  const d = new Date(start)
  return monthKey(new Date(d.getFullYear(), d.getMonth() + n, 1).getTime())
}

function dayCount(since: number, until: number): number {
  // Calendar days between local midnights (DST-safe through rounding).
  return Math.max(1, Math.round((until - since) / 86_400_000))
}

/** Local midnight after today. */
function endOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function periodSpan(p: UsagePeriod, now: number): PeriodSpan {
  if (p.kind === 'days') {
    const since = rangeSince(now, p.days)
    return { since, until: now + 1, days: p.days }
  }
  if (p.kind === 'this-month') {
    const { start } = monthBounds(monthKey(now))
    return { since: start, until: now + 1, days: dayCount(start, endOfToday(now)) }
  }
  if (p.kind === 'last-month') {
    const { start, end } = monthBounds(addMonths(monthKey(now), -1))
    return { since: start, until: end, days: dayCount(start, end) }
  }
  const from = MONTH_RE.test(p.from) ? p.from : monthKey(now)
  const to = MONTH_RE.test(p.to) && p.to >= from ? p.to : from
  const start = monthBounds(from).start
  const end = monthBounds(to).end
  const running = end > now
  return { since: start, until: running ? now + 1 : end, days: dayCount(start, running ? Math.min(end, endOfToday(now)) : end) }
}

/** The equal span just before this one, for the summary deltas (4.3). */
export function previousSpan(p: UsagePeriod, now: number): PeriodSpan {
  if (p.kind === 'last-month' || p.kind === 'this-month') {
    const month = p.kind === 'this-month' ? addMonths(monthKey(now), -1) : addMonths(monthKey(now), -2)
    const { start, end } = monthBounds(month)
    return { since: start, until: end, days: dayCount(start, end) }
  }
  if (p.kind === 'months') {
    const cur = periodSpan(p, now)
    const n = monthsBetween(p.from, p.to) + 1
    const from = addMonths(p.from, -n)
    const { start } = monthBounds(from)
    return { since: start, until: cur.since, days: dayCount(start, cur.since) }
  }
  const cur = periodSpan(p, now)
  const d = new Date(cur.since)
  d.setDate(d.getDate() - cur.days)
  return { since: d.getTime(), until: cur.since, days: cur.days }
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return Math.max(0, (ty! - fy!) * 12 + (tm! - fm!))
}

/** Default bucket for a span: Day up to 31 days, Week up to 92, else Month (3.2). */
export function autoBucket(days: number): UsageBucket {
  return days <= 31 ? 'day' : days <= 92 ? 'week' : 'month'
}

/** Why a bucket cannot be chosen for a span, else null. Day past 92 days, Month under 60 days. */
export function bucketRefusal(bucket: UsageBucket, days: number): string | null {
  if (bucket === 'day' && days > 92) return 'Days are available for spans up to 92 days.'
  if (bucket === 'month' && days < 60) return 'Months are available for spans of 60 days or more.'
  return null
}

/** The bucket in force: the manual choice while it is still valid, else the automatic one. */
export function effectiveBucket(f: Pick<UsageFilters, 'period' | 'bucket'>, now: number): UsageBucket {
  const { days } = periodSpan(f.period, now)
  return f.bucket && !bucketRefusal(f.bucket, days) ? f.bucket : autoBucket(days)
}

/** The last 12 months for the Months... selects ("November 2026, so far" first). */
export function usageMonthOptions(now: number): { value: string; label: string }[] {
  return monthOptions(now).slice(0, 12)
}

/** Picking From after To moves To up (3.1); returns the new period and the sentence to announce, if any. */
export function pickMonths(p: UsagePeriod, which: 'from' | 'to', month: string, now: number): { period: UsagePeriod; moved?: string } {
  const cur = p.kind === 'months' ? p : { kind: 'months' as const, from: monthKey(now), to: monthKey(now) }
  if (which === 'to') return { period: { kind: 'months', from: cur.from <= month ? cur.from : month, to: month } }
  if (month > cur.to) return { period: { kind: 'months', from: month, to: month }, moved: `To month moved to ${monthName(month)}` }
  return { period: { kind: 'months', from: month, to: cur.to } }
}

const DAY_FMT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }

function shortDate(ms: number, withYear = false): string {
  return new Date(ms).toLocaleDateString('en-GB', withYear ? { ...DAY_FMT, year: 'numeric' } : DAY_FMT)
}

/** "6 Oct to 5 Nov 2026 (30 days)" (usage-period-label). */
export function periodLabel(p: UsagePeriod, now: number): string {
  const s = periodSpan(p, now)
  const last = Math.min(s.until - 1, now)
  const sameYear = new Date(s.since).getFullYear() === new Date(last).getFullYear()
  return `${shortDate(s.since, !sameYear)} to ${shortDate(last, true)} (${s.days} ${s.days === 1 ? 'day' : 'days'})`
}

/** Short words for a period chip / delta: "the previous 30 days", "last month". */
export function previousPeriodWords(p: UsagePeriod): string {
  if (p.kind === 'days') return `the previous ${p.days} days`
  if (p.kind === 'this-month') return 'last month'
  if (p.kind === 'last-month') return 'the month before'
  return 'the months before'
}

/** Stored part of the filters (localStorage orgai.usage.v1): period and bucket only (3.5). */
export function parseStoredUsage(raw: string | null | undefined, now: number): Pick<UsageFilters, 'period' | 'bucket'> {
  const fallback = { period: DEFAULT_USAGE_PERIOD, bucket: null }
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as { period?: unknown; bucket?: unknown }
    const bucket = v.bucket === 'day' || v.bucket === 'week' || v.bucket === 'month' ? v.bucket : null
    const p = v.period as Record<string, unknown> | undefined
    let period: UsagePeriod = DEFAULT_USAGE_PERIOD
    if (p?.kind === 'days' && (p.days === 7 || p.days === 30)) period = { kind: 'days', days: p.days }
    else if (p?.kind === 'this-month' || p?.kind === 'last-month') period = { kind: p.kind }
    else if (p?.kind === 'months' && typeof p.from === 'string' && typeof p.to === 'string' && MONTH_RE.test(p.from) && MONTH_RE.test(p.to)) {
      const valid = new Set(usageMonthOptions(now).map((o) => o.value))
      if (valid.has(p.from) && valid.has(p.to) && p.from <= p.to) period = { kind: 'months', from: p.from, to: p.to }
    }
    return { period, bucket }
  } catch {
    return fallback
  }
}

export function storedUsage(f: Pick<UsageFilters, 'period' | 'bucket'>): string {
  return JSON.stringify({ period: f.period, bucket: f.bucket })
}

// ---------- query ----------

const KIND_RUN_KINDS: Record<UsageKind, RunKind[]> = {
  work: ['work'],
  ask: ['work'],
  chat: ['work'],
  setup: ['setup'],
  assistants: ['mcp-assist', 'skill-assist']
}

/** The runs:usageOverview query of the filters (period, kinds and projects only; the rest narrows client-side). */
export function overviewQuery(f: UsageFilters, now: number, span: PeriodSpan = periodSpan(f.period, now)): UsageOverviewQuery {
  const kinds = f.kinds.length === 0 || f.kinds.length === USAGE_KINDS.length ? [] : [...new Set(f.kinds.flatMap((k) => KIND_RUN_KINDS[k]))]
  return {
    since: span.since,
    until: span.until,
    bucket: effectiveBucket(f, now),
    limit: USAGE_STATS_MAX_LIMIT,
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(f.projectIds.length > 0 ? { projectIds: [...f.projectIds] } : {})
  }
}

/** The equal prior span's query for the deltas: same kinds and projects, month buckets (only totals are read). */
export function previousQuery(f: UsageFilters, now: number): UsageOverviewQuery {
  const span = previousSpan(f.period, now)
  return { ...overviewQuery(f, now, span), bucket: 'month', limit: 1 }
}

/** The page kind of a row (section 8). Chat wins over Ask: a Chat is a single-agent conversation by default. */
export function usageKindOf(row: Pick<UsageOverviewRow, 'kind' | 'team' | 'quick' | 'projectId'>): UsageKind {
  if (row.kind === 'setup') return 'setup'
  if (row.kind === 'mcp-assist' || row.kind === 'skill-assist') return 'assistants'
  if (row.quick || row.projectId === 'quick') return 'chat'
  return row.team === 'single' ? 'ask' : 'work'
}

/** True when a narrowing can only be answered from the rows (the server rollups do not cover it). */
export function needsClientFold(f: UsageFilters): boolean {
  if (f.model || f.role || f.bucketPick || f.connection || f.noPrice) return true
  if (f.kinds.length === 0 || f.kinds.length === USAGE_KINDS.length) return false
  const work = (['work', 'ask', 'chat'] as const).filter((k) => f.kinds.includes(k)).length
  return work > 0 && work < 3
}

const roleKeyOf = (r: Pick<RoleUsage, 'roleId' | 'roleSlug'>): string => r.roleId ?? r.roleSlug

function rowConnections(row: UsageOverviewRow): string[] {
  const split = row.usage.connections ? Object.keys(row.usage.connections) : []
  return [...new Set([...(row.connection ? [row.connection] : []), ...split])]
}

function rowCostKnown(row: UsageOverviewRow): boolean {
  return row.usage.costUsd !== null && !row.usage.costPartial && row.usage.costSource !== 'unknown'
}

/** Does a row pass the client-side narrowings? */
export function rowMatches(row: UsageOverviewRow, f: UsageFilters): boolean {
  if (f.kinds.length > 0 && f.kinds.length < USAGE_KINDS.length && !f.kinds.includes(usageKindOf(row))) return false
  if (f.projectIds.length > 0 && !f.projectIds.includes(row.projectId)) return false
  if (f.connection && !rowConnections(row).includes(f.connection)) return false
  if (f.model && !row.usage.models.some((m) => m.model === f.model)) return false
  if (f.role) {
    const role = f.role
    if (row.projectId !== role.projectId || !row.usage.roles.some((r) => roleKeyOf(r) === role.roleKey && totalTokens(r.tokens) > 0)) return false
  }
  if (f.bucketPick && (row.startedAt < f.bucketPick.start || row.startedAt >= f.bucketPick.end)) return false
  if (f.noPrice && rowCostKnown(row)) return false
  return true
}

// ---------- the data the page draws ----------

export interface UsageTotals {
  runs: number
  costKnownRuns: number
  costUnknownRuns: number
  tokens: TokenUsage
  /** The figure for `Cost` (sourceMixed set). */
  cost: CostInput
  turns: number
  toolCalls: number
  retries: number
  nudges: number
  wallMs: number
  waitingMs: number
  idleMs: number
  limitHoldMs: number
  agents: number
  agentsWithoutResult: number
  noResultTokens: number
  /** Runs still going (live rows). */
  liveRuns: number
  /** Rows recorded before usage tracking. */
  legacyRuns: number
}

export interface UsageData {
  /** Rows that pass every narrowing, newest first (at most the query limit). */
  rows: UsageOverviewRow[]
  totals: UsageTotals
  projects: UsageProjectRollup[]
  models: UsageOverviewModel[]
  roles: UsageOverviewRole[]
  connections: UsageOverviewConnection[]
  /** Oldest first, only buckets with runs. */
  trend: UsageOverviewTrendPoint[]
  /** Runs counted by the figures. */
  matchedRuns: number
  /** The rollups were recomputed from rows. */
  folded: boolean
  /**
   * Figures may be short: rows were folded while the overview was truncated (older matched runs are not in `runs`),
   * so every total is a lower bound.
   */
  lowerBound: boolean
  /** The model chip is set: costs are that model's own cost in those runs ("Model cost"). */
  modelCost: boolean
}

const ZERO_TOKENS = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function addTokens(into: TokenUsage, t: TokenUsage): void {
  into.input += t.input
  into.output += t.output
  into.cacheRead += t.cacheRead
  into.cacheWrite += t.cacheWrite
}

interface CostAcc {
  parts: CostInput[]
}

function costOf(parts: CostInput[]): { costUsd: number | null; costSource: CostSource; costPartial?: true } {
  const s = sumCosts(parts)
  return { costUsd: s.costUsd, costSource: s.costSource, ...(s.costPartial ? { costPartial: true } : {}) }
}

/** One row's figures under the filters: with a model chip only that model's tokens and cost count. */
function rowFigures(row: UsageOverviewRow, model: string | null): { tokens: TokenUsage; cost: CostInput; known: boolean } {
  if (!model) {
    const u = row.usage
    return {
      tokens: u.tokens,
      cost: { costUsd: u.costUsd, costSource: u.costSource, ...(u.costPartial ? { costPartial: true } : {}), ...(u.legacy ? { legacy: true } : {}) },
      known: rowCostKnown(row)
    }
  }
  const entries = row.usage.models.filter((m) => m.model === model)
  const tokens = ZERO_TOKENS()
  for (const m of entries) addTokens(tokens, m.tokens)
  const cost = costOf(entries.map(modelCost))
  return { tokens, cost, known: cost.costUsd !== null && !cost.costPartial && cost.costSource !== 'unknown' }
}

function modelCost(m: ModelUsageEntry): CostInput {
  if (m.costUsd === null || m.priceSource === 'unknown') return totalTokens(m.tokens) > 0 ? { costUsd: null, costSource: 'unknown' } : { costUsd: 0, costSource: 'none' }
  return { costUsd: m.costUsd, costSource: m.priceSource === 'provider' ? 'provider' : 'computed' }
}

const PRICE_RANK: PriceSource[] = ['override', 'proxy', 'builtin', 'community', 'provider', 'unknown']

function bucketStartOf(ms: number, size: UsageBucket): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  if (size === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  if (size === 'month') d.setDate(1)
  return d.getTime()
}

/** [start, end) of the bucket that starts at `start`. */
export function bucketEnd(start: number, size: UsageBucket): number {
  const d = new Date(start)
  if (size === 'day') d.setDate(d.getDate() + 1)
  else if (size === 'week') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function bucketPickOf(point: Pick<UsageOverviewTrendPoint, 'start'>, size: UsageBucket): UsageBucketPick {
  const start = bucketStartOf(point.start, size)
  return { key: bucketKey(start), start, end: bucketEnd(start, size), size }
}

/**
 * Folds rows into the overview's rollups. Used when a narrowing applies; mirrors runUsage.ts's rules for what the page
 * reads (costs through sumCosts, coverage per run, roles keyed project + role).
 */
export function foldRows(rows: readonly UsageOverviewRow[], f: UsageFilters, size: UsageBucket, connectionName: (id: string | null) => string): Omit<UsageData, 'rows' | 'folded' | 'lowerBound' | 'modelCost' | 'matchedRuns'> {
  const model = f.model
  const totalsCost: CostInput[] = []
  const totals: UsageTotals = {
    runs: 0, costKnownRuns: 0, costUnknownRuns: 0, tokens: ZERO_TOKENS(), cost: { costUsd: 0, costSource: 'none' }, turns: 0, toolCalls: 0,
    retries: 0, nudges: 0, wallMs: 0, waitingMs: 0, idleMs: 0, limitHoldMs: 0, agents: 0, agentsWithoutResult: 0, noResultTokens: 0, liveRuns: 0, legacyRuns: 0
  }
  const projects = new Map<string, UsageProjectRollup & { _cost: CostAcc; _nr: CostAcc }>()
  const models = new Map<string, UsageOverviewModel & { _cost: CostAcc; _projects: Set<string> }>()
  const roles = new Map<string, UsageOverviewRole & { _cost: CostAcc }>()
  const conns = new Map<string, UsageOverviewConnection & { _cost: CostAcc }>()
  const trend = new Map<number, UsageOverviewTrendPoint & { _slices: Map<string, UsageTrendProjectSlice> }>()

  for (const row of rows) {
    const u = row.usage
    const fig = rowFigures(row, model)
    totals.runs++
    if (fig.known) totals.costKnownRuns++
    else totals.costUnknownRuns++
    addTokens(totals.tokens, fig.tokens)
    totalsCost.push(fig.cost)
    totals.turns += u.turns
    totals.toolCalls += u.toolCalls
    totals.retries += u.retries
    totals.nudges += u.nudges
    totals.wallMs += u.wallMs
    totals.waitingMs += u.waitingMs
    totals.idleMs += u.idleMs
    totals.limitHoldMs += u.limitHoldMs
    totals.agents += u.agents
    totals.agentsWithoutResult += u.agentsWithoutResult
    totals.noResultTokens += u.noResultTokens
    if (row.live) totals.liveRuns++
    if (row.legacy || u.legacy) totals.legacyRuns++

    // project
    let p = projects.get(row.projectId)
    if (!p) {
      p = {
        projectId: row.projectId, projectName: row.projectName, projectKind: row.projectKind, ...(row.client ? { client: row.client } : {}),
        ...(row.projectRemoved ? { projectRemoved: true as const } : {}), runs: 0, runsByKind: {}, firstStartedAt: row.startedAt, lastStartedAt: row.startedAt,
        tokens: ZERO_TOKENS(), costUsd: 0, costSource: 'none', turns: 0, toolCalls: 0, retries: 0, nudges: 0, wallMs: 0, waitingMs: 0, idleMs: 0,
        limitHoldMs: 0, agents: 0, agentsWithoutResult: 0, noResultTokens: 0, noResultCostUsd: 0, connections: [], costKnownRuns: 0, costUnknownRuns: 0,
        _cost: { parts: [] }, _nr: { parts: [] }
      }
      projects.set(row.projectId, p)
    }
    p.runs++
    const rk = row.kind === 'work' && row.team === 'single' ? 'ask' : row.kind
    p.runsByKind[rk] = (p.runsByKind[rk] ?? 0) + 1
    p.firstStartedAt = Math.min(p.firstStartedAt, row.startedAt)
    p.lastStartedAt = Math.max(p.lastStartedAt, row.startedAt)
    addTokens(p.tokens, fig.tokens)
    p._cost.parts.push(fig.cost)
    if (fig.known) p.costKnownRuns++
    else p.costUnknownRuns++
    p.turns += u.turns
    p.toolCalls += u.toolCalls
    p.retries += u.retries
    p.nudges += u.nudges
    p.wallMs += u.wallMs
    p.waitingMs += u.waitingMs
    p.idleMs += u.idleMs
    p.limitHoldMs += u.limitHoldMs
    p.agents += u.agents
    p.agentsWithoutResult += u.agentsWithoutResult
    p.noResultTokens += u.noResultTokens
    if (u.agentsWithoutResult > 0) {
      if (u.noResultCostUsd === undefined) p._nr.parts.push({ costUsd: 0, costSource: 'computed', costPartial: true })
      else p._nr.parts.push(u.noResultCostUsd === null ? { costUsd: null, costSource: 'unknown' } : { costUsd: u.noResultCostUsd, costSource: 'computed', ...(u.noResultCostPartial ? { costPartial: true } : {}) })
    }
    for (const c of rowConnections(row)) if (!p.connections.includes(c)) p.connections.push(c)

    // models
    for (const m of u.models) {
      if (model && m.model !== model) continue
      let e = models.get(m.model)
      if (!e) {
        e = { model: m.model, tokens: ZERO_TOKENS(), costUsd: null, priceSource: m.priceSource, runs: 0, projects: 0, costKnownRuns: 0, costUnknownRuns: 0, _cost: { parts: [] }, _projects: new Set() }
        models.set(m.model, e)
      }
      addTokens(e.tokens, m.tokens)
      const mc = modelCost(m)
      e._cost.parts.push(mc)
      if (m.providerCostUsd) e.providerCostUsd = (e.providerCostUsd ?? 0) + m.providerCostUsd
      if (PRICE_RANK.indexOf(m.priceSource) < PRICE_RANK.indexOf(e.priceSource)) e.priceSource = m.priceSource
      e.runs++
      e._projects.add(row.projectId)
      if (mc.costUsd === null) e.costUnknownRuns++
      else e.costKnownRuns++
    }

    // roles
    for (const r of u.roles) {
      const key = `${row.projectId}\u0000${roleKeyOf(r)}`
      let e = roles.get(key)
      if (!e) {
        e = { ...r, tokens: ZERO_TOKENS(), models: [], agents: 0, turns: 0, toolCalls: 0, retries: 0, agentWallMs: 0, agentsWithoutResult: 0, noResultTokens: 0, costUsd: 0, costSource: 'none', projectId: row.projectId, projectName: row.projectName, runs: 0, costKnownRuns: 0, costUnknownRuns: 0, _cost: { parts: [] } }
        delete e.costPartial
        roles.set(key, e)
      }
      addTokens(e.tokens, r.tokens)
      e._cost.parts.push({ costUsd: r.costUsd, costSource: r.costSource, ...(r.costPartial ? { costPartial: true } : {}) })
      e.agents += r.agents
      e.turns += r.turns
      e.toolCalls += r.toolCalls
      e.retries += r.retries
      e.agentWallMs += r.agentWallMs
      e.agentsWithoutResult += r.agentsWithoutResult
      e.noResultTokens += r.noResultTokens
      for (const m of r.models) if (!e.models.includes(m)) e.models.push(m)
      e.runs++
      if (r.costUsd !== null && !r.costPartial && r.costSource !== 'unknown') e.costKnownRuns++
      else e.costUnknownRuns++
    }

    // connections
    const split = u.connections
    const list: { id: string | null; cost: CostInput; agents: number }[] = split
      ? Object.entries(split).map(([id, v]) => ({ id, agents: v?.agents ?? 0, cost: v?.costUsd === null || v === undefined ? { costUsd: null, costSource: 'unknown' } : { costUsd: v.costUsd, costSource: 'computed', ...(v.costPartial ? { costPartial: true } : {}) } }))
      : [{ id: row.connection ?? null, agents: u.agents, cost: fig.cost }]
    for (const c of list) {
      const k = c.id ?? ''
      let e = conns.get(k)
      if (!e) {
        e = { connection: c.id, name: connectionName(c.id), kind: c.id === null ? null : c.id === 'anthropic' || c.id === 'openai' ? 'builtin' : 'proxy', runs: 0, agents: 0, costUsd: 0, costSource: 'none', costKnownRuns: 0, costUnknownRuns: 0, _cost: { parts: [] } }
        conns.set(k, e)
      }
      e.runs++
      e.agents += c.agents
      e._cost.parts.push(c.cost)
      if (c.cost.costUsd !== null && !c.cost.costPartial && c.cost.costSource !== 'unknown') e.costKnownRuns++
      else e.costUnknownRuns++
    }

    // trend
    const start = bucketStartOf(row.startedAt, size)
    let t = trend.get(start)
    if (!t) {
      t = { bucket: bucketKey(start), start, runs: 0, tokens: ZERO_TOKENS(), costUsd: null, costUnknownRuns: 0, costKnownRuns: 0, turns: 0, toolCalls: 0, nudges: 0, retries: 0, wallMs: 0, waitingMs: 0, noResultTokens: 0, byProject: [], _slices: new Map() }
      trend.set(start, t)
    }
    t.runs++
    addTokens(t.tokens, fig.tokens)
    if (fig.cost.costUsd !== null && fig.cost.costSource !== 'unknown') t.costUsd = (t.costUsd ?? 0) + fig.cost.costUsd
    if (fig.known) t.costKnownRuns++
    else t.costUnknownRuns++
    t.turns += u.turns
    t.toolCalls += u.toolCalls
    t.nudges += u.nudges
    t.retries += u.retries
    t.wallMs += u.wallMs
    t.waitingMs += u.waitingMs
    t.noResultTokens += u.noResultTokens
    let sl = t._slices.get(row.projectId)
    if (!sl) {
      sl = { projectId: row.projectId, runs: 0, tokens: ZERO_TOKENS(), costUsd: null, wallMs: 0, waitingMs: 0, costKnownRuns: 0, costUnknownRuns: 0 }
      t._slices.set(row.projectId, sl)
    }
    sl.runs++
    addTokens(sl.tokens, fig.tokens)
    if (fig.cost.costUsd !== null && fig.cost.costSource !== 'unknown') sl.costUsd = (sl.costUsd ?? 0) + fig.cost.costUsd
    if (fig.known) sl.costKnownRuns++
    else sl.costUnknownRuns++
    sl.wallMs += u.wallMs
    sl.waitingMs += u.waitingMs
  }

  totals.cost = { ...costOf(totalsCost), sourceMixed: true, ...(totals.legacyRuns > 0 && totals.legacyRuns === totals.runs ? { legacy: true } : {}) }
  const byCost = <T extends { costUsd: number | null; tokens: TokenUsage }>(a: T, b: T): number =>
    (b.costUsd ?? -1) - (a.costUsd ?? -1) || totalTokens(b.tokens) - totalTokens(a.tokens)
  const strip = <T extends object>(o: T, ...keys: string[]): T => {
    const out = { ...o } as Record<string, unknown>
    for (const k of keys) delete out[k]
    return out as T
  }
  return {
    totals,
    projects: [...projects.values()]
      .map((p) => {
        const c = costOf(p._cost.parts)
        const nr: { costUsd: number | null; costPartial?: true } = p._nr.parts.length ? costOf(p._nr.parts) : { costUsd: 0 }
        return strip({ ...p, ...c, noResultCostUsd: nr.costUsd, ...(nr.costPartial ? { noResultCostPartial: true as const } : {}) }, '_cost', '_nr')
      })
      .sort((a, b) => byCost(a, b) || a.projectName.localeCompare(b.projectName)),
    models: [...models.values()]
      .map((m) => {
        const c = costOf(m._cost.parts)
        return strip({ ...m, costUsd: c.costUsd, ...(c.costPartial ? { costPartial: true as const } : {}), projects: m._projects.size }, '_cost', '_projects')
      })
      .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)),
    roles: [...roles.values()].map((r) => strip({ ...r, ...costOf(r._cost.parts) }, '_cost')).sort(byCost),
    connections: [...conns.values()].map((c) => strip({ ...c, ...costOf(c._cost.parts) }, '_cost')).sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.agents - a.agents),
    trend: [...trend.values()]
      .sort((a, b) => a.start - b.start)
      .map((t) => strip({ ...t, byProject: [...t._slices.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || totalTokens(b.tokens) - totalTokens(a.tokens)) }, '_slices'))
  }
}

/** The server totals as UsageTotals. */
function serverTotals(o: UsageOverview): UsageTotals {
  const t = o.totals
  const live = o.runs.filter((r) => r.live).length
  const legacy = o.runs.filter((r) => r.legacy || r.usage.legacy).length
  return {
    runs: o.matchedRuns,
    costKnownRuns: o.costKnownRuns,
    costUnknownRuns: o.costUnknownRuns,
    tokens: t.tokens,
    cost: { costUsd: t.costUsd, costSource: t.costSource, ...(t.costPartial ? { costPartial: true } : {}), sourceMixed: true, models: t.models },
    turns: t.turns,
    toolCalls: t.toolCalls,
    retries: t.retries,
    nudges: t.nudges,
    wallMs: t.wallMs,
    waitingMs: t.waitingMs,
    idleMs: t.idleMs,
    limitHoldMs: t.limitHoldMs,
    agents: t.agents,
    agentsWithoutResult: t.agentsWithoutResult,
    noResultTokens: t.noResultTokens,
    liveRuns: live,
    legacyRuns: legacy
  }
}

/**
 * What the page draws for an overview under the filters. Without a client-side narrowing the server's rollups are
 * used as they are (they cover every matched run, past the row limit); with one, the rollups are folded from the
 * matching rows and, when the overview was truncated, marked as a lower bound.
 */
export function usageData(o: UsageOverview, f: UsageFilters, connectionName: (id: string | null) => string): UsageData {
  const rows = o.runs.filter((r) => rowMatches(r, f))
  if (!needsClientFold(f)) {
    return {
      rows,
      totals: serverTotals(o),
      projects: o.projects,
      models: o.models,
      roles: o.roles,
      connections: o.connections,
      trend: o.trend,
      matchedRuns: o.matchedRuns,
      folded: false,
      lowerBound: false,
      modelCost: false
    }
  }
  const folded = foldRows(rows, f, o.query.bucket, connectionName)
  return { rows, ...folded, matchedRuns: rows.length, folded: true, lowerBound: !!o.truncated, modelCost: !!f.model }
}

// ---------- chips ----------

export type UsageChipKind = 'project' | 'model' | 'role' | 'connection' | 'kind' | 'bucket' | 'period' | 'cost'

export interface UsageChip {
  kind: UsageChipKind
  /** Stable key (kind plus the value). */
  key: string
  /** "Project: Billing". */
  text: string
  /** The X button's name: "Remove filter: Project Billing". */
  removeLabel: string
  /** Optional title (a week or month bucket offers "Switch to days"). */
  title?: string
}

/** "Day: Tue 3 Nov", "Week of 2 Nov", "Month: Oct 2026". */
export function bucketChipText(b: Pick<UsageBucketPick, 'start' | 'size'>): string {
  const d = new Date(b.start)
  if (b.size === 'day') return `Day: ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`
  if (b.size === 'week') return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
  return `Month: ${d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
}

/** "Period: Last month" etc.; null for the default 30 days. */
export function periodChipText(p: UsagePeriod): string | null {
  if (p.kind === 'days') return p.days === 30 ? null : `Period: ${p.days} days`
  if (p.kind === 'this-month') return 'Period: This month'
  if (p.kind === 'last-month') return 'Period: Last month'
  return p.from === p.to ? `Period: ${monthName(p.from)}` : `Period: ${monthName(p.from)} to ${monthName(p.to)}`
}

const chip = (kind: UsageChipKind, key: string, text: string, title?: string): UsageChip => ({
  kind,
  key: `${kind}:${key}`,
  text,
  removeLabel: `Remove filter: ${text.replace(': ', ' ')}`,
  ...(title ? { title } : {})
})

/** One chip per narrowing that is not the default (3.5), in a stable order. */
export function usageChips(f: UsageFilters, names: { project: (id: string) => string; connection: (id: string) => string }): UsageChip[] {
  const out: UsageChip[] = []
  for (const id of f.projectIds) out.push(chip('project', id, `Project: ${names.project(id)}`))
  if (f.model) out.push(chip('model', f.model, `Model: ${f.model}`))
  if (f.role) out.push(chip('role', `${f.role.projectId}/${f.role.roleKey}`, `Role: ${f.role.label}`))
  if (f.connection) out.push(chip('connection', f.connection, `Connection: ${names.connection(f.connection)}`))
  if (f.kinds.length > 0 && f.kinds.length < USAGE_KINDS.length) for (const k of f.kinds) out.push(chip('kind', k, `Kind: ${USAGE_KIND_LABELS[k]}`))
  if (f.bucketPick) out.push(chip('bucket', f.bucketPick.key, bucketChipText(f.bucketPick), f.bucketPick.size === 'day' ? undefined : 'Switch to days'))
  if (f.noPrice) out.push(chip('cost', 'no-price', 'Cost: no price'))
  const period = periodChipText(f.period)
  if (period) out.push(chip('period', 'period', period))
  return out
}

/** The filters without one chip's narrowing. The period chip returns to 30 days. */
export function withoutChip(f: UsageFilters, c: Pick<UsageChip, 'kind' | 'key'>): UsageFilters {
  const value = c.key.slice(c.kind.length + 1)
  switch (c.kind) {
    case 'project':
      return { ...f, projectIds: f.projectIds.filter((id) => id !== value) }
    case 'model':
      return { ...f, model: null }
    case 'role':
      return { ...f, role: null }
    case 'connection':
      return { ...f, connection: null }
    case 'kind':
      return { ...f, kinds: f.kinds.filter((k) => k !== value) }
    case 'bucket':
      return { ...f, bucketPick: null }
    case 'cost':
      return { ...f, noPrice: false }
    case 'period':
      return { ...f, period: DEFAULT_USAGE_PERIOD, bucketPick: null }
  }
}

/** A narrowing from a chart element (7.1). Each set field replaces the current one; projects add. */
export interface UsageNarrowing {
  projectId?: string
  model?: string
  role?: UsageRolePick
  bucket?: UsageBucketPick
  connection?: string
  noPrice?: true
}

export function narrowFilters(f: UsageFilters, n: UsageNarrowing): UsageFilters {
  return {
    ...f,
    ...(n.projectId ? { projectIds: [n.projectId] } : {}),
    ...(n.model ? { model: n.model } : {}),
    ...(n.role ? { role: n.role } : {}),
    ...(n.bucket ? { bucketPick: n.bucket } : {}),
    ...(n.connection ? { connection: n.connection } : {}),
    ...(n.noPrice ? { noPrice: true } : {})
  }
}

/** The chips a narrowing adds (for "Filter added: ..." and focus on the added chip). */
export function addedChips(before: UsageChip[], after: UsageChip[]): UsageChip[] {
  const had = new Set(before.map((c) => c.key))
  return after.filter((c) => !had.has(c.key))
}

/** A key that changes when the query must be re-run (period, bucket, kinds, projects). */
export function queryKey(f: UsageFilters, now: number): string {
  const q = overviewQuery(f, now)
  // since / until move with `now` for running periods; key on the period instead so a refetch is a choice, not a tick.
  return JSON.stringify([f.period, q.bucket, q.kinds ?? [], q.projectIds ?? []])
}

export { monthKey }
