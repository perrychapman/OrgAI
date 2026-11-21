/**
 * Pick up where you left off (docs/design/dashboard-overhaul.md 7.4). Pure: no store, no DOM.
 *
 * One row per conversation (a session chain, shown by its newest member), work runs only. Kinds in order: paused,
 * closed (ended with OrgAI while waiting on the person), failed and finished since the last visit, pinned projects
 * (their newest thread, or "no runs yet"), then every other thread newest first. A live chain belongs to Working
 * now and is left out unless that section is hidden; then it is a `recent` row with the action "Open".
 */
import type { RunSummary } from '@shared/types'
import { costView, type CostInput } from './cost'
import { chainGroups, isOpenStatus, lastActivityAt, type ChainSummary } from './runChains'
import { clockLabel, endedKind, errorFirstLine, SINCE_WINDOW_MS, type EndedRunLike } from './dashboard'
import { pausedCaption } from './needsInline'

export type ResumeKind = 'paused' | 'closed' | 'failed' | 'finished' | 'pinned' | 'recent'

/** The one action of a row (`data-action`). */
export type ResumeAction = 'resume' | 'continue' | 'open'

/** How the row's action is decided: see `resumeAction`. */
export type ResumeFlavor = 'paused' | 'live' | 'failed' | 'closed' | 'done' | 'empty'

/** Most rows Pick up ever lists, even after "Show more" (History is the archive). */
export const RESUME_ROW_MAX = 12

/** The run fields these rows read. */
export interface ResumeRun extends EndedRunLike, ChainSummary {
  projectId: string
  error?: string
  pauseReason?: string
  autoResume?: boolean
  pausedUntil?: number
}

export interface ResumeRow<T extends ResumeRun> {
  /** Unique and stable: the newest run's id, or `pin:{projectId}` for a pinned project without runs. */
  key: string
  kind: ResumeKind
  flavor: ResumeFlavor
  projectId: string
  /** The chain's newest member; null for a pinned project with no runs. */
  run: T | null
  /** Every run id of the chain (the outputs of any of them count). */
  chainIds: string[]
  /** The newest member can be continued (a stopped run with a provider session). */
  continuable: boolean
  /** When the run ended, else started (epoch ms); 0 without a run. */
  at: number
  /** The third line: why a closed or failed run stopped, a pause reason, "No runs yet."; empty when none. */
  detail: string
}

export interface ResumeInput<T extends ResumeRun> {
  summaries: readonly T[]
  /** The time the person last left the Dashboard (epoch ms). */
  lastSeen: number
  now: number
  /** Working now is hidden: a live chain then shows here. */
  workingHidden: boolean
  /** Pinned project ids in pin order. */
  pinned: readonly string[]
  /** Ids of the projects that exist; a pin of any other id is ignored. */
  projectIds: Iterable<string>
  max?: number
}

/** Work runs count (an absent kind is a work run, as the older helpers read it). */
const isWork = (r: { kind?: string }): boolean => r.kind === undefined || r.kind === 'work'

/** What the row's detail line says for a closed run. */
export const CLOSED_WAITING_DETAIL = 'Was waiting on you when OrgAI closed.'
export const NO_RUNS_DETAIL = 'No runs yet.'

/** One thread per chain of each project's work runs, newest member first in each group, merged by newest start. */
function threads<T extends ResumeRun>(summaries: readonly T[]): { newest: T; ids: string[] }[] {
  const seen = new Set<string>()
  const byProject = new Map<string, T[]>()
  for (const s of summaries) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    const list = byProject.get(s.projectId)
    if (list) list.push(s)
    else byProject.set(s.projectId, [s])
  }
  const out: { newest: T; ids: string[] }[] = []
  for (const list of byProject.values()) {
    for (const g of chainGroups(list)) {
      if (!isWork(g.newest)) continue
      out.push({ newest: g.newest, ids: g.members.map((m) => m.id) })
    }
  }
  return out.sort((a, b) => b.newest.startedAt - a.newest.startedAt || a.newest.id.localeCompare(b.newest.id))
}

const byActivity = <T extends ResumeRun>(a: ResumeRow<T>, b: ResumeRow<T>): number =>
  b.at - a.at || (b.run?.startedAt ?? 0) - (a.run?.startedAt ?? 0) || a.key.localeCompare(b.key)

