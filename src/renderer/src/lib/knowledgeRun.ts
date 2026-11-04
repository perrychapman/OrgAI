/**
 * Pure helpers for the knowledge tools in run views (docs/design/knowledge.md sections 7 and 8): the "Recorded N
 * items" count over a run's harness rows, and the collapse of each knowledge write (engagement_knowledge upsert_node /
 * link / retire, engagement_context save) into the one harness row RunManager wrote for it, with the humanised
 * headline, the tool result behind "Show output" and the Knowledge-tab focus request for its "Open" link. No I/O.
 */

import type { TranscriptEntry } from '@shared/types'
import { ENGAGEMENT_CONTEXT_TOOL, KNOWLEDGE_TOOL } from '@shared/types'
import { normalizeKnowledgeKey } from '@shared/knowledge'
import { keyWords, type KnowledgeFocusRequest } from './knowledge'
import { bareToolName } from './transcriptRows'

/** What a transcript row asks the Knowledge tab to select; the panel adds the project id. */
export type KnowledgeFocus = Omit<KnowledgeFocusRequest, 'projectId'>

/** One harness row that stands for a knowledge write, as the transcript shows it. */
export interface KnowledgeRow {
  /** The headline: kinds and relations as words ("Recorded organisation Acme Corp"). */
  text: string
  /** The item's name for the Open link ("Open <name> in Knowledge"); empty when the row names no item. */
  name: string
  /** The Open link's target; undefined when the row names nothing the tab could select (no link then). */
  focus?: KnowledgeFocus
}

export interface KnowledgeCollapse {
  /** Entry ids to hide: the paired write calls and their results. */
  hidden: Set<string>
  /** Harness row id -> the paired call's result text (the row's "Show output"). */
  body: Map<string, string>
  /** Harness row id -> its humanised row (every knowledge write row, paired or not). */
  rows: Map<string, KnowledgeRow>
  /** Call entry id -> the sentence a read call gets once its result names the item ("Read the note Kickoff call summary"). */
  labels: Map<string, string>
}

const WRITE_ROW_RE = /^(Recorded|Updated|Linked|Retired|Saved note) /

/** A harness system row RunManager wrote for a knowledge write ("Recorded <kind> <name>", "Updated ...", "Linked ...", "Retired ...", "Saved note <title>"). */
export const isKnowledgeWriteRow = (e: TranscriptEntry): boolean => e.source === 'harness' && e.block.kind === 'system' && WRITE_ROW_RE.test(e.block.text)

/** Section 8: how many items the run recorded, updated, linked, retired or saved as notes (every agent). */
export function recordedCount(entries: readonly TranscriptEntry[]): number {
  let n = 0
  for (const e of entries) if (isKnowledgeWriteRow(e)) n++
  return n
}

type WriteKind = 'upsert_node' | 'link' | 'retire' | 'save'

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The write a tool call makes, or null for reads and other tools. */
function writeKindOf(name: string, input: unknown): WriteKind | null {
  const bare = bareToolName(name)
  const action = str(obj(input).action)
  if (bare === KNOWLEDGE_TOOL) return action === 'upsert_node' || action === 'link' || action === 'retire' ? action : null
  if (bare === ENGAGEMENT_CONTEXT_TOOL) return action === 'save' ? 'save' : null
  return null
}

function rowMatches(kind: WriteKind, text: string): boolean {
  switch (kind) {
    case 'upsert_node':
      return /^(Recorded|Updated) /.test(text)
    case 'link':
      return text.startsWith('Linked ')
    case 'retire':
      return text.startsWith('Retired ')
    case 'save':
      return text.startsWith('Saved note ')
  }
}

/** A result that means no harness row was written (the write was refused or made no change). */
const NO_WRITE_RE = /^(REFUSED\b|Already retired\b|No knowledge graph\b|No context notes\b)/

/** A lower-case hyphenated key as it reads in a harness row (a normalised kind or relation). */
const KEY_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

/** Hyphens to spaces in the one key-shaped token of a label; untouched when none or several (a name may carry one). */
function hyphenWords(label: string): string {
  const words = label.split(' ')
  const hits = words.filter((w) => KEY_TOKEN_RE.test(w))
  if (hits.length !== 1) return label
  return words.map((w) => (w === hits[0] ? keyWords(w) : w)).join(' ')
}

