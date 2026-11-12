/**
 * `orgai usage` (cli-spec 6.3, Wave 5): token and cost usage of a project's runs, the CSV export and plan windows.
 *
 *   usage [show] [--range day|week|month|all] [--month YYYY-MM] [--limit N] [--all-projects]   read
 *   usage show --overview [same filters]   cost by model and tier, lead alone against reports, runs worth a look (runs:usageOverview)
 *   usage csv [same filters] [--out <file>] [--force]                                           read
 *   usage refresh                                                                               operate
 *
 * Costs go through the shared cost view: unknown is never $0 and a partial sum shows "+". The CSV is the host's text
 * as-is (already formula-quoted by runs:usageCsv): it is data for spreadsheets, never re-quoted or sanitized here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isProxyConnection, isVirtualProjectId, RUN_KIND_LABELS, USAGE_STATS_MAX_LIMIT, type ConnectionInfo, type ModelUsageEntry, type Project, type RateLimitWindow, type RunKind, type RunUsage, type TokenUsage, type UsageOverview, type UsageOverviewQuery, type UsageStats, type UsageStatsQuery, type UsageStatus } from '../../shared/types'
import { tierForModel, totalTokens } from '../../shared/defaults'
import { costByTier, effectiveWastefulSort, leadComparison, makeTierOf, minutesText, pageCost, tierLabel, wastefulRuns, type GroupStats } from '../../shared/view/usageInsights'
import { formatDateTime } from '../../shared/view/dates'
import { costView, formatTokens, sumCosts, type CostInput } from '../../shared/view/cost'
import { parseFlags } from '../flags'
import { hostCall, requireProject, withHost } from '../manage'
import { emit, isJsonOutput, safe, safeLine, styleFor, table, termWidth, warn, type Json } from '../output'
import { kindLabel } from '../render'
import { checkProjectResolution, ownerSnapshot, type ReadSource } from '../runRef'
import { buildUsageStats, monthRange } from '../../main/runtime/runUsage'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { OPERATE, READ } from './connections'

export type UsageRange = 'day' | 'week' | 'month' | 'all'
const RANGES: readonly UsageRange[] = ['day', 'week', 'month', 'all']
const MONTH_RE = /^(2\d{3})-(0[1-9]|1[0-2])$/
const ALL_KINDS = Object.keys(RUN_KIND_LABELS) as RunKind[]

export interface UsageFilters {
  range?: UsageRange
  month?: string
  limit?: number
}

const FILTER_FLAGS = {
  range: { type: 'string' },
  month: { type: 'string' },
  limit: { type: 'string' },
  'all-projects': { type: 'boolean' }
} as const
const SHOW_FLAGS = { ...FILTER_FLAGS, overview: { type: 'boolean' } } as const
/** Rows of "runs worth a look" and of the per-run model lists in the text. */
const LIST_SHOWN = 10

function filtersOf(values: { range?: string; month?: string; limit?: string }): UsageFilters {
  if (values.range !== undefined && !(RANGES as readonly string[]).includes(values.range)) throw new CliError(`--range takes ${RANGES.join(', ')}.`, EXIT.usage)
  if (values.month !== undefined && values.range !== undefined) throw new CliError('Give --range or --month, not both.', EXIT.usage)
  if (values.month !== undefined && !MONTH_RE.test(values.month)) throw new CliError('--month takes a month as YYYY-MM, e.g. 2026-11.', EXIT.usage)
  let limit: number | undefined
  if (values.limit !== undefined) {
    if (!/^\d+$/.test(values.limit)) throw new CliError(`--limit takes a whole number from 1 to ${USAGE_STATS_MAX_LIMIT}.`, EXIT.usage)
    limit = Number(values.limit)
    if (limit < 1 || limit > USAGE_STATS_MAX_LIMIT) throw new CliError(`--limit takes a whole number from 1 to ${USAGE_STATS_MAX_LIMIT}.`, EXIT.usage)
  }
  return { ...(values.range ? { range: values.range as UsageRange } : {}), ...(values.month ? { month: values.month } : {}), ...(limit ? { limit } : {}) }
}

