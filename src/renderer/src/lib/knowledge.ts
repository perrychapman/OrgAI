import type { EngagementNote, KnowledgeEdge, KnowledgeFact, KnowledgeGraph, KnowledgeNode, KnowledgeSource } from '@shared/types'
import { KNOWLEDGE_COMMON_KINDS } from '@shared/types'
import { ROLE_COLORS } from '@shared/defaults'
import { formatDate, formatDateTime } from './dates'
import { runName, runTag } from './runLabels'

/**
 * Pure helpers for the Knowledge tab (docs/design/knowledge.md): one item model over graph nodes and context notes,
 * kind labels and group order, stable ordering, search ranking, provenance lines, the Settings summary line and the
 * kind -> colour slot the graph and legend share. No I/O, no React.
 */

// ---- items ----

/** A row of the Knowledge list: an entity of the graph or a context note (notes are items too, rec 8). */
export type KnowledgeItem = { type: 'node'; id: string; node: KnowledgeNode } | { type: 'note'; id: string; note: EngagementNote }

/** The pseudo-kind of context notes in groups and filters (never a graph kind: KNOWLEDGE_KEY_RE allows 'note', but the tab reserves it). */
export const NOTE_KIND = 'note'

/** Who wrote an item, as the list filters it. */
export type ItemOrigin = 'user' | 'agent'

/** The provenance of an item in one shape (nodes carry a KnowledgeSource, notes carry source / recordedBy). */
export interface ItemSource {
  by: ItemOrigin
  runId?: string
  role?: string
  /** Epoch ms of the write (a note's createdAt). */
  at: number
}

export function itemsOf(graph: Pick<KnowledgeGraph, 'nodes'>, notes: readonly EngagementNote[]): KnowledgeItem[] {
  return [...graph.nodes.map((node): KnowledgeItem => ({ type: 'node', id: node.id, node })), ...notes.map((note): KnowledgeItem => ({ type: 'note', id: note.id, note }))]
}

export const itemName = (i: KnowledgeItem): string => (i.type === 'node' ? i.node.name : i.note.title)
export const itemKind = (i: KnowledgeItem): string => (i.type === 'node' ? i.node.kind : NOTE_KIND)
export const itemCreatedAt = (i: KnowledgeItem): number => (i.type === 'node' ? i.node.createdAt : i.note.createdAt)
export const itemRetired = (i: KnowledgeItem): boolean => (i.type === 'node' ? !!i.node.retired : !!i.note.retired)

/** Who created the item. A note without `source` is the user's (saved before the field existed). */
export function itemSource(i: KnowledgeItem): ItemSource {
  if (i.type === 'node') return sourceOf(i.node.source)
  const n = i.note
  return n.source === 'agent' ? { by: 'agent', runId: n.recordedBy?.runId, role: n.recordedBy?.role, at: n.createdAt } : { by: 'user', at: n.createdAt }
}

/** A KnowledgeSource as an ItemSource (role and run dropped for the user). */
export function sourceOf(s: KnowledgeSource): ItemSource {
  return s.by === 'agent' ? { by: 'agent', runId: s.runId, role: s.role, at: s.at } : { by: 'user', at: s.at }
}

export const itemOrigin = (i: KnowledgeItem): ItemOrigin => itemSource(i).by

