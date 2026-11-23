import type { AgentInstance, PermissionMode, ProjectSpend, RunPlan, RunSummary, Schedule, TodoItem, UsageOverview } from '@shared/types'
import { formatDate } from '@shared/view/dates'
import { formatUsdCompact, runCostInput, costView, type CostInput } from '@shared/view/cost'
import { lastResultText } from '@shared/view/schedules'
import { bandAgentState, planProgress, planProgressText, runMarks, type BandAgentState, type PlanProgress } from './dashboardBand'

/**
 * Pure derivations for the Home tab of a stored project (docs/design/ui-overhaul/project/ProjectHome.dc.html and
 * EngagementHome.dc.html). Everything here is built from data the app really holds; a section whose data does not exist
 * gets `null` or an empty list so the view leaves it out. Nothing reads the DOM, the store or the clock (callers pass
 * `now`).
 */

/** Plain words for a permission mode, after "N roles · " (the board: "12 roles · asks before risky actions"). */
export const PERMISSION_WORDS: Readonly<Record<PermissionMode, string>> = {
  auto: 'works on its own and asks when unsure',
  acceptEdits: 'edits files freely, asks before commands',
  default: 'asks before risky actions',
  dontAsk: 'never asks, blocks what needs approval',
  plan: 'plans only, changes nothing',
  bypassPermissions: 'asks nothing (all prompts bypassed)'
}

export function permissionWords(mode: PermissionMode | undefined): string {
  return PERMISSION_WORDS[mode ?? 'default'] ?? PERMISSION_WORDS.default
}

/** "1 role" / "12 roles". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------- Quick starts ----------

/** Starting points on the "new run" box. They only fill the New run message box; nothing is sent. */
export const QUICK_STARTS: readonly string[] = ['Fix a failing test', 'Review my last change', 'Plan a new feature']

/** The New run draft after adding `text` to what is already there: nothing lost, nothing doubled. */
export function mergeDraftText(existing: string, text: string): string {
  const add = text.trim()
  if (!add) return existing
  const have = existing.trim()
  if (!have) return add
  if (have === add || have.endsWith(add)) return existing
  return `${existing.replace(/\s+$/, '')}\n${add}`
}

// ---------- Running now ----------

export interface RunningNowIn {
  summary: Pick<RunSummary, 'id' | 'status' | 'kind' | 'startedAt' | 'prompt' | 'title' | 'totalCostUsd' | 'usage'>
  agents: Record<string, AgentInstance>
  plan?: RunPlan
  /** Open decisions of the run (lib needsYou `waitingItems(...).length`). */
  decisions: number
}

export interface RunningNowMark {
  id: string
  state: BandAgentState
}

export interface RunningNow {
  runId: string
  startedAt: number
  marks: RunningNowMark[]
  /** Agents beyond the drawn marks. */
  more: number
  /** The marks' sentence, "7 agents: 5 working, 1 waiting on you, 1 done"; the text alternative of the strip. */
  summary: string
  working: number
  waiting: number
  agentCount: number
  plan: PlanProgress | null
  planText: string
  decisions: number
  cost: CostInput
}

/** Marks drawn in the strip before "+N" (the board draws 16). */
export const RUNNING_MARKS_MAX = 24

const WORKING_STATUS = new Set(['starting', 'running', 'stopping'])

/** A run counts as "running now" while it works, or while it waits on a decision of the person. */
export function isRunningNow(r: Pick<RunningNowIn, 'summary' | 'decisions'>): boolean {
  return (r.summary.kind ?? 'work') === 'work' && (WORKING_STATUS.has(r.summary.status) || (r.decisions > 0 && r.summary.status !== 'error'))
}

