import { costView, formatDuration, formatUsdGrouped, type CostInput } from './cost'
import { dayLedger, ledgerTotals, LEDGER_DAYS, type CostKind, type DayBucket, type LedgerRun, type LedgerTotals } from './activityStrip'
import { FOCUS_FIGURES, FOCUS_TITLES, type FocusFigure } from './dashboardLayout'
import type { SparkPoint } from './usageDashboard'

/**
 * Your week (docs/design/dashboard-usage-redesign dashboard.md "Your week"): honest numbers about the last 7 local days
 * including today, and how they moved against the 7 days before. Pure. Built on `dayLedger(summaries, now, 14)`: the older
 * seven days are the comparison, the newer seven the week. No target, no streak, no "best day".
 *
 * Agent time is, per run, `max(0, usage.wallMs - usage.idleMs - usage.waitingMs)` summed over the runs of the window (see
 * `runWorkMs` in activityStrip.ts for why `limitHoldMs` is NOT subtracted: the three timers overlap, a usage-limited run's
 * hold sits inside its idle time). It is the time runs were busy, never summed across parallel agents, and it is not the
 * Usage page's Wall time (which counts the whole open time, waiting on you included). A run without `usage` is left out
 * and the figure becomes a lower bound ("6h 40m+", "at least 6h 40m").
 */

/** A summary the recap reads: a ledger run plus the project it belongs to. */
export type RecapRun = LedgerRun & { projectId: string }

export interface WeekRecap {
  /** The seven day buckets of the week, oldest first, today last. */
  days: DayBucket[]
  /** The seven days before them (the comparison), oldest first. */
  previousDays: DayBucket[]
  runs: number
  failed: number
  /** Time working in ms and whether it is a lower bound. */
  workMs: number
  workPartial: boolean
  /** "6h 40m" or "6h 40m+"; "unknown" when nothing was measured and every run lacks usage. */
  workText: string
  /** "at least 6h 40m" for a lower bound, else the same as `workText`. */
  workLabel: string
  /** The summed cost as the cost component takes it (never a printed $0.00: see `costShown`). */
  cost: CostInput
  costKind: CostKind
  /** False when nothing was spent or the cost is a reported zero (flat-rate plans): the figure is omitted. */
  costShown: boolean
  /** The week before, for the movement lines. */
  previous: LedgerTotals
}

/** Only work runs: setup, MCP-assistant and Skill-assistant runs are not part of the person's week. */
export const isWorkRun = (r: { kind?: string }): boolean => r.kind === undefined || r.kind === 'work'

export function weekRecap(summaries: readonly RecapRun[], _projects: readonly { id: string; name: string }[], now: number): WeekRecap {
  const work = summaries.filter(isWorkRun)
  const both = dayLedger(work, now, LEDGER_DAYS * 2)
  const days = both.slice(LEDGER_DAYS)
  const previousDays = both.slice(0, LEDGER_DAYS)
  const totals = ledgerTotals(days)

  // "0s+" says nothing: when no run in the window has usage, the time is simply unknown.
  const workUnknown = totals.workPartial && totals.workMs < 1000
  const workText = workUnknown ? 'unknown' : `${formatDuration(totals.workMs)}${totals.workPartial ? '+' : ''}`
  const workLabel = workUnknown ? 'unknown' : totals.workPartial ? `at least ${formatDuration(totals.workMs)}` : formatDuration(totals.workMs)

  const kind = costView(totals.cost).kind
  const costShown = kind === 'unknown' || kind === 'partial' || (kind === 'known' && (totals.cost.costUsd ?? 0) > 0)

  return {
    days,
    previousDays,
    runs: totals.runs,
    failed: totals.failed,
    workMs: totals.workMs,
    workPartial: totals.workPartial,
    workText,
    workLabel,
    cost: totals.cost,
    costKind: totals.costKind,
    costShown,
    previous: ledgerTotals(previousDays)
  }
}