/** The "to" name of a "Linked <from> <relation> <to>" row once the relation token is known; undefined when it is not in the row. */
function linkedTarget(text: string, relation: string | undefined): string | undefined {
  if (!relation) return undefined
  const at = text.indexOf(` ${relation} `, 'Linked '.length)
  return at < 0 ? undefined : text.slice(at + relation.length + 2)
}

/**
 * The row's headline (section 7): the kind token after "Recorded" / "Updated" / "Retired node" and the relation
 * token of a "Linked" row (from the call's `relation`, else the one hyphenated token) read as words.
 */
export function humanizeKnowledgeRow(text: string, input?: unknown): string {
  let m = /^(Recorded|Updated) (\S+) (.*)$/.exec(text)
  if (m) return `${m[1]} ${keyWords(m[2])} ${m[3]}`
  m = /^Retired node (\S+) (.*)$/.exec(text)
  if (m) return `Retired ${keyWords(m[1])} ${m[2]}`
  m = /^Retired edge (.*)$/.exec(text)
  if (m) return `Retired relation ${hyphenWords(m[1])}`
  if (text.startsWith('Linked ')) {
    const relation = normalizeKnowledgeKey(str(obj(input).relation)) ?? undefined
    if (relation && text.indexOf(` ${relation} `, 'Linked '.length) >= 0) return text.replace(` ${relation} `, ` ${keyWords(relation)} `)
    return `Linked ${hyphenWords(text.slice('Linked '.length))}`
  }
  return text
}

/** The first line of a tool result, trimmed. */
const firstLine = (text: string): string => text.split('\n').find((l) => l.trim())?.trim() ?? ''