/** The row's one-line excerpt: the first live fact, else the summary, else the note's excerpt; '' when none. */
export function itemExcerpt(i: KnowledgeItem): string {
  if (i.type === 'note') return oneLine(i.note.excerpt)
  const fact = i.node.facts.find((f) => !f.retired)
  return oneLine(fact?.text ?? i.node.summary ?? '')
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ---- kinds ----

/** Plural group titles of the common kinds (rec 14); every other kind shows as typed, sentence case, singular. */
const COMMON_PLURAL: Record<(typeof KNOWLEDGE_COMMON_KINDS)[number], string> = {
  person: 'People',
  organisation: 'Organisations',
  system: 'Systems',
  document: 'Documents',
  decision: 'Decisions',
  risk: 'Risks',
  requirement: 'Requirements',
  deadline: 'Deadlines',
  meeting: 'Meetings',
  'open-question': 'Open questions'
}

/** A kind or relation key as words: hyphens become spaces ("open-question" -> "open question"). */
export const keyWords = (key: string): string => key.replace(/-+/g, ' ').trim()

/** Sentence case of a key's words: "open question" -> "Open question". */
export function sentenceCase(words: string): string {
  const w = words.trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''
}

/** "Person", "Open question", "Note": the singular label on a row's badge. */
export function kindLabel(kind: string): string {
  if (kind === NOTE_KIND) return 'Note'
  return sentenceCase(keyWords(kind))
}

/** "People", "Open questions", "Notes", or a free-form kind as typed in sentence case ("Vendor"). */
export function kindGroupLabel(kind: string): string {
  if (kind === NOTE_KIND) return 'Notes'
  const common = (COMMON_PLURAL as Record<string, string>)[kind]
  return common ?? sentenceCase(keyWords(kind))
}

/** Group order: the common kinds in order, then free-form kinds alphabetically by label, then Notes last. */
export function kindOrder(kinds: Iterable<string>): string[] {
  const set = new Set(kinds)
  const common = KNOWLEDGE_COMMON_KINDS.filter((k) => set.has(k)) as string[]
  const free = [...set].filter((k) => !(KNOWLEDGE_COMMON_KINDS as readonly string[]).includes(k) && k !== NOTE_KIND).sort((a, b) => kindGroupLabel(a).localeCompare(kindGroupLabel(b)))
  return [...common, ...free, ...(set.has(NOTE_KIND) ? [NOTE_KIND] : [])]
}

/**
 * The colour slot of a kind (the role colour slots, so Person and System differ as roles do; rec 19): common kinds
 * take fixed slots in their order, free-form kinds the slots after them in `kindOrder` order, wrapping round.
 */
export function kindColor(kind: string, kindsInUse: Iterable<string> = []): string {
  const order = kindOrder(new Set([...KNOWLEDGE_COMMON_KINDS, ...kindsInUse, kind]))
  const at = Math.max(0, order.indexOf(kind))
  return ROLE_COLORS[at % ROLE_COLORS.length]
}

// ---- filters, order and groups ----

export interface KnowledgeFilter {
  query: string
  /** Kinds to show; empty = every kind. */
  kinds: readonly string[]
  /** Origins to show; empty = both. */
  origins: readonly ItemOrigin[]
  showRetired: boolean
}

export const EMPTY_FILTER: KnowledgeFilter = { query: '', kinds: [], origins: [], showRetired: false }

export const isFilterActive = (f: KnowledgeFilter): boolean => f.query.trim() !== '' || f.kinds.length > 0 || f.origins.length > 0

/**
 * Search rank of an item for a query (the Connectors gallery pattern): 1 the name starts with it, 2 the name contains
 * it, 3 an alias, 4 a live fact, the summary or a note excerpt; null when nothing matches. Every word of a multi-word
 * query must match somewhere; the rank is the worst word's. Empty query = 0 for every item.
 */
export function searchRank(i: KnowledgeItem, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = itemName(i).toLowerCase()
  const aliases = i.type === 'node' ? (i.node.aliases ?? []).map((a) => a.toLowerCase()) : []
  const body = i.type === 'node' ? [...i.node.facts.filter((f) => !f.retired).map((f) => f.text), i.node.summary ?? ''] : [i.note.excerpt]
  const bodyText = body.join('\n').toLowerCase()
  let worst = 0
  for (const w of q.split(/\s+/)) {
    let r: number | null = null
    if (name.startsWith(w)) r = 1
    else if (name.includes(w)) r = 2
    else if (aliases.some((a) => a.includes(w))) r = 3
    else if (bodyText.includes(w)) r = 4
    if (r === null) return null
    worst = Math.max(worst, r)
  }
  if (name.includes(q)) worst = Math.min(worst, name.startsWith(q) ? 1 : 2)
  return worst
}

/** Items passing the kind, origin and retired filters (the query is applied by `searchItems`). */
export function applyFilter(items: readonly KnowledgeItem[], f: KnowledgeFilter): KnowledgeItem[] {
  return items.filter((i) => (f.showRetired || !itemRetired(i)) && (f.kinds.length === 0 || f.kinds.includes(itemKind(i))) && (f.origins.length === 0 || f.origins.includes(itemOrigin(i))))
}

/** Stable order: creation time, then name, then id. Never by updatedAt (H3: agent writes must not reshuffle the list). */
export function orderItems(items: readonly KnowledgeItem[]): KnowledgeItem[] {
  return [...items].sort((a, b) => itemCreatedAt(a) - itemCreatedAt(b) || itemName(a).localeCompare(itemName(b)) || a.id.localeCompare(b.id))
}

/**
 * The filtered and searched list in display order: with a query, best rank first and creation order within a rank;
 * without one, creation order.
 */
export function searchItems(items: readonly KnowledgeItem[], f: KnowledgeFilter): KnowledgeItem[] {
  const q = f.query.trim()
  const kept = applyFilter(items, f)
  if (!q) return orderItems(kept)
  const ranked = orderItems(kept)
    .map((i) => ({ i, r: searchRank(i, q) }))
    .filter((x): x is { i: KnowledgeItem; r: number } => x.r !== null)
  return ranked.sort((a, b) => a.r - b.r).map((x) => x.i)
}

export interface KnowledgeGroup {
  kind: string
  label: string
  items: KnowledgeItem[]
}

/** Items grouped by kind in `kindOrder`, each group in the given order (pass `searchItems` output). Empty groups are left out. */
export function groupItems(items: readonly KnowledgeItem[]): KnowledgeGroup[] {
  const byKind = new Map<string, KnowledgeItem[]>()
  for (const i of items) {
    const k = itemKind(i)
    const list = byKind.get(k)
    if (list) list.push(i)
    else byKind.set(k, [i])
  }
  return kindOrder(byKind.keys()).map((kind) => ({ kind, label: kindGroupLabel(kind), items: byKind.get(kind)! }))
}

/** Count per kind over the live (or, with showRetired, all) items, for the kind chips. */
export function kindCounts(items: readonly KnowledgeItem[], showRetired: boolean): { kind: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const i of items) {
    if (!showRetired && itemRetired(i)) continue
    counts.set(itemKind(i), (counts.get(itemKind(i)) ?? 0) + 1)
  }
  return kindOrder(counts.keys()).map((kind) => ({ kind, label: kindGroupLabel(kind), count: counts.get(kind)! }))
}