/** The newest live work run of the project, as a strip of agent marks. null when nothing runs. */
export function runningNow(runs: readonly RunningNowIn[]): RunningNow | null {
  const live = runs.filter(isRunningNow).sort((a, b) => b.summary.startedAt - a.summary.startedAt)
  const run = live[0]
  if (!run) return null
  const all = Object.values(run.agents)
  const m = runMarks(all, undefined, RUNNING_MARKS_MAX)
  const states = all.filter((a) => a.parentId !== null && a.id !== 'root').map((a) => bandAgentState(a.state))
  const plan = planProgress(run.plan)
  return {
    runId: run.summary.id,
    startedAt: run.summary.startedAt,
    marks: m.marks.map((x) => ({ id: x.id, state: x.state })),
    more: m.more,
    summary: m.summary,
    working: states.filter((s) => s === 'working').length,
    waiting: states.filter((s) => s === 'waiting').length,
    agentCount: states.length,
    plan,
    planText: plan ? (plan.current ? `Step ${plan.current.index} of ${plan.total}${plan.blocked ? ', blocked' : ''}` : planProgressText(plan)) : '',
    decisions: run.decisions,
    cost: runCostInput(run.summary)
  }
}

/** The running-now line: "Step 2 of 4 · 7 working · 1 waiting on you · $2.31" (parts without data are left out). */
export function runningLine(r: RunningNow): { parts: string[]; waitingText: string; cost: string } {
  const parts: string[] = []
  if (r.planText) parts.push(r.planText)
  if (r.working > 0) parts.push(`${r.working} working`)
  const cost = costView(r.cost, { compact: true })
  return { parts, waitingText: r.decisions > 0 ? `${r.decisions} waiting on you` : '', cost: cost.empty ? '' : cost.text }
}

// ---------- Month spend ----------

export interface MonthSpend {
  /** "$38.20" / "$38.20+" / "unknown" (null when nothing was spent: the section says so in words). */
  text: string
  title: string
  runs: number
  /** The median cost of a run this month when at least 3 runs had a known cost; null otherwise. */
  typicalUsd: number | null
  typicalText: string | null
  /** Runs whose cost the figure leaves out. */
  unknownRuns: number
  /** "of $200.00 a month" when the project has a monthly cap (projectSpend only). */
  limitText?: string
  /** "on course for about $90.00" once the month has enough days (projectSpend only). */
  projectionText?: string
}

/**
 * The month figure from `runInsights.projectSpend` (recorded spend, caps, projection), with the typical-run line of the
 * usage overview. Unknown stays "unknown": a month whose runs all lack a price is never $0, and a partly unknown month
 * is a lower bound ("$12.00+"). null when the project has no run this month or the answer is missing (the caller then
 * uses `monthSpend`).
 */
export function monthSpendFrom(spend: Pick<ProjectSpend, 'month' | 'maxMonthlyUsd' | 'monthProjectionUsd'> | null | undefined, overview?: Parameters<typeof monthSpend>[0]): MonthSpend | null {
  const m = spend?.month
  if (!m || !Number.isFinite(m.spentUsd) || !(m.runs > 0)) return null
  const typical = monthSpend(overview)
  const allUnknown = m.unknownRuns >= m.runs && m.spentUsd === 0
  const partial = m.unknownRuns > 0 && !allUnknown
  const text = allUnknown ? 'unknown' : `${formatUsdCompact(m.spentUsd)}${partial ? '+' : ''}`
  return {
    text,
    title: allUnknown ? 'No run this month has a known price' : partial ? 'At least this much; some runs have no known price' : 'Estimated from recorded usage',
    runs: m.runs,
    typicalUsd: typical?.typicalUsd ?? null,
    typicalText: typical?.typicalText ?? null,
    unknownRuns: m.unknownRuns,
    ...(typeof spend?.maxMonthlyUsd === 'number' && spend.maxMonthlyUsd > 0 ? { limitText: `of ${formatUsdCompact(spend.maxMonthlyUsd)} a month` } : {}),
    ...(typeof spend?.monthProjectionUsd === 'number' && !allUnknown ? { projectionText: `on course for about ${formatUsdCompact(spend.monthProjectionUsd)}` } : {})
  }
}

