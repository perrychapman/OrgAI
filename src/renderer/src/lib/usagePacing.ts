/**
 * The Usage page's Pacing header (docs/design/dashboard-usage-redesign/project/usage.md "Pacing"): the period's spend
 * against the previous period at the same point, and a projection. Pure: numbers in, plain sentences and dial
 * fractions out.
 *
 * The projection is a straight line: spend so far over the elapsed share of the period. It is labelled "Projected",
 * never a fact, and shown only once a fifth of the period has passed AND every run in it is priced (and the data is
 * not cut short). Otherwise it is hidden and a sentence says why. Unknown spend never becomes $0 here.
 */
import { pageCost } from '@shared/view/usageInsights'
import { monthBounds, monthKey } from './trends'
import { periodSpan, rowFigures, type UsagePeriod } from './usageOverview'
import { costView } from './cost'
import type { UsageOverviewRow } from '@shared/types'

/** A projection needs at least this share of the period to have passed. */
export const PROJECTION_MIN_FRACTION = 0.2

export const PROJECTION_EARLY_TEXT = 'Projection needs more data'
export const PROJECTION_UNPRICED_TEXT = 'Projection hidden: some usage is not priced'
export const PROJECTION_TRUNCATED_TEXT = 'Projection hidden: older runs in this period are not loaded'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** The whole period, including the part that has not happened yet: [since, end). */
export function periodBounds(p: UsagePeriod, now: number): { since: number; end: number } {
  const span = periodSpan(p, now)
  if (p.kind === 'days') {
    const d = new Date(span.since)
    d.setDate(d.getDate() + p.days)
    return { since: span.since, end: d.getTime() }
  }
  if (p.kind === 'this-month') return { since: span.since, end: monthBounds(monthKey(now)).end }
  if (p.kind === 'last-month') return { since: span.since, end: span.until }
  // Whole months: the last month's end, valid or not (periodSpan applies the same fallbacks).
  const from = MONTH_RE.test(p.from) ? p.from : monthKey(now)
  const to = MONTH_RE.test(p.to) && p.to >= from ? p.to : from
  return { since: span.since, end: monthBounds(to).end }
}

/** The share of [since, end) that has passed at `now`, clamped to 0..1 (a zero-length or reversed period counts as over). */
export function elapsedFraction(since: number, end: number, now: number): number {
  if (!(end > since)) return 1
  return Math.min(1, Math.max(0, (now - since) / (end - since)))
}

/** One run of the previous period, reduced to what pacing needs. */
export interface PacingRun {
  startedAt: number
  /** The run's known cost; null = no price. */
  usd: number | null
  /** False for a lower bound (partly priced) or no price. */
  exact: boolean
}

/** The runs' cost as pacing reads it (the Model chip narrows to that model's own cost, like every figure on the page). */
export function pacingRuns(rows: readonly UsageOverviewRow[], model: string | null): PacingRun[] {
  return rows.map((r) => {
    const v = costView(rowFigures(r, model).cost)
    if (v.kind === 'none') return { startedAt: r.startedAt, usd: 0, exact: true }
    if (v.kind === 'unknown') return { startedAt: r.startedAt, usd: null, exact: false }
    return { startedAt: r.startedAt, usd: rowFigures(r, model).cost.costUsd, exact: v.kind === 'known' }
  })
}

/** What the previous period had spent at the same point. */
export interface PreviousPoint {
  usd: number
  /** False when a run before the point has no price or only a lower bound: the figure is "at least". */
  exact: boolean
}

/**
 * Where the previous period stood at the same elapsed time: runs that started before `prevSince + elapsedMs`, capped
 * at the previous period's own end (a 30-day month against a 31-day one). A period that is over compares in full.
 */
export function previousAtPoint(runs: readonly PacingRun[], prev: { since: number; until: number }, elapsedMs: number, ended: boolean): PreviousPoint {
  const cutoff = ended ? prev.until : Math.min(prev.until, prev.since + Math.max(0, elapsedMs))
  let usd = 0
  let exact = true
  for (const r of runs) {
    if (r.startedAt < prev.since || r.startedAt >= cutoff) continue
    if (r.usd === null) exact = false
    else usd += r.usd
    if (!r.exact) exact = false
  }
  return { usd, exact }
}