/** "You (12)" / "Agents (38)" counts over the items the kind and retired filters keep. */
export function originCounts(items: readonly KnowledgeItem[], showRetired: boolean): Record<ItemOrigin, number> {
  const out: Record<ItemOrigin, number> = { user: 0, agent: 0 }
  for (const i of items) if (showRetired || !itemRetired(i)) out[itemOrigin(i)]++
  return out
}

/** "12 of 300 items" / "1 of 1 item"; the polite count after a filter change. */
export function countLine(shown: number, total: number): string {
  return `${shown} of ${total} ${total === 1 ? 'item' : 'items'}`
}

// ---- provenance ----

/** Run facts the provenance lines need (from the store's summaries and `runIndexMap`). */
export interface RunFacts {
  /** run id -> R-index. */
  indexes: ReadonlyMap<string, number>
  /** run id -> the run's name (`runName`). */
  names?: ReadonlyMap<string, string>
}

/** The role name as the canvas shows it, else "Agent". Control and hidden characters fall back too. */
export function roleWord(role: string | undefined): string {
  const r = (role ?? '').replace(/\s+/g, ' ').trim()
  if (!r || /[\p{Cc}\p{Cf}]/u.test(r)) return 'Agent'
  return r.length > 64 ? `${r.slice(0, 63)}…` : r
}

/** Row line (rec 7, 15): "You · 4 Nov 2026" / "Analyst · R3 · 4 Nov 2026" (a run not known to the project reads "R?"). */
export function provenanceLine(s: ItemSource, runs: RunFacts): string {
  const when = formatDate(s.at)
  if (s.by === 'user') return when ? `You · ${when}` : 'You'
  const parts = [roleWord(s.role), s.runId ? runTag(runs.indexes.get(s.runId)) : undefined, when || undefined]
  return parts.filter(Boolean).join(' · ')
}

/** One line of the detail pane's History block; `runId` makes the run name a link. */
export interface HistoryLine {
  text: string
  runId?: string
  /** The full time for a title. */
  at: number
}

