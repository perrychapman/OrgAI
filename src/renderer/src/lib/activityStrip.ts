import type { RunSummary } from '@shared/types'
import { costView, formatDuration, runCostInput, sumCosts, type CostInput } from './cost'
import { statusOfRun } from './runStatus'

/**
 * The "Last 14 days" strip's numbers (docs/design/dashboard-2.md section 7). Pure: summaries in, one bucket per local
 * calendar day out. A run counts on the local day it started, with its whole cost; nothing is split at midnight.
 */

export type Outcome = 'finished' | 'failed' | 'stopped' | 'open' | 'paused'

/** Nearest the baseline first: the rarer, louder outcomes (spec 7.3). */
export const OUTCOME_ORDER: readonly Outcome[] = ['failed', 'open', 'paused', 'finished', 'stopped']

export type CostKind = 'none' | 'known' | 'partial' | 'unknown'

/** Waiting under a second would read "0s"; it counts as none ("Waited on you" shows only when above zero, spec 7.2). */
export function waitedShown(ms: number): boolean {
  return ms >= 1000
}

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
  /** The summed cost (unknown stays unknown, a partial sum is a lower bound). */
  cost: CostInput
  costKind: CostKind
  /** The known part of the cost (0 when none or unknown). */
  costUsd: number
  waitingMs: number
}

export interface LedgerTotals {
  runs: number
  cost: CostInput
  costKind: CostKind
  waitingMs: number
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

/**
 * Today and the 13 days before it, oldest first. Days are built from calendar parts (`new Date(y, m, d - i)`), never
 * by subtracting 24 hours, so a daylight saving change cannot repeat or skip a day. Each run id counts once.
 */
export function dayLedger(summaries: readonly LedgerRun[], now: number, days = 14): DayBucket[] {
  const n = new Date(now)
  const todayKey = dayKey(now)
  const buckets: DayBucket[] = []
  const byKey = new Map<string, { bucket: DayBucket; costs: CostInput[] }>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - i)
    const key = dayKey(d.getTime())
    const bucket: DayBucket = { key, start: d.getTime(), today: key === todayKey, runs: 0, outcomes: emptyOutcomes(), cost: noneCost, costKind: 'none', costUsd: 0, waitingMs: 0 }
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
    const waited = run.usage?.waitingMs
    if (typeof waited === 'number' && Number.isFinite(waited) && waited > 0) slot.bucket.waitingMs += waited
  }
  for (const { bucket, costs } of byKey.values()) {
    bucket.cost = costs.length > 0 ? sumCosts(costs) : noneCost
    bucket.costKind = costView(bucket.cost).kind
    bucket.costUsd = bucket.costKind === 'known' || bucket.costKind === 'partial' ? (bucket.cost.costUsd ?? 0) : 0
  }
  return buckets
}

/** Runs, cost and waiting over every bucket. */
export function ledgerTotals(days: readonly DayBucket[]): LedgerTotals {
  const cost = sumCosts(days.filter((d) => d.runs > 0).map((d) => d.cost))
  return { runs: days.reduce((a, d) => a + d.runs, 0), cost, costKind: costView(cost).kind, waitingMs: days.reduce((a, d) => a + d.waitingMs, 0) }
}

/** Bar height in px: a linear share of the largest known day cost, at least `minPx` for any cost above zero; 0 for none. */
export function barHeight(day: Pick<DayBucket, 'costUsd' | 'costKind'>, maxCost: number, trackPx: number, minPx = 2): number {
  if ((day.costKind !== 'known' && day.costKind !== 'partial') || day.costUsd <= 0 || maxCost <= 0) return 0
  return Math.min(trackPx, Math.max(minPx, (day.costUsd / maxCost) * trackPx))
}

/** The largest known day cost (the scale of the bars). */
export function maxDayCost(days: readonly DayBucket[]): number {
  return days.reduce((m, d) => ((d.costKind === 'known' || d.costKind === 'partial') && d.costUsd > m ? d.costUsd : m), 0)
}

export interface Tick {
  outcome: Outcome | 'more'
}

/** One tick per run in OUTCOME_ORDER, at most `max`; past that the last slot becomes the "more" tick. */
export function ledgerTicks(outcomes: Record<Outcome, number>, max: number): Tick[] {
  const all: Tick[] = []
  for (const o of OUTCOME_ORDER) for (let i = 0; i < outcomes[o]; i++) all.push({ outcome: o })
  if (all.length <= max) return all
  return [...all.slice(0, Math.max(0, max - 1)), { outcome: 'more' }]
}

// ---------------------------------------------------------------- words

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "Tue 4 Nov" (en-GB parts, so the order never follows the OS locale). */
export function dayName(start: number): string {
  const d = new Date(start)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

/** "24 Oct": the label under the oldest column. */
export function shortDate(start: number): string {
  return new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** One weekday initial ("M", "T"...) for the tall strip. */
export function weekdayInitial(start: number): string {
  return new Date(start).toLocaleDateString('en-GB', { weekday: 'narrow' })
}

/** The cost part of a line: the compact figure, "cost unknown", or '' when nothing was spent. */
export function costPart(cost: CostInput): string {
  const v = costView(cost, { compact: true })
  if (v.kind === 'none') return ''
  return v.kind === 'unknown' ? 'cost unknown' : v.text
}

/** The readout line under the days (spec 7.4). */
export function dayReadout(day: DayBucket): string {
  const when = day.today ? 'Today' : dayName(day.start)
  if (day.runs === 0) return `${when}: no runs`
  const failed = day.outcomes.failed
  const parts = [`${plural(day.runs, 'run', 'runs')} started${failed > 0 ? ` (${failed} failed)` : ''}`]
  const cost = costPart(day.cost)
  if (cost) parts.push(cost)
  if (waitedShown(day.waitingMs)) parts.push(`waited on you ${formatDuration(day.waitingMs)}`)
  return `${when}: ${parts.join(' · ')}`
}

/** The accessible name of a day's button (spec 7.3): zero parts are left out. */
export function dayAriaLabel(day: DayBucket): string {
  const when = day.today ? `Today, ${dayName(day.start)}` : dayName(day.start)
  if (day.runs === 0) return `${when}: no runs`
  const o = day.outcomes
  const detail = ([['finished', o.finished], ['failed', o.failed], ['stopped', o.stopped], ['open', o.open + o.paused]] as const)
    .filter(([, n]) => n > 0)
    .map(([w, n]) => `${n} ${w}`)
    .join(', ')
  const cost = costPart(day.cost)
  const tail = [cost ? `cost ${cost}` : '', waitedShown(day.waitingMs) ? `waited on you ${formatDuration(day.waitingMs)}` : ''].filter(Boolean)
  return `${when}: ${plural(day.runs, 'run', 'runs')} (${detail})${tail.length > 0 ? `, ${tail.join(', ')}` : ''}`
}
