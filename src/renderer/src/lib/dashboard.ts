import type { ProjectKind, ProjectRemoveResult, RunEndedBy, RunStatus } from '@shared/types'
import { chainGroups, isOpenStatus } from './runChains'
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

export const LAST_SEEN_KEY = 'orgai.dashboardSeenAt'

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
  /** Chain links (see lib/runChains): one row per chain. */
  sessionId?: string
  resumedFrom?: string
  /** Only 'work' runs count (quick runs are 'work' too); absent counts as work. */
  kind?: string
  endedAt?: number
  endedBy?: RunEndedBy
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

export const SINCE_WINDOW_MS = 7 * DAY
/** Row caps of the attention column sections (spec 4). */
export const NEEDS_CAP = 5
export const RUNNING_CAP = 6
export const SINCE_LAST_SEEN_CAP = 6
export const PAUSED_CAP = 6

/** Each run once (a run listed in both the live store and history counts once; the first copy wins), chain newest members only. */
function chainNewest<T extends EndedRunLike>(summaries: readonly T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const s of summaries) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    unique.push(s)
  }
  return chainGroups(unique).map((g) => g.newest)
}

/**
 * Spec 4.3: one row per chain (its newest member) that finished or failed after `lastSeen` and at most 7 days ago,
 * kind work (quick runs included), newest first. `more` is how many the cap cut.
 */
export function sinceLastSeen<T extends EndedRunLike>(
  summaries: readonly T[],
  lastSeen: number,
  now: number,
  opts: { cap?: number; clearedAt?: number } = {}
): { items: EndedItem<T>[]; more: number } {
  const cap = Math.max(0, opts.cap ?? SINCE_LAST_SEEN_CAP)
  // M1: a run cut while it waited on the user stays until "Mark all seen" (clearedAt), whatever the last-seen time says.
  const closedWaitingSince = Math.min(lastSeen, opts.clearedAt ?? lastSeen)
  const all: EndedItem<T>[] = []
  for (const run of chainNewest(summaries)) {
    if (run.status !== 'finished' && run.status !== 'error') continue
    if (run.kind !== undefined && run.kind !== 'work') continue
    const kind = endedKind(run)
    if (!kind || kind === 'paused') continue
    const endedAt = run.endedAt ?? run.startedAt
    if (endedAt <= (kind === 'closed-waiting' ? closedWaitingSince : lastSeen) || endedAt < now - SINCE_WINDOW_MS) continue
    all.push({ run, kind, endedAt })
  }
  all.sort((a, b) => b.endedAt - a.endedAt || b.run.startedAt - a.run.startedAt || a.run.id.localeCompare(b.run.id))
  return { items: all.slice(0, cap), more: Math.max(0, all.length - cap) }
}

/** Spec 4.4: chains whose newest member is paused, newest start first. */
export function pausedRuns<T extends EndedRunLike>(summaries: readonly T[]): T[] {
  return chainNewest(summaries)
    .filter((r) => r.status === 'paused')
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
}

