import type { KnowledgeEdge, KnowledgeFact, KnowledgeFactInput, KnowledgeNode } from '@shared/types'
import { KNOWLEDGE_ALIASES_MAX } from '@shared/types'
import type { KnowledgeGroup, KnowledgeItem } from './knowledge'
import { itemExcerpt, kindOrder } from './knowledge'

/**
 * Pure helpers behind the Knowledge tab's list, detail pane and live updates (docs/design/knowledge.md sections 2, 3
 * and 6): the flat windowed list and its row heights, keyboard type-ahead, the batched "The team recorded N items"
 * announcement, own-write detection, alias parsing, fact list edits and the relation picker. No DOM, no React.
 */

// ---- the flat list and windowing ----

/** Past this many shown rows the list renders only the rows near the viewport (spec 2). */
export const WINDOW_THRESHOLD = 100
/** Rows rendered beyond each edge of the viewport while windowing. */
export const WINDOW_OVERSCAN_ROWS = 20
/** Fixed heights the windowing math and knowledge.css agree on (px). */
export const GROUP_TITLE_PX = 32
export const ROW_PX = 56
export const ROW_PLAIN_PX = 44

export type ListEntry = { type: 'title'; key: string; kind: string; label: string; count: number } | { type: 'row'; key: string; item: KnowledgeItem }

/** Group titles and rows as one flat list, in display order. */
export function flattenGroups(groups: readonly KnowledgeGroup[]): ListEntry[] {
  const out: ListEntry[] = []
  for (const g of groups) {
    out.push({ type: 'title', key: `title:${g.kind}`, kind: g.kind, label: g.label, count: g.items.length })
    for (const item of g.items) out.push({ type: 'row', key: item.id, item })
  }
  return out
}

/** A row is 56 px with an excerpt, 44 px without; a group title 32 px. */
export function entryHeight(e: ListEntry): number {
  if (e.type === 'title') return GROUP_TITLE_PX
  return itemExcerpt(e.item) ? ROW_PX : ROW_PLAIN_PX
}

/** The top offset of every entry plus the total height. */
export function entryOffsets(entries: readonly ListEntry[]): { offsets: number[]; total: number } {
  const offsets: number[] = []
  let y = 0
  for (const e of entries) {
    offsets.push(y)
    y += entryHeight(e)
  }
  return { offsets, total: y }
}

export interface WindowRange {
  /** First entry index rendered. */
  start: number
  /** One past the last entry index rendered. */
  end: number
  /** Spacer heights standing in for the entries left out. */
  topPad: number
  bottomPad: number
}

/**
 * The entries to render for a scroll position: the ones inside the viewport plus `overscan` entries on each side.
 * With `entries.length` at or under the threshold everything is rendered.
 */
export function windowRange(entries: readonly ListEntry[], scrollTop: number, viewport: number, overscan = WINDOW_OVERSCAN_ROWS): WindowRange {
  const n = entries.length
  const rows = entries.reduce((c, e) => c + (e.type === 'row' ? 1 : 0), 0)
  if (rows <= WINDOW_THRESHOLD) return { start: 0, end: n, topPad: 0, bottomPad: 0 }
  const { offsets, total } = entryOffsets(entries)
  const top = Math.max(0, scrollTop)
  const bottom = top + Math.max(0, viewport)
  let first = offsets.findIndex((y, i) => y + entryHeight(entries[i]) > top)
  if (first < 0) first = n - 1
  let last = first
  while (last + 1 < n && offsets[last + 1] < bottom) last++
  const start = Math.max(0, first - overscan)
  const end = Math.min(n, last + 1 + overscan)
  const topPad = offsets[start] ?? 0
  const bottomPad = end < n ? total - (offsets[end] ?? total) : 0
  return { start, end, topPad, bottomPad }
}

/** The scrollTop that shows entry `index` whole inside a viewport, moving as little as possible; `current` when it already does. */
export function scrollTopFor(entries: readonly ListEntry[], index: number, current: number, viewport: number): number {
  const { offsets } = entryOffsets(entries)
  const e = entries[index]
  if (!e) return current
  const y = offsets[index]
  const h = entryHeight(e)
  // When scrolling up to a group's first row, bring its title along.
  const above = index > 0 && entries[index - 1].type === 'title' ? GROUP_TITLE_PX : 0
  if (y < current) return Math.max(0, y - above)
  if (y + h > current + viewport) return Math.max(0, y + h - viewport)
  return current
}

// ---- keyboard ----

/** Letters typed within this many ms form one type-ahead prefix. */
export const TYPE_AHEAD_MS = 500

export interface TypeAhead {
  text: string
  at: number
}