/** The tooltip and description of the Agent time card. Never the same thing as Usage's Wall time. */
export const AGENT_TIME_TOOLTIP = 'Time agents spent working on your runs this week. Time a run was idle or waiting on you is left out, and parallel agents are not added together. Not the same as Wall time on Usage, which counts the whole time a run was open.'

/** The tooltip and description of the Decisions card. */
export const DECISIONS_TOOLTIP = 'Decision cards agents asked of you in runs that started this week: permissions, questions, proposals.'

export const COMPARED_WITH = 'vs the 7 days before'

export type MoveDir = 'up' | 'down' | 'same' | 'none'

export interface Movement {
  dir: MoveDir
  /** The visible line after the glyph: "$4.20 vs the 7 days before"; the whole line for `same` and `none`. */
  text: string
  /** The same for assistive tech: "up $4.20 vs the 7 days before". */
  label: string
}

/** ▲ for up, ▼ for down; nothing else carries a glyph. */
export const MOVE_GLYPH: Record<'up' | 'down', string> = { up: '▲', down: '▼' }

function movement(cur: number, prev: number, fmt: (n: number) => string): Movement {
  if (cur === prev) return { dir: 'same', text: `No change ${COMPARED_WITH}`, label: `No change ${COMPARED_WITH}` }
  const dir = cur > prev ? 'up' : 'down'
  const amount = fmt(Math.abs(cur - prev))
  return { dir, text: `${amount} ${COMPARED_WITH}`, label: `${dir} ${amount} ${COMPARED_WITH}` }
}

const notCompared = (why: string): Movement => ({ dir: 'none', text: `Not compared: ${why}`, label: `Not compared: ${why}` })

export interface StatCard {
  id: FocusFigure
  label: string
  /** The number the figure counts up to; null when there is nothing to count (unknown, none, not measured). */
  value: number | null
  /** The final text of the figure; "Not priced", "None" and "Not measured" are words, never "$0". */
  text: string
  /** The text for assistive tech when it differs from `text` ("at least 6h 40m"). */
  label2: string
  /** The figure is a lower bound ("$4.20+"). */
  partial: boolean
  /** Spend only: how the figure reads (the Cost component renders known and partial amounts). */
  cost?: CostInput
  movement: Movement
  /** One value per local day, oldest first, for the area sparkline. */
  series: SparkPoint[]
  /** What the card opens on Usage: the same 7 days; a metric only for Spend and Runs. */
  metric?: 'cost' | 'runs'
  /** A definition for the tooltip and the description; '' when the label says it all. */
  help: string
  /** The accessible name: label, figure and movement (the instruction is the description: `OPENS_USAGE_HINT`). */
  name: string
}

const dayPoint = (value: number, runs: number): SparkPoint => (runs === 0 ? { value: 0, kind: 'empty' } : { value, kind: 'known' })

function spendCard(r: WeekRecap): StatCard {
  const label = FOCUS_TITLES.spend
  const prevKind = r.previous.costKind
  const series: SparkPoint[] = r.days.map((d) => {
    if (d.runs === 0 || d.costKind === 'none') return { value: 0, kind: 'empty' }
    if (d.costKind === 'unknown') return { value: null, kind: 'unknown' }
    return { value: d.cost.costUsd ?? 0, kind: d.costKind === 'partial' ? 'partial' : 'known' }
  })
  let text: string
  let value: number | null
  let label2: string
  const partial = r.costKind === 'partial'
  if (r.costKind === 'unknown') {
    text = 'Not priced'
    value = null
    label2 = 'not priced'
  } else if (!r.costShown) {
    text = 'None'
    value = null
    label2 = 'nothing spent'
  } else {
    value = r.cost.costUsd ?? 0
    text = `${formatUsdGrouped(value)}${partial ? '+' : ''}`
    label2 = partial ? `at least ${formatUsdGrouped(value)}` : text
  }
  const comparable = (k: CostKind): boolean => k === 'known' || k === 'none'
  const move = comparable(r.costKind) && comparable(prevKind) ? movement(r.cost.costUsd ?? 0, r.previous.cost.costUsd ?? 0, formatUsdGrouped) : notCompared('some runs are not priced')
  return finish({ id: 'spend', label, value, text, label2, partial, ...(r.costShown && r.costKind !== 'unknown' ? { cost: r.cost } : {}), movement: move, series, metric: 'cost', help: '' })
}

