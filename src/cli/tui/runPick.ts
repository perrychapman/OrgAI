/**
 * The selectable /runs list (ux-review-tui-org.md F8): the project's runs oldest first as rows the App's overlay moves
 * through (Enter opens, c continues, r Org retrospective). Pure; every string comes through the shared run labels and
 * `cleanLine`, so a hostile title cannot reach the terminal.
 */
import type { RunSummary } from '../../shared/types'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { statusWordOfSummary } from '../render'
import { offersRetro } from './selectors'
import { cleanLine } from './slashCommands'
import { textWidth, truncateEnd } from './panes/text'

export interface RunPickRow {
  id: string
  tag: string
  status: string
  title: string
  summary: RunSummary
  /** The Org retrospective applies to this run. */
  retro: boolean
}

export function runPickRows(runs: readonly RunSummary[], projectId?: string): RunPickRow[] {
  const own = projectId ? runs.filter((r) => r.projectId === projectId) : [...runs]
  const idx = runIndexMap(own)
  return [...own]
    .sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0))
    .map((r) => ({
      id: r.id,
      tag: runTag(idx.get(r.id)),
      status: cleanLine(statusWordOfSummary(r), 40),
      title: cleanLine(runName(r), 80),
      summary: r,
      retro: offersRetro(r)
    }))
}

/** One line per row: the marker, tag, status word and title (cut to `width`). */
export function runPickLines(rows: readonly RunPickRow[], sel: number, width: number, followedId?: string, ellipsis = '…'): string[] {
  return rows.map((r, i) => {
    const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - textWidth(s)))
    const text = `${i === sel ? '>' : ' '} ${pad(r.tag, 5)} ${pad(r.status, 22)} ${r.title}${r.id === followedId ? '  (following)' : ''}`
    return truncateEnd(text, width, ellipsis)
  })
}
