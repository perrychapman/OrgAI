// Pure helpers for the History board (components/RunHistory.tsx): status buckets and their counts, the period and
// search filters, day groups with their totals, per-conversation facts and the words of the result line. No React, no
// DOM, no store, no clock (callers pass `now`). Every figure comes from the run summaries or records; an unknown stays
// unknown (null), never 0.
import type { AgentState, PlanStepStatus, RunSummary } from '@shared/types'
import type { StatusWord } from './runStatus'

/** The chips: what a conversation's newest session is doing or how it ended. */
export type HistoryBucket = 'running' | 'open' | 'finished' | 'failed' | 'stopped'

/** Chip order after "All". "Open" holds the open sessions that are not working right now (needs you, idle, paused). */
export const BUCKET_ORDER: readonly HistoryBucket[] = ['running', 'open', 'finished', 'failed', 'stopped']

export const BUCKET_LABEL: Readonly<Record<HistoryBucket, string>> = {
  running: 'Running',
  open: 'Still open',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped'
}

/** The bucket of a shared status word (lib/runStatus.ts). */
export function bucketOf(word: StatusWord): HistoryBucket {
  switch (word) {
    case 'Running':
      return 'running'
    case 'Needs you':
    case 'Idle':
    case 'Paused':
      return 'open'
    case 'Failed':
      return 'failed'
    case 'Stopped':
      return 'stopped'
    default:
      return 'finished'
  }
}

export function bucketCounts(buckets: readonly HistoryBucket[]): Record<HistoryBucket, number> {
  const out: Record<HistoryBucket, number> = { running: 0, open: 0, finished: 0, failed: 0, stopped: 0 }
  for (const b of buckets) out[b]++
  return out
}

// ---------- Period ----------

export type HistoryPeriod = 'all' | '7' | '30'

export const PERIOD_OPTIONS: readonly { value: HistoryPeriod; label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: 'all', label: 'All time' }
]

const DAY_MS = 86_400_000

/** True when `at` is inside the period; 'all' keeps everything. The window starts at local midnight N-1 days ago. */
export function inPeriod(at: number, period: HistoryPeriod, now: number): boolean {
  if (period === 'all') return true
  const days = Number(period)
  // Calendar arithmetic, not 24 h steps: a day with a clock change is 23 or 25 hours long.
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return at >= start.getTime()
}

// ---------- Search ----------