/** The rows of Pick up, in order, at most `max` (default 12). */
export function resumeRows<T extends ResumeRun>(input: ResumeInput<T>): ResumeRow<T>[] {
  const { lastSeen, now, workingHidden, pinned } = input
  const max = Math.max(0, input.max ?? RESUME_ROW_MAX)
  const known = new Set(input.projectIds)
  const all = threads(input.summaries)
  const claimed = new Set<string>()
  const rowOf = (t: { newest: T; ids: string[] }, kind: ResumeKind, flavor: ResumeFlavor, detail = ''): ResumeRow<T> => ({
    key: t.newest.id,
    kind,
    flavor,
    projectId: t.newest.projectId,
    run: t.newest,
    chainIds: t.ids,
    continuable: canContinueRun(t.newest),
    at: lastActivityAt(t.newest),
    detail
  })

  // The newest thread of each project, with the flavor its status gives it.
  const live = (t: { newest: T }): boolean => isOpenStatus(t.newest.status)
  const hiddenLive = (t: { newest: T }): boolean => live(t) && !workingHidden
  const flavorOf = (r: T): ResumeFlavor => {
    if (r.status === 'paused') return 'paused'
    if (isOpenStatus(r.status)) return 'live'
    if (r.status === 'error') return 'failed'
    return endedKind(r) === 'closed-waiting' ? 'closed' : 'done'
  }

  const paused: ResumeRow<T>[] = []
  const closed: ResumeRow<T>[] = []
  const failed: ResumeRow<T>[] = []
  const finished: ResumeRow<T>[] = []
  const rest: { t: { newest: T; ids: string[] }; row: ResumeRow<T> }[] = []

  for (const t of all) {
    const r = t.newest
    if (hiddenLive(t)) continue
    const kind = endedKind(r)
    const endedAt = r.endedAt ?? r.startedAt
    const recentEnough = endedAt >= now - SINCE_WINDOW_MS
    if (r.status === 'paused') {
      paused.push(rowOf(t, 'paused', 'paused', r.pauseReason ? errorFirstLine(r.pauseReason) : ''))
    } else if (kind === 'closed-waiting' && (r.status === 'finished' || r.status === 'error') && recentEnough) {
      closed.push(rowOf(t, 'closed', 'closed', CLOSED_WAITING_DETAIL))
    } else if (r.status === 'error' && kind === 'failed' && endedAt > lastSeen && recentEnough) {
      failed.push(rowOf(t, 'failed', 'failed', errorFirstLine(r.error)))
    } else if (r.status === 'finished' && kind === 'finished' && endedAt > lastSeen && recentEnough) {
      finished.push(rowOf(t, 'finished', 'done'))
    } else {
      rest.push({ t, row: rowOf(t, 'recent', flavorOf(r)) })
    }
  }

  paused.sort((a, b) => (b.run?.startedAt ?? 0) - (a.run?.startedAt ?? 0) || a.key.localeCompare(b.key))
  closed.sort(byActivity)
  failed.sort(byActivity)
  finished.sort(byActivity)

  const rows: ResumeRow<T>[] = [...paused, ...closed, ...failed, ...finished]
  for (const row of rows) claimed.add(row.key)

  // Pinned projects, in pin order: the newest thread (even a live one while Working now shows it is skipped there),
  // or "no runs yet".
  const pins: ResumeRow<T>[] = []
  const seenPins = new Set<string>()
  for (const id of pinned) {
    if (!known.has(id) || seenPins.has(id)) continue
    seenPins.add(id)
    const newest = all.find((t) => t.newest.projectId === id)
    if (!newest) {
      pins.push({ key: `pin:${id}`, kind: 'pinned', flavor: 'empty', projectId: id, run: null, chainIds: [], continuable: false, at: 0, detail: NO_RUNS_DETAIL })
      continue
    }
    // Its newest thread is in Working now, or already above: it is not listed twice.
    if (hiddenLive(newest) || claimed.has(newest.newest.id)) continue
    const row = rest.find((e) => e.row.key === newest.newest.id)?.row ?? rowOf(newest, 'recent', flavorOf(newest.newest))
    pins.push({ ...row, kind: 'pinned' })
    claimed.add(row.key)
  }
  rows.push(...pins)

  const others = rest
    .map((e) => e.row)
    .filter((r) => !claimed.has(r.key))
    .sort(byActivity)
  rows.push(...others)
  return rows.slice(0, max)
}

/** Continue is offered on the chain's newest member once it stopped and has a provider session (lib/runChains canContinueIn). */
function canContinueRun(r: ResumeRun): boolean {
  return (r.status === 'finished' || r.status === 'error' || r.status === 'paused') && (!!r.sessionId || !!r.modelSelection)
}

