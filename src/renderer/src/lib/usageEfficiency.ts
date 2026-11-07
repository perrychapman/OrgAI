/**
 * Efficiency instruments, "Runs worth a look" and the efficiency-by-project table of the Usage page
 * (docs/design/usage-app.md 6.5 and 6.6). Pure: rows in, plain strings and numbers out. Unknown cost is null and never
 * counted as $0; figures that need usage tracking use only rows that are not legacy.
 */
import type { TokenUsage, UsageOverviewRow } from '@shared/types'
import type { EfficiencySignal, WastefulSort } from '../components/usage/panelProps'
import { costView, formatTokens, type CostInput } from './cost'
import { totalTokens } from './trends'
import { usageKindOf } from './usageOverview'

// ---------- shared helpers ----------

export const CACHE_MIN_INPUT_TOKENS = 20_000
export const WASTEFUL_SHOWN = 10
export const WASTEFUL_MORE = 25
/** Runs of each kind the Team vs Ask comparison needs. */
export const TEAM_ASK_MIN_RUNS = 3

export const isLegacyRow = (r: Pick<UsageOverviewRow, 'legacy' | 'usage'>): boolean => !!(r.legacy || r.usage.legacy)

/** Known cost of a row: priced, complete, and something was spent. Partial and unknown are left out. */
function knownCost(r: UsageOverviewRow): number | null {
  const u = r.usage
  if (u.costUsd === null || u.costPartial || u.costSource === 'unknown') return null
  return totalTokens(u.tokens) > 0 ? u.costUsd : null
}

const cacheReportedBy = (t: TokenUsage): boolean => t.cacheRead + t.cacheWrite > 0
const promptTokens = (t: TokenUsage): number => t.input + t.cacheRead + t.cacheWrite

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)

/** A page-precision cost string (the same words as <Cost precision="page" />). */
export function pageCost(usd: number | null, partial = false): string {
  if (usd === null) return 'unknown'
  return costView({ costUsd: usd, costSource: 'computed', sourceMixed: true, ...(partial ? { costPartial: true as const } : {}) } as CostInput, { precision: 'page' }).text
}

/** 0-1 as "41%"; a real but tiny share reads "<1%", never 0%. */
export function percentText(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  const p = fraction * 100
  if (p > 0 && p < 1) return '<1%'
  return `${Math.round(p)}%`
}

/** "45 s", "12 min", "1 h 20 min". */
export function minutesText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

// ---------- instruments (6.5) ----------

export type EfficiencyDraw =
  | { kind: 'rail'; fraction: number | null }
  | { kind: 'range'; min: number; max: number; median: number; mean: number }
  | { kind: 'spark'; values: number[] }
  | { kind: 'segments'; waiting: number; idle: number; limit: number }
  | { kind: 'dots'; team: number | null; ask: number | null }
  | { kind: 'none' }

export interface EfficiencyItem {
  signal: EfficiencySignal
  name: string
  /** The headline ("41%", "$0.43", "Not reported"). */
  value: string
  /** One line under the value. */
  detail: string
  /** "Based on 190 of 212 runs." */
  basis: string
  /** Definition for the info popover (12.2). */
  definition: string
  /** The "Runs worth a look" sort the value button sets. */
  sort: WastefulSort
  draw: EfficiencyDraw
}

export const EFFICIENCY_ORDER: readonly EfficiencySignal[] = ['cache', 'cost-per-run', 'tokens-per-turn', 'retries', 'no-result', 'nudges', 'idle', 'team-vs-ask']

export const EFFICIENCY_NAMES: Record<EfficiencySignal, string> = {
  cache: 'Cache hit',
  'cost-per-run': 'Cost per run',
  'tokens-per-turn': 'Tokens per turn',
  retries: 'Retries',
  'no-result': 'No result',
  nudges: 'Nudges',
  idle: 'Waiting and idle',
  'team-vs-ask': 'Team vs Ask'
}

