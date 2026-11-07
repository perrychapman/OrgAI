/**
 * Pure scale, tick and series helpers for the Usage page's inline SVG charts (docs/design/usage-app.md section 5).
 * STUB from the UI Lead: the charts engineer owns this file and replaces it (keep `assignSeries` and `SeriesState`).
 */
import type { UsageProjectRollup } from '@shared/types'

/** Series assignment for one period: project id -> 0..4 (s1..s5); the rest fold into "Other". */
export interface SeriesState {
  /** The period key the assignment belongs to. */
  key: string
  map: ReadonlyMap<string, number>
}

/**
 * Keeps a period's assignment while the period is unchanged (a drilled view never recolours, 5.2); a new period
 * ranks the projects by cost (unknown after known, then tokens) and gives the top 5 s1..s5.
 */
export function assignSeries(prev: SeriesState | null, projects: readonly UsageProjectRollup[], periodKey: string): SeriesState {
  if (prev && prev.key === periodKey) {
    // Projects new to the period (a refetch after a run ended) take free slots, never another project's.
    const used = new Set(prev.map.values())
    let map: Map<string, number> | null = null
    for (const p of projects) {
      if (prev.map.has(p.projectId)) continue
      const free = [0, 1, 2, 3, 4].find((i) => !used.has(i))
      if (free === undefined) break
      map ??= new Map(prev.map)
      map.set(p.projectId, free)
      used.add(free)
    }
    return map ? { key: periodKey, map } : prev
  }
  const map = new Map<string, number>()
  projects.slice(0, 5).forEach((p, i) => map.set(p.projectId, i))
  return { key: periodKey, map }
}
