// Pure helpers for the History board (components/RunHistory.tsx): status buckets and their counts, the period and
// search filters, day groups with their totals, per-conversation facts and the words of the result line. No React, no
// DOM, no store, no clock (callers pass `now`). Every figure comes from the run summaries or records; an unknown stays
// unknown (null), never 0.
import type { AgentInstance, AgentState, PlanStepStatus, RunSummary } from '@shared/types'
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

/** Whether a conversation's newest session is working or waiting on the user: the "Running now" scope. */
export const isRunningNow = (word: string): boolean => word === 'Running' || word === 'Needs you'

/**
 * The two scope counts under the current filters. `fits` says the conversation passes kind, period and search; `bucket`
 * is the status chip. "All runs" counts what the list would show with that scope, "Running now" what it would show
 * if it were chosen, so each number matches its list.
 */
export function scopeCounts(items: readonly { word: string; bucket: HistoryBucket; fits: boolean }[], chip: 'all' | HistoryBucket): { all: number; running: number } {
  let all = 0
  let running = 0
  for (const it of items) {
    if (!it.fits || (chip !== 'all' && it.bucket !== chip)) continue
    all++
    if (isRunningNow(it.word)) running++
  }
  return { all, running }
}

/** Whether the outputs index is still being fetched, could not be fetched or is in the store. */
export type OutputsPhase = 'loading' | 'failed' | 'ready'

/** The "What it left" line when there is nothing to list yet (or nothing at all); null when files can be listed. */
export function filesNote(phase: OutputsPhase, count: number): string | null {
  if (phase === 'loading') return 'Checking files…'
  if (phase === 'failed') return 'Could not load the files.'
  return count === 0 ? 'No files registered.' : null
}

/** Shown beside "Run it again": what the new request does and does not take from the old run. */
export const RERUN_NOT_CARRIED = 'Model, effort, permission mode, goal and images are not carried over: the run uses this project as it is set up now.'

export type RerunPlan = { ok: true; text: string; mode: 'team' | 'ask' } | { ok: false; reason: string }

/**
 * What "Run it again" does: prefill the New run page of the run's own project with its request, sending nothing. The page
 * applies every start guard (setup pending, a project that cannot start, the permission-mode confirmation). Refuses when
 * the run is not repeatable or does not belong to the project on screen, so it can never land in another project.
 */
export function rerunPlan(run: Pick<RunSummary, 'kind' | 'quick' | 'prompt' | 'projectId' | 'team'>, selectedProjectId: string | null | undefined): RerunPlan {
  if (run.kind !== 'work' || run.quick) return { ok: false, reason: 'Only a team run can be run again.' }
  const text = run.prompt.trim()
  if (!text) return { ok: false, reason: 'This run has no request to repeat.' }
  if (!selectedProjectId) return { ok: false, reason: 'Open the project first.' }
  if (run.projectId !== selectedProjectId) return { ok: false, reason: 'This run belongs to another project. Open that project to run it again.' }
  return { ok: true, text, mode: run.team === 'single' ? 'ask' : 'team' }
}

// ---------- What the agents left (worktree facts) ----------

export interface BranchLine {
  /** Plain words, no counts the record does not hold. */
  title: string
  note: string
}

export interface BranchFacts {
  /** Agents that worked in an isolated copy (a worktree). 0 = none did, or the run is not a code run. */
  isolated: number
  merged: number
  /** Copies kept for the user or the orchestrator: held, in review, conflict, waiting on child copies. */
  kept: number
  conflict: number
  active: number
  /** Distinct file paths named by the copies that merged or are kept, in first-seen order. Line counts are not recorded. */
  files: string[]
}

/** The merge facts of a run's agents, from each worktree's recorded status and changed files only. */
export function branchFacts(agents: readonly Pick<AgentInstance, 'worktree'>[]): BranchFacts {
  const out: BranchFacts = { isolated: 0, merged: 0, kept: 0, conflict: 0, active: 0, files: [] }
  const seen = new Set<string>()
  for (const a of agents) {
    const w = a.worktree
    if (!w) continue
    out.isolated++
    const s = w.status
    if (s === 'merged') out.merged++
    else if (s === 'conflict') {
      out.kept++
      out.conflict++
    } else if (s === 'held' || s === 'review' || s === 'waiting-children') out.kept++
    else if (s === 'active' || s === 'merging') out.active++
    if (s === 'merged' || s === 'conflict' || s === 'held' || s === 'review' || s === 'waiting-children') {
      for (const f of w.changedFiles ?? []) {
        if (!seen.has(f)) {
          seen.add(f)
          out.files.push(f)
        }
      }
    }
  }
  return out
}

/** "3 files" / "1 file". */
export const filesWord = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/** The lines under "What it left" for the merge facts: nothing for facts that are not there. */
export function branchLines(f: BranchFacts, fileCap = 5): BranchLine[] {
  const lines: BranchLine[] = []
  if (f.isolated === 0) return lines
  if (f.merged > 0) lines.push({ title: `${f.merged} ${f.merged === 1 ? 'copy' : 'copies'} merged`, note: f.files.length > 0 ? `${filesWord(f.files.length)} changed` : 'no changed files recorded' })
  if (f.conflict > 0) lines.push({ title: `${f.conflict} could not merge by itself`, note: 'kept, not merged' })
  const heldOnly = f.kept - f.conflict
  if (heldOnly > 0) lines.push({ title: `${heldOnly} ${heldOnly === 1 ? 'copy' : 'copies'} kept`, note: 'not merged' })
  if (f.active > 0) lines.push({ title: `${f.active} still being worked on`, note: 'nothing merged yet' })
  if (lines.length === 0) lines.push({ title: 'Nothing was changed in the project', note: '' })
  for (const p of f.files.slice(0, fileCap)) lines.push({ title: p, note: '' })
  if (f.files.length > fileCap) lines.push({ title: `${f.files.length - fileCap} more files`, note: '' })
  return lines
}

/** The row's merge words for the result line, or '' when the record says nothing about merging. */
export function mergeWord(f: BranchFacts): string {
  if (f.isolated === 0) return ''
  if (f.conflict > 0) return 'Merge needs you'
  if (f.merged > 0 && f.kept === 0 && f.active === 0) return f.files.length > 0 ? `Merged · ${filesWord(f.files.length)} changed` : 'Merged'
  if (f.kept > 0) return 'Kept, not merged'
  return ''
}

// ---------- Retry ("Try again") ----------

export type RetryPlan = { ok: true; request: string } | { ok: false; reason: string }

/** Whether a failed conversation offers "Try again": its newest session ended in error and belongs to the project on screen. */
export function retryPlan(run: Pick<RunSummary, 'status' | 'prompt' | 'projectId'>, selectedProjectId: string | null | undefined): RetryPlan {
  if (run.status !== 'error') return { ok: false, reason: 'Only a failed run can be tried again.' }
  if (!selectedProjectId || run.projectId !== selectedProjectId) return { ok: false, reason: 'Open this run’s project first.' }
  return { ok: true, request: run.prompt.trim() }
}

/** An IPC refusal without Electron's wrapper. */
export function refusalText(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const t = raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '').trim()
  return t || fallback
}

/** The plan summary or, failing that, the root agent's last result, one clipped paragraph. Empty when neither exists. */
export function runSummaryText(opts: { planSummary?: string; rootResult?: string }, max = 360): string {
  const raw = (opts.planSummary?.trim() || opts.rootResult?.trim() || '').replace(/\s+/g, ' ')
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}
