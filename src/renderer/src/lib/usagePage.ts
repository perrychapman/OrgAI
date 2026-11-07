/**
 * Copy and decisions of the Usage page shell (docs/design/usage-app.md sections 3, 4, 10, 11, 12). Pure: no store, DOM
 * or React. Every cost figure goes through lib/cost.ts costView with precision 'page'; nothing here formats a USD.
 */
import type { ProjectKind, RunStatus, TokenUsage, UsageOverviewRow, UsageProjectKind, UsageProjectRollup } from '@shared/types'
import { VIRTUAL_PROJECT_LABELS, isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { costView, formatDuration, type CostInput } from './cost'
import { ASSISTANT_ORDER } from './assistants'
import { groupByClient } from './clientGroups'
import {
  USAGE_KIND_LABELS,
  USAGE_KINDS,
  periodLabel,
  rowFigures,
  type UsageChip,
  type UsageData,
  type UsageFilters,
  type UsagePeriod
} from './usageOverview'

export const USAGE_SUBTITLE = 'What your runs cost and where the time and tokens went. Costs are estimates unless your provider reports them.'
export const TRUNCATED_LIMIT_LABEL = '2,000'

export const runsPhrase = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`

// ---------- scope and header ----------

/** "6 Oct to 5 Nov 2026" (the period label without its day count). */
export function periodDates(p: UsagePeriod, now: number): string {
  return periodLabel(p, now).replace(/ \(\d+ days?\)$/, '')
}

/** Who the page is about: all, one project, "3 projects", the kinds, or both (3.1). */
export function scopeSubject(f: UsageFilters, projectName: (id: string) => string): string {
  const kinds = f.kinds.length > 0 && f.kinds.length < USAGE_KINDS.length ? f.kinds.map((k) => USAGE_KIND_LABELS[k]).join(' and ') : ''
  const projects = f.projectIds.length === 1 ? projectName(f.projectIds[0]!) : f.projectIds.length > 1 ? `${f.projectIds.length} projects` : ''
  if (projects && kinds) return `${projects}, ${kinds}`
  return projects || kinds || 'All projects and chats'
}

/** "All projects and chats, 6 Oct to 5 Nov 2026 · 212 runs" (usage-scope, and the filter bar's sr-only copy). */
export function scopeLine(f: UsageFilters, runs: number | null, projectName: (id: string) => string, now: number): string {
  const head = `${scopeSubject(f, projectName)}, ${periodDates(f.period, now)}`
  return runs === null ? head : `${head} · ${runsPhrase(runs)}`
}

/** "OrgAI usage 7 Oct to 5 Nov 2026.csv" (Save CSV...). */
export function usageCsvFileName(p: UsagePeriod, now: number): string {
  return `OrgAI usage ${periodDates(p, now).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')}.csv`
}

/** "Updated 14:02" (usage-updated). */
export function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}
export const updatedText = (ms: number): string => `Updated ${hhmm(ms)}`
export const refreshFailedText = (ms: number): string => `Could not refresh usage. Showing the data from ${hhmm(ms)}.`

// ---------- figures ----------

/** cacheRead / (input + cacheRead + cacheWrite); null when no cache tokens were reported at all ("Not reported", never 0%). */
export function cacheHit(t: TokenUsage): number | null {
  if (t.cacheRead + t.cacheWrite <= 0) return null
  const all = t.input + t.cacheRead + t.cacheWrite
  return all > 0 ? t.cacheRead / all : null
}

