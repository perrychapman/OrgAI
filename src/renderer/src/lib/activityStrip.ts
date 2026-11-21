import type { RunSummary } from '@shared/types'
import { costView, runCostInput, sumCosts, type CostInput } from './cost'
import { statusOfRun } from './runStatus'

/**
 * The day ledger behind Your week (docs/design/dashboard-usage-redesign dashboard.md): pure, summaries in, one bucket per
 * local calendar day out. A run counts on the local day it started, with its whole cost and working time; nothing is split
 * at midnight. The 14-day bar strip that used to draw these is retired; the stat cards (lib/weekRecap.ts), the project
 * tiles (lib/projectSparkline.ts) and the commit chart share this core.
 */

export type Outcome = 'finished' | 'failed' | 'stopped' | 'open' | 'paused'

export type CostKind = 'none' | 'known' | 'partial' | 'unknown'

/** Days in the ledger: the last 7 local days including today. */
export const LEDGER_DAYS = 7
/** A day with runs never draws a bar shorter than this. */
export const MIN_BAR_PX = 2

export type LedgerRun = Pick<RunSummary, 'id' | 'startedAt' | 'status' | 'totalCostUsd'> &
  Partial<Pick<RunSummary, 'kind' | 'usage' | 'endedBy' | 'endedWithApp'>>

export interface DayBucket {
  /** Local calendar day, YYYY-MM-DD. */
  key: string
  /** Local midnight of that day. */
  start: number
  today: boolean
  runs: number
  outcomes: Record<Outcome, number>
  /** The summed cost (unknown stays unknown, a partial sum is a lower bound; a reported zero is 'none'). */
  cost: CostInput
  costKind: CostKind
  /** Time the day's runs were busy (see `runWorkMs`), ms, summed over the runs that have usage. */
  workMs: number
  /** True when at least one run of the day has no usage, so `workMs` is a lower bound. */
  workPartial: boolean
  /** Decision cards asked in the day's runs, summed over the runs that carry the count (RunUsage.decisions). */
  decisions: number
  /** Runs of the day that carry the decisions count. */
  decisionRuns: number
}

