// Pure helpers for the project's Outputs tab (docs/design/outputs.md section 8). No React, no DOM, no store.
import type { OutputKind, RunOutput } from '@shared/types'
import { runTag } from '@shared/view/runLabels'
import { formatDate } from './dates'
import { formatBytes, kindChipLabel as baseChipLabel, kindLabel, outputSearchTerms, outputsCountLabel } from './outputs'
import { typeAheadMatch } from './knowledgeList'

/** Kind chip text: "Deck" for pptx, else the shared short label. */
export const kindChipLabel = (kind: OutputKind): string => (kind === 'pptx' ? 'Deck' : baseChipLabel(kind))

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

/** When the current version was made (a new version keeps `createdAt` and sets `updatedAt`). */
export const outputTime = (o: Pick<RunOutput, 'createdAt' | 'updatedAt'>): number => o.updatedAt ?? o.createdAt

/** Consecutive rows of the same local day (of the current version) under one heading; the order of `list` is kept. */
export function dayGroups(list: readonly RunOutput[], now: number): DayGroup[] {
  const out: DayGroup[] = []
  for (const o of list) {
    const t = outputTime(o)
    const key = dayKey(t)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(o)
    else out.push({ key, label: dayLabel(t, now), items: [o] })
  }
  return out
}

/** "Excel workbook · v2 · 3 versions · 24 KB" (the version parts only once there is history). */
export function rowMetaLine(o: Pick<RunOutput, 'kind' | 'bytes' | 'version' | 'versionCount'>): string {
  const v = o.version ?? 1
  const n = o.versionCount ?? 1
  return [kindLabel(o.kind), v > 1 || n > 1 ? `v${v}` : '', n > 1 ? `${n} versions` : '', formatBytes(o.bytes)].filter(Boolean).join(' · ')
}

/** "v2 · Excel" for a card ("Excel" alone for a first version). */
export function cardMetaLine(o: Pick<RunOutput, 'kind' | 'version' | 'versionCount'>): string {
  const v = o.version ?? 1
  return [v > 1 || (o.versionCount ?? 1) > 1 ? `v${v}` : '', kindChipLabel(o.kind)].filter(Boolean).join(' · ')
}

/** "Analyst · R2 · 7 Nov 2026", "You · edited", "You · restored", "Changed outside OrgAI": the current version's maker. */
export function currentProvenance(o: Pick<RunOutput, 'role' | 'createdAt' | 'updatedAt' | 'runId' | 'current'>, tagFor: (runId: string) => string | undefined): string {
  const c = o.current
  const when = formatDate(c?.at ?? outputTime(o))
  if (c?.source === 'edit') return `You · edited · ${when}`
  if (c?.source === 'restore') return `You · restored · ${when}`
  if (c?.source === 'external') return `Changed outside OrgAI · ${when}`
  const role = c?.role?.trim() || o.role?.trim() || 'An agent'
  return [role, tagFor(c?.runId ?? o.runId), when].filter(Boolean).join(' · ')
}

/** "2 open notes". */
export function openNotesLabel(n: number): string {
  return n === 1 ? '1 open note' : `${n} open notes`
}

/** The "New" badge: a version the user has not seen in this window. */
export function isNewVersion(o: Pick<RunOutput, 'id' | 'version'>, seen: Readonly<Record<string, number>>): boolean {
  const s = seen[o.id]
  return s !== undefined && (o.version ?? 1) > s
}

export interface UpdatedVersion {
  id: string
  title: string
  version: number
}

/** Outputs that were in `prev` and now have a higher version (a live update; never a new output). */
export function updatedVersions(prev: readonly Pick<RunOutput, 'id' | 'title' | 'version'>[], next: readonly Pick<RunOutput, 'id' | 'title' | 'version'>[]): UpdatedVersion[] {
  const had = new Map(prev.map((o) => [o.id, o.version ?? 1]))
  const out: UpdatedVersion[] = []
  for (const o of next) {
    const was = had.get(o.id)
    const now = o.version ?? 1
    if (was !== undefined && now > was) out.push({ id: o.id, title: o.title, version: now })
  }
  return out
}

/** "Updated Project plan to version 3" / "Updated 3 outputs". */
export function updatedText(items: readonly UpdatedVersion[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return `Updated ${items[0].title} to version ${items[0].version}`
  return `Updated ${outputsCountLabel(items.length)}`
}

/** "Deleted 3 outputs." / "Deleted Project plan." */
export function deletedText(n: number, firstTitle?: string): string {
  return n === 1 && firstTitle ? `Deleted ${firstTitle}.` : `Deleted ${outputsCountLabel(n)}.`
}

/** "3 selected". */
export function selectedText(n: number): string {
  return `${n} selected`
}

/** Grid columns from the measured tops of the cards: how many share the first row's top. */
export function gridColumns(tops: readonly number[]): number {
  if (tops.length === 0) return 1
  let n = 0
  for (const t of tops) {
    if (Math.abs(t - tops[0]) > 2) break
    n++
  }
  return Math.max(1, n)
}

/** The index a grid key lands on (Left / Right by one, Up / Down by `cols`), clamped; same index when it cannot move. */
export function gridTarget(key: string, from: number, count: number, cols: number): number {
  if (count === 0) return -1
  let to = from
  if (key === 'ArrowRight') to = from + 1
  else if (key === 'ArrowLeft') to = from - 1
  else if (key === 'ArrowDown') to = from + cols
  else if (key === 'ArrowUp') to = from - cols
  else if (key === 'Home') to = 0
  else if (key === 'End') to = count - 1
  if (to < 0 || to >= count) return from
  return to
}

export type OutputsViewMode = 'list' | 'grid'
export const outputsViewKey = (projectId: string): string => `orgai.outputsView.${projectId}`
export function readViewMode(raw: string | null): OutputsViewMode {
  return raw === 'grid' ? 'grid' : 'list'
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

/** The id one step from `id` in list order (-1 previous, 1 next); null at an end or when `id` is not in the list. */
export function stepId(rows: readonly Pick<RunOutput, 'id'>[], id: string | null, dir: -1 | 1): string | null {
  const at = id ? rows.findIndex((o) => o.id === id) : -1
  if (at < 0) return null
  return rows[at + dir]?.id ?? null
}

/** "3 of 12" for the shown output; '' when it is not in the list. */
export function positionText(rows: readonly Pick<RunOutput, 'id'>[], id: string | null): string {
  const at = id ? rows.findIndex((o) => o.id === id) : -1
  return at < 0 ? '' : `${at + 1} of ${rows.length}`
}

/** Ids in `next` that are not in `prev` (live arrivals; an in-place update is not new). */
export function newOutputIds(prev: readonly Pick<RunOutput, 'id'>[], next: readonly Pick<RunOutput, 'id'>[]): string[] {
  const had = new Set(prev.map((o) => o.id))
  return next.filter((o) => !had.has(o.id)).map((o) => o.id)
}

/** Kinds whose run side tab row shows a 40 x 30 thumbnail instead of the kind icon (docs/design/outputs-2.md section 4). */
export const RUN_ROW_THUMB_KINDS: ReadonlySet<OutputKind> = new Set<OutputKind>(['pptx', 'image', 'svg', 'mermaid'])
