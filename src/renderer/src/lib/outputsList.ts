// Pure helpers for the project's Outputs tab (docs/design/outputs.md section 8). No React, no DOM, no store.
import type { OutputKind, RunOutput } from '@shared/types'
import { runTag } from '@shared/view/runLabels'
import { formatDate } from './dates'
import { kindChipLabel, outputSearchTerms, outputsCountLabel } from './outputs'
import { typeAheadMatch } from './knowledgeList'

/** The filter state of one view instance. `runId` '' means every run; no kinds means every kind. */
export interface OutputsFilter {
  query: string
  kinds: OutputKind[]
  runId: string
}

export const EMPTY_OUTPUTS_FILTER: OutputsFilter = { query: '', kinds: [], runId: '' }

/** Rows past this many render on demand behind "Show N more". */
export const OUTPUTS_PAGE = 300

/** The count line is spoken this long after the last filter change. */
export const OUTPUTS_COUNT_ANNOUNCE_MS = 400
/** New outputs are announced at most once per this many ms. */
export const OUTPUTS_PRODUCED_ANNOUNCE_MS = 5000

export function isOutputsFilterActive(f: OutputsFilter): boolean {
  return f.query.trim() !== '' || f.kinds.length > 0 || f.runId !== ''
}

/** Case-insensitive search over title, file name, relative path and role. An empty query matches everything. */
export function matchesQuery(o: Pick<RunOutput, 'title' | 'fileName' | 'relPath' | 'role' | 'kind'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return outputSearchTerms(o).some((s) => s.toLowerCase().includes(q))
}

/** Outputs matching the search and the run, whatever the kinds (what the kind chips count). */
export function outputsBeforeKinds(list: readonly RunOutput[], f: OutputsFilter): RunOutput[] {
  return list.filter((o) => (!f.runId || o.runId === f.runId) && matchesQuery(o, f.query))
}

/** The list the user sees: search, run and kinds (kinds are OR). Keeps the input order (newest first). */
export function filterOutputs(list: readonly RunOutput[], f: OutputsFilter): RunOutput[] {
  const kinds = new Set<OutputKind>(f.kinds)
  return outputsBeforeKinds(list, f).filter((o) => kinds.size === 0 || kinds.has(o.kind))
}

export interface KindCount {
  kind: OutputKind
  label: string
  count: number
}

/**
 * One chip per kind that the whole list uses (so a chip never vanishes while its kind is pressed), counted over what
 * the search and the run filter leave. Most used first, then by label.
 */
export function kindCounts(list: readonly RunOutput[], f: OutputsFilter): KindCount[] {
  const counts = new Map<OutputKind, number>()
  for (const o of list) if (!counts.has(o.kind)) counts.set(o.kind, 0)
  for (const o of outputsBeforeKinds(list, f)) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1)
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: kindChipLabel(kind), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** The run filter's options: "R3 · <run title>", newest run first, only runs that have outputs. */
export function runOptions(list: readonly RunOutput[], indexes: ReadonlyMap<string, number>, names: ReadonlyMap<string, string>): { value: string; label: string }[] {
  const seen = new Set<string>()
  for (const o of list) seen.add(o.runId)
  return [...seen]
    .sort((a, b) => (indexes.get(b) ?? 0) - (indexes.get(a) ?? 0) || a.localeCompare(b))
    .map((id) => {
      const name = names.get(id)
      return { value: id, label: name ? `${runTag(indexes.get(id))} · ${name}` : runTag(indexes.get(id)) }
    })
}

export interface DayGroup {
  key: string
  label: string
  items: RunOutput[]
}

const dayKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** "Today", "Yesterday", else the date ("4 Nov 2026"). */
export function dayLabel(t: number, now: number): string {
  const key = dayKey(t)
  if (key === dayKey(now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key === dayKey(y.getTime())) return 'Yesterday'
  return formatDate(t)
}

/** Consecutive rows of the same local day under one heading; the order of `list` is kept. */
export function dayGroups(list: readonly RunOutput[], now: number): DayGroup[] {
  const out: DayGroup[] = []
  for (const o of list) {
    const key = dayKey(o.createdAt)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(o)
    else out.push({ key, label: dayLabel(o.createdAt, now), items: [o] })
  }
  return out
}

/** "5 of 12 outputs" while a filter hides some, else "12 outputs". */
export function countLine(shown: number, total: number): string {
  return shown === total ? outputsCountLabel(total) : `${shown} of ${outputsCountLabel(total)}`
}

/** "Agents produced 2 outputs" (spoken at most once per OUTPUTS_PRODUCED_ANNOUNCE_MS). */
export function producedText(n: number): string {
  return `Agents produced ${outputsCountLabel(n)}`
}

/** The row a type-ahead prefix lands on (by title), or -1. Same rules as the Knowledge list. */
export function titleTypeAhead(rows: readonly Pick<RunOutput, 'title'>[], from: number, text: string): number {
  return typeAheadMatch(
    rows.map((r) => r.title),
    from,
    text
  )
}

/** The id to select after `id` leaves `visible`: the next row, else the previous one, else null. */
export function idAfterRemoval(visible: readonly Pick<RunOutput, 'id'>[], id: string): string | null {
  const at = visible.findIndex((o) => o.id === id)
  if (at < 0) return null
  return visible[at + 1]?.id ?? visible[at - 1]?.id ?? null
}

/** A focus request resolves to its output when the list has it. */
export function resolveOutputFocus(list: readonly RunOutput[], outputId: string | undefined): RunOutput | null {
  if (!outputId) return null
  return list.find((o) => o.id === outputId) ?? null
}

/** Ids in `next` that are not in `prev` (live arrivals; an in-place update is not new). */
export function newOutputIds(prev: readonly Pick<RunOutput, 'id'>[], next: readonly Pick<RunOutput, 'id'>[]): string[] {
  const had = new Set(prev.map((o) => o.id))
  return next.filter((o) => !had.has(o.id)).map((o) => o.id)
}