/** Local midnight of `now`'s day. */
function dayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local calendar month of `now` as YYYY-MM. */
export function monthOf(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * The runs:usageStats / runs:usageCsv query: every run kind; day = since local midnight, week = since Monday's local
 * midnight (ISO week), month = the current local month (UsageStatsQuery.range), --month = that month, all (default) =
 * no bound. Trend buckets are days, weeks for month-long or open ranges.
 */
export function usageQuery(projectId: string, f: UsageFilters, now: number): UsageStatsQuery {
  const q: UsageStatsQuery = { projectId, kinds: [...ALL_KINDS] }
  if (f.month) q.range = { month: f.month }
  else if (f.range === 'day') q.since = dayStart(now)
  else if (f.range === 'week') {
    const start = dayStart(now)
    const back = (new Date(start).getDay() + 6) % 7
    const d = new Date(start)
    d.setDate(d.getDate() - back)
    q.since = d.getTime()
  } else if (f.range === 'month') q.range = { month: monthOf(now) }
  q.bucket = f.range === 'day' || f.range === 'week' || f.month || f.range === 'month' ? 'day' : 'week'
  if (f.limit) q.limit = f.limit
  return q
}

function rangeWords(f: UsageFilters): string {
  if (f.month) return `in ${f.month}`
  switch (f.range) {
    case 'day':
      return 'today'
    case 'week':
      return 'this week'
    case 'month':
      return 'this month'
    default:
      return 'all time'
  }
}

/** Projects in scope: every stored project with --all-projects, else the cwd / --project one. */
async function scopeProjects(ctx: CliContext, client: HostClient, all: boolean): Promise<Project[]> {
  if (!all) return [await requireProject(ctx, client)]
  const list = await hostCall<Project[]>(client, 'projects:list', [])
  return (Array.isArray(list) ? list : []).filter((p) => !isVirtualProjectId(p.id))
}

// ---------- show ----------

const costText = (c: CostInput): string => costView(c).text
const tokensText = (t: TokenUsage | undefined): string => formatTokens(t ? totalTokens(t) : 0)

interface KindRow {
  kind: string
  runs: number
  tokens: number
  cost: CostInput
}

/** Runs grouped by kind label (Run, Ask, Setup, ...), costs summed with sumCosts (unknown parts make it partial). */
export function byKind(stats: Pick<UsageStats, 'runs'>): KindRow[] {
  const groups = new Map<string, { runs: number; tokens: number; costs: CostInput[] }>()
  for (const r of stats.runs) {
    const label = kindLabel({ kind: r.kind, team: r.team })
    const g = groups.get(label) ?? { runs: 0, tokens: 0, costs: [] }
    g.runs++
    g.tokens += totalTokens(r.usage.tokens)
    g.costs.push(r.usage)
    groups.set(label, g)
  }
  return [...groups].map(([kind, g]) => ({ kind, runs: g.runs, tokens: g.tokens, cost: sumCosts(g.costs) }))
}

/** A trend point's cost (the renderer's pointCost): unknown when no run had a known cost, a lower bound when some did not. */
export function pointCost(p: UsageStats['trend'][number]): CostInput {
  if (p.runs === 0) return { costUsd: 0, costSource: 'none' }
  if (p.costUsd === null) return { costUsd: null, costSource: 'unknown' }
  return { costUsd: p.costUsd, costSource: 'provider', sourceMixed: true, ...(p.costUnknownRuns > 0 ? { costPartial: true } : {}) }
}

// ---------- by model ----------

export interface ModelRow {
  model: string
  runs: number
  /**
   * Model responses attributable to this model: a run's turns count when the run used only this model. A run that
   * mixed models cannot be split (UsageStats rows carry no per-model turns), so `requestsExact` is then false and the
   * number is a lower bound; null when no run could be attributed.
   */
  requests: number | null
  requestsExact: boolean
  tokens: TokenUsage
  cost: CostInput
}

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const addTok = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

/** A model entry's cost for the shared cost view: no price is unknown, never $0. */
export function modelEntryCost(m: Pick<ModelUsageEntry, 'costUsd' | 'priceSource' | 'tokens'>): CostInput {
  if (m.costUsd === null || m.priceSource === 'unknown') return totalTokens(m.tokens) > 0 ? { costUsd: null, costSource: 'unknown' } : { costUsd: 0, costSource: 'none' }
  return { costUsd: m.costUsd, costSource: m.priceSource === 'provider' ? 'provider' : 'computed' }
}

/** The models actually used across `usages`, most tokens first. */
export function modelRows(usages: readonly Pick<RunUsage, 'models' | 'turns'>[]): ModelRow[] {
  const by = new Map<string, { runs: number; requests: number; exact: boolean; attributed: boolean; tokens: TokenUsage; costs: CostInput[] }>()
  for (const u of usages) {
    const models = Array.isArray(u.models) ? u.models : []
    for (const m of models) {
      const g = by.get(m.model) ?? { runs: 0, requests: 0, exact: true, attributed: false, tokens: ZERO_TOKENS, costs: [] }
      g.runs++
      if (models.length === 1) {
        g.requests += u.turns
        g.attributed = true
      } else g.exact = false
      g.tokens = addTok(g.tokens, m.tokens)
      g.costs.push(modelEntryCost(m))
      by.set(m.model, g)
    }
  }
  return [...by]
    .map(([model, g]) => ({ model, runs: g.runs, requests: g.attributed ? g.requests : null, requestsExact: g.exact, tokens: g.tokens, cost: sumCosts(g.costs) }))
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens) || a.model.localeCompare(b.model))
}

