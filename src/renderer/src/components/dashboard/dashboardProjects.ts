import { isVirtualProjectId, type ConnectionId, type ConnectionInfo, type PendingWorktree, type Project, type RunSummary } from '@shared/types'
import { projectConnection, projectKindOf } from '@shared/defaults'
import { relativeTime } from '../../lib/runChains'
import { runCostInput, sumCosts, type CostInput } from '../../lib/cost'
import { WEEK_MS } from '../../lib/dashboard'
import { folderName } from '../../lib/paths'
import { connectionLabel } from '../../lib/connectionLabel'

/** Pure helpers for the Dashboard's project tiles and fact cards. Plain data in, plain data out; no store, no IPC. */

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export type CostSummary = Pick<RunSummary, 'id' | 'projectId' | 'startedAt' | 'totalCostUsd' | 'usage'>

/** Runs from the live store and from history in one list, each id once; the live copy wins (it is fresher). */
export function mergeSummaries<T extends { id: string }>(live: readonly T[], history: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const list of [live, ...history]) {
    for (const s of list) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
  }
  return out
}

/** The summed cost of runs started in the last 7 days and how many there were. */
export function costInWindow(summaries: readonly CostSummary[], now: number): { cost: CostInput; runs: number } {
  const from = now - WEEK_MS
  const inside = summaries.filter((s) => s.startedAt >= from)
  return { cost: sumCosts(inside.map(runCostInput)), runs: inside.length }
}

export interface ProjectCost {
  projectId: string
  name: string
  cost: CostInput
}

const hasCost = (c: CostInput): boolean => !(c.costSource === 'none' && !c.costUsd)

/** The projects that spent the most in the window, known costs first (largest first), unknown after, nothing-spent left out. */
export function topProjectCosts(summaries: readonly CostSummary[], now: number, nameOf: (projectId: string) => string, limit = 3): ProjectCost[] {
  const from = now - WEEK_MS
  const byProject = new Map<string, CostSummary[]>()
  for (const s of summaries) {
    if (s.startedAt < from) continue
    const list = byProject.get(s.projectId)
    if (list) list.push(s)
    else byProject.set(s.projectId, [s])
  }
  const rows: ProjectCost[] = []
  for (const [projectId, list] of byProject) {
    const cost = sumCosts(list.map(runCostInput))
    if (hasCost(cost)) rows.push({ projectId, name: nameOf(projectId), cost })
  }
  rows.sort((a, b) => (b.cost.costUsd ?? -1) - (a.cost.costUsd ?? -1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.projectId.localeCompare(b.projectId))
  return rows.slice(0, Math.max(0, limit))
}

/** Projects whose name or folder name contains the query (case-insensitive); an empty query keeps all. */
export function filterProjects<T extends Pick<Project, 'name' | 'path'>>(projects: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...projects]
  return projects.filter((p) => p.name.toLowerCase().includes(q) || folderName(p.path).toLowerCase().includes(q))
}

/** Past this many projects the tiles get a search field. */
export const SEARCH_AFTER = 6

/** The tile to focus after `removed` leaves the list: the next one, else the previous, else null. */
export function idAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed)
  if (at < 0) return null
  return ids[at + 1] ?? ids[at - 1] ?? null
}

/** True when no usage report is newer than `maxAgeMs` (or none exists), so the Usage card should ask for a fresh one. */
export function usageIsStale(reports: readonly { updatedAt: number }[], now: number, maxAgeMs = 60_000): boolean {
  if (reports.length === 0) return true
  const newest = Math.max(...reports.map((r) => r.updatedAt))
  return now - newest > maxAgeMs
}

/** "Five-hour" becomes "5-hour window", "Seven-day" "7-day window"; anything else just gains "window". */
export function windowLabel(label: string): string {
  if (label === 'Five-hour') return '5-hour window'
  if (label === 'Seven-day') return '7-day window'
  return `${label} window`
}

export interface ConnectionProblem {
  id: ConnectionId
  text: string
}