/** The buffer after one more printable key: appended within TYPE_AHEAD_MS of the last one, else started over. */
export function nextTypeAhead(prev: TypeAhead | null, key: string, now: number): TypeAhead {
  if (prev && now - prev.at <= TYPE_AHEAD_MS) return { text: prev.text + key, at: now }
  return { text: key, at: now }
}

/**
 * The index of the row a type-ahead prefix lands on, or -1. A repeated single letter ("aaa") cycles through the names
 * starting with that letter from the row after `from`; a longer prefix is matched from `from` itself first (the focused
 * row may still match as the prefix grows). Wraps round. Case-insensitive.
 */
export function typeAheadMatch(names: readonly string[], from: number, text: string): number {
  const n = names.length
  if (n === 0 || !text) return -1
  const lower = text.toLowerCase()
  const cycling = lower.length > 1 && lower.split('').every((c) => c === lower[0])
  const prefix = cycling ? lower[0] : lower
  const startAt = cycling || lower.length === 1 ? from + 1 : Math.max(0, from)
  for (let step = 0; step < n; step++) {
    const i = (((startAt + step) % n) + n) % n
    if (names[i].toLowerCase().startsWith(prefix)) return i
  }
  return -1
}

/** True for a key that feeds type-ahead: one printable character without a modifier. */
export function isTypeAheadKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' '
}

// ---- live-update announcements (spec 6) ----

/** "The team recorded N items" is spoken at most once per this many ms; counts in between are batched. */
export const RECORDED_ANNOUNCE_MS = 5000

export interface RecordedBatch {
  pending: number
  /** When the last announcement was made (0 = never). */
  lastAt: number
}

export const EMPTY_BATCH: RecordedBatch = { pending: 0, lastAt: 0 }

export const recordedText = (n: number): string => `The team recorded ${n} ${n === 1 ? 'item' : 'items'}`

/**
 * Add `n` recorded items at `now`: announced at once when the last announcement is RECORDED_ANNOUNCE_MS or more ago,
 * else held (`delay` ms until a flush should run). Zero items change nothing.
 */
export function addRecorded(batch: RecordedBatch, n: number, now: number): { batch: RecordedBatch; announce: string | null; delay: number | null } {
  if (n <= 0) return { batch, announce: null, delay: batch.pending > 0 ? Math.max(0, batch.lastAt + RECORDED_ANNOUNCE_MS - now) : null }
  const total = batch.pending + n
  if (batch.lastAt === 0 || now - batch.lastAt >= RECORDED_ANNOUNCE_MS) return { batch: { pending: 0, lastAt: now }, announce: recordedText(total), delay: null }
  return { batch: { pending: total, lastAt: batch.lastAt }, announce: null, delay: Math.max(0, batch.lastAt + RECORDED_ANNOUNCE_MS - now) }
}

/** Speak what was held, if anything (the timer's call). */
export function flushRecorded(batch: RecordedBatch, now: number): { batch: RecordedBatch; announce: string | null } {
  if (batch.pending === 0) return { batch, announce: null }
  return { batch: { pending: 0, lastAt: now }, announce: recordedText(batch.pending) }
}

/** The item ids of a push event: nodes (`kn_`) and notes; relation ids (`ke_`) are not items. */
export function eventItemIds(ids: readonly string[] | undefined): string[] {
  return (ids ?? []).filter((id) => !id.startsWith('ke_'))
}

/** How long an id of the tab's own write counts as its own. */
export const OWN_WRITE_MS = 10_000

/**
 * True when a push event comes from this tab's own write: a write is still in flight (main broadcasts before the
 * IPC call resolves), or every id the event names was written here within OWN_WRITE_MS.
 */
export function isOwnEvent(ids: readonly string[] | undefined, own: ReadonlyMap<string, number>, inFlight: number, now: number): boolean {
  if (inFlight > 0) return true
  if (!ids || ids.length === 0) return false
  return ids.every((id) => {
    const at = own.get(id)
    return at !== undefined && now - at <= OWN_WRITE_MS
  })
}

/** Of the ids a push named, the ones that exist as items but the filter hides ("Show new", spec 6). */
export function hiddenNewIds(ids: readonly string[], existing: ReadonlySet<string>, shown: ReadonlySet<string>): string[] {
  return ids.filter((id) => existing.has(id) && !shown.has(id))
}

// ---- empty states (spec 2) ----

export type EmptyKind = 'none' | 'none-runs' | 'filter' | 'retired' | null

/** Which empty state to show, or null when rows are shown. */
export function emptyKind(total: number, shown: number, filterActive: boolean, hasWorkRun: boolean): EmptyKind {
  if (shown > 0) return null
  if (total === 0) return hasWorkRun ? 'none-runs' : 'none'
  return filterActive ? 'filter' : 'retired'
}