export const percentText = (fraction: number): string => `${Math.round(fraction * 100)}%`

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** The known per-run costs of the rows (a model chip counts only that model's share), and how many runs were left out. */
export function runCosts(rows: readonly UsageOverviewRow[], model: string | null): { known: number[]; unknown: number } {
  const known: number[] = []
  let unknown = 0
  for (const r of rows) {
    const f = rowFigures(r, model)
    if (f.known && f.cost.costUsd !== null) known.push(f.cost.costUsd)
    else unknown++
  }
  return { known, unknown }
}

/** "up 12% on the previous 30 days"; null when the earlier figure is zero or unusable (never a made-up zero). */
export function percentDelta(cur: number, prev: number, words: string): string | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null
  const pct = Math.round((Math.abs(cur - prev) / prev) * 100)
  if (pct === 0) return `about the same as ${words}`
  return `${cur > prev ? 'up' : 'down'} ${pct}% on ${words}`
}

/** Percentage-point change of a share ("up 4 points on ..."). */
export function pointsDelta(cur: number, prev: number, words: string): string | null {
  const pts = Math.round(Math.abs(cur - prev) * 100)
  if (pts === 0) return `about the same as ${words}`
  return `${cur > prev ? 'up' : 'down'} ${pts} ${pts === 1 ? 'point' : 'points'} on ${words}`
}

export type SummarySignal = 'cost' | 'runs' | 'cost-per-run' | 'cache' | 'wall'

export interface SummaryItemModel {
  signal: SummarySignal
  label: string
  /** The figure: a cost (through costView page) ... */
  cost?: CostInput
  /** ... or plain text. */
  text?: string
  /** "At least " shown before a cost that is a lower bound over folded or truncated data. */
  atLeast?: boolean
  /** Text for a cost with no price at all ("No price"). */
  noPriceText?: string
  title?: string
  delta: string | null
}

export interface CostCoverage {
  line: string
  noPrice: number
  /** "1 run has no price". */
  noPriceLabel: string
}

/** "from 3 of 4 runs" plus the no-price link text whenever any run is partial or unknown (4.3); null when all are known. */
export function costCoverage(t: { runs: number; costKnownRuns: number; costUnknownRuns: number }): CostCoverage | null {
  if (t.costUnknownRuns <= 0 || t.runs <= 0) return null
  const n = t.costUnknownRuns
  return { line: `from ${t.costKnownRuns} of ${t.runs} runs`, noPrice: n, noPriceLabel: `${n} ${n === 1 ? 'run has' : 'runs have'} no price` }
}

export function liveNote(n: number): string | null {
  if (n <= 0) return null
  return n === 1 ? '1 run is still going; its figures will grow.' : `${n} runs are still going; their figures will grow.`
}

export const PARTIAL_COST_TITLE = 'A lower bound. Runs with no known price are left out of the sum.'
export const MODEL_COST_TITLE = 'Cost of this model only, not of the whole runs.'

/** One earlier span's data for the deltas. */
export interface PreviousSpan {
  data: UsageData
  truncated: boolean
}

function costExact(c: CostInput): c is CostInput & { costUsd: number } {
  return c.costUsd !== null && !c.costPartial && c.costSource !== 'unknown' && c.costSource !== 'none'
}

/**
 * The five summary figures (4.3) with their deltas against the previous equal span. A delta is null (the line is
 * omitted) whenever either side is a lower bound, unknown, truncated where it needs rows, or zero.
 */