export interface LedgerTotals {
  runs: number
  failed: number
  cost: CostInput
  costKind: CostKind
  workMs: number
  workPartial: boolean
  decisions: number
  decisionRuns: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local YYYY-MM-DD of a time. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The outcome of a run summary, by the app's one status vocabulary (`statusOfRun`). */
export function outcomeOf(run: LedgerRun): Outcome {
  const word = statusOfRun({ summary: { status: run.status, kind: run.kind ?? 'work', endedBy: run.endedBy, endedWithApp: run.endedWithApp } }, undefined, false).word
  switch (word) {
    case 'Finished':
      return 'finished'
    case 'Failed':
      return 'failed'
    case 'Stopped':
      return 'stopped'
    case 'Paused':
      return 'paused'
    default:
      return 'open'
  }
}

function emptyOutcomes(): Record<Outcome, number> {
  return { finished: 0, failed: 0, stopped: 0, open: 0, paused: 0 }
}

const noneCost: CostInput = { costUsd: 0, costSource: 'none' }
const unknownCost: CostInput = { costUsd: null, costSource: 'unknown' }

/**
 * A cost the page may print: a reported zero is "nothing spent" (never "$0.00"), and a lower bound of zero beside an
 * unpriced run is simply unknown.
 */
export function honestCost(cost: CostInput): CostInput {
  const v = costView(cost)
  if (v.kind === 'known' && cost.costUsd === 0) return noneCost
  if (v.kind === 'partial' && !cost.costUsd) return unknownCost
  return cost
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * The time a run was busy, ms: `wallMs - idleMs - waitingMs`, floored at 0; null for a run without `usage` (an older
 * record), which the figure then leaves out and marks as a lower bound.
 *
 * Why `limitHoldMs` is not subtracted: waitingMs (a decision card open), idleMs (status idle) and limitHoldMs (from a
 * usage-limit report until the person's next send) are three independent timers in `computeRunUsage` and they overlap.
 * A usage-limited run's turn has ended, so its hold sits inside its idle time; subtracting both would count it twice and
 * floor honest busy time to zero.
 */
export function runWorkMs(usage: LedgerRun['usage']): number | null {
  if (!usage || !finite(usage.wallMs)) return null
  const idle = finite(usage.idleMs) ? usage.idleMs : 0
  const waiting = finite(usage.waitingMs) ? usage.waitingMs : 0
  return Math.max(0, usage.wallMs - idle - waiting)
}

/**
 * Decision cards asked in a run (RunUsage.decisions); null for a run that does not carry the count (an older record).
 * Read through a local cast until the field lands in src/shared/types.ts; absent is unknown, never 0.
 */
export function decisionsOf(usage: LedgerRun['usage']): number | null {
  const n = (usage as { decisions?: unknown } | undefined)?.decisions
  return finite(n) && n >= 0 ? Math.floor(n) : null
}

/**
 * Today and the days before it (7 by default), oldest first. Days are built from calendar parts (`new Date(y, m, d - i)`),
 * never by subtracting 24 hours, so a daylight saving change cannot repeat or skip a day. Each run id counts once.
 */
export function dayLedger(summaries: readonly LedgerRun[], now: number, days = LEDGER_DAYS): DayBucket[] {
  const n = new Date(now)
  const todayKey = dayKey(now)
  const buckets: DayBucket[] = []
  const byKey = new Map<string, { bucket: DayBucket; costs: CostInput[] }>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - i)
    const key = dayKey(d.getTime())
    const bucket: DayBucket = { key, start: d.getTime(), today: key === todayKey, runs: 0, outcomes: emptyOutcomes(), cost: noneCost, costKind: 'none', workMs: 0, workPartial: false, decisions: 0, decisionRuns: 0 }
    buckets.push(bucket)
    byKey.set(key, { bucket, costs: [] })
  }
  const seen = new Set<string>()
  for (const run of summaries) {
    if (seen.has(run.id)) continue
    seen.add(run.id)
    if (!Number.isFinite(run.startedAt)) continue
    const slot = byKey.get(dayKey(run.startedAt))
    if (!slot) continue
    slot.bucket.runs += 1
    slot.bucket.outcomes[outcomeOf(run)] += 1
    slot.costs.push(runCostInput(run))
    const work = runWorkMs(run.usage)
    if (work === null) slot.bucket.workPartial = true
    else slot.bucket.workMs += work
    const asked = decisionsOf(run.usage)
    if (asked !== null) {
      slot.bucket.decisions += asked
      slot.bucket.decisionRuns += 1
    }
  }
  for (const { bucket, costs } of byKey.values()) {
    bucket.cost = costs.length > 0 ? honestCost(sumCosts(costs)) : noneCost
    bucket.costKind = costView(bucket.cost).kind
  }
  return buckets
}

/** Runs, cost and working time over every bucket. */
export function ledgerTotals(days: readonly DayBucket[]): LedgerTotals {
  const cost = honestCost(sumCosts(days.filter((d) => d.runs > 0).map((d) => d.cost)))
  return {
    runs: days.reduce((a, d) => a + d.runs, 0),
    failed: days.reduce((a, d) => a + d.outcomes.failed, 0),
    cost,
    costKind: costView(cost).kind,
    workMs: days.reduce((a, d) => a + d.workMs, 0),
    workPartial: days.some((d) => d.workPartial),
    decisions: days.reduce((a, d) => a + d.decisions, 0),
    decisionRuns: days.reduce((a, d) => a + d.decisionRuns, 0)
  }
}

/** Bar height in px: a linear share of the busiest day (scale from zero), at least `minPx` for any day with runs; 0 for none. */
export function barHeight(runs: number, maxRuns: number, trackPx: number, minPx = MIN_BAR_PX): number {
  if (runs <= 0 || maxRuns <= 0) return 0
  return Math.min(trackPx, Math.max(minPx, (runs / maxRuns) * trackPx))
}

// ---------------------------------------------------------------- words

/** "Tue 4 Nov" (en-GB parts, so the order never follows the OS locale). */
export function dayName(start: number): string {
  const d = new Date(start)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

/** One weekday initial ("M", "T"...). */
export function weekdayInitial(start: number): string {
  return new Date(start).toLocaleDateString('en-GB', { weekday: 'narrow' })
}