// ---- detail pane edits ----

/** Aliases as typed ("Acme, ACME Ltd"): trimmed, empty and duplicate (case-insensitive) ones dropped, at most `max`. */
export function parseAliases(text: string, max = KNOWLEDGE_ALIASES_MAX): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(',')) {
    const a = raw.replace(/\s+/g, ' ').trim()
    const key = a.toLowerCase()
    if (!a || seen.has(key)) continue
    seen.add(key)
    out.push(a)
    if (out.length >= max) break
  }
  return out
}

export const aliasesText = (aliases: readonly string[] | undefined): string => (aliases ?? []).join(', ')

/** The full fact list as knowledge:saveNode wants it (ids kept, so every fact keeps its source). */
export function factInputs(facts: readonly KnowledgeFact[]): KnowledgeFactInput[] {
  return facts.map((f) => ({ id: f.id, text: f.text, ...(f.retired ? { retired: true } : {}) }))
}

/** The list with one fact's text replaced (an unknown id leaves it unchanged). */
export function withFactText(facts: readonly KnowledgeFact[], id: string, text: string): KnowledgeFactInput[] {
  return factInputs(facts).map((f) => (f.id === id ? { ...f, text } : f))
}

export function withFactRetired(facts: readonly KnowledgeFact[], id: string, retired: boolean): KnowledgeFactInput[] {
  return factInputs(facts).map((f) => (f.id === id ? { id: f.id, text: f.text, ...(retired ? { retired: true } : {}) } : f))
}

export function withoutFact(facts: readonly KnowledgeFact[], id: string): KnowledgeFactInput[] {
  return factInputs(facts).filter((f) => f.id !== id)
}

/** The list plus one new user fact (no id). */
export function withNewFact(facts: readonly KnowledgeFact[], text: string): KnowledgeFactInput[] {
  return [...factInputs(facts), { text }]
}

/** Kinds in use across the nodes, in group order (the kind field's datalist). */
export function kindsInUse(nodes: readonly Pick<KnowledgeNode, 'kind'>[]): string[] {
  return kindOrder(new Set(nodes.map((n) => n.kind)))
}

/** Relations in use, most used first then alphabetical (the relation field's datalist). */
export function relationsInUse(edges: readonly Pick<KnowledgeEdge, 'relation'>[]): string[] {
  const counts = new Map<string, number>()
  for (const e of edges) counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r)
}

/**
 * The live nodes a relation picker offers for a query (name or alias substring, case-insensitive; names that start
 * with it first), never the item itself, at most `max`. An empty query lists the first `max` by name.
 */
export function relationCandidates(nodes: readonly KnowledgeNode[], query: string, excludeId: string, max = 8): KnowledgeNode[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const live = nodes.filter((n) => !n.retired && n.id !== excludeId)
  const rank = (n: KnowledgeNode): number => {
    if (!q) return 1
    const name = n.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    if ((n.aliases ?? []).some((a) => a.toLowerCase().includes(q))) return 2
    return -1
  }
  return live
    .map((n) => ({ n, r: rank(n) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.n.name.localeCompare(b.n.name))
    .slice(0, max)
    .map((x) => x.n)
}

/** Notes a "Link a note" picker offers: title substring, the ones already linked left out, at most `max`. */
export function noteCandidates<T extends { id: string; title: string; retired?: boolean }>(notes: readonly T[], query: string, linked: readonly string[], max = 8): T[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const taken = new Set(linked)
  return notes
    .filter((n) => !taken.has(n.id) && !n.retired && (!q || n.title.toLowerCase().includes(q)))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)) || a.title.localeCompare(b.title))
    .slice(0, max)
}

/** The notes cap / items cap sentence beside a disabled Add button (spec 2). */
export const notesCapText = (max: number): string => `${max.toLocaleString()} notes is the most an engagement can keep.`
export const itemsCapText = (max: number): string => `${max.toLocaleString()} items is the most an engagement can keep.`

/** The row's list index by id, or -1. */
export function rowIndexOf(entries: readonly ListEntry[], id: string | null): number {
  if (!id) return -1
  return entries.findIndex((e) => e.type === 'row' && e.item.id === id)
}

/** The next row index from `from` in a direction, skipping titles; `from` -1 = before the start. */
export function stepRow(entries: readonly ListEntry[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < entries.length) {
    if (entries[i].type === 'row') return i
    i += dir
  }
  return -1
}

/** The first or last row index, or -1. */
export function edgeRow(entries: readonly ListEntry[], which: 'first' | 'last'): number {
  return which === 'first' ? stepRow(entries, -1, 1) : stepRow(entries, entries.length, -1)
}