/** "Recorded by Analyst in R3 Summarise the kickoff, 4 Nov 2026 11:46" / "Added by you, 4 Nov 2026 11:46". */
function sourceLine(verb: 'Recorded' | 'Added' | 'Edited' | 'Retired' | 'Changed', s: ItemSource, runs: RunFacts): HistoryLine {
  const when = formatDateTime(s.at)
  if (s.by === 'user') return { text: `${verb} by you${when ? `, ${when}` : ''}`, at: s.at }
  const run = s.runId ? `${runTag(runs.indexes.get(s.runId))}${runs.names?.get(s.runId) ? ` ${runs.names.get(s.runId)}` : ''}` : ''
  return { text: `${verb} by ${roleWord(s.role)}${run ? ` in ${run}` : ''}${when ? `, ${when}` : ''}`, ...(s.runId ? { runId: s.runId } : {}), at: s.at }
}

/**
 * The History block (rec 7, 15): who recorded it (never overwritten), who last changed it (nodes carry a source;
 * notes only a 'user' | 'agent' flag), and "Retired by" when it is retired (the last change of a retired node is its
 * retirement; a retired note has no retirer in the contract, so it reads "Retired").
 */
export function historyLines(i: KnowledgeItem, runs: RunFacts): HistoryLine[] {
  const created = itemSource(i)
  const lines: HistoryLine[] = [sourceLine(created.by === 'agent' ? 'Recorded' : 'Added', created, runs)]
  if (i.type === 'node') {
    const n = i.node
    if (n.updatedBy) {
      const changed = sourceOf(n.updatedBy)
      lines.push(sourceLine(n.retired ? 'Retired' : changed.by === 'user' ? 'Edited' : 'Changed', changed, runs))
    } else if (n.retired) lines.push({ text: 'Retired', at: n.updatedAt })
  } else {
    const n = i.note
    if (n.updatedBy && n.updatedAt !== n.createdAt) lines.push({ text: n.updatedBy === 'user' ? `Edited by you, ${formatDateTime(n.updatedAt)}` : `Changed by an agent, ${formatDateTime(n.updatedAt)}`, at: n.updatedAt })
    if (n.retired) lines.push({ text: 'Retired', at: n.updatedAt })
  }
  return lines
}

/**
 * A History line split around its run link: "Recorded by Analyst in " + "R1 Summarise the kickoff" + ", 4 Nov 2026
 * 11:46", so the run part renders as a button. Null when the line has no run (the whole text is plain).
 */
export function splitHistoryLine(line: HistoryLine, runs: RunFacts): { before: string; link: string; after: string } | null {
  if (!line.runId) return null
  const label = `${runTag(runs.indexes.get(line.runId))}${runs.names?.get(line.runId) ? ` ${runs.names.get(line.runId)}` : ''}`
  const needle = ` in ${label}`
  const at = line.text.indexOf(needle)
  if (at < 0) return null
  return { before: line.text.slice(0, at + 4), link: label, after: line.text.slice(at + needle.length) }
}

/** A run's name for `RunFacts.names` from the store's summaries. */
export function runNamesOf(summaries: readonly { id: string; title?: string; prompt: string }[]): Map<string, string> {
  return new Map(summaries.map((s) => [s.id, runName(s)]))
}

// ---- relations ----

/** One row of the detail pane's Related section: the neighbour and the relation as read from this item's side. */
export interface RelatedRow {
  edge: KnowledgeEdge
  /** The other node (undefined when it is gone, which the store prevents). */
  other: KnowledgeNode | undefined
  /** True when this item is the edge's `from` (reads "<relation> <other>"), false when it is the `to` ("<other> <relation>"). */
  outgoing: boolean
  /** "works at Acme Corp" / "Migrate billing to Stripe decided by" (hyphens as spaces, rec 13). */
  text: string
}