export function summaryModel(data: UsageData, prev: PreviousSpan | null, o: { truncated: boolean; words: string; model: string | null }): SummaryItemModel[] {
  const t = data.totals
  const model = data.modelCost
  const lowerBound = data.lowerBound
  const cost: CostInput = lowerBound && t.cost.costUsd !== null ? { ...t.cost, costPartial: true } : t.cost
  const view = costView(cost, { precision: 'page' })
  const p = prev && !prev.data.lowerBound ? prev.data : null

  // Cost per run: the median of the rows' known costs.
  const { known, unknown } = runCosts(data.rows, o.model)
  const med = median(known)
  const mean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null
  const rowsAreAll = !o.truncated || data.folded
  let perRunTitle = mean !== null ? `Mean ${costView({ costUsd: mean, costSource: 'computed', sourceMixed: true }, { precision: 'page' }).text}.` : ''
  if (unknown > 0) perRunTitle += ` ${runsPhrase(unknown)} with no price ${unknown === 1 ? 'is' : 'are'} left out.`
  if (o.truncated) perRunTitle += ` Median of the newest ${TRUNCATED_LIMIT_LABEL} runs.`
  const prevRows = p && !prev?.truncated ? runCosts(p.rows, o.model) : null
  const prevMed = prevRows ? median(prevRows.known) : null

  const cur = cacheHit(t.tokens)
  const prevCache = p ? cacheHit(p.totals.tokens) : null

  return [
    {
      signal: 'cost',
      label: model ? 'Model cost' : 'Estimated cost',
      cost,
      atLeast: lowerBound && t.cost.costUsd !== null,
      ...(view.kind === 'unknown' ? { noPriceText: 'No price' } : {}),
      ...(model ? { title: MODEL_COST_TITLE } : {}),
      delta: p && costExact(cost) && costExact(p.totals.cost) && !lowerBound ? percentDelta(cost.costUsd, p.totals.cost.costUsd, o.words) : null
    },
    {
      signal: 'runs',
      label: 'Runs',
      text: String(t.runs),
      ...(lowerBound ? { atLeast: true } : {}),
      delta: p && !lowerBound ? percentDelta(t.runs, p.totals.runs, o.words) : null
    },
    {
      signal: 'cost-per-run',
      label: model ? 'Model cost per run' : 'Cost per run',
      ...(med !== null ? { cost: { costUsd: med, costSource: 'computed' as const, sourceMixed: true } } : { noPriceText: t.runs > 0 ? 'No price' : '—' }),
      ...(perRunTitle ? { title: perRunTitle.trim() } : {}),
      delta: rowsAreAll && med !== null && prevMed !== null ? percentDelta(med, prevMed, o.words) : null
    },
    {
      signal: 'cache',
      label: 'Cache hit',
      text: cur === null ? 'Not reported' : percentText(cur),
      delta: cur !== null && prevCache !== null ? pointsDelta(cur, prevCache, o.words) : null
    },
    {
      signal: 'wall',
      label: 'Wall time',
      text: formatDuration(t.wallMs),
      delta: p && !lowerBound && t.wallMs > 0 ? percentDelta(t.wallMs, p.totals.wallMs, o.words) : null
    }
  ]
}

// ---------- notes ----------

export interface DataNotes {
  truncated: { text: string; offerThirtyDays: boolean } | null
  partial: string | null
  unpriced: string | null
  legacy: string | null
}

export function dateWithYearIfOld(ms: number, now: number): string {
  const d = new Date(ms)
  const base: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  return d.toLocaleDateString('en-GB', d.getFullYear() === new Date(now).getFullYear() ? base : { ...base, year: 'numeric' })
}

/**
 * Notes under the summary and in the footer (11). The truncation sentence follows the contract: the rollups cover every
 * matched run, only the runs list holds the newest 2,000, so figures are a lower bound only where they were folded from
 * the listed rows (a narrowing the server cannot apply).
 */