const requestsText = (r: Pick<ModelRow, 'requests' | 'requestsExact'>): string => (r.requests === null ? '-' : `${r.requests}${r.requestsExact ? '' : '+'}`)

function modelRowJson(r: ModelRow): Json {
  return { model: r.model, runs: r.runs, requests: r.requests, requestsExact: r.requestsExact, tokens: totalTokens(r.tokens), costUsd: r.cost.costUsd, costPartial: !!r.cost.costPartial, cost: costText(r.cost) }
}

function modelTable(rows: readonly ModelRow[], w: number, st: ReturnType<typeof styleFor>): string[] {
  return table([{ header: 'MODEL', flex: true, min: 8, ellipsis: 'middle' }, { header: 'RUNS', align: 'right', min: 4 }, { header: 'REQUESTS', align: 'right', min: 8 }, { header: 'TOKENS', align: 'right', min: 6 }, { header: 'COST', align: 'right', min: 6 }], rows.map((r) => [safeLine(r.model), String(r.runs), requestsText(r), formatTokens(totalTokens(r.tokens)), costText(r.cost)]), w, st)
}

function statsJson(project: Project, stats: UsageStats): Json {
  const totals = stats.totals
  return {
    project: { id: project.id, name: project.name },
    runs: stats.runs.length,
    ...(stats.truncated ? { truncated: true } : {}),
    totals: { tokens: totals.tokens, costUsd: totals.costUsd, costSource: totals.costSource, costPartial: !!totals.costPartial, cost: costText(totals), turns: totals.turns, toolCalls: totals.toolCalls, wallMs: totals.wallMs },
    roles: stats.roles.map((r) => ({ roleId: r.roleId, roleSlug: r.roleSlug, roleName: r.roleName, runs: r.runs, agents: r.agents, tokens: r.tokens, costUsd: r.costUsd, costSource: r.costSource, costPartial: !!r.costPartial, cost: costText(r) })),
    kinds: byKind(stats).map((k) => ({ kind: k.kind, runs: k.runs, tokens: k.tokens, costUsd: k.cost.costUsd, costPartial: !!k.cost.costPartial, cost: costText(k.cost) })),
    trend: stats.trend.map((p) => ({ bucket: p.bucket, runs: p.runs, tokens: p.tokens, costUsd: p.costUsd, costUnknownRuns: p.costUnknownRuns, cost: costText(pointCost(p)) })),
    byModel: modelRows(stats.runs.map((r) => r.usage)).map(modelRowJson),
    runModels: stats.runs.map((r) => ({ runId: r.runId, models: modelRows([r.usage]).map(modelRowJson) }))
  }
}