/** Connections in use whose status is 'error' or 'disconnected', with the number of projects that run on each. */
export function connectionProblems(
  connections: readonly Pick<ConnectionInfo, 'connection' | 'status'>[] | null | undefined,
  inUse: ReadonlySet<ConnectionId>,
  projects: readonly Pick<Project, 'provider'>[]
): ConnectionProblem[] {
  const out: ConnectionProblem[] = []
  for (const c of connections ?? []) {
    const id = c.connection.id
    if (!inUse.has(id)) continue
    const state = c.status.state
    if (state !== 'error' && state !== 'disconnected') continue
    const users = projects.filter((p) => projectConnection(p) === id).length
    const head = state === 'error' ? `${connectionLabel(id)} has a problem.` : `${connectionLabel(id)} is not connected.`
    out.push({ id, text: users > 0 ? `${head} ${plural(users, 'project uses', 'projects use')} it.` : head })
  }
  return out
}

// ---------- Tile signals and chips (docs/design/dashboard-2.md 10) ----------

/** Branches waiting: worktrees with commits ahead or uncommitted files (clean leftovers do not count). */
export function branchesWaiting(list: readonly Pick<PendingWorktree, 'commitsAhead' | 'uncommittedFiles'>[] | null | undefined): number {
  if (!Array.isArray(list)) return 0
  return list.filter((w) => w.commitsAhead > 0 || w.uncommittedFiles > 0).length
}

export type TileChipKind = 'branches' | 'suggestions' | 'folder-trust'

export interface TileChip {
  kind: TileChipKind
  /** Visible text. */
  text: string
  /** Accessible name: the text and the project. */
  name: string
}

/** The chips of a tile, only non-zero ones, in the order branches, suggestions, folder trust. Branches only for code projects. */
export function tileChips(input: { projectName: string; code: boolean; branches: number; suggestions: number; untrusted: boolean }): TileChip[] {
  const chips: TileChip[] = []
  if (input.code && input.branches > 0) {
    const text = `${plural(input.branches, 'branch', 'branches')} waiting`
    chips.push({ kind: 'branches', text, name: `${text} in ${input.projectName}` })
  }
  if (input.suggestions > 0) {
    const text = plural(input.suggestions, 'team suggestion', 'team suggestions')
    chips.push({ kind: 'suggestions', text, name: `${text} in ${input.projectName}` })
  }
  if (input.untrusted) {
    const text = 'Folder settings to review'
    chips.push({ kind: 'folder-trust', text, name: `${text} in ${input.projectName}` })
  }
  return chips
}

/** The project ids that get a worktree call: real code projects only. */
export function worktreeTargets(projects: readonly Pick<Project, 'id' | 'kind'>[]): string[] {
  return projects.filter((p) => projectKindOf(p as Project) === 'code' && !isVirtualProjectId(p.id)).map((p) => p.id)
}

/** The newest run by start (id breaks ties); the caller passes live runs first so a live copy wins over history. */
export function newestSummary<T extends { id: string; startedAt: number }>(summaries: readonly T[]): T | undefined {
  let best: T | undefined
  for (const s of summaries) {
    if (!best || s.startedAt > best.startedAt || (s.startedAt === best.startedAt && s.id.localeCompare(best.id) > 0)) best = s
  }
  return best
}

/** "Continue {name}" in the More menu: the run name cut at 32 characters with an ellipsis. */
export function continueLabel(name: string): string {
  const chars = [...name]
  return `Continue ${chars.length > 32 ? `${chars.slice(0, 31).join('')}…` : name}`
}

/** The caption of a tile's newest run: live "Idle · Waiting for your reply", ended "Finished · 2 h ago". */
export function tileRunCaption(input: { live: boolean; statusWord: string; activity?: string; endedAt?: number; now: number }): string {
  if (input.live) return input.activity ? `${input.statusWord} · ${input.activity}` : input.statusWord
  return input.endedAt ? `${input.statusWord} · ${relativeTime(input.endedAt, input.now)}` : input.statusWord
}
