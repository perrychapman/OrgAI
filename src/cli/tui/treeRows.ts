/** Pure helpers over OrgTreeRow lists shared by selectors.ts and the tree pane (no state, no React). */
import type { OrgTreeRow } from './types'

/** Numbers for the tree title: every agent (folded ones included), those working, and open decision cards. */
export function treeCounts(rows: readonly OrgTreeRow[]): { total: number; working: number; waiting: number } {
  let total = 0
  let working = 0
  let waiting = 0
  for (const r of rows) {
    if (r.kind === 'group') {
      total += r.count ?? 0
      continue
    }
    total += 1
    if (r.state === 'starting' || r.state === 'thinking' || r.state === 'tool' || r.state === 'delegating') working += 1
    waiting += r.waiting ?? 0
  }
  return { total, working, waiting }
}