export function dataNotes(a: { data: UsageData; truncated: boolean; oldestIncludedAt?: number; matchedRuns: number; spanDays: number; now: number }): DataNotes {
  const { data } = a
  const t = data.totals
  let truncated: DataNotes['truncated'] = null
  if (a.truncated) {
    const cut = a.oldestIncludedAt !== undefined ? ` Runs before ${dateWithYearIfOld(a.oldestIncludedAt, a.now)} are not listed.` : ''
    const figures = data.folded
      ? ' Because of the filters you chose, the figures below count only the listed runs, so they are at least these amounts.'
      : ' Totals, spend and the project, model and role lists still count every run; Efficiency and the run tables use the listed ones.'
    truncated = {
      text: `The lists show the newest ${TRUNCATED_LIMIT_LABEL} of ${a.matchedRuns.toLocaleString('en-GB')} runs.${cut}${figures} Narrow the period to see them all.`,
      offerThirtyDays: a.spanDays > 30
    }
  }
  const allUnknown = t.cost.costUsd === null && t.cost.costSource === 'unknown' && t.runs > 0
  let unpriced: string | null = null
  if (allUnknown) {
    const n = data.models.filter((m) => m.costUsd === null).length
    unpriced = n > 0 ? `No price is known for ${n} ${n === 1 ? 'model' : 'models'}, so cost cannot be shown. Tokens are counted.` : 'No prices are known for these runs, so cost cannot be shown. Tokens are counted.'
  }
  const partial = !allUnknown && t.costUnknownRuns > 0 ? `${t.costUnknownRuns} ${t.costUnknownRuns === 1 ? 'run has' : 'runs have'} no known price, so costs are at least these figures.` : null
  const legacy =
    t.legacyRuns > 0 ? `${t.legacyRuns} ${t.legacyRuns === 1 ? 'run is' : 'runs are'} from before OrgAI measured usage. Their tokens and cost are rough, and they have no efficiency figures.` : null
  return { truncated, partial, unpriced, legacy }
}

// ---------- empty states ----------

export interface EmptyModel {
  title: string
  description: string
  /** Clear all filters is useful (some narrowing besides the period is set). */
  canClear: boolean
  /** The period is not 30 days: offer "Use 30 days". */
  canUseThirtyDays: boolean
}

function periodWords(p: UsagePeriod): string {
  if (p.kind === 'days') return `the last ${p.days} days`
  if (p.kind === 'this-month') return 'this month'
  if (p.kind === 'last-month') return 'last month'
  return 'that period'
}

/** "No runs match these filters" with the strongest cause (11): chips first, then projects or kinds, then the period. */
export function emptyModel(f: UsageFilters, chips: readonly UsageChip[], lastRunAt: number | null, now: number): EmptyModel {
  const narrowing = chips.filter((c) => c.kind !== 'period' && c.kind !== 'project' && c.kind !== 'kind')
  const barNarrowed = f.projectIds.length > 0 || (f.kinds.length > 0 && f.kinds.length < USAGE_KINDS.length)
  const canClear = narrowing.length > 0 || barNarrowed
  const canUseThirtyDays = !(f.period.kind === 'days' && f.period.days === 30)
  let description: string
  if (narrowing.length > 0) description = `No runs in ${periodWords(f.period)} match ${narrowing.map((c) => c.text).join(', ')}.`
  else if (barNarrowed) description = `No runs in ${periodWords(f.period)} for the projects or kinds you chose.`
  else description = `No runs in ${periodWords(f.period)}.`
  if (lastRunAt !== null) description += ` The most recent run was on ${dateWithYearIfOld(lastRunAt, now)}.`
  return { title: 'No runs match these filters', description, canClear, canUseThirtyDays }
}

// ---------- announcements ----------

/** "estimated $42.10" / "cost unknown"; empty when nothing was spent. */
export function costPhrase(cost: CostInput): string {
  const v = costView(cost, { precision: 'page' })
  if (v.kind === 'unknown') return 'cost unknown'
  if (v.kind === 'none') return ''
  return `estimated ${v.text}`
}

export function figuresSentence(runs: number, cost: CostInput): string {
  const c = costPhrase(cost)
  return c ? `${runsPhrase(runs)}, ${c}.` : `${runsPhrase(runs)}.`
}

export const loadedAnnouncement = (runs: number, cost: CostInput): string => `Usage loaded. ${figuresSentence(runs, cost)}`
export const loadFailedAnnouncement = 'Could not load usage.'

export function filterAnnouncement(kind: 'added' | 'removed' | 'cleared', chipText: string | null, runs: number, cost: CostInput): string {
  const lead = kind === 'cleared' ? 'Filters cleared.' : `Filter ${kind}: ${chipText ?? 'filter'}.`
  return `${lead} ${figuresSentence(runs, cost)}`
}