export const EFFICIENCY_DEFINITIONS: Record<EfficiencySignal, string> = {
  cache: 'The share of input tokens the provider read from its prompt cache instead of processing again. Higher is cheaper. "Not reported" means the connection does not say.',
  'cost-per-run': 'The median estimated cost of a run in this view. The mean is in the tooltip.',
  'tokens-per-turn': 'Tokens used divided by the number of turns agents took.',
  retries: 'Times a failed request was sent again. Counted per 100 turns.',
  'no-result': 'Tokens spent by agents that finished without giving a report back. The root agent is never counted here.',
  nudges: 'Times OrgAI asked an agent to keep going after it stopped before the work was done.',
  idle: 'Waiting on you: time a run was paused on a decision or answer. Idle: time a run was open with nothing running and nothing waiting on you. Limit hold: time a run was paused because the plan or account limit was reached. Shares are of wall time, the clock time a run was open.',
  'team-vs-ask': 'Team runs use the whole org chart; Ask runs use one assistant. Costs are compared per run.'
}

/** What each signal's value button sorts "Runs worth a look" by. */
export const SIGNAL_SORT: Record<EfficiencySignal, WastefulSort> = {
  cache: 'cache',
  'cost-per-run': 'cost',
  'tokens-per-turn': 'cost',
  retries: 'retries',
  'no-result': 'no-result',
  nudges: 'nudges',
  idle: 'idle',
  'team-vs-ask': 'cost'
}

export const WASTEFUL_SORT_LABELS: Record<WastefulSort, string> = {
  'no-result': 'Cost with no result',
  cost: 'Most expensive',
  cache: 'Lowest cache hit',
  retries: 'Most retries',
  nudges: 'Most nudges',
  idle: 'Most idle time'
}

/** "Sorted by lowest cache hit." for an instrument pick. */
export const sortedByText = (sort: WastefulSort): string => `Sorted by ${WASTEFUL_SORT_LABELS[sort].toLowerCase()}.`

interface Tally {
  runs: number
  tokens: number
  input: number
  cacheRead: number
  cacheWrite: number
  cacheReportedRuns: number
  turns: number
  turnTokens: number
  retries: number
  retryRuns: number
  retryTurns: number
  noResultTokens: number
  noResultAgents: number
  noResultRuns: number
  nudges: number
  wallMs: number
  waitingMs: number
  idleMs: number
  limitMs: number
  costs: number[]
  unpriced: number
}

function tally(rows: readonly UsageOverviewRow[]): Tally {
  const t: Tally = {
    runs: 0, tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheReportedRuns: 0, turns: 0, turnTokens: 0, retries: 0, retryRuns: 0, retryTurns: 0,
    noResultTokens: 0, noResultAgents: 0, noResultRuns: 0, nudges: 0, wallMs: 0, waitingMs: 0, idleMs: 0, limitMs: 0, costs: [], unpriced: 0
  }
  for (const r of rows) {
    const u = r.usage
    t.runs++
    const tokens = totalTokens(u.tokens)
    t.tokens += tokens
    if (cacheReportedBy(u.tokens)) {
      t.cacheReportedRuns++
      t.input += u.tokens.input
      t.cacheRead += u.tokens.cacheRead
      t.cacheWrite += u.tokens.cacheWrite
    }
    if (u.turns > 0) {
      t.turns += u.turns
      t.turnTokens += tokens
      t.retryTurns += u.turns
      t.retries += u.retries
      if (u.retries > 0) t.retryRuns++
    }
    t.noResultTokens += u.noResultTokens
    t.noResultAgents += u.agentsWithoutResult
    if (u.agentsWithoutResult > 0) t.noResultRuns++
    t.nudges += u.nudges
    if (u.wallMs > 0) {
      t.wallMs += u.wallMs
      t.waitingMs += u.waitingMs
      t.idleMs += u.idleMs
      t.limitMs += u.limitHoldMs
    }
    const c = knownCost(r)
    if (c !== null) t.costs.push(c)
    else if (tokens > 0) t.unpriced++
  }
  return t
}

const cacheRate = (t: Tally): number | null => {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return t.cacheReportedRuns > 0 && prompt > 0 ? t.cacheRead / prompt : null
}

function connectionOfAll(rows: readonly UsageOverviewRow[]): string | null {
  const ids = new Set(rows.map((r) => r.connection ?? ''))
  return ids.size === 1 ? ([...ids][0] || null) : null
}

export interface EfficiencyOptions {
  connectionName: (id: string) => string
  /** Trend points (oldest first) for the tokens-per-turn sparkline. */
  trend?: readonly { tokens: TokenUsage; turns: number }[]
}

/**
 * The instruments for the rows. Tokens per turn is left out when no row reports turns. Every figure counts only rows
 * recorded since usage tracking (not legacy); `basis` says how many.
 */