function statsLines(ctx: CliContext, project: Project, stats: UsageStats, f: UsageFilters): string[] {
  const st = styleFor(ctx)
  const w = termWidth(ctx)
  const t: RunUsage = stats.totals
  const lines = [`${safeLine(project.name)}: ${stats.runs.length} run${stats.runs.length === 1 ? '' : 's'} ${rangeWords(f)}${stats.truncated ? ' (newest only; raise --limit)' : ''}`]
  if (stats.runs.length === 0) return lines
  lines.push(`  Tokens: ${tokensText(t.tokens)}   Estimated cost: ${costText(t)}   Turns: ${t.turns}   Tool calls: ${t.toolCalls}`)
  if (stats.roles.length) {
    lines.push('', ...table([{ header: 'ROLE', flex: true, min: 8 }, { header: 'RUNS', align: 'right', min: 4 }, { header: 'AGENTS', align: 'right', min: 6 }, { header: 'TOKENS', align: 'right', min: 6 }, { header: 'COST', align: 'right', min: 6 }], stats.roles.map((r) => [safeLine(r.roleName || r.roleSlug), String(r.runs), String(r.agents), tokensText(r.tokens), costText(r)]), w, st))
  }
  const kinds = byKind(stats)
  lines.push('', ...table([{ header: 'KIND', flex: true, min: 6 }, { header: 'RUNS', align: 'right', min: 4 }, { header: 'TOKENS', align: 'right', min: 6 }, { header: 'COST', align: 'right', min: 6 }], kinds.map((k) => [k.kind, String(k.runs), formatTokens(k.tokens), costText(k.cost)]), w, st))
  const models = modelRows(stats.runs.map((r) => r.usage))
  if (models.length) {
    lines.push('', 'By model', ...modelTable(models, w, st))
    if (models.some((m) => m.requests === null || !m.requestsExact)) lines.push(st.dim('REQUESTS counts only runs that used one model; a + marks a lower bound, - none attributable.'))
    const perRun = stats.runs.filter((r) => Array.isArray(r.usage.models) && r.usage.models.length > 0).slice(0, LIST_SHOWN)
    if (perRun.length) {
      lines.push('', `By model, per run${stats.runs.length > perRun.length ? ` (newest ${perRun.length}; --json has all)` : ''}`)
      for (const r of perRun) {
        lines.push(`  ${safeLine(r.runId)}  ${safeLine(r.title || r.prompt).slice(0, 60)}`)
        for (const m of modelRows([r.usage])) lines.push(`    ${safeLine(m.model)}: ${requestsText(m) === '-' ? '' : `${requestsText(m)} request${m.requests === 1 ? '' : 's'}, `}${formatTokens(totalTokens(m.tokens))} tokens, ${costText(m.cost)}`)
      }
    }
  }
  if (stats.trend.length) {
    lines.push('', ...table([{ header: 'FROM', min: 10 }, { header: 'RUNS', align: 'right', min: 4 }, { header: 'TOKENS', align: 'right', min: 6 }, { header: 'COST', align: 'right', min: 6 }], stats.trend.map((p) => [p.bucket, String(p.runs), tokensText(p.tokens), costText(pointCost(p))]), w, st))
  }
  if ([t, ...stats.roles].some((c) => costView(c).kind === 'partial' || costView(c).kind === 'unknown')) lines.push(st.dim('A cost with + is a lower bound: some models have no known price. See `orgai models prices`.'))
  return lines
}

// ---------- overview ----------

/** The runs:usageOverview query of the same filters (the overview's own query shape, project ids instead of one id). */
export function overviewQueryOf(projectIds: readonly string[], f: UsageFilters, now: number): UsageOverviewQuery {
  const { projectId: _projectId, ...q } = usageQuery('', f, now)
  return { ...q, ...(projectIds.length ? { projectIds: [...projectIds] } : {}) }
}

const groupLine = (label: string, g: GroupStats): string =>
  `  ${label}: ${g.runs} run${g.runs === 1 ? '' : 's'}${g.runs > 0 ? `, median ${g.medianWallMs === null ? 'time unknown' : minutesText(g.medianWallMs)}, median cost ${g.medianCostUsd === null ? 'unknown' : pageCost(g.medianCostUsd)}${g.costKnownRuns < g.runs ? ` (from ${g.costKnownRuns})` : ''}` : ''}`