/** Case-insensitive: every word of the query must appear in one of the fields. An empty query matches. */
export function matchesQuery(fields: readonly (string | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fields
    .filter((f): f is string => !!f)
    .join('\n')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}

// ---------- Days ----------

/** Local midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today", "Yesterday", the weekday for the rest of the last week, else "4 Nov" (with the year when it is not this one). */
export function dayLabel(ms: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const d = new Date(ms)
  if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export interface DayGroup<T> {
  /** Local midnight, as text (a stable React key). */
  key: string
  label: string
  items: T[]
}

/** Items (already newest first) grouped by the local day of `at(item)`; days and the items in them keep their order. */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number, now: number): DayGroup<T>[] {
  const days: DayGroup<T>[] = []
  for (const item of items) {
    const start = startOfDay(at(item))
    const key = String(start)
    const last = days[days.length - 1]
    if (last && last.key === key) last.items.push(item)
    else days.push({ key, label: dayLabel(start, now), items: [item] })
  }
  return days
}

/**
 * The first days holding at least `limit` items (a day is never cut), and how many items are left out. A `limit` of 0 or
 * less shows everything.
 */
export function takeDays<T>(days: readonly DayGroup<T>[], limit: number): { shown: DayGroup<T>[]; hidden: number } {
  if (limit <= 0) return { shown: [...days], hidden: 0 }
  const shown: DayGroup<T>[] = []
  let count = 0
  for (const d of days) {
    if (count >= limit) break
    shown.push(d)
    count += d.items.length
  }
  const total = days.reduce((n, d) => n + d.items.length, 0)
  return { shown, hidden: total - count }
}

/** "1 run" / "3 runs". */
export const runsLabel = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`

/** "1 agent" / "5 agents". */
export const agentsLabel = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'}`

// ---------- One conversation ----------

export interface ChainFacts {
  /** Agents over every session; null when any session has no usage figure yet. */
  agents: number | null
  /** Working time over every session, ms; null when any session has no usage figure yet. */
  wallMs: number | null
}

/** Sums of a conversation's sessions. A session without `usage` makes the figure unknown rather than smaller. */
export function chainFacts(members: readonly Pick<RunSummary, 'usage'>[]): ChainFacts {
  let agents = 0
  let wallMs = 0
  for (const m of members) {
    if (!m.usage) return { agents: null, wallMs: null }
    agents += m.usage.agents
    wallMs += m.usage.wallMs
  }
  return { agents, wallMs }
}

/**
 * The second line of a row, in the app's own words: the status word, then what is known about why (a failure's
 * message, a pause reason, the status note) and how many sessions the conversation has. Never a merge or file claim:
 * those come from the run's own facts where they exist.
 */
export function resultLine(opts: { word: StatusWord; note?: string; error?: string; pauseReason?: string; sessions: number }): string {
  const parts: string[] = [opts.word]
  const why = opts.word === 'Failed' ? oneLine(opts.error) : opts.word === 'Paused' ? oneLine(opts.pauseReason) : ''
  if (why) parts.push(why)
  else if (opts.note) parts.push(opts.note)
  if (opts.sessions > 1) parts.push(`${opts.sessions} sessions`)
  return parts.join(' · ')
}

/** First line of a message, trimmed to `max` characters with an ellipsis. */
export function oneLine(text: string | undefined, max = 120): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  const t = line.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ---------- Agents of a run (selected run's record) ----------

export type AgentMark = 'done' | 'error' | 'working' | 'waiting' | 'idle'

const MARK_OF: Record<AgentState, AgentMark> = {
  starting: 'working',
  thinking: 'working',
  tool: 'working',
  delegating: 'working',
  waiting: 'waiting',
  idle: 'idle',
  done: 'done',
  error: 'error'
}

export const MARK_WORD: Readonly<Record<AgentMark, string>> = {
  done: 'done',
  error: 'failed',
  working: 'working',
  waiting: 'waiting',
  idle: 'idle'
}

export interface AgentTally {
  /** One mark per agent, in the record's order, at most `cap`. */
  marks: AgentMark[]
  /** Agents not drawn because of the cap. */
  more: number
  counts: Record<AgentMark, number>
  total: number
}

/** The agents of one run as marks and counts, from their final states. Empty input gives total 0 (nothing to draw). */
export function agentTally(states: readonly AgentState[], cap = 24): AgentTally {
  const counts: Record<AgentMark, number> = { done: 0, error: 0, working: 0, waiting: 0, idle: 0 }
  const all = states.map((s) => MARK_OF[s])
  for (const m of all) counts[m]++
  return { marks: all.slice(0, cap), more: Math.max(0, all.length - cap), counts, total: all.length }
}

const MARK_ORDER: readonly AgentMark[] = ['error', 'waiting', 'working', 'idle', 'done']

/** "11 done, 1 failed": the non-zero counts, trouble first. */
export function tallyText(t: AgentTally): string {
  return MARK_ORDER.filter((m) => t.counts[m] > 0)
    .map((m) => `${t.counts[m]} ${MARK_WORD[m]}`)
    .join(', ')
}

// ---------- Plan steps ("How it went") ----------

export type StepTone = 'ok' | 'bad' | 'working' | 'pending' | 'skipped'

export const STEP_WORD: Readonly<Record<PlanStepStatus, string>> = {
  done: 'Done',
  blocked: 'Blocked',
  in_progress: 'In progress',
  pending: 'Not started',
  skipped: 'Skipped'
}

export function stepTone(status: PlanStepStatus): StepTone {
  switch (status) {
    case 'done':
      return 'ok'
    case 'blocked':
      return 'bad'
    case 'in_progress':
      return 'working'
    case 'skipped':
      return 'skipped'
    default:
      return 'pending'
  }
}

/** The plan summary or, failing that, the root agent's last result, one clipped paragraph. Empty when neither exists. */
export function runSummaryText(opts: { planSummary?: string; rootResult?: string }, max = 360): string {
  const raw = (opts.planSummary?.trim() || opts.rootResult?.trim() || '').replace(/\s+/g, ' ')
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}