export function efficiencyItems(rows: readonly UsageOverviewRow[], opts: EfficiencyOptions): EfficiencyItem[] {
  const tracked = rows.filter((r) => !isLegacyRow(r))
  const t = tally(tracked)
  const basis = `Based on ${tracked.length.toLocaleString()} of ${rows.length.toLocaleString()} runs.`
  const items: EfficiencyItem[] = []
  const make = (signal: EfficiencySignal, value: string, detail: string, draw: EfficiencyDraw): void => {
    items.push({ signal, name: EFFICIENCY_NAMES[signal], value, detail, basis, definition: EFFICIENCY_DEFINITIONS[signal], sort: SIGNAL_SORT[signal], draw })
  }

  // Cache hit: never 0% when nothing reported cache tokens.
  const rate = cacheRate(t)
  if (rate === null) {
    const only = connectionOfAll(tracked)
    make('cache', 'Not reported', only ? `Not reported by ${opts.connectionName(only)}.` : 'No run in this view reports cache tokens.', { kind: 'rail', fraction: null })
  } else {
    const skipped = t.runs - t.cacheReportedRuns
    make('cache', percentText(rate), `${plural(t.cacheRead + t.cacheWrite > 0 ? t.cacheReportedRuns : 0, 'run')} report cache tokens${skipped > 0 ? `; ${skipped} do not` : ''}.`, { kind: 'rail', fraction: rate })
  }

  // Cost per run.
  const med = median(t.costs)
  const avg = mean(t.costs)
  if (med === null || avg === null) {
    make('cost-per-run', 'No price', t.unpriced > 0 ? `${plural(t.unpriced, 'run has', 'runs have')} no price.` : 'No priced runs in this view.', { kind: 'none' })
  } else {
    const detail = `Mean ${pageCost(avg)}${t.unpriced > 0 ? `. ${plural(t.unpriced, 'run has', 'runs have')} no price.` : ''}`
    make('cost-per-run', pageCost(med), detail, { kind: 'range', min: Math.min(...t.costs), max: Math.max(...t.costs), median: med, mean: avg })
  }

  // Tokens per turn (hidden without turns).
  if (t.turns > 0) {
    const values: number[] = []
    for (const p of (opts.trend ?? []).slice(-14)) if (p.turns > 0) values.push(Math.round(totalTokens(p.tokens) / p.turns))
    make('tokens-per-turn', formatTokens(Math.round(t.turnTokens / t.turns)), `${plural(t.turns, 'turn')} in total.`, { kind: 'spark', values })
  }

  // Retries per 100 turns.
  if (t.retryTurns > 0) {
    const per100 = (t.retries / t.retryTurns) * 100
    const value = per100 === 0 ? '0' : per100 < 0.1 ? '<0.1' : per100 < 10 ? per100.toFixed(1) : String(Math.round(per100))
    make('retries', `${value} per 100 turns`, t.retries === 0 ? 'No retries.' : `${plural(t.retries, 'retry', 'retries')} across ${plural(t.retryRuns, 'run')}.`, { kind: 'rail', fraction: Math.min(1, per100 / 100) })
  } else {
    make('retries', 'Not reported', 'No run in this view reports turns.', { kind: 'rail', fraction: null })
  }

  // No result: share of tokens.
  if (t.tokens > 0) {
    const share = t.noResultTokens / t.tokens
    make('no-result', percentText(share), t.noResultAgents === 0 ? 'No agent finished without a result.' : `${plural(t.noResultAgents, 'agent')} returned nothing in ${plural(t.noResultRuns, 'run')}.`, { kind: 'rail', fraction: share })
  } else {
    make('no-result', '—', 'No tokens counted yet.', { kind: 'rail', fraction: null })
  }

  // Nudges per run.
  if (t.runs > 0) {
    const per = t.nudges / t.runs
    make('nudges', per === 0 ? '0 per run' : `${per < 10 ? per.toFixed(1) : Math.round(per)} per run`, `${plural(t.nudges, 'nudge')} across ${plural(t.runs, 'run')}.`, { kind: 'none' })
  } else {
    make('nudges', '—', 'No runs yet.', { kind: 'none' })
  }

  // Waiting and idle.
  if (t.wallMs > 0) {
    const w = t.waitingMs / t.wallMs
    const i = t.idleMs / t.wallMs
    const l = t.limitMs / t.wallMs
    make('idle', percentText(w), `Waiting on you ${percentText(w)}, idle ${percentText(i)}, limit hold ${percentText(l)}.`, { kind: 'segments', waiting: w, idle: i, limit: l })
  } else {
    make('idle', '—', 'No run time counted yet.', { kind: 'segments', waiting: 0, idle: 0, limit: 0 })
  }

  // Team vs Ask: cost per run of each, with at least three of each.
  const team: number[] = []
  const ask: number[] = []
  for (const r of tracked) {
    const k = usageKindOf(r)
    const c = knownCost(r)
    if (c === null) continue
    if (k === 'work') team.push(c)
    else if (k === 'ask') ask.push(c)
  }
  if (team.length >= TEAM_ASK_MIN_RUNS && ask.length >= TEAM_ASK_MIN_RUNS) {
    const tm = median(team)!
    const am = median(ask)!
    make('team-vs-ask', `Team ${pageCost(tm)}, Ask ${pageCost(am)}`, `Median per run, ${plural(team.length, 'Team run')} and ${plural(ask.length, 'Ask run')}.`, { kind: 'dots', team: tm, ask: am })
  } else {
    const lacking = ask.length < TEAM_ASK_MIN_RUNS ? 'Ask' : 'Team'
    make('team-vs-ask', `Not enough ${lacking} runs to compare`, `${plural(team.length, 'priced Team run')} and ${plural(ask.length, 'priced Ask run')}; ${TEAM_ASK_MIN_RUNS} of each are needed.`, { kind: 'dots', team: null, ask: null })
  }
  return items
}