/** First millisecond of the local calendar month holding `now`. */
export function monthStart(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** Median of the numbers; null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Fewest priced runs before "A typical run costs" is said. */
export const TYPICAL_MIN_RUNS = 3

/**
 * Month-to-date spend from `runs.usageOverview({ since: monthStart, projectIds: [id] })`: the totals cover every matched
 * run, the median reads the rows (work and ask runs with a known, complete cost above zero). null for no runs.
 */
export function monthSpend(overview: Pick<UsageOverview, 'totals' | 'matchedRuns' | 'runs' | 'costKnownRuns' | 'costUnknownRuns'> | null | undefined): MonthSpend | null {
  if (!overview || !(overview.matchedRuns > 0)) return null
  const total = costView(
    {
      costUsd: overview.totals.costUsd,
      costSource: overview.totals.costSource,
      ...(overview.totals.costPartial || overview.costUnknownRuns > 0 ? { costPartial: true } : {})
    } as CostInput,
    { compact: true }
  )
  const priced = overview.runs
    .filter((r) => (r.kind === 'work' || r.kind === undefined) && r.usage.costUsd !== null && !r.usage.costPartial && r.usage.costUsd > 0)
    .map((r) => r.usage.costUsd as number)
  const typicalUsd = priced.length >= TYPICAL_MIN_RUNS ? median(priced) : null
  // "Nothing recorded" with runs matched is a true zero only when every run's cost is known; a run whose cost is unknown
  // (or a total with no figure at all) reads "unknown", never $0.
  const trueZero = total.empty && overview.totals.costUsd === 0 && !(overview.costUnknownRuns > 0)
  const unknownCost = costView({ costUsd: null, costSource: 'unknown' }, { compact: true })
  return {
    text: total.empty ? (trueZero ? '$0.00' : unknownCost.text) : total.text,
    title: total.empty && !trueZero ? unknownCost.title : total.title,
    runs: overview.matchedRuns,
    typicalUsd,
    typicalText: typicalUsd === null ? null : formatUsdCompact(typicalUsd),
    unknownRuns: overview.costUnknownRuns
  }
}

// ---------- Team ----------

export interface TeamRoleIn {
  id: string
  name: string
  reportsTo: string | null
  color: string
}

export interface TeamGroup {
  id: string
  name: string
  /** One colour per role of the group (role.color, the colour the role has on the canvas). */
  colors: string[]
  count: number
}

export interface TeamSummary {
  roleCount: number
  groups: TeamGroup[]
}

/** Most groups drawn; the rest fold into one "Other". */
export const TEAM_GROUPS_MAX = 5
/** Most colour squares drawn for one group. */
export const TEAM_SQUARES_MAX = 8

/**
 * The project's roles as groups, from the real org chart: a lead who has reports of their own heads a group (named after
 * the lead, with the lead's whole subtree); direct reports of the root with no reports of their own share one
 * "Direct reports" group. The root itself belongs to no group. A chart with only the root has no groups.
 */
export function teamSummary(roles: readonly TeamRoleIn[]): TeamSummary {
  const ids = new Set(roles.map((r) => r.id))
  const kids = new Map<string, TeamRoleIn[]>()
  const tops: TeamRoleIn[] = []
  for (const r of roles) {
    if (r.reportsTo && ids.has(r.reportsTo) && r.reportsTo !== r.id) kids.set(r.reportsTo, [...(kids.get(r.reportsTo) ?? []), r])
    else tops.push(r)
  }
  const root = tops[0]
  if (!root) return { roleCount: 0, groups: [] }
  // Any other top-level role (a second root) is treated as a direct report of the first, so no role goes missing.
  const direct = [...(kids.get(root.id) ?? []), ...tops.slice(1)]
  const subtree = (r: TeamRoleIn, seen = new Set<string>()): TeamRoleIn[] => {
    if (seen.has(r.id)) return []
    seen.add(r.id)
    return [r, ...(kids.get(r.id) ?? []).flatMap((c) => subtree(c, seen))]
  }
  const groups: TeamGroup[] = []
  const leaves: TeamRoleIn[] = []
  for (const r of direct) {
    if ((kids.get(r.id) ?? []).length > 0) {
      const members = subtree(r)
      groups.push({ id: r.id, name: r.name, colors: members.map((m) => m.color), count: members.length })
    } else leaves.push(r)
  }
  if (leaves.length > 0) groups.push({ id: 'direct', name: 'Direct reports', colors: leaves.map((m) => m.color), count: leaves.length })
  let shown = groups
  if (groups.length > TEAM_GROUPS_MAX) {
    const rest = groups.slice(TEAM_GROUPS_MAX - 1)
    shown = [
      ...groups.slice(0, TEAM_GROUPS_MAX - 1),
      { id: 'other', name: 'Other', colors: rest.flatMap((g) => g.colors), count: rest.reduce((n, g) => n + g.count, 0) }
    ]
  }
  return { roleCount: roles.length, groups: shown.map((g) => ({ ...g, colors: g.colors.slice(0, TEAM_SQUARES_MAX) })) }
}

/**
 * A role colour is data from a team file (a hand edit, an import, an agent): only a hex colour reaches an inline style;
 * anything else draws as a neutral token colour.
 */
export function safeSquareColor(color: unknown): string {
  return typeof color === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.trim()) ? color.trim() : 'var(--border-strong)'
}

