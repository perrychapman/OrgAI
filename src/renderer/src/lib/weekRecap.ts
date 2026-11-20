import type { Project } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { costView, formatDuration, type CostInput } from './cost'
import { projectShare, type ProjectShare } from './projectShare'
import { dayKey, dayLedger, ledgerTotals, LEDGER_DAYS, type CostKind, type DayBucket, type LedgerRun } from './activityStrip'

/**
 * Your week (docs/design/dashboard-overhaul.md 7.7): honest numbers about the last 7 local days including today. Pure.
 * No comparison, no target, no streak, no "best day". Built on `dayLedger(summaries, now, 7)`.
 *
 * Time working is, per run, `max(0, usage.wallMs - usage.idleMs - usage.waitingMs)` summed over the runs of the window
 * (see `runWorkMs` in activityStrip.ts for why `limitHoldMs` is NOT subtracted: the three timers overlap, a usage-limited
 * run's hold sits inside its idle time). It is the time runs were busy, never summed across parallel agents. A run
 * without `usage` is left out and the figure becomes a lower bound ("6h 40m+", "at least 6h 40m").
 */

/** A summary the recap reads: a ledger run plus the project it belongs to. */
export type RecapRun = LedgerRun & { projectId: string }

export interface TopProject {
  id: string
  name: string
  runs: number
}

export interface WeekRecap {
  /** The seven day buckets, oldest first, today last (the ledger draws these). */
  days: DayBucket[]
  runs: number
  failed: number
  /** Time working in ms and whether it is a lower bound. */
  workMs: number
  workPartial: boolean
  /** "6h 40m" or "6h 40m+"; "" when nothing was measured and every run lacks usage. */
  workText: string
  /** "at least 6h 40m" for a lower bound, else the same as `workText`. */
  workLabel: string
  /** The summed cost as the cost component takes it (never a printed $0.00: see `costShown`). */
  cost: CostInput
  costKind: CostKind
  /** False when nothing was spent or the cost is a reported zero (flat-rate plans): the figure is omitted. */
  costShown: boolean
  /** The stored project with the most runs; only when two or more stored projects had runs. */
  top: TopProject | null
  /** How the week's runs divide over projects (the share bar); `show` is false below two entries. */
  share: ProjectShare
}

/** Only work runs: setup, MCP-assistant and Skill-assistant runs are not part of the person's week. */
const isWorkRun = (r: LedgerRun): boolean => r.kind === undefined || r.kind === 'work'

export function weekRecap(summaries: readonly RecapRun[], projects: readonly Pick<Project, 'id' | 'name'>[], now: number): WeekRecap {
  const work = summaries.filter(isWorkRun)
  const days = dayLedger(work, now, LEDGER_DAYS)
  const totals = ledgerTotals(days)

  // "0s+" says nothing: when no run in the window has usage, the time is simply unknown.
  const workUnknown = totals.workPartial && totals.workMs < 1000
  const workText = workUnknown ? 'unknown' : `${formatDuration(totals.workMs)}${totals.workPartial ? '+' : ''}`
  const workLabel = workUnknown ? 'unknown' : totals.workPartial ? `at least ${formatDuration(totals.workMs)}` : formatDuration(totals.workMs)

  const kind = costView(totals.cost).kind
  const costShown = kind === 'unknown' || kind === 'partial' || (kind === 'known' && (totals.cost.costUsd ?? 0) > 0)

  // Most active: stored projects only (Chat and the assistants have no project page to open), counted over the same
  // runs and days the ledger shows. Ties go to the project whose newest run is newer, then to the name.
  const perProject = new Map<string, { runs: number; newest: number }>()
  const seen = new Set<string>()
  const keys = new Set(days.map((d) => d.key))
  for (const r of work) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (isVirtualProjectId(r.projectId) || !Number.isFinite(r.startedAt)) continue
    if (!keys.has(dayKey(r.startedAt))) continue
    const cur = perProject.get(r.projectId) ?? { runs: 0, newest: 0 }
    cur.runs += 1
    cur.newest = Math.max(cur.newest, r.startedAt)
    perProject.set(r.projectId, cur)
  }
  let top: TopProject | null = null
  if (perProject.size >= 2) {
    const ranked = [...perProject.entries()]
      .map(([id, v]) => ({ id, name: projects.find((p) => p.id === id)?.name ?? '', ...v }))
      .filter((p) => p.name !== '')
      .sort((a, b) => b.runs - a.runs || b.newest - a.newest || a.name.localeCompare(b.name))
    if (ranked.length >= 2) top = { id: ranked[0].id, name: ranked[0].name, runs: ranked[0].runs }
  }

  return {
    days,
    runs: totals.runs,
    failed: totals.failed,
    workMs: totals.workMs,
    workPartial: totals.workPartial,
    workText,
    workLabel,
    cost: totals.cost,
    costKind: totals.costKind,
    costShown,
    top,
    share: projectShare(work, keys, projects)
  }
}

/** "Most active: Mobile app, 8 runs". */
export function topProjectText(top: TopProject): string {
  return `Most active: ${top.name}, ${top.runs} ${top.runs === 1 ? 'run' : 'runs'}`
}

/** The tooltip on the Time working label. */
export const TIME_WORKING_TOOLTIP = 'Time runs were busy this week. Time spent waiting for you or idle is left out. Parallel agents are not added together.'