/** The sentence under the panel title: the weakest signal, compared only when a comparison exists. */
export function efficiencySummary(rows: readonly UsageOverviewRow[], opts: { connectionName: (id: string) => string }): string {
  const tracked = rows.filter((r) => !isLegacyRow(r))
  if (tracked.length === 0) return rows.length === 0 ? 'No runs in this view.' : 'These runs are from before OrgAI measured usage, so there are no efficiency figures.'
  const t = tally(tracked)
  const rate = cacheRate(t)

  // Cache hit in the weakest project against the others.
  if (rate !== null && t.input + t.cacheRead + t.cacheWrite >= CACHE_MIN_INPUT_TOKENS) {
    const byProject = new Map<string, UsageOverviewRow[]>()
    for (const r of tracked) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
    if (byProject.size >= 2) {
      let worst: { name: string; rate: number; others: number | null } | null = null
      for (const [id, list] of byProject) {
        if (list.length < 3) continue
        const pr = cacheRate(tally(list))
        if (pr === null) continue
        const orate = cacheRate(tally(tracked.filter((r) => r.projectId !== id)))
        if (!worst || pr < worst.rate) worst = { name: list[0]!.projectName, rate: pr, others: orate }
      }
      if (worst && worst.others !== null && worst.rate < worst.others - 0.1) {
        return `Cache hit in ${worst.name} is ${percentText(worst.rate)}, lower than the ${percentText(worst.others)} your other projects reach.`
      }
    }
    if (rate < 0.6) return `Cache hit is ${percentText(rate)}.`
  }
  if (t.tokens > 0 && t.noResultTokens / t.tokens >= 0.05) return `${percentText(t.noResultTokens / t.tokens)} of tokens went to agents that returned nothing.`
  if (t.retryTurns > 0 && (t.retries / t.retryTurns) * 100 >= 5) return `${plural(t.retries, 'request')} had to be retried, ${((t.retries / t.retryTurns) * 100).toFixed(0)} per 100 turns.`
  if (t.wallMs > 0 && t.idleMs / t.wallMs >= 0.3) return `Runs sat idle for ${percentText(t.idleMs / t.wallMs)} of their time.`
  const med = median(t.costs)
  if (rate !== null) return `Cache hit is ${percentText(rate)}.`
  if (med !== null) return `The median run costs ${pageCost(med)}.`
  return `${plural(tracked.length, 'run')} measured.`
}

// ---------- efficiency by project (table alternative) ----------

export type EfficiencyColumn = 'project' | 'runs' | 'cost' | 'cache' | 'tokens-per-turn' | 'retries' | 'no-result' | 'idle'

export interface EfficiencyProjectRow {
  projectId: string
  project: string
  removed: boolean
  runs: number
  cells: Record<Exclude<EfficiencyColumn, 'project'>, string>
  /** Sort keys; null sorts last in both directions. */
  keys: Record<EfficiencyColumn, number | string | null>
}

