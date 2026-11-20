import { projectKindOf } from '@shared/defaults'
import type { Project, RunSummary } from '@shared/types'
import { clientOf } from './clientGroups'

/** The Engagements tile's pure model (docs/design/dashboard-overhaul.md "Visual pass"): which engagements, in which order, with which facts. */

export const ENGAGEMENTS_CAP = 4
export const FACTS_MAX = 3
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type EngagementFactKind = 'runs' | 'folders' | 'notes' | 'knowledge'

/** What the lazy reads gave for one engagement (undefined: not loaded or failed, so no fact is drawn). */
export interface EngagementLoaded {
  notes?: number
  knowledge?: number
}

export interface EngagementFact {
  kind: EngagementFactKind
  count: number
  /** The figure as drawn. */
  text: string
  /** "3 notes": the accessible name and tooltip. */
  label: string
}

export interface EngagementTile {
  project: Project
  client: string
  /** Newest run start or end of the project, or 0 when it has none. */
  lastActivity: number
  /** "2d ago" style text, or "No runs yet". */
  activity: string
  facts: EngagementFact[]
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function engagementProjects(projects: Project[]): Project[] {
  return projects.filter((p) => projectKindOf(p) === 'engagement')
}

/** Newest activity of a project from run summaries (start or end). */
export function lastActivityOf(projectId: string, summaries: RunSummary[]): number {
  let at = 0
  for (const s of summaries) {
    if (s.projectId !== projectId) continue
    at = Math.max(at, s.startedAt ?? 0, s.endedAt ?? 0)
  }
  return at
}

/** "just now", "5 min ago", "3 h ago", "2d ago". */
export function activityText(at: number, now: number): string {
  if (!at) return 'No runs yet'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Facts in drawing order, at most FACTS_MAX: runs this week (always), then reference folders and loaded notes and knowledge when above zero. */
export function engagementFacts(project: Project, summaries: RunSummary[], now: number, loaded?: EngagementLoaded): EngagementFact[] {
  const week = summaries.filter((s) => s.projectId === project.id && s.startedAt >= now - WEEK_MS).length
  const out: EngagementFact[] = [{ kind: 'runs', count: week, text: String(week), label: `${plural(week, 'run', 'runs')} this week` }]
  const folders = project.referenceDirectories?.length ?? 0
  if (folders > 0) out.push({ kind: 'folders', count: folders, text: String(folders), label: plural(folders, 'reference folder', 'reference folders') })
  if (loaded?.notes) out.push({ kind: 'notes', count: loaded.notes, text: String(loaded.notes), label: plural(loaded.notes, 'note', 'notes') })
  if (loaded?.knowledge) out.push({ kind: 'knowledge', count: loaded.knowledge, text: String(loaded.knowledge), label: plural(loaded.knowledge, 'knowledge item', 'knowledge items') })
  return out.slice(0, FACTS_MAX)
}

/** Every engagement, newest activity first (no runs last, then by name). */
export function engagementTiles(projects: Project[], summaries: RunSummary[], now: number, loaded: Record<string, EngagementLoaded | undefined> = {}): EngagementTile[] {
  return engagementProjects(projects)
    .map((project) => {
      const lastActivity = lastActivityOf(project.id, summaries)
      return { project, client: clientOf(project), lastActivity, activity: activityText(lastActivity, now), facts: engagementFacts(project, summaries, now, loaded[project.id]) }
    })
    .sort((a, b) => b.lastActivity - a.lastActivity || a.project.name.localeCompare(b.project.name))
}

/** The tiles shown: all when expanded, else the first ENGAGEMENTS_CAP; `hidden` is how many the cap hides. */
export function visibleEngagements<T>(tiles: T[], expanded: boolean): { shown: T[]; hidden: number } {
  const shown = expanded ? tiles : tiles.slice(0, ENGAGEMENTS_CAP)
  return { shown, hidden: Math.max(0, tiles.length - ENGAGEMENTS_CAP) }
}

/** "Open Tax, engagement, Acme Corp" */
export function engagementOpenLabel(name: string, client: string): string {
  return `Open ${name}, engagement${client ? `, ${client}` : ''}`
}