/** "12 roles · asks before risky actions". */
export function teamLine(roleCount: number, mode: PermissionMode | undefined): string {
  return `${plural(roleCount, 'role')} · ${permissionWords(mode)}`
}

// ---------- To-dos ----------

/** At most this many to-dos are drawn on Home; "All to-dos" opens the tab. */
export const HOME_TODOS_MAX = 5

export interface TodoHomeRow {
  id: string
  title: string
  /** The team wrote it (createdBy 'agent'). */
  fromTeam: boolean
  /** The stored item, for "Run" (startSessionFromTodo). */
  item: TodoItem
}

/** Open items, the team's first (they are what the user has not seen), then newest first; capped. */
export function homeTodos(items: readonly TodoItem[] | undefined, max = HOME_TODOS_MAX): { rows: TodoHomeRow[]; open: number } {
  const open = (items ?? []).filter((t) => t.status === 'open')
  const sorted = [...open].sort((a, b) => Number(b.createdBy === 'agent') - Number(a.createdBy === 'agent') || b.updatedAt - a.updatedAt)
  return { rows: sorted.slice(0, max).map((t) => ({ id: t.id, title: t.title, fromTeam: t.createdBy === 'agent', item: t })), open: open.length }
}

// ---------- Schedules ----------

export type LineTone = 'ok' | 'bad' | 'warn' | 'muted'

export interface ScheduleLine {
  id: string
  name: string
  last: string
  tone: LineTone
  enabled: boolean
}

/** The tone of a schedule's newest result: a failure or an error reads bad, a skip or a needs-you amber. */
export function scheduleTone(s: Pick<Schedule, 'lastEntry' | 'consecutiveFailures' | 'state'>): LineTone {
  const e = s.lastEntry
  if (!e) return s.consecutiveFailures > 0 || s.state === 'error' ? 'bad' : 'muted'
  if (e.result === 'failed' || e.outcome === 'error') return 'bad'
  if (e.result === 'skipped' || e.outcome === 'needs-you') return 'warn'
  if (e.outcome === 'finished') return 'ok'
  return 'muted'
}

/** The project's schedules (team schedules aimed at it), most recently handled first; paused ones stay, marked. */
export function projectSchedules(list: readonly Schedule[] | null | undefined, projectId: string): ScheduleLine[] {
  return (list ?? [])
    .filter((s) => s.target.kind === 'team' && s.target.projectId === projectId && s.state !== 'done')
    .sort((a, b) => (b.lastEntry?.at ?? 0) - (a.lastEntry?.at ?? 0) || a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, name: s.name, last: lastResultText(s), tone: scheduleTone(s), enabled: s.enabled }))
}

// ---------- Facts shared by both Homes ----------

/** "3 Nov 2026" of the project's oldest run (the nearest thing to a start date); '' when there is none. */
export function firstRunDate(runs: readonly Pick<RunSummary, 'startedAt'>[]): string {
  const oldest = runs.reduce<number | undefined>((m, r) => (m === undefined || r.startedAt < m ? r.startedAt : m), undefined)
  return oldest === undefined ? '' : formatDate(oldest)
}