export function efficiencyByProject(rows: readonly UsageOverviewRow[], opts: { connectionName: (id: string) => string }): EfficiencyProjectRow[] {
  const groups = new Map<string, UsageOverviewRow[]>()
  for (const r of rows) groups.set(r.projectId, [...(groups.get(r.projectId) ?? []), r])
  const out: EfficiencyProjectRow[] = []
  for (const [projectId, list] of groups) {
    const tracked = list.filter((r) => !isLegacyRow(r))
    const t = tally(tracked)
    const first = list[0]!
    const med = median(t.costs)
    const rate = cacheRate(t)
    const tpt = t.turns > 0 ? Math.round(t.turnTokens / t.turns) : null
    const per100 = t.retryTurns > 0 ? (t.retries / t.retryTurns) * 100 : null
    const nr = t.tokens > 0 ? t.noResultTokens / t.tokens : null
    const idle = t.wallMs > 0 ? t.idleMs / t.wallMs : null
    const none = tracked.length === 0
    out.push({
      projectId,
      project: first.projectName,
      removed: !!first.projectRemoved,
      runs: list.length,
      cells: {
        runs: String(list.length),
        cost: none ? '—' : med === null ? 'No price' : pageCost(med),
        cache: none ? '—' : rate === null ? 'Not reported' : percentText(rate),
        'tokens-per-turn': tpt === null ? '—' : formatTokens(tpt),
        retries: per100 === null ? '—' : per100 === 0 ? '0' : per100 < 10 ? per100.toFixed(1) : String(Math.round(per100)),
        'no-result': nr === null ? '—' : percentText(nr),
        idle: idle === null ? '—' : percentText(idle)
      },
      keys: { project: first.projectName.toLowerCase(), runs: list.length, cost: med, cache: rate, 'tokens-per-turn': tpt, retries: per100, 'no-result': nr, idle }
    })
  }
  return sortEfficiencyRows(out, 'runs', 'desc')
}

export type SortDir = 'asc' | 'desc'

export function sortEfficiencyRows(rows: readonly EfficiencyProjectRow[], column: EfficiencyColumn, dir: SortDir): EfficiencyProjectRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a.keys[column]
    const y = b.keys[column]
    if (x === null && y === null) return a.project.localeCompare(b.project)
    if (x === null) return 1
    if (y === null) return -1
    const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y
    return c * sign || a.project.localeCompare(b.project)
  })
}

// ---------- runs worth a look (6.6) ----------

/** The sort in force: "cost with no result" needs noResultCostUsd on some row, else Most expensive (6.6). */
export function effectiveWastefulSort(sort: WastefulSort, rows: readonly UsageOverviewRow[]): WastefulSort {
  if (sort !== 'no-result') return sort
  return rows.some((r) => r.usage.noResultCostUsd !== undefined) ? sort : 'cost'
}

export interface WastefulEntry {
  row: UsageOverviewRow
  /** The run's cost is not known (it sorts after the known ones, by tokens). */
  unknownCost: boolean
  /** The run has agents that returned nothing. */
  noResult: boolean
  /** The plain sentence for the active sort. */
  why: string
}

const WHY_NAMES_MAX = 1

/** "implementer-2 spent 820 tokens and produced no result" / "implementer-2 and 1 other spent 1,640 tokens ...". */
export function noResultSentence(row: Pick<UsageOverviewRow, 'usage'>): string {
  const u = row.usage
  const n = u.agentsWithoutResult
  const tokens = `${u.noResultTokens.toLocaleString()} ${u.noResultTokens === 1 ? 'token' : 'tokens'}`
  const names = (u.noResultAgents ?? []).map((a) => a.name)
  if (n <= 0) return 'No agent finished without a result.'
  if (names.length === 0) return `${plural(n, 'agent')} produced no result and spent ${tokens}.`
  const first = names.slice(0, WHY_NAMES_MAX).join(', ')
  const others = n - Math.min(names.length, WHY_NAMES_MAX)
  const who = others > 0 ? `${first} and ${others} other${others === 1 ? '' : 's'}` : first
  return `${who} spent ${tokens} and produced no result`
}

interface Scored {
  row: UsageOverviewRow
  /** Higher sorts first. null = unknown cost (sorts after, by `tie`). */
  score: number | null
  tie: number
  unknownCost: boolean
  why: string
}