function runsCard(r: WeekRecap): StatCard {
  const series = r.days.map((d) => dayPoint(d.runs, d.runs))
  const text = String(r.runs)
  return finish({ id: 'runs', label: FOCUS_TITLES.runs, value: r.runs, text, label2: text, partial: false, movement: movement(r.runs, r.previous.runs, String), series, metric: 'runs', help: '' })
}

function timeCard(r: WeekRecap): StatCard {
  const unknown = r.workText === 'unknown'
  const series: SparkPoint[] = r.days.map((d) => (d.runs === 0 ? { value: 0, kind: 'empty' } : { value: d.workMs, kind: d.workPartial ? 'partial' : 'known' }))
  const comparable = !r.workPartial && !r.previous.workPartial
  const move = comparable ? movement(r.workMs, r.previous.workMs, formatDuration) : notCompared('some runs have no timing')
  return finish({
    id: 'time',
    label: FOCUS_TITLES.time,
    value: unknown ? null : r.workMs,
    text: unknown ? 'Not measured' : r.workText,
    label2: unknown ? 'not measured' : r.workLabel,
    partial: r.workPartial && !unknown,
    movement: move,
    series,
    help: AGENT_TIME_TOOLTIP
  })
}

/** Decisions asked in the week; null (no card) until at least one run of the week carries the count. */
function decisionsCard(r: WeekRecap): StatCard | null {
  const cur = r.days.reduce((a, d) => a + d.decisionRuns, 0)
  if (cur === 0) return null
  const sum = r.days.reduce((a, d) => a + d.decisions, 0)
  const partial = cur < r.runs
  const prevPartial = r.previous.decisionRuns < r.previous.runs
  const series: SparkPoint[] = r.days.map((d) => (d.runs === 0 ? { value: 0, kind: 'empty' } : { value: d.decisions, kind: d.decisionRuns < d.runs ? 'partial' : 'known' }))
  const text = `${sum}${partial ? '+' : ''}`
  return finish({
    id: 'decisions',
    label: FOCUS_TITLES.decisions,
    value: sum,
    text,
    label2: partial ? `at least ${sum}` : text,
    partial,
    movement: partial || prevPartial ? notCompared('some runs do not count decisions') : movement(sum, r.previous.decisions, String),
    series,
    help: DECISIONS_TOOLTIP
  })
}

/** The Decisions card is drawn only once a run of the week carries decision counts; Customise offers it as a lead figure only then. */
export const hasDecisionsCard = (r: WeekRecap): boolean => decisionsCard(r) !== null

/** What a card opens, said once through `aria-describedby` and never inside the name. */
export const OPENS_USAGE_HINT = 'Opens Usage for the same 7 days.'

/**
 * The accessible name is the reading alone: label, figure, movement. The instruction (`OPENS_USAGE_HINT`) rides in the
 * description, and a card with a definition adds it there, so a screen reader never hears the figure twice.
 */
function finish(c: Omit<StatCard, 'name'>): StatCard {
  const move = c.movement.label
  return { ...c, name: `${c.label} ${c.label2}, ${move.charAt(0).toLowerCase()}${move.slice(1)}` }
}

/**
 * The cards of Your week in display order: the focus figure first, the rest in canonical order. A card without data is
 * left out (Decisions until runs carry the count); a focus that is left out falls back to the first card.
 */
export function statCards(recap: WeekRecap, focus: FocusFigure): StatCard[] {
  const all = [spendCard(recap), runsCard(recap), timeCard(recap), decisionsCard(recap)].filter((c): c is StatCard => c !== null)
  const lead = all.find((c) => c.id === focus)
  const order = [...FOCUS_FIGURES]
  const rest = all.filter((c) => c !== lead).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return lead ? [lead, ...rest] : rest
}