/** The first line of an error text, cut at `max` characters with an ellipsis. */
export function errorFirstLine(error: string | undefined, max = 100): string {
  const line = (error ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
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

/**
 * Spec 4.2 plan line: "Plan blocked", "Plan done", else "Step 3 of 7" (total = steps not skipped, current = 1 + the
 * first step not done among them). Null without a plan or counted steps.
 */
export function planStepLabel(plan: { status?: string; steps: readonly { status: string }[] } | null | undefined): string | null {
  if (!plan) return null
  if (plan.status === 'blocked') return 'Plan blocked'
  if (plan.status === 'done') return 'Plan done'
  const steps = plan.steps.filter((s) => s.status !== 'skipped')
  if (steps.length === 0) return null
  const open = steps.findIndex((s) => s.status !== 'done')
  return `Step ${(open < 0 ? steps.length - 1 : open) + 1} of ${steps.length}`
}

/** The Dashboard's one big figure (spec 3): decisions, then live runs, then paused, else quiet; no projects is a welcome. */
export function heroFigure(input: { decisions: number; running: number; paused: number; projects: number }): { figure: string } {
  const { decisions, running, paused, projects } = input
  if (projects === 0 && decisions === 0 && running === 0 && paused === 0) return { figure: 'Welcome to OrgAI' }
  if (decisions > 0) return { figure: decisions === 1 ? '1 needs you' : `${decisions} need you` }
  if (running > 0) return { figure: `${running} running` }
  if (paused > 0) return { figure: `${paused} paused` }
  return { figure: 'All quiet' }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The text parts of the hero subline before the cost: "3 projects", "2 runs open". Empty parts are left out. */
export function heroSublineParts(input: { projects: number; openRuns: number; closedWaiting?: number; quiet?: boolean }): string[] {
  const parts: string[] = []
  if (input.projects > 0) parts.push(plural(input.projects, 'project', 'projects'))
  if (input.openRuns > 0) parts.push(`${plural(input.openRuns, 'run', 'runs')} open`)
  // M2: "All quiet" must not hide runs OrgAI cut while they waited on the user.
  const cut = Math.max(0, Math.floor(input.closedWaiting ?? 0))
  if (input.quiet && cut > 0) parts.push(`${cut} ${cut === 1 ? 'was' : 'were'} waiting on you when OrgAI closed`)
  return parts
}

export const FIRST_LAUNCH_LINE = 'Start a project or just chat. Nothing runs until you say so.'

// ---------------------------------------------------------------- forget an engagement (engagement-2 spec 6)

/** The tile menu item: an engagement is forgotten, a code project deleted. */
export function tileRemoveLabel(kind: ProjectKind): string {
  return kind === 'engagement' ? 'Forget engagement…' : 'Delete project…'
}

/** The confirm button of the same action. */
export function removeConfirmLabel(kind: ProjectKind): string {
  return kind === 'engagement' ? 'Forget engagement' : 'Delete project'
}

export interface ForgetConfirmText {
  /** One list row each; counts of zero are left out. Empty when the counts are unavailable. */
  lines: string[]
  /** Set when the dry run was unavailable: the kinds are named without numbers. */
  uncounted: string | null
  stays: string
}

/**
 * The forget confirm's list from the dry-run counts (null = unavailable). `openRuns` is how many runs of the
 * engagement are open now (the preview does not say); `folder` names the working folder.
 */
export function forgetConfirmText(preview: ProjectRemoveResult | null, openRuns: number, folder: string): ForgetConfirmText {
  const stays = `Stays: files in ${folder || 'the working folder'} and in the reference folders, your library skills, custom servers and connected services.`
  if (!preview) {
    return { lines: [], uncounted: 'its plan, context notes, what the team recorded, saved rules, runs and costs', stays }
  }
  const lines: string[] = []
  if (preview.documentRemoved) lines.push('The engagement plan')
  if (preview.notesRemoved > 0) lines.push(plural(preview.notesRemoved, 'context note', 'context notes'))
  if (preview.knowledgeRemoved > 0) lines.push(plural(preview.knowledgeRemoved, 'recorded item', 'recorded items'))
  if (preview.rulesRemoved) lines.push('Saved permission rules')
  const open = Math.max(0, Math.floor(openRuns))
  if (preview.runsRemoved > 0) {
    const runs = `${plural(preview.runsRemoved, 'run', 'runs')} with ${preview.runsRemoved === 1 ? 'its' : 'their'} transcripts and costs`
    lines.push(open > 0 ? `Ends ${plural(open, 'open run', 'open runs')} and deletes ${runs}` : runs.charAt(0).toUpperCase() + runs.slice(1))
  } else if (open > 0) {
    lines.push(`Ends ${plural(open, 'open run', 'open runs')}`)
  }
  if (preview.skillsRemoved > 0) lines.push(`${plural(preview.skillsRemoved, 'skill copy', 'skill copies')} made for it`)
  const review = (preview.teamReviewRemoved ? 1 : 0) + (preview.skillEvaluationRemoved ? 1 : 0)
  if (review > 0) lines.push(plural(review, 'team review file', 'team review files'))
  return { lines, uncounted: null, stays }
}

/** The Dashboard notice after a forget: "Forgot Acme. Deleted the plan, 12 notes, 40 recorded items, its saved rules, 23 runs." */
export function forgetNoticeText(name: string, result: ProjectRemoveResult): string {
  const parts: string[] = []
  if (result.documentRemoved) parts.push('the plan')
  if (result.notesRemoved > 0) parts.push(plural(result.notesRemoved, 'note', 'notes'))
  if (result.knowledgeRemoved > 0) parts.push(plural(result.knowledgeRemoved, 'recorded item', 'recorded items'))
  if (result.rulesRemoved) parts.push('its saved rules')
  if (result.runsRemoved > 0) parts.push(plural(result.runsRemoved, 'run', 'runs'))
  if (result.skillsRemoved > 0) parts.push(plural(result.skillsRemoved, 'skill copy', 'skill copies'))
  return parts.length === 0 ? `Forgot ${name}.` : `Forgot ${name}. Deleted ${parts.join(', ')}.`
}

/** What deleting a project removes, in the confirm dialog (spec 5.1). `historyRuns` is every saved run, open ones included. */
export function deleteProjectBody(input: { openRuns: number; historyRuns: number }): string {
  const open = Math.max(0, Math.floor(input.openRuns))
  const hist = Math.max(0, Math.floor(input.historyRuns))
  const files = 'Files in its folder are untouched.'
  const also = 'Its project skills and saved service secrets go too.'
  if (open === 0 && hist === 0) return `Removes the project from OrgAI. ${files}`
  const wipe = `the history, transcripts and costs of ${plural(hist, 'run', 'runs')}`
  if (open === 0) return `Deletes ${wipe}. ${also} ${files}`
  if (hist === 0) return `Ends ${plural(open, 'open run', 'open runs')}. ${also} ${files}`
  return `Ends ${plural(open, 'open run', 'open runs')} and deletes ${wipe}. ${also} ${files}`
}