// ---------- live policy (10) ----------

export interface RunStatusFact {
  id: string
  status: RunStatus
  startedAt: number
  endedAt?: number
}

const LIVE_STATUSES: readonly RunStatus[] = ['starting', 'running', 'idle', 'stopping']

/** A live run that started this close before the overview was generated may have missed it. */
const NEW_RUN_SLACK_MS = 2000

/** Ended or paused: the statuses that make the page refetch. */
export const settledStatus = (s: RunStatus): boolean => !LIVE_STATUSES.includes(s)

/**
 * Runs that ended or paused since the overview was built: a live row whose store status is no longer live, or a run
 * the overview never listed that started in the span and ended after it was generated. Also a live run the overview
 * never listed that started after it was generated (a run begun with the page open), so the "still going" note shows
 * at once instead of after the run ends. Empty after the next fetch.
 */
export function staleRunIds(rows: readonly Pick<UsageOverviewRow, 'runId' | 'live'>[], facts: readonly RunStatusFact[], generatedAt: number, since: number): string[] {
  const byId = new Map(rows.map((r) => [r.runId, r]))
  const out: string[] = []
  for (const f of facts) {
    if (!settledStatus(f.status)) {
      if (!byId.has(f.id) && f.startedAt >= since && f.startedAt >= generatedAt - NEW_RUN_SLACK_MS) out.push(f.id)
      continue
    }
    const row = byId.get(f.id)
    if (row) {
      if (row.live) out.push(f.id)
    } else if (f.startedAt >= since && (f.endedAt ?? 0) > generatedAt) out.push(f.id)
  }
  return out
}

export const anyLiveRow = (rows: readonly Pick<UsageOverviewRow, 'live'>[]): boolean => rows.some((r) => r.live)

/** The 30 s refetch runs only while a row is live, the window is focused and visible (and the page is mounted). */
export function livePollDue(i: { anyLive: boolean; focused: boolean; visible: boolean }): boolean {
  return i.anyLive && i.focused && i.visible
}

export const LIVE_ENDED_THROTTLE_MS = 5000
export const LIVE_POLL_MS = 30_000
export const LIVE_ENDED_MIN_DELAY_MS = 500
export const FILTER_DEBOUNCE_MS = 150
export const ANNOUNCE_GAP_MS = 2000

/** Delay before the trailing refetch after a run settled: at most one per 5 s, but never sooner than 500 ms. */
export function endedRefetchDelay(lastFetchAt: number, now: number): number {
  return Math.max(LIVE_ENDED_MIN_DELAY_MS, lastFetchAt + LIVE_ENDED_THROTTLE_MS - now)
}

// ---------- project options for the filter bar (3.3) ----------

export interface ProjectOption {
  id: string
  name: string
  kind: UsageProjectKind
  removed: boolean
  runs: number
  cost: CostInput | null
}

export interface ProjectOptionGroup {
  key: string
  label: string
  options: ProjectOption[]
}

type StoredProject = { id: string; name: string; kind?: ProjectKind; client?: string }

function costOfRollup(r: UsageProjectRollup | undefined): CostInput | null {
  if (!r) return null
  return { costUsd: r.costUsd, costSource: r.costSource, ...(r.costPartial ? { costPartial: true } : {}), sourceMixed: true }
}

function byUse(a: ProjectOption, b: ProjectOption): number {
  if ((a.runs > 0) !== (b.runs > 0)) return a.runs > 0 ? -1 : 1
  const ca = a.cost?.costUsd ?? -1
  const cb = b.cost?.costUsd ?? -1
  return cb - ca || a.name.localeCompare(b.name)
}

/**
 * The popover's groups: Code projects, Engagements (one group per client when there are two or more), Assistants,
 * Removed projects. `stats` are the period's per-project rollups (every selectable project, even while narrowed).
 * Projects with no runs sort last and read dimmed.
 */