/**
 * The rows of Pick up (dashboard-usage-redesign dashboard.md): the paused and recently ended work runs of `resumeRows`,
 * newest first, as one list. Left out: a pinned project that has no run yet (Projects says it), a live chain (Right now
 * shows it) and a run that ended before the last visit or more than 7 days ago unless it can still be continued. Rows
 * that are paused, closed with OrgAI or ended since the last visit keep their kind; `since` marks those ended after
 * `lastSeen`.
 */
export function pickUpRows<T extends ResumeRun>(rows: readonly ResumeRow<T>[], now: number): ResumeRow<T>[] {
  return rows
    .filter((r) => {
      if (!r.run || r.flavor === 'empty' || r.flavor === 'live') return false
      if (r.kind === 'paused' || r.kind === 'closed' || r.kind === 'failed' || r.kind === 'finished') return true
      return r.continuable && r.at >= now - SINCE_WINDOW_MS
    })
    .sort(byActivity)
}

/** Ended after the person last left the Dashboard (the rows that are `closed`, `failed` or `finished` by `resumeRows`). */
export const endedSinceLastVisit = (row: Pick<ResumeRow<ResumeRun>, 'kind'>): boolean => row.kind === 'closed' || row.kind === 'failed' || row.kind === 'finished'

/**
 * The one action of a Pick up row: a paused run Continues in place ("Continue" resumes it now), a stopped run that has a
 * provider session Continues in its composer, anything else Opens.
 */
export function pickUpAction(row: Pick<ResumeRow<ResumeRun>, 'flavor' | 'continuable'>): ResumeAction {
  if (row.flavor === 'paused') return 'resume'
  return row.continuable ? 'continue' : 'open'
}

const startOfLocalDay = (t: number): number => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * A paused row's caption with the day when the resume is not today (walk 4 M1), in local time: "resumes at 10:40 PM if OrgAI
 * stays open" today, "resumes tomorrow at 10:40 PM ..." the next local day, "resumes Saturday at ..." within a week after
 * that, else "resumes Nov 28 at ...". Without an automatic resume it is the plain "waits for you to continue" that
 * `pausedCaption` (lib/needsInline.ts, left untouched) gives.
 */
export function pausedResumeCaption(s: Pick<RunSummary, 'autoResume' | 'pausedUntil'>, now: number, locale?: string): string {
  if (!(s.autoResume && s.pausedUntil)) return pausedCaption(s)
  const at = new Date(s.pausedUntil)
  const time = clockLabel(s.pausedUntil, locale)
  const days = Math.round((startOfLocalDay(s.pausedUntil) - startOfLocalDay(now)) / 86_400_000)
  let when = `at ${time}`
  if (days === 1) when = `tomorrow at ${time}`
  else if (days >= 2 && days <= 6) when = `${at.toLocaleDateString(locale, { weekday: 'long' })} at ${time}`
  else if (days >= 7) when = `${at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} at ${time}`
  return `resumes ${when} if OrgAI stays open`
}

/** Line 2: "{project} · {age}", or "{client} · {project} · {age}". A paused row's age is its pause caption. */
export function resumeCaption(
  row: Pick<ResumeRow<ResumeRun>, 'flavor' | 'run'>,
  ctx: { project: string; client?: string; age: string; now?: number; locale?: string }
): string {
  const tail = row.flavor === 'paused' && row.run ? pausedResumeCaption(row.run, ctx.now ?? Date.now(), ctx.locale) : ctx.age
  return [ctx.client, ctx.project, tail].filter((p): p is string => !!p).join(' · ')
}

/** The accessible name of a row's action button: the verb and the run's title, so no two buttons read alike. */
export function resumeActionName(action: ResumeAction, ctx: { runName: string }): string {
  switch (action) {
    case 'resume':
      return `Continue ${ctx.runName} now`
    case 'continue':
      return `Continue ${ctx.runName}`
    case 'open':
      return `Open ${ctx.runName}`
  }
}

/** The visible label of an action. */
export function resumeActionLabel(action: ResumeAction): string {
  return action === 'open' ? 'Open' : 'Continue'
}

/** The row's muted cost: a known figure (or a lower bound) above zero. Zero shows nothing; an unpriced run says so (`isUnpricedRun`). */
export function showsRunCost(input: CostInput): boolean {
  const v = costView(input)
  return (v.kind === 'known' || v.kind === 'partial') && input.costUsd !== null && input.costUsd > 0
}

/** The words of an unpriced run's cost: usage was recorded but no price is known, never a blank and never $0. */
export const NOT_PRICED = 'Not priced'

/** The run has usage but its cost is unknown (no price for its model): the row says "Not priced" where a priced row shows its figure. */
export function isUnpricedRun(input: CostInput): boolean {
  return costView(input).kind === 'unknown'
}