interface OverviewView {
  overview: UsageOverview
  tiers: ReturnType<typeof costByTier>
  lead: ReturnType<typeof leadComparison>
  worth: ReturnType<typeof wastefulRuns>
}

function overviewView(overview: UsageOverview, infos: readonly ConnectionInfo[]): OverviewView {
  const tierOf = makeTierOf(infos.map((i) => ({ id: i.connection.id, tierModels: i.connection.tierModels ?? {} })), (m) => tierForModel(m))
  const rows = overview.runs
  return { overview, tiers: costByTier(rows, overview.totals.costUsd, tierOf), lead: leadComparison(rows), worth: wastefulRuns(rows, effectiveWastefulSort('no-result', rows)).slice(0, LIST_SHOWN) }
}

const overviewModelCost = (m: UsageOverview['models'][number]): CostInput => modelEntryCost({ costUsd: m.costUsd, priceSource: m.priceSource, tokens: m.tokens })

function overviewJson(v: OverviewView, f: UsageFilters): Json {
  const o = v.overview
  const group = (g: GroupStats): Json => ({ runs: g.runs, medianWallMs: g.medianWallMs, medianCostUsd: g.medianCostUsd, costKnownRuns: g.costKnownRuns })
  return {
    range: f.month ? { month: f.month } : (f.range ?? 'all'),
    matchedRuns: o.matchedRuns,
    ...(o.truncated ? { truncated: true } : {}),
    totals: { tokens: totalTokens(o.totals.tokens), costUsd: o.totals.costUsd, costPartial: !!o.totals.costPartial, cost: costText(o.totals) },
    byModel: o.models.map((m) => ({ model: m.model, runs: m.runs, projects: m.projects, tokens: totalTokens(m.tokens), costUsd: m.costUsd, costPartial: !!m.costPartial, cost: costText(overviewModelCost(m)) })),
    byTier: v.tiers === null ? null : v.tiers.map((t) => ({ tier: t.key, label: t.label, costUsd: t.costUsd, share: t.share })),
    leadAlone: group(v.lead.alone),
    withReports: group(v.lead.withReports),
    worthALook: v.worth.map((w) => ({ runId: w.row.runId, project: w.row.projectName, title: w.row.title ?? w.row.prompt, status: w.row.status, costUsd: w.row.usage.costUsd, unknownCost: w.unknownCost, noResult: w.noResult, why: w.why }))
  }
}

function overviewLines(ctx: CliContext, v: OverviewView, f: UsageFilters): string[] {
  const st = styleFor(ctx)
  const w = termWidth(ctx)
  const o = v.overview
  const lines = [`Overview: ${o.matchedRuns} run${o.matchedRuns === 1 ? '' : 's'} ${rangeWords(f)}${o.truncated ? ' (the lists below use the newest only; raise --limit)' : ''}`]
  if (o.matchedRuns === 0) return lines
  lines.push(`  Tokens: ${tokensText(o.totals.tokens)}   Estimated cost: ${costText(o.totals)}`)
  lines.push('', 'Cost by model')
  if (o.models.length === 0) lines.push('  No model usage recorded.')
  else lines.push(...table([{ header: 'MODEL', flex: true, min: 8, ellipsis: 'middle' }, { header: 'RUNS', align: 'right', min: 4 }, { header: 'TOKENS', align: 'right', min: 6 }, { header: 'COST', align: 'right', min: 6 }], o.models.map((m) => [safeLine(m.model), String(m.runs), formatTokens(totalTokens(m.tokens)), costText(overviewModelCost(m))]), w, st))
  lines.push('', 'Cost by tier')
  if (v.tiers === null) lines.push('  Not shown: the total cost is unknown or zero.')
  else lines.push(...table([{ header: 'TIER', min: 6 }, { header: 'COST', align: 'right', min: 6 }, { header: 'SHARE', align: 'right', min: 5 }], v.tiers.map((t) => [tierLabel(t.key), pageCost(t.costUsd), `${Math.round(t.share * 100)}%`]), w, st))
  lines.push('', 'Lead alone against runs with reports (team work runs)', groupLine('Lead alone', v.lead.alone), groupLine('With reports', v.lead.withReports))
  lines.push('', 'Runs worth a look')
  if (v.worth.length === 0) lines.push('  None.')
  else lines.push(...table([{ header: 'RUN', min: 8 }, { header: 'PROJECT', min: 7, ellipsis: 'middle' }, { header: 'COST', align: 'right', min: 6 }, { header: 'WHY', flex: true, min: 12 }], v.worth.map((x) => [safeLine(x.row.runId).slice(0, 12), safeLine(x.row.projectName), x.unknownCost ? 'unknown' : pageCost(x.row.usage.costUsd, !!x.row.usage.costPartial), safeLine(x.why)]), w, st))
  return lines
}