export function relatedRows(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, nodeId: string, showRetired: boolean): RelatedRow[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  return graph.edges
    .filter((e) => (e.from === nodeId || e.to === nodeId) && (showRetired || !e.retired))
    .map((edge) => {
      const outgoing = edge.from === nodeId
      const other = nodes.get(outgoing ? edge.to : edge.from)
      const name = other?.name ?? '(removed)'
      return { edge, other, outgoing, text: outgoing ? `${keyWords(edge.relation)} ${name}` : `${name} ${keyWords(edge.relation)}` }
    })
    .sort((a, b) => a.edge.createdAt - b.edge.createdAt || a.edge.id.localeCompare(b.edge.id))
}

/** Live facts first in their order, then retired ones (each keeps its id). */
export function factsInOrder(facts: readonly KnowledgeFact[], showRetired: boolean): KnowledgeFact[] {
  return facts.filter((f) => showRetired || !f.retired)
}

// ---- Settings summary (rec 3) ----

/**
 * "12 notes, 40 facts, 8 people" for Project settings > General > Context notes: live counts, the largest kind by
 * count named (common kinds by their plural, a free-form kind as "3 vendor"); "Nothing recorded yet" when empty.
 */
export function knowledgeSummaryLine(graph: Pick<KnowledgeGraph, 'nodes'>, notes: readonly EngagementNote[]): string {
  const liveNotes = notes.filter((n) => !n.retired).length
  const liveNodes = graph.nodes.filter((n) => !n.retired)
  const facts = liveNodes.reduce((n, node) => n + node.facts.filter((f) => !f.retired).length, 0)
  const parts: string[] = []
  if (liveNotes > 0) parts.push(`${liveNotes} ${liveNotes === 1 ? 'note' : 'notes'}`)
  if (facts > 0) parts.push(`${facts} ${facts === 1 ? 'fact' : 'facts'}`)
  const counts = kindCounts(itemsOf({ nodes: liveNodes }, []), false)
  const top = [...counts].sort((a, b) => b.count - a.count)[0]
  if (top) parts.push(`${top.count} ${top.count === 1 ? kindLabel(top.kind).toLowerCase() : kindGroupLabel(top.kind).toLowerCase()}`)
  else if (liveNodes.length > 0) parts.push(`${liveNodes.length} ${liveNodes.length === 1 ? 'item' : 'items'}`)
  return parts.length ? parts.join(', ') : 'Nothing recorded yet'
}

/** "Clear everything" confirm counts: "12 items, 40 facts, 8 relations". Notes are not cleared (knowledge:clear leaves them). */
export function clearCountsLine(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>): string {
  const n = graph.nodes.length
  const facts = graph.nodes.reduce((s, node) => s + node.facts.length, 0)
  const e = graph.edges.length
  return `${n} ${n === 1 ? 'item' : 'items'}, ${facts} ${facts === 1 ? 'fact' : 'facts'}, ${e} ${e === 1 ? 'relation' : 'relations'}`
}

// ---- focus requests ----

/**
 * What a transcript row or a settings link asks the Knowledge tab to select (store `knowledgeFocus`): a node or note
 * by id, else a node by kind and name, else a note by title. Resolved by `resolveFocus` once the tab has its data.
 */
export interface KnowledgeFocusRequest {
  projectId: string
  nodeId?: string
  noteId?: string
  kind?: string
  name?: string
  noteTitle?: string
}

/** The item id a focus request names, or null when nothing matches (the tab then just opens). */
export function resolveFocus(items: readonly KnowledgeItem[], req: Omit<KnowledgeFocusRequest, 'projectId'>): string | null {
  if (req.nodeId && items.some((i) => i.type === 'node' && i.id === req.nodeId)) return req.nodeId
  if (req.noteId && items.some((i) => i.type === 'note' && i.id === req.noteId)) return req.noteId
  const fold = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  if (req.name) {
    const want = fold(req.name)
    const hit = items.find((i) => i.type === 'node' && (!req.kind || i.node.kind === req.kind) && (fold(i.node.name) === want || (i.node.aliases ?? []).some((a) => fold(a) === want)))
    if (hit) return hit.id
  }
  if (req.noteTitle) {
    const want = fold(req.noteTitle)
    const hit = items.find((i) => i.type === 'note' && fold(i.note.title) === want)
    if (hit) return hit.id
  }
  return null
}

/** The id to select after removing or retiring `id` from the shown list: the next, else the previous, else null. */
export function idAfterRemoval(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  return ids[at + 1] ?? ids[at - 1] ?? null
}
