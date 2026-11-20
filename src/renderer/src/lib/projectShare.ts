import type { Project } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { dayKey } from './activityStrip'
import { projectHue } from './projectIdentity'

/**
 * The per-project share bar of Your week (docs/design/dashboard-overhaul.md "Visual pass"): how the week's runs divide over
 * projects. One pure function builds the drawn segments, the legend and the sentence that is its text alternative, so
 * the three can never disagree. Data is the summaries the week recap already holds; nothing new is read.
 *
 * Entries are the stored projects that had runs plus one "Chat" entry (every run outside a stored project). The biggest
 * `max` entries (default 5) are named; the rest fold into one neutral "Other" (also any run whose project is no longer
 * stored). Ties go to the project whose newest run is newer, then to the name. A project with no run in the window is
 * never an entry. The bar needs two or more entries, otherwise `show` is false.
 */

/** Named entries before "Other". */
export const SHARE_MAX_NAMED = 5

export type ShareKind = 'project' | 'chat' | 'other'

export interface ShareSegment {
  /** The project id, or 'chat' / 'other'. */
  id: string
  kind: ShareKind
  name: string
  runs: number
  /** Whole percent of all runs counted; the segments sum to exactly 100. */
  pct: number
  /** Identity hue 1..8 for a project; 0 (neutral) for Chat and Other. */
  hue: number
}

export interface ProjectShare {
  segments: ShareSegment[]
  /** Runs counted (each run id once, inside the window). */
  total: number
  /** True with two or more entries. */
  show: boolean
  /** "Runs by project this week: Billing API 5, Website 3, Other 2." */
  text: string
}

export interface ShareRun {
  id: string
  projectId: string
  startedAt: number
}

/** Whole percents that add up to exactly 100 (largest remainder), in the order of `parts`. */
export function wholePercents(parts: readonly number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0)
  if (total <= 0) return parts.map(() => 0)
  const raw = parts.map((p) => (p / total) * 100)
  const floor = raw.map(Math.floor)
  let left = 100 - floor.reduce((a, b) => a + b, 0)
  const byRemainder = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    floor[i] += 1
    left -= 1
  }
  return floor
}

/** The sentence a screen reader gets in place of the drawn bar. */
export function shareText(segments: readonly Pick<ShareSegment, 'name' | 'runs'>[]): string {
  if (segments.length === 0) return 'No runs by project this week.'
  return `Runs by project this week: ${segments.map((s) => `${s.name} ${s.runs}`).join(', ')}.`
}

export function projectShare(
  runs: readonly ShareRun[],
  dayKeys: ReadonlySet<string>,
  projects: readonly Pick<Project, 'id' | 'name'>[],
  max = SHARE_MAX_NAMED
): ProjectShare {
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const counts = new Map<string, { id: string; kind: ShareKind; name: string; runs: number; newest: number }>()
  const seen = new Set<string>()
  const add = (id: string, kind: ShareKind, name: string, startedAt: number): void => {
    const cur = counts.get(id) ?? { id, kind, name, runs: 0, newest: 0 }
    cur.runs += 1
    cur.newest = Math.max(cur.newest, startedAt)
    counts.set(id, cur)
  }
  let orphans = 0
  for (const r of runs) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (!Number.isFinite(r.startedAt) || !dayKeys.has(dayKey(r.startedAt))) continue
    if (isVirtualProjectId(r.projectId) || !r.projectId) add('chat', 'chat', 'Chat', r.startedAt)
    else if (names.get(r.projectId)) add(r.projectId, 'project', names.get(r.projectId) as string, r.startedAt)
    else orphans += 1
  }
  const ranked = [...counts.values()].sort((a, b) => b.runs - a.runs || b.newest - a.newest || a.name.localeCompare(b.name))
  const named = ranked.slice(0, Math.max(0, max))
  const folded = ranked.slice(named.length)
  const otherRuns = folded.reduce((a, e) => a + e.runs, 0) + orphans
  const entries: { id: string; kind: ShareKind; name: string; runs: number }[] = [...named]
  if (otherRuns > 0) entries.push({ id: 'other', kind: 'other', name: 'Other', runs: otherRuns })
  const pct = wholePercents(entries.map((e) => e.runs))
  const segments: ShareSegment[] = entries.map((e, i) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    runs: e.runs,
    pct: pct[i],
    hue: e.kind === 'project' ? projectHue(e.id) : 0
  }))
  const total = segments.reduce((a, s) => a + s.runs, 0)
  return { segments, total, show: segments.length >= 2, text: shareText(segments) }
}