const runOverview = async (ctx: CliContext, values: { range?: string; month?: string; limit?: string; 'all-projects'?: boolean }, f: UsageFilters): Promise<number> =>
  withHost(ctx, READ, async (client) => {
    const projects = await scopeProjects(ctx, client, !!values['all-projects'])
    const query = overviewQueryOf(values['all-projects'] ? [] : projects.map((p) => p.id), f, Date.now())
    const overview = await hostCall<UsageOverview>(client, 'runs:usageOverview', [query])
    const infos = await client.call<ConnectionInfo[]>('connections:list', []).catch(() => [] as ConnectionInfo[])
    const v = overviewView(overview, Array.isArray(infos) ? infos : [])
    emit(ctx, { overview: overviewJson(v, f) }, () => overviewLines(ctx, v, f))
    return EXIT.ok
  })

const runShow = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, SHOW_FLAGS)
  if (positionals.length) throw new CliError(`Unexpected argument "${safeLine(positionals[0]).slice(0, 40)}".`, EXIT.usage)
  const f = filtersOf(values)
  if (values.overview) return runOverview(ctx, values, f)
  const saved = await ownerSnapshot(ctx)
  const fromFiles = async (src: ReadSource): Promise<number> => showUsage(ctx, values, f, await savedStats(ctx, src, !!values['all-projects'], f))
  if (saved) return fromFiles(saved)
  try {
    return await withHost(ctx, READ, async (client) => {
      const projects = await scopeProjects(ctx, client, !!values['all-projects'])
      const now = Date.now()
      const results: { project: Project; stats: UsageStats }[] = []
      for (const p of projects) results.push({ project: p, stats: await hostCall<UsageStats>(client, 'runs:usageStats', [usageQuery(p.id, f, now)]) })
      return showUsage(ctx, values, f, results)
    })
  } catch (e) {
    // Another orgai took the folder between the owner check and the start: answer from the saved files (G4, 4.3).
    if (e instanceof CliError && e.exitCode === EXIT.hostBusy) {
      const late = await ownerSnapshot(ctx)
      if (late) return fromFiles(late)
    }
    throw e
  }
}

/** Beside another orgai: the same numbers from the saved run summaries (a summary without usage reads as legacy). */
async function savedStats(ctx: CliContext, src: ReadSource, all: boolean, f: UsageFilters): Promise<{ project: Project; stats: UsageStats }[]> {
  const projects = (await src.projects()).filter((p) => !isVirtualProjectId(p.id))
  let scope = projects
  if (!all) {
    const res = ctx.resolveProject(projects)
    checkProjectResolution(res)
    if (!res.project) throw new CliError('No OrgAI project here. Run this inside a project folder or pass --project <id-or-path>.', EXIT.usage)
    scope = [res.project]
  }
  const now = Date.now()
  const out: { project: Project; stats: UsageStats }[] = []
  for (const p of scope) {
    const q = usageQuery(p.id, f, now)
    if (q.range) {
      const { since, until } = monthRange(q.range.month)
      q.since = since
      q.until = until
      delete q.range
    }
    out.push({ project: p, stats: buildUsageStats(await src.runs(p.id), q, now) })
  }
  return out
}