export function projectOptionGroups(stored: readonly StoredProject[], stats: ReadonlyMap<string, UsageProjectRollup>): ProjectOptionGroup[] {
  const real = stored.filter((p) => !isVirtualProjectId(p.id))
  const known = new Set<string>([...real.map((p) => p.id), ...ASSISTANT_ORDER])
  const opt = (id: string, name: string, kind: UsageProjectKind, removed = false): ProjectOption => {
    const r = stats.get(id)
    return { id, name, kind, removed, runs: r?.runs ?? 0, cost: costOfRollup(r) }
  }
  const code = real.filter((p) => projectKindOf(p) !== 'engagement').map((p) => opt(p.id, p.name, 'code'))
  const eng = real.filter((p) => projectKindOf(p) === 'engagement')
  const groups: ProjectOptionGroup[] = []
  if (code.length > 0) groups.push({ key: 'code', label: 'Code projects', options: code.sort(byUse) })
  if (eng.length > 0) {
    const g = groupByClient(eng.map((p) => ({ ...p, kind: 'engagement' as const })))
    const clients = g.groups.filter((x) => x.type === 'client')
    if (clients.length >= 2) {
      for (const cg of g.groups) {
        groups.push({
          key: `eng:${cg.key}`,
          label: cg.type === 'client' ? `Engagements: ${cg.label}` : 'Engagements: no client',
          options: cg.items.map((p) => opt(p.id, p.name, 'engagement')).sort(byUse)
        })
      }
    } else groups.push({ key: 'eng', label: 'Engagements', options: eng.map((p) => opt(p.id, p.name, 'engagement')).sort(byUse) })
  }
  groups.push({ key: 'assistants', label: 'Assistants', options: ASSISTANT_ORDER.map((id) => opt(id, VIRTUAL_PROJECT_LABELS[id], 'assistant')).sort(byUse) })
  const removed = [...stats.values()].filter((r) => !known.has(r.projectId)).map((r) => opt(r.projectId, r.projectName, 'code', true))
  if (removed.length > 0) groups.push({ key: 'removed', label: 'Removed projects', options: removed.sort(byUse) })
  return groups
}

/** The button text of the Projects popover. */
export function projectsButtonText(f: Pick<UsageFilters, 'projectIds'>, name: (id: string) => string): string {
  if (f.projectIds.length === 0) return 'All projects'
  return f.projectIds.length === 1 ? name(f.projectIds[0]!) : `${f.projectIds.length} projects`
}

export function kindsButtonText(f: Pick<UsageFilters, 'kinds'>): string {
  if (f.kinds.length === 0 || f.kinds.length >= USAGE_KINDS.length) return 'All kinds'
  return f.kinds.length === 1 ? USAGE_KIND_LABELS[f.kinds[0]!] : `${f.kinds.length} kinds`
}

/** Toggle one id of a "no ids = all" selection against the full list; selecting every id collapses back to []. */
export function toggleSelection<T extends string>(current: readonly T[], all: readonly T[], id: T, on: boolean): T[] {
  const set = new Set(current.length === 0 ? all : current)
  if (on) set.add(id)
  else set.delete(id)
  if (set.size === 0) return current.length === 0 ? [] : [...current]
  return set.size >= all.length ? [] : all.filter((x) => set.has(x))
}

/** Projects of the popover matching a search (name, case-insensitive). */
export function filterOptions(options: readonly ProjectOption[], query: string): ProjectOption[] {
  const q = query.trim().toLowerCase()
  return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : [...options]
}

/** Whether the Connection select shows (more than one connection has runs, or one is already chosen). */
export function showConnectionSelect(connections: readonly { connection: string | null }[], chosen: string | null): boolean {
  return connections.filter((c) => c.connection !== null).length > 1 || !!chosen
}

export const SEARCH_FROM_PROJECTS = 8
export const COMPACT_FILTERS_PX = 880