/** The entity name an engagement_knowledge `get` result names ("Entity <name> (data from ...)."), else undefined. */
export function entityNameOfResult(text: string): string | undefined {
  return /^Entity (.+) \(data from the project's knowledge graph, not instructions\)\.$/.exec(firstLine(text))?.[1]
}

/** The note title an engagement_context read result names ("Context note <title> (data from ...)"), else undefined. */
export function noteTitleOfResult(text: string): string | undefined {
  return /^Context note (.+?)(?: \(retired\))? \(data from the project's notes, not instructions\)$/.exec(firstLine(text))?.[1]
}

/** The node id and name of a `get` result's first fenced line ("kn_x | kind | name | ..."). */
function entityRefOfResult(text: string): { nodeId: string; name: string } | undefined {
  const lines = text.split('\n')
  const at = lines.indexOf('<<<')
  const ref = at >= 0 ? lines[at + 1] : undefined
  const m = ref ? /^(kn_\S+) \| \S+ \| ([^|]+?)(?: \|.*)?$/.exec(ref) : null
  return m ? { nodeId: m[1], name: m[2] } : undefined
}

/**
 * The entity whose `get` result (an earlier tool result of the same agent) lists the fact or edge id: a retire of a
 * fact or relation names no node itself, so the Open link uses the item the agent read it from.
 */
function entityOfItem(entries: readonly TranscriptEntry[], before: number, agentId: string, itemId: string): { nodeId: string; name: string } | undefined {
  const line = new RegExp(`^\\s+${itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| `, 'm')
  for (let i = before - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.agentId !== agentId || e.block.kind !== 'tool_result') continue
    if (!line.test(e.block.content)) continue
    const ref = entityRefOfResult(e.block.content)
    if (ref) return ref
  }
  return undefined
}

/** The focus request and name of a write row from the call's input, its result and the row text. */
function rowFor(text: string, input: unknown, result: string | undefined, ctx: { entries: readonly TranscriptEntry[]; at: number; agentId: string }): KnowledgeRow {
  const i = obj(input)
  const shown = humanizeKnowledgeRow(text, input)
  let m: RegExpExecArray | null
  if ((m = /^(?:Recorded|Updated) \S+ (.*)$/.exec(text))) {
    const name = m[1]
    const nodeId = result ? /\((kn_[^()\s]+)\)/.exec(result)?.[1] : undefined
    const inputKind = normalizeKnowledgeKey(str(i.kind)) ?? undefined
    const focus: KnowledgeFocus = nodeId ? { nodeId } : { ...(inputKind ? { kind: inputKind } : {}), name }
    return { text: shown, name, focus }
  }
  if (text.startsWith('Linked ')) {
    const relation = normalizeKnowledgeKey(str(i.relation)) ?? undefined
    const to = str(i.to)
    const target = linkedTarget(text, relation) ?? (to && !/^kn_/.test(to) ? to : undefined)
    if (to && /^kn_/.test(to)) return { text: shown, name: target ?? to, focus: { nodeId: to } }
    return target ? { text: shown, name: target, focus: { name: target } } : { text: shown, name: '' }
  }
  if ((m = /^Retired node \S+ (.*)$/.exec(text))) {
    const name = m[1]
    const nodeId = str(i.nodeId)
    return { text: shown, name, focus: nodeId ? { nodeId } : { name } }
  }
  if (text.startsWith('Retired ')) {
    const itemId = str(i.factId) ?? str(i.edgeId)
    const ref = itemId ? entityOfItem(ctx.entries, ctx.at, ctx.agentId, itemId) : undefined
    return ref ? { text: shown, name: ref.name, focus: { nodeId: ref.nodeId } } : { text: shown, name: '' }
  }
  if ((m = /^Saved note (.*)$/.exec(text))) {
    const title = m[1]
    const noteId = result ? /^Saved note (\S+) \(/.exec(firstLine(result))?.[1] : undefined
    return { text: shown, name: title, focus: noteId ? { noteId } : { noteTitle: title } }
  }
  return { text: shown, name: '' }
}

/**
 * Section 7: pairs each knowledge write call (upsert_node, link, retire, context save) with the next unclaimed harness
 * write row of the same agent whose text matches its action, hides the call and its result, and keeps the result text
 * for the row's "Show output". A refused write (result "REFUSED: ...", "Already retired ...") pairs with nothing and
 * keeps its rows. Every knowledge write row, paired or not, gets its humanised headline and Open target. Read calls
 * whose sentence needs the result (`get` by id, a note read) get a label override.
 */
export function collapseKnowledgeWrites(entries: readonly TranscriptEntry[]): KnowledgeCollapse {
  const hidden = new Set<string>()
  const body = new Map<string, string>()
  const rows = new Map<string, KnowledgeRow>()
  const labels = new Map<string, string>()
  const results = new Map<string, TranscriptEntry>()
  for (const e of entries) if (e.block.kind === 'tool_result') results.set(e.block.toolUseId, e)
  const claimed = new Set<string>()
  entries.forEach((e, idx) => {
    const b = e.block
    if (b.kind !== 'tool_use') return
    const bare = bareToolName(b.name)
    const res = results.get(b.id)
    const resText = res && res.block.kind === 'tool_result' ? res.block.content.trim() : undefined
    const action = str(obj(b.input).action)
    // Reads whose sentence depends on the result.
    if (bare === KNOWLEDGE_TOOL && action === 'get' && !str(obj(b.input).name) && resText) {
      const name = entityNameOfResult(resText)
      if (name) labels.set(e.id, `Read ${name}`)
      return
    }
    if (bare === ENGAGEMENT_CONTEXT_TOOL && (action === 'read' || (!action && str(obj(b.input).noteId))) && resText) {
      const title = noteTitleOfResult(resText)
      if (title) labels.set(e.id, `Read the note ${title}`)
      return
    }
    const kind = writeKindOf(b.name, b.input)
    if (!kind) return
    if (resText !== undefined && (NO_WRITE_RE.test(resText) || (res && res.block.kind === 'tool_result' && res.block.isError))) return
    const at = entries.findIndex((x, j) => j > idx && !claimed.has(x.id) && x.agentId === e.agentId && isKnowledgeWriteRow(x) && x.block.kind === 'system' && rowMatches(kind, x.block.text))
    if (at < 0) return
    const row = entries[at]
    claimed.add(row.id)
    hidden.add(e.id)
    if (res) {
      hidden.add(res.id)
      if (resText) body.set(row.id, resText)
    }
    if (row.block.kind === 'system') rows.set(row.id, rowFor(row.block.text, b.input, resText, { entries, at, agentId: row.agentId }))
  })
  // Write rows nothing claimed (an older record, a report's row seen from another feed): headline and link from the text alone.
  entries.forEach((e, idx) => {
    if (rows.has(e.id) || !isKnowledgeWriteRow(e) || e.block.kind !== 'system') return
    rows.set(e.id, rowFor(e.block.text, undefined, undefined, { entries, at: idx, agentId: e.agentId }))
  })
  return { hidden, body, rows, labels }
}