function showUsage(ctx: CliContext, values: { 'all-projects'?: boolean }, f: UsageFilters, results: { project: Project; stats: UsageStats }[]): number {
  const value: Json = values['all-projects']
      ? { range: f.month ? { month: f.month } : (f.range ?? 'all'), projects: results.map((r) => statsJson(r.project, r.stats)), total: { cost: costText(sumCosts(results.map((r) => r.stats.totals))), costUsd: sumCosts(results.map((r) => r.stats.totals)).costUsd } }
      : { range: f.month ? { month: f.month } : (f.range ?? 'all'), ...statsJson(results[0].project, results[0].stats) }
  emit(ctx, value, () => {
    if (results.length === 0) return 'No projects.'
    const out: string[] = []
    for (const r of results) out.push(...statsLines(ctx, r.project, r.stats, f), '')
    if (results.length > 1) out.push(`All projects: estimated cost ${costText(sumCosts(results.map((r) => r.stats.totals)))}`)
    while (out.length && out[out.length - 1] === '') out.pop()
    return out
  })
  return EXIT.ok
}

// ---------- csv ----------

/** Join per-project CSVs: the header once (from the first), every data row as the host wrote it. */
export function joinCsv(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  const [first, ...rest] = parts
  const tails = rest.map((p) => {
    const nl = p.indexOf('\n')
    return nl === -1 ? '' : p.slice(nl + 1)
  })
  const eol = first.includes('\r\n') ? '\r\n' : '\n'
  const head = first.endsWith('\n') || first === '' ? first : first + eol
  return head + tails.filter((t) => t.length > 0).map((t) => (t.endsWith('\n') ? t : t + eol)).join('')
}

const runCsv = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { ...FILTER_FLAGS, out: { type: 'string', short: 'o' }, force: { type: 'boolean' } })
  if (positionals.length) throw new CliError(`Unexpected argument "${safeLine(positionals[0]).slice(0, 40)}".`, EXIT.usage)
  if (values.force && values.out === undefined) throw new CliError('--force goes with --out.', EXIT.usage)
  const f = filtersOf(values)
  const target = values.out !== undefined && values.out !== '-' ? path.resolve(ctx.cwd, values.out) : undefined
  if (target && !values.force && fs.existsSync(target)) throw new CliError(`${safeLine(target)} exists. Pass --force to replace it.`, EXIT.failure)
  return withHost(ctx, READ, async (client) => {
    const projects = await scopeProjects(ctx, client, !!values['all-projects'])
    const now = Date.now()
    const parts: string[] = []
    for (const p of projects) parts.push(await hostCall<string>(client, 'runs:usageCsv', [usageQuery(p.id, f, now)]))
    const csv = joinCsv(parts.map((s) => (typeof s === 'string' ? s : '')))
    if (target) {
      try {
        fs.writeFileSync(target, csv, { encoding: 'utf8', flag: values.force ? 'w' : 'wx' })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') throw new CliError(`${safeLine(target)} exists. Pass --force to replace it.`, EXIT.failure)
        throw new CliError(`Could not write ${safeLine(target)}: ${safeLine((e as Error).message)}`, EXIT.failure)
      }
      const rows = Math.max(0, csv.split(/\r?\n/).filter((l) => l.length > 0).length - 1)
      emit(ctx, { out: target, rows, bytes: Buffer.byteLength(csv) }, () => `Wrote ${rows} run${rows === 1 ? '' : 's'} to ${safeLine(target)}.`)
      return EXIT.ok
    }
    if (isJsonOutput(ctx)) {
      emit(ctx, { csv }, () => [])
      return EXIT.ok
    }
    // Run prompts and names reach the CSV unchecked: on a terminal it is untrusted text like every other host string
    // (cli-spec 2.5), so control sequences are stripped there. Piped output, --out files and JSON stay byte-exact.
    if (ctx.io.stdout.isTTY) {
      warn(ctx, 'Raw CSV follows; use --out <file> to save it.')
      ctx.io.stdout.write(safe(csv))
      return EXIT.ok
    }
    ctx.io.stdout.write(csv)
    return EXIT.ok
  })
}

// ---------- refresh ----------

function windowLine(name: string, w: RateLimitWindow): string {
  const used = w.utilization === null || !Number.isFinite(w.utilization) ? 'usage not reported' : `${Math.round(w.utilization)}% used`
  return `  ${name}: ${used}${w.resetsAt ? `, resets ${formatDateTime(w.resetsAt)}` : ''}`
}

