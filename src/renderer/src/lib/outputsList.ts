// Pure helpers behind the Outputs project tab (docs/design/outputs.md section 8): filters, search, counts, day groups,
// the count line, type-ahead and where focus goes after a removal. No React, no DOM, no store.
import type { OutputKind, RunOutput } from '@shared/types'
import { OUTPUT_KINDS } from '@shared/types'
import { formatDate } from './dates'
import { OUTPUT_KIND_PLURAL, outputsCountLabel } from './outputs'

export { isTypeAheadKey, nextTypeAhead, typeAheadMatch } from './knowledgeList'

/** Rows rendered before "Show 300 more". */
export const OUTPUTS_PAGE = 300
/** The status line is spoken this long after the last change. */
export const STATUS_DEBOUNCE_MS = 400
/** "Agents produced N outputs" is spoken at most once per this long. */
export const PRODUCED_ANNOUNCE_MS = 5000

export interface OutputsFilter {
  query: string
  kinds: OutputKind[]
  /** '' = all runs. */
  runId: string
}

export const EMPTY_OUTPUTS_FILTER: OutputsFilter = { query: '', kinds: [], runId: '' }

export function isFilterActive(f: OutputsFilter): boolean {
  return f.query.trim() !== '' || f.kinds.length > 0 || f.runId !== ''
}

/** Case-insensitive match of every word of the query against title, file name, relPath and role. */
export function matchesQuery(o: Pick<RunOutput, 'title' | 'fileName' | 'relPath' | 'role'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = [o.title, o.fileName, o.relPath, o.role ?? ''].join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function filterOutputs(list: readonly RunOutput[], f: OutputsFilter): RunOutput[] {
  return list.filter((o) => (f.kinds.length === 0 || f.kinds.includes(o.kind)) && (f.runId === '' || o.runId === f.runId) && matchesQuery(o, f.query))
}

/** Kinds in use with their counts and plural labels, in the contract's kind order. */
export function kindCounts(list: readonly RunOutput[]): { kind: OutputKind; label: string; count: number }[] {
  const counts = new Map<OutputKind, number>()
  for (const o of list) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1)
  return OUTPUT_KINDS.filter((k) => counts.has(k)).map((k) => ({ kind: k, label: OUTPUT_KIND_PLURAL[k], count: counts.get(k) ?? 0 }))
}

/** Newest first by creation time; ties keep their incoming order. */
export function sortNewest(list: readonly RunOutput[]): RunOutput[] {
  return list.map((o, i) => ({ o, i })).sort((a, b) => b.o.createdAt - a.o.createdAt || a.i - b.i).map((x) => x.o)
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", else "4 Nov 2026". */
export function dayLabel(ms: number, now: number): string {
  const today = startOfDay(now)
  const day = startOfDay(ms)
  if (day === today) return 'Today'
  const y = new Date(today)
  y.setDate(y.getDate() - 1)
  if (day === y.getTime()) return 'Yesterday'
  return formatDate(ms)
}

export interface OutputDayGroup {
  key: string
  label: string
  items: RunOutput[]
}

/** Day groups, newest first, over at most `limit` rows. `total` is how many rows the filter left. */
export function groupByDay(list: readonly RunOutput[], now: number, limit = OUTPUTS_PAGE): { groups: OutputDayGroup[]; shown: number; hidden: number } {
  const sorted = sortNewest(list)
  const shownList = sorted.slice(0, Math.max(0, limit))
  const groups: OutputDayGroup[] = []
  for (const o of shownList) {
    const key = String(startOfDay(o.createdAt))
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(o)
    else groups.push({ key, label: dayLabel(o.createdAt, now), items: [o] })
  }
  return { groups, shown: shownList.length, hidden: sorted.length - shownList.length }
}

/** "5 of 12 outputs"; with no filter "12 outputs". */
export function countLine(shown: number, total: number, filtered: boolean): string {
  if (!filtered) return outputsCountLabel(total)
  return `${shown} of ${total} ${total === 1 ? 'output' : 'outputs'}`
}

/** The word-by-word status: the count line, plus "no outputs match" when the filter empties the list. */
export function statusText(shown: number, total: number, filtered: boolean): string {
  if (total === 0) return 'No outputs yet.'
  if (filtered && shown === 0) return `No outputs match. ${countLine(shown, total, true)}.`
  return `${countLine(shown, total, filtered)}.`
}

/** "Agents produced 2 outputs" / "An agent produced 1 output". */
export function producedText(n: number): string {
  return n === 1 ? 'Agents produced 1 output' : `Agents produced ${n} outputs`
}

/** Ids in `next` that were not in `known`, ignoring the list's first load (known = null). */
export function newOutputIds(known: ReadonlySet<string> | null, next: readonly RunOutput[]): string[] {
  if (known === null) return []
  return next.filter((o) => !known.has(o.id)).map((o) => o.id)
}

/** Where focus goes after a row left the visible list: the next row, else the previous, else null (list / empty state). */
export function idAfterRemoval(visibleIds: readonly string[], removedId: string): string | null {
  const at = visibleIds.indexOf(removedId)
  if (at < 0) return null
  return visibleIds[at + 1] ?? visibleIds[at - 1] ?? null
}

export interface RunOption {
  value: string
  label: string
}

/**
 * "All runs", then one option per run that has outputs, newest output first: "R3 · <run title>". `labelOf` gives the
 * label of a run (the view builds it from the run index and summary); an unknown run reads "Earlier run".
 */
export function runOptions(list: readonly RunOutput[], labelOf: (runId: string) => string | undefined): RunOption[] {
  const newest = new Map<string, number>()
  for (const o of list) newest.set(o.runId, Math.max(newest.get(o.runId) ?? 0, o.createdAt))
  const runs = [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ value: id, label: labelOf(id) || 'Earlier run' }))
  return [{ value: '', label: 'All runs' }, ...runs]
}

/** "R3 · Add caching" (title may be empty). */
export function runOptionLabel(tag: string, name: string): string {
  return name ? `${tag} · ${name}` : tag
}