export interface PacingInput {
  since: number
  /** The period's full end (periodBounds). */
  end: number
  now: number
  /** Spend so far; null = unknown (no price at all). */
  spendUsd: number | null
  /** Every run in the period is priced (no unknown, no lower bound). */
  allPriced: boolean
  /** The runs list was cut short: the figures are a lower bound. */
  truncated: boolean
  /** The previous period at the same point; null = not available (not loaded, or cut short). */
  previous: PreviousPoint | null
  /** "the previous 7 days", "last month". */
  previousWords: string
}

export type ProjectionState = 'shown' | 'early' | 'unpriced' | 'truncated' | 'ended'

export interface PacingPace {
  /** ▲ more, ▼ less, null = level or not compared. */
  glyph: '▲' | '▼' | null
  /** The whole sentence, glyph first when there is one. */
  text: string
  /** Spend minus the previous period at this point; null when not compared. */
  deltaUsd: number | null
}

export interface PacingModel {
  fraction: number
  state: ProjectionState
  /** Projected spend by the period's end; only in the 'shown' state. */
  projectedUsd: number | null
  /** The sentence for the projection or the reason it is missing. */
  projectionText: string
  /** The burn dial; null whenever the projection is hidden. */
  dial: { fill: number; tick: number | null; text: string; tickText: string | null } | null
  pace: PacingPace | null
}

const dayWord = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

function paceOf(i: PacingInput): PacingPace | null {
  const p = i.previous
  if (!p) return null
  if (i.spendUsd === null || !i.allPriced || i.truncated || !p.exact) {
    return { glyph: null, text: `Not compared with ${i.previousWords}: some usage is not priced.`, deltaUsd: null }
  }
  const delta = i.spendUsd - p.usd
  // A period that is over compares in full, so "at this point" would be wrong.
  const at = elapsedFraction(i.since, i.end, i.now) >= 1 ? '' : ' at this point'
  // Half a cent either way is level: both figures read the same on the page.
  if (Math.abs(delta) < 0.005) return { glyph: null, text: `Level with ${i.previousWords}${at}.`, deltaUsd: 0 }
  return delta > 0
    ? { glyph: '▲', text: `▲ ${pageCost(delta)} more than ${i.previousWords}${at}`, deltaUsd: delta }
    : { glyph: '▼', text: `▼ ${pageCost(-delta)} less than ${i.previousWords}${at}`, deltaUsd: delta }
}

/** The pacing model for a period. Never throws; every branch has words. */
export function pacingModel(i: PacingInput): PacingModel {
  const fraction = elapsedFraction(i.since, i.end, i.now)
  const pace = paceOf(i)
  const hidden = (state: Exclude<ProjectionState, 'shown'>, text: string): PacingModel => ({ fraction, state, projectedUsd: null, projectionText: text, dial: null, pace })

  if (fraction >= 1) return hidden('ended', 'No projection: this period is over')
  if (fraction < PROJECTION_MIN_FRACTION) return hidden('early', PROJECTION_EARLY_TEXT)
  if (i.truncated) return hidden('truncated', PROJECTION_TRUNCATED_TEXT)
  if (!i.allPriced || i.spendUsd === null) return hidden('unpriced', PROJECTION_UNPRICED_TEXT)

  const projected = i.spendUsd / fraction
  const fill = projected > 0 ? Math.min(1, i.spendUsd / projected) : 0
  const tick = i.previous && i.previous.exact && projected > 0 ? Math.min(1, i.previous.usd / projected) : null
  const by = dayWord(i.end - 1)
  const tickText = i.previous && i.previous.exact ? `Tick: ${i.previousWords} at this point, ${pageCost(i.previous.usd)}` : null
  const pct = Math.round(fill * 100)
  const text = `${pageCost(i.spendUsd)} so far of a projected ${pageCost(projected)} by ${by}, ${pct} percent.${tickText ? ` ${tickText}.` : ''}`
  return {
    fraction,
    state: 'shown',
    projectedUsd: projected,
    projectionText: `Projected ${pageCost(projected)} by ${by}`,
    dial: { fill, tick, text, tickText },
    pace
  }
}