/** Text lines of a usage report: plan windows, then a proxy's spend periods. `names` maps proxy ids to display names. */
export function usageStatusLines(u: UsageStatus, names?: Readonly<Record<string, string>>): string[] {
  const conn = u.connection ?? 'anthropic'
  const lines = [`${conn === 'openai' ? 'OpenAI' : conn === 'anthropic' ? 'Anthropic' : safeLine(names?.[conn] ?? (conn === 'litellm' ? 'LiteLLM' : conn))}${u.subscriptionType ? ` (${safeLine(u.subscriptionType)})` : ''}, updated ${formatDateTime(u.updatedAt)}`]
  const w = u.windows ?? {}
  if (w.fiveHour) lines.push(windowLine('Five-hour window', w.fiveHour))
  if (w.sevenDay) lines.push(windowLine('Seven-day window', w.sevenDay))
  if (w.sevenDayOpus) lines.push(windowLine('Seven-day Opus window', w.sevenDayOpus))
  if (w.sevenDaySonnet) lines.push(windowLine('Seven-day Sonnet window', w.sevenDaySonnet))
  for (const m of u.modelWindows ?? []) lines.push(windowLine(`Weekly ${safeLine(m.model)}`, m))
  if (!w.fiveHour && (w.sevenDay || (u.modelWindows ?? []).length) && u.authMode === 'subscription') lines.push('  Five-hour window: not reported by your plan right now.')
  if (u.status === 'rejected') lines.push(`  Limited${u.limitedUntil ? ` until ${formatDateTime(u.limitedUntil)}` : ''}.`)
  else if (u.status === 'allowed_warning') lines.push('  Close to a limit.')
  if (u.spend) {
    const s = u.spend
    const usd = (n: number): string => costView({ costUsd: n, costSource: 'provider' }).text
    lines.push(`  Spend: ${usd(s.usd)}${s.budgetUsd !== null ? ` of ${usd(s.budgetUsd)} budget` : ', no budget set'}`)
    if (s.periods) lines.push(`  ${usd(s.periods.day.usd)} today, ${usd(s.periods.week.usd)} this week, ${usd(s.periods.month.usd)} this month (UTC)`)
    else if (s.periodsNote) lines.push(`  ${safeLine(s.periodsNote)}`)
    if (typeof s.totalUsd === 'number' && s.totalUsd !== s.usd) lines.push(`  Lifetime ${usd(s.totalUsd)}`)
  }
  if (lines.length === 1 && !u.available) lines.push('  No plan windows reported (an API key or a plan without limits).')
  return lines
}

/** id -> name of the listed proxies; best effort. */
async function proxyNameMap(client: HostClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const list = await client.call<ConnectionInfo[]>('connections:list', [])
    for (const i of Array.isArray(list) ? list : []) if (isProxyConnection(i.connection)) out[i.connection.id] = i.connection.name
  } catch {
    // Names are cosmetic.
  }
  return out
}

const runRefresh = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length) throw new CliError(`Unexpected argument "${safeLine(positionals[0]).slice(0, 40)}".`, EXIT.usage)
  return withHost(ctx, OPERATE, async (client) => {
    const status = await hostCall<UsageStatus | null>(client, 'usage:refresh', [], { timeoutMs: 60_000 })
    const names = status?.connection && status.connection !== 'anthropic' && status.connection !== 'openai' ? await proxyNameMap(client) : undefined
    emit(ctx, { usage: status ?? null }, () => (status ? usageStatusLines(status, names) : 'No plan usage reported.'))
    return EXIT.ok
  })
}

export const runUsage: CommandFn = (ctx, args) => {
  const [sub, ...rest] = args
  if (sub === undefined || sub.startsWith('-')) return runShow(ctx, args)
  if (sub === 'show') return runShow(ctx, rest)
  if (sub === 'csv') return runCsv(ctx, rest)
  if (sub === 'refresh') return runRefresh(ctx, rest)
  throw new CliError(`Unknown subcommand '${safeLine(sub).slice(0, 64)}'. Usage: orgai usage [show|csv|refresh] [options]`, EXIT.usage)
}