function noResultScore(r: UsageOverviewRow): Scored | null {
  const u = r.usage
  const failed = r.status === 'error'
  const noResult = u.agentsWithoutResult > 0
  if (!failed && !noResult) return null
  // A failed run counts its whole cost; its no-result agents are inside it, so they are not added again.
  let usd: number | null
  let tie: number
  if (failed) {
    usd = u.costUsd === null || u.costSource === 'unknown' ? null : u.costUsd
    tie = totalTokens(u.tokens)
  } else {
    usd = u.noResultCostUsd === undefined || u.noResultCostUsd === null ? null : u.noResultCostUsd
    tie = u.noResultTokens
  }
  if (usd !== null && usd <= 0 && tie <= 0) return null
  const why = noResult ? `${noResultSentence(r)}${failed ? '; the run failed' : ''}` : 'The run failed'
  return { row: r, score: usd, tie, unknownCost: usd === null, why }
}

/** Cells carry short phrases without a closing full stop ("Retried 2 times"). */
function phrase(s: string): string {
  return s.replace(/\.+$/, '')
}

/**
 * The runs worth a look, best first, for a sort. Rows with unknown cost sort after known ones by tokens. The sort must
 * already be effective (`effectiveWastefulSort`).
 */
export function wastefulRuns(rows: readonly UsageOverviewRow[], sort: WastefulSort): WastefulEntry[] {
  const scored: Scored[] = []
  for (const r of rows) {
    const u = r.usage
    let s: Scored | null = null
    const tokens = totalTokens(u.tokens)
    switch (sort) {
      case 'no-result':
        s = noResultScore(r)
        break
      case 'cost': {
        if (tokens <= 0) break
        const known = u.costUsd !== null && u.costSource !== 'unknown'
        s = { row: r, score: known ? u.costUsd : null, tie: tokens, unknownCost: !known, why: known ? `Estimated ${pageCost(u.costUsd, !!u.costPartial)}.` : `Cost unknown; ${tokens.toLocaleString()} tokens.` }
        break
      }
      case 'cache': {
        if (isLegacyRow(r) || promptTokens(u.tokens) < CACHE_MIN_INPUT_TOKENS || !cacheReportedBy(u.tokens)) break
        const rate = u.tokens.cacheRead / promptTokens(u.tokens)
        s = { row: r, score: 1 - rate, tie: promptTokens(u.tokens), unknownCost: false, why: `Cache hit ${percentText(rate)}.` }
        break
      }
      case 'retries':
        if (u.retries > 0) s = { row: r, score: u.retries, tie: u.turns, unknownCost: false, why: u.retries === 1 ? 'Retried once.' : `Retried ${u.retries} times.` }
        break
      case 'nudges':
        if (u.nudges > 0) s = { row: r, score: u.nudges, tie: u.turns, unknownCost: false, why: u.nudges === 1 ? 'Auto-continued once.' : `Auto-continued ${u.nudges} times.` }
        break
      case 'idle': {
        if (isLegacyRow(r) || u.wallMs <= 0 || u.idleMs <= 0) break
        const share = u.idleMs / u.wallMs
        const waited = u.waitingMs >= 60_000 ? `; waited on you ${minutesText(u.waitingMs)}` : ''
        s = { row: r, score: share, tie: u.idleMs, unknownCost: false, why: `Idle ${minutesText(u.idleMs)}, ${percentText(share)} of its time${waited}` }
        break
      }
    }
    if (s) scored.push(s)
  }
  scored.sort((a, b) => {
    if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score
    return b.tie - a.tie || b.row.startedAt - a.row.startedAt
  })
  return scored.map((s) => ({ row: s.row, unknownCost: s.unknownCost, noResult: s.row.usage.agentsWithoutResult > 0, why: phrase(s.why) }))
}

/**
 * The sentence above a run's agent table naming the agents that produced nothing: "implementer-2 produced no result",
 * "a and b produced no result", "a, b and 2 others produced no result". Null when none. Labels are handle-first.
 */
export function noResultAgentsLine(labels: readonly string[]): string | null {
  const n = labels.length
  if (n === 0) return null
  if (n === 1) return `${labels[0]} produced no result`
  if (n === 2) return `${labels[0]} and ${labels[1]} produced no result`
  if (n === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]} produced no result`
  return `${labels[0]}, ${labels[1]} and ${n - 2} others produced no result`
}
