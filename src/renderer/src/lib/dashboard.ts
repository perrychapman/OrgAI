import type { RunStatus } from '@shared/types'
import { isOpenStatus } from './runChains'
import { waitingItems, type WaitRun } from './needsYou'

/** Pure helpers for the Dashboard. They take plain data and never touch the store. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ---------------------------------------------------------------- project order

/** Per-project facts that decide where its card sits. */
export interface ProjectAttention {
  /** Open decisions (cards) across the project's runs. */
  decisions: number
  /** Live (open) runs. */
  liveRuns: number
  /** Start of the project's newest run, live or in history (epoch ms). */
  newestStart?: number
}

/** Projects ordered by what needs the user: decisions, then live runs, then the newest run, then name. */
export function projectAttentionOrder<T extends { id: string; name: string }>(projects: readonly T[], ctx: Readonly<Record<string, ProjectAttention | undefined>>): T[] {
  const of = (p: T): ProjectAttention => ctx[p.id] ?? { decisions: 0, liveRuns: 0 }
  return [...projects].sort((a, b) => {
    const x = of(a)
    const y = of(b)
    return (
      y.decisions - x.decisions ||
      y.liveRuns - x.liveRuns ||
      (y.newestStart ?? 0) - (x.newestStart ?? 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id)
    )
  })
}

/**
 * Builds the ordering context from the store's live runs and per-project history. A run in both is counted once for
 * the newest start; live runs come from `runs` (their decisions are the open cards).
 */
export function buildAttentionCtx(
  runs: readonly (WaitRun & { summary: { projectId: string } })[],
  historyByProject: Readonly<Record<string, readonly { id: string; startedAt: number }[]>>
): Record<string, ProjectAttention> {
  const ctx: Record<string, ProjectAttention> = {}
  const at = (id: string): ProjectAttention => (ctx[id] ??= { decisions: 0, liveRuns: 0 })
  const newest = (id: string, startedAt: number): void => {
    const c = at(id)
    if (c.newestStart === undefined || startedAt > c.newestStart) c.newestStart = startedAt
  }
  for (const r of runs) {
    const c = at(r.summary.projectId)
    if (isOpenStatus(r.summary.status)) c.liveRuns += 1
    c.decisions += waitingItems(r).length
    newest(r.summary.projectId, r.summary.startedAt)
  }
  for (const [projectId, list] of Object.entries(historyByProject)) {
    at(projectId)
    for (const h of list) newest(projectId, h.startedAt)
  }
  return ctx
}

// ---------------------------------------------------------------- since you last looked

export const LAST_SEEN_KEY = 'orgai.dashboardLastSeen'

