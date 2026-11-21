import type { RunSummary } from '@shared/types'
import { costView, formatUsdCompact, runCostInput, sumCosts, type CostInput } from './cost'
import { clockLabel, sinceLastSeen, type EndedRunLike } from './dashboard'

/** What the summary reads of a run: the ended-run facts and its cost. */
export type SinceRun = EndedRunLike & Pick<RunSummary, 'totalCostUsd' | 'usage'>

/**
 * The Briefing's "Since yesterday 18:40: 4 runs finished, 1 failed" line (docs/design/dashboard-usage-redesign/project/
 * components/Briefing): counts by outcome of the work runs that ended after the time the person last left the Dashboard,
 * newest chain member per chain, at most seven days back (`sinceLastSeen`). Pure: summaries and times in, a model out.
 * Omitted (null) on a first visit, before history is in, and when nothing changed.
 */

export type SinceOutcome = 'finished' | 'failed' | 'stopped' | 'closed-waiting' | 'closed'

export interface SincePart {
  outcome: SinceOutcome
  count: number
}

export interface SinceSummary {
  /** "Since yesterday 18:40" (no colon). */
  label: string
  /** Outcomes with a count above zero, finished first. */
  parts: SincePart[]
  /** What the finished and failed runs cost, when a figure can be said truthfully ("$1.42", "at least $1.42"); '' otherwise. */
  spent: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Since 06:40 PM" (today), "Since yesterday 06:40 PM", "Since Thu 09:00 AM" (this week), "Since 12 Nov" (older). Local time in the app's one clock format (`clockLabel`). */
export function sinceLabel(lastSeen: number, now: number, locale?: string): string {
  const d = new Date(lastSeen)
  const clock = clockLabel(lastSeen, locale)
  const days = Math.round((startOfDay(now) - startOfDay(lastSeen)) / DAY_MS)
  if (days <= 0) return `Since ${clock}`
  if (days === 1) return `Since yesterday ${clock}`
  if (days < 7) return `Since ${WEEKDAYS[d.getDay()]} ${clock}`
  return `Since ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/**
 * "4 runs finished", "1 run finished", "1 failed", "2 stopped", "1 run was waiting on you when OrgAI closed", "2 runs ended
 * when OrgAI closed". The count always leads (the Briefing counts it up and prints the rest as is).
 */
export function outcomeText(part: SincePart): string {
  const runs = part.count === 1 ? 'run' : 'runs'
  switch (part.outcome) {
    case 'finished':
      return `${part.count} ${runs} finished`
    case 'closed-waiting':
      return `${part.count} ${runs} ${part.count === 1 ? 'was' : 'were'} waiting on you when OrgAI closed`
    case 'closed':
      return `${part.count} ${runs} ended when OrgAI closed`
    default:
      return `${part.count} ${part.outcome}`
  }
}

/** The cost of the ended runs as words: "$1.42 spent", "at least $1.42 spent"; '' for unknown, zero or under a cent that cannot be said. */
export function spentText(cost: CostInput | undefined): string {
  if (!cost) return ''
  const view = costView(cost, { compact: true })
  if (view.kind !== 'known' && view.kind !== 'partial') return ''
  const usd = cost.costUsd
  if (usd === null || !(usd > 0)) return ''
  if (usd < 0.01) return view.kind === 'known' ? 'less than $0.01 spent' : ''
  return view.kind === 'partial' ? `at least ${formatUsdCompact(usd)} spent` : `${formatUsdCompact(usd)} spent`
}

export interface SinceInput {
  summaries: readonly SinceRun[]
  lastSeen: number
  now: number
  firstVisit: boolean
  /** Every project's history is in: before that the counts would be a partial truth. */
  ready: boolean
}

export function sinceSummary(input: SinceInput): SinceSummary | null {
  const { summaries, lastSeen, now, firstVisit, ready } = input
  if (firstVisit || !ready) return null
  const items = sinceLastSeen(summaries, lastSeen, now, { cap: Number.MAX_SAFE_INTEGER }).items
  const count = (kind: SinceOutcome): number => items.filter((i) => i.kind === kind).length
  // A run cut by OrgAI closing counts too: one that was waiting on the person is said first, so "Nothing needs you" never stands alone above it.
  const parts: SincePart[] = (['finished', 'failed', 'stopped', 'closed-waiting', 'closed'] as const).map((outcome) => ({ outcome, count: count(outcome) })).filter((p) => p.count > 0)
  if (parts.length === 0) return null
  const ran = items.filter((i) => i.kind === 'finished' || i.kind === 'failed')
  const spent = ran.length > 0 ? spentText(sumCosts(ran.map((i) => runCostInput(i.run)))) : ''
  return { label: sinceLabel(lastSeen, now), parts, spent }
}

/** The whole line as one sentence, for the accessible text: "Since yesterday 18:40: 4 runs finished, 1 failed, $6.42 spent." */
export function sinceSentence(summary: SinceSummary): string {
  return `${summary.label}: ${[...summary.parts.map(outcomeText), ...(summary.spent ? [summary.spent] : [])].join(', ')}.`
}
