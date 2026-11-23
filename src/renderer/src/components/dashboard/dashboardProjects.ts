import { isVirtualProjectId, type ConnectionId, type ConnectionInfo, type PendingWorktree, type Project, type Role, type RunSummary } from '@shared/types'
import { NEUTRAL_ROLE_COLOR } from '../../lib/dashboardBand'
import { projectConnection, projectKindOf } from '@shared/defaults'
import { runCostInput, sumCosts, type CostInput } from '../../lib/cost'
import { WEEK_MS, type ProjectAttention } from '../../lib/dashboard'
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
  /** The figure the tile's icon mark shows beside the icon; null when the chip is only a mark (folder settings). */
  count: number | null
}

/** The chips of a tile, only non-zero ones, in the order branches, suggestions, folder trust. Branches only for code projects. */
export function tileChips(input: { projectName: string; code: boolean; branches: number; suggestions: number; untrusted: boolean }): TileChip[] {
  const chips: TileChip[] = []
  if (input.code && input.branches > 0) {
    const text = `${plural(input.branches, 'branch', 'branches')} waiting`
    chips.push({ kind: 'branches', text, name: `${text} in ${input.projectName}`, count: input.branches })
  }
  if (input.suggestions > 0) {
    const text = plural(input.suggestions, 'team suggestion', 'team suggestions')
    chips.push({ kind: 'suggestions', text, name: `${text} in ${input.projectName}`, count: input.suggestions })
  }
  if (input.untrusted) {
    const text = 'Folder settings to review'
    chips.push({ kind: 'folder-trust', text, name: `${text} in ${input.projectName}`, count: null })
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

/** "just now", "5 min ago", "2 hours ago", "9 days ago". */
export function agoWords(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${plural(h, 'hour', 'hours')} ago`
  return `${plural(Math.round(h / 24), 'day', 'days')} ago`
}

/**
 * The tile's one status fact, plain text (dashboard-overhaul.md 7.8), most urgent first: "2 decisions waiting", "Working",
 * "3 runs open", "Last run 9 days ago", "No runs yet". Never a command or an activity line.
 */
export function tileStatusLine(input: { open: number; decisions: number; working: boolean; newestStartedAt?: number; now: number; agents?: number }): string {
  if (input.decisions > 0) return `${plural(input.decisions, 'decision', 'decisions')} waiting`
  // "Working · 16 agents" (Main board) when the agents at work are known.
  if (input.working) return input.agents && input.agents > 0 ? `Working · ${plural(input.agents, 'agent', 'agents')}` : 'Working'
  if (input.open > 0) return `${plural(input.open, 'run', 'runs')} open`
  if (input.newestStartedAt !== undefined) return `Last run ${agoWords(input.newestStartedAt, input.now)}`
  return 'No runs yet'
}

/** The shape of the tile's status mark: each state has its own shape, so colour is never the only cue. */
export type TileStatusKind = 'decisions' | 'working' | 'open' | 'idle' | 'none'

/**
 * Which mark the status line gets, in the same order as `tileStatusLine`: decisions waiting (a ring with a bar), working
 * (a solid dot), runs open but not working (a ring with a dot), past runs only (a small square), no runs ever (a dashed ring).
 */
export function tileStatusKind(input: { open: number; decisions: number; working: boolean; newestStartedAt?: number }): TileStatusKind {
  if (input.decisions > 0) return 'decisions'
  if (input.working) return 'working'
  if (input.open > 0) return 'open'
  return input.newestStartedAt !== undefined ? 'idle' : 'none'
}

/**
 * Pinned projects first in pin order (ids matching no project are ignored), then the rest by last activity: the project
 * whose newest run started most recently first, a project without runs last, ties by name. What needs the person is not
 * a matter of tile order (Needs you and Right now say it), so a decision never reshuffles the tiles.
 */
export function pinnedFirst<T extends { id: string; name: string }>(projects: readonly T[], pinned: readonly string[], ctx: Readonly<Record<string, ProjectAttention | undefined>>): T[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const head: T[] = []
  for (const id of pinned) {
    const p = byId.get(id)
    if (!p || seen.has(id)) continue
    seen.add(id)
    head.push(p)
  }
  const rest = projects
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => (ctx[b.id]?.newestStart ?? 0) - (ctx[a.id]?.newestStart ?? 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
  return [...head, ...rest]
}

// ---------- The tile's team row ----------

/** The most marks a tile's team row draws (the root plus seven). */
export const TILE_TEAM_MARKS = 8

export interface TileTeamMark {
  id: string
  name: string
  /** CSS colour of the role (the neutral colour when the role has none). */
  color: string
}

export interface TileTeam {
  /** Root first, then breadth-first chart order, at most `TILE_TEAM_MARKS`. */
  marks: TileTeamMark[]
  /** Roles beyond the marks. */
  more: number
  /** Every role name, in the same order (for the accessible name). */
  names: string[]
  total: number
}

/**
 * The chart in breadth-first order for the team row: the root (no `reportsTo`, else the first role) first, then each
 * level in chart order; roles the walk never reaches (a dangling or cyclic `reportsTo`) follow in stored order.
 */
export function tileTeam(roles: readonly Pick<Role, 'id' | 'name' | 'color' | 'reportsTo'>[] | undefined, cap = TILE_TEAM_MARKS): TileTeam {
  const list = roles ?? []
  const ordered = bfsRoles(list)
  const marks = ordered.slice(0, Math.max(0, cap)).map((r) => ({ id: r.id, name: r.name, color: r.color || NEUTRAL_ROLE_COLOR }))
  return { marks, more: Math.max(0, ordered.length - marks.length), names: ordered.map((r) => r.name), total: ordered.length }
}

function bfsRoles<T extends Pick<Role, 'id' | 'reportsTo'>>(list: readonly T[]): T[] {
  if (list.length === 0) return []
  const root = list.find((r) => r.reportsTo === null || r.reportsTo === undefined) ?? list[0]
  const children = new Map<string, T[]>()
  for (const r of list) {
    if (r === root || r.reportsTo == null) continue
    const kids = children.get(r.reportsTo)
    if (kids) kids.push(r)
    else children.set(r.reportsTo, [r])
  }
  const seen = new Set<string>([root.id])
  const out: T[] = [root]
  for (let i = 0; i < out.length; i++) {
    for (const kid of children.get(out[i].id) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      out.push(kid)
    }
  }
  for (const r of list) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/** The "Open" button's accessible name: status, "pinned" and, when there is a chart, "team of 9: A, B, C and 6 more". */
export function openLabel(input: { name: string; statusLine: string; team: Pick<TileTeam, 'total' | 'names'>; pinned?: boolean; setupPending?: boolean }): string {
  const parts = [`Open ${input.name}`, input.statusLine]
  if (input.pinned) parts.push('pinned')
  if (input.team.total > 0) {
    const shown = input.team.names.slice(0, 3)
    const rest = input.team.total - shown.length
    parts.push(`team of ${input.team.total}: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`)
  }
  if (input.setupPending) parts.push('setup pending')
  return parts.join(', ')
}