/** Reads the saved timestamp; null when absent, unreadable or not a positive finite number. */
export function readLastSeen(storage: Pick<Storage, 'getItem'> | null | undefined): number | null {
  try {
    const raw = storage?.getItem(LAST_SEEN_KEY)
    if (raw === null || raw === undefined || raw.trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Saves the timestamp; storage failures (quota, privacy mode) are ignored. */
export function writeLastSeen(storage: Pick<Storage, 'setItem'> | null | undefined, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    storage?.setItem(LAST_SEEN_KEY, String(Math.floor(ms)))
  } catch {
    // ignore
  }
}

export type EndedKind = 'finished' | 'failed' | 'stopped' | 'closed' | 'closed-waiting' | 'paused'

/** The fields of a run summary these helpers read. */
export interface EndedRunLike {
  id: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  endedBy?: 'user' | 'app'
  endedWhile?: 'working' | 'waiting'
  endedWithApp?: true
}

export interface EndedItem<T extends EndedRunLike> {
  run: T
  kind: EndedKind
  /** When it ended: endedAt, else its start. */
  endedAt: number
}

/** Why an ended run ended, or null for a live run. */
export function endedKind(run: EndedRunLike): EndedKind | null {
  if (isOpenStatus(run.status)) return null
  if (run.status === 'paused') return 'paused'
  if (run.endedBy === 'app' || run.endedWithApp) return run.endedWhile === 'waiting' ? 'closed-waiting' : 'closed'
  if (run.endedBy === 'user') return 'stopped'
  if (run.status === 'error') return 'failed'
  return 'finished'
}

export const FIRST_VISIT_WINDOW_MS = DAY
export const SINCE_LAST_SEEN_CAP = 5

/**
 * Runs that ended after `lastSeen`, newest first, live runs excluded. With no `lastSeen` (first visit) the last 24 hours.
 * A run listed twice (live store and history) counts once. `more` is how many the cap cut.
 */
export function sinceLastSeen<T extends EndedRunLike>(
  summaries: readonly T[],
  lastSeen: number | null,
  now: number,
  opts: { cap?: number } = {}
): { items: EndedItem<T>[]; more: number } {
  const since = lastSeen ?? now - FIRST_VISIT_WINDOW_MS
  const cap = Math.max(0, opts.cap ?? SINCE_LAST_SEEN_CAP)
  const seen = new Set<string>()
  const all: EndedItem<T>[] = []
  for (const run of summaries) {
    if (seen.has(run.id)) continue
    seen.add(run.id)
    const kind = endedKind(run)
    if (!kind) continue
    const endedAt = run.endedAt ?? run.startedAt
    if (endedAt <= since) continue
    all.push({ run, kind, endedAt })
  }
  all.sort((a, b) => b.endedAt - a.endedAt || b.run.startedAt - a.run.startedAt || a.run.id.localeCompare(b.run.id))
  return { items: all.slice(0, cap), more: Math.max(0, all.length - cap) }
}

// ---------------------------------------------------------------- week cost

export const WEEK_MS = 7 * DAY

export interface WeekCost {
  /** Sum of the known costs; null when no run in the week has a known cost (never shown as $0). */
  costUsd: number | null
  /** Some run's cost is unknown or partial: the sum is a lower bound. */
  partial: boolean
  /** Runs started in the window. */
  runs: number
}

/** Cost of runs started in the last 7 days (rolling), each run once. */
export function weekCost(
  summaries: readonly { id: string; startedAt: number; usage?: { costUsd: number | null; costPartial?: true } }[],
  now: number
): WeekCost {
  const from = now - WEEK_MS
  const seen = new Set<string>()
  let sum = 0
  let known = 0
  let partial = false
  let runs = 0
  for (const s of summaries) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    if (s.startedAt < from) continue
    runs += 1
    const c = s.usage?.costUsd
    if (typeof c === 'number' && Number.isFinite(c)) {
      sum += c
      known += 1
      if (s.usage?.costPartial) partial = true
    } else {
      partial = true
    }
  }
  if (runs === 0) return { costUsd: 0, partial: false, runs: 0 }
  return { costUsd: known > 0 ? sum : null, partial, runs }
}

// ---------------------------------------------------------------- words

/** How long a run has been going: "just started", "4 min", "1 h 12 min", "2 d". */
export function elapsedLabel(startMs: number, now: number): string {
  const ms = Math.max(0, now - startMs)
  if (ms < MINUTE) return 'just started'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return m === 0 ? `${h} h` : `${h} h ${m} min`
  }
  return `${Math.floor(ms / DAY)} d`
}

/** "Step 3 of 7" for the first step not yet done, "All 7 steps done", or null without a plan or steps. */
export function planStepLabel(plan: { steps: readonly { status: string }[] } | null | undefined): string | null {
  const steps = plan?.steps
  if (!steps || steps.length === 0) return null
  const open = steps.findIndex((s) => s.status !== 'done' && s.status !== 'skipped')
  if (open < 0) return steps.length === 1 ? 'All 1 step done' : `All ${steps.length} steps done`
  return `Step ${open + 1} of ${steps.length}`
}

/** The Dashboard's one big figure and the line under it. */
export function heroFigure(input: { decisions: number; running: number }): { figure: string; caption: string } {
  const { decisions, running } = input
  if (decisions > 0) {
    return {
      figure: decisions === 1 ? '1 needs you' : `${decisions} need you`,
      caption: decisions === 1 ? 'decision waiting' : 'decisions waiting'
    }
  }
  if (running > 0) return { figure: `${running} running`, caption: running === 1 ? 'run in progress' : 'runs in progress' }
  return { figure: 'All quiet', caption: 'Nothing is running or waiting for you' }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What deleting a project removes, in the confirm dialog. `historyRuns` is every saved run, open ones included. */
export function deleteProjectBody(input: { openRuns: number; historyRuns: number }): string {
  const open = Math.max(0, Math.floor(input.openRuns))
  const hist = Math.max(0, Math.floor(input.historyRuns))
  const files = 'Files in its folder are untouched.'
  if (open === 0 && hist === 0) return `Deletes the project from OrgAI. It has no runs. ${files}`
  const wipe = `the history, transcripts and costs of ${plural(hist, 'run', 'runs')}`
  if (open === 0) return `Deletes ${wipe}. ${files}`
  if (hist === 0) return `Ends ${plural(open, 'open run', 'open runs')} and deletes the project from OrgAI. ${files}`
  return `Ends ${plural(open, 'open run', 'open runs')} and deletes ${wipe}. ${files}`
}
