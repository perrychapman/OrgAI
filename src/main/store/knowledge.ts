import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  KnowledgeEdge,
  KnowledgeEdgeSaveInput,
  KnowledgeEdgeWriteResult,
  KnowledgeFact,
  KnowledgeFactInput,
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeNodeSaveInput,
  KnowledgeNodeUpsertInput,
  KnowledgeNodeWriteResult,
  KnowledgeRetireInput,
  KnowledgeRetireResult,
  KnowledgeSource
} from '@shared/types'
import {
  KNOWLEDGE_ALIASES_MAX,
  KNOWLEDGE_EDGES_MAX,
  KNOWLEDGE_EDGE_NOTE_MAX_CHARS,
  KNOWLEDGE_FACT_MAX_CHARS,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_KEY_RE,
  KNOWLEDGE_NAME_MAX_CHARS,
  KNOWLEDGE_NODES_MAX,
  KNOWLEDGE_NODE_FACTS_MAX,
  KNOWLEDGE_NODE_NOTES_MAX,
  KNOWLEDGE_SUMMARY_MAX_CHARS
} from '@shared/types'
import { emptyKnowledgeGraph, knowledgeNameKey, knowledgeNodeNamed, matchKnowledgeNodes, normalizeKnowledgeKey } from '@shared/knowledge'
import { isSafeId } from '@shared/defaults'
import type { KnowledgeStoreApi } from '../runtime/types'
import { hiddenCharIn, hiddenCharProblem } from '../capabilities/sanitize'
import { atomicWrite, ensurePlainDir, isLink, listNotes, projectDataDir, readPlain } from './projectData'

/**
 * The engagement knowledge graph store (types.ts "Engagement knowledge graph"): `<data>/projects/<id>/knowledge.json`
 * = { version: 1, nodes, edges, updatedAt } as compact JSON (either form reads), never in the working folder. Every
 * write re-reads the file, validates the whole input (keys, lengths, hidden characters, caps, note ids against the
 * note index; refused, never cut), mutates the in-memory graph and writes once through an atomic rename, so a throw
 * leaves the file untouched. Reads never throw and drop junk INSIDE a valid graph item by item; a file that is present
 * but cannot be read as a graph at all (over KNOWLEDGE_FILE_MAX_BYTES, not a regular file, not JSON, or a root that
 * is not { version: 1, nodes: [], edges: [] }) reads as empty and makes every write refuse (UNREADABLE_MESSAGE), so a
 * damaged or over-size file is never overwritten with a near-empty graph; only clearKnowledge (the user's start-over)
 * removes it. Identity, vocabulary and search helpers are the shared ones in src/shared/knowledge.ts.
 */

const NODE_PREFIX = 'kn_'
const EDGE_PREFIX = 'ke_'
const FACT_PREFIX = 'kf_'

const isNodeId = (x: unknown): x is string => isSafeId(x) && x.startsWith(NODE_PREFIX)
const isEdgeId = (x: unknown): x is string => isSafeId(x) && x.startsWith(EDGE_PREFIX)
const isFactId = (x: unknown): x is string => isSafeId(x) && x.startsWith(FACT_PREFIX)

const fmt = (n: number): string => n.toLocaleString('en-US')

/** `<data>/projects/<projectId>/knowledge.json`. Throws on an unsafe id. */
export function knowledgeFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'knowledge.json')
}

// ---------- Read (junk dropped) ----------

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** A short string without hidden characters (1..max), else undefined. */
function cleanString(x: unknown, max: number): string | undefined {
  return typeof x === 'string' && x.length >= 1 && x.length <= max && !hiddenCharIn(x) ? x : undefined
}

function cleanSource(x: unknown): KnowledgeSource | undefined {
  if (!x || typeof x !== 'object') return undefined
  const s = x as Record<string, unknown>
  if ((s.by !== 'user' && s.by !== 'agent') || !finite(s.at)) return undefined
  const out: KnowledgeSource = { by: s.by, at: s.at }
  if (isSafeId(s.runId)) out.runId = s.runId
  if (isSafeId(s.agentId)) out.agentId = s.agentId
  const role = cleanString(s.role, KNOWLEDGE_NAME_MAX_CHARS)
  if (role !== undefined) out.role = role
  return out
}

/** A name or alias as stored: 1..KNOWLEDGE_NAME_MAX_CHARS, not blank, one line (no hidden characters). */
function cleanName(x: unknown): string | undefined {
  const s = cleanString(x, KNOWLEDGE_NAME_MAX_CHARS)
  return s !== undefined && knowledgeNameKey(s) ? s : undefined
}

function cleanFact(x: unknown, seen: Set<string>): KnowledgeFact | undefined {
  if (!x || typeof x !== 'object') return undefined
  const f = x as Record<string, unknown>
  if (!isFactId(f.id) || seen.has(f.id)) return undefined
  if (typeof f.text !== 'string' || !f.text.length || f.text.length > KNOWLEDGE_FACT_MAX_CHARS || hiddenCharIn(f.text, { multiline: true })) return undefined
  const source = cleanSource(f.source)
  if (!source) return undefined
  seen.add(f.id)
  return { id: f.id, text: f.text, source, ...(f.retired === true ? { retired: true } : {}) }
}

/** Distinct names (by knowledgeNameKey) that are not the node's own name, at most `max`. */
function dedupeAliases(list: string[], name: string, max: number): string[] {
  const seen = new Set<string>([knowledgeNameKey(name)])
  const out: string[] = []
  for (const a of list) {
    const k = knowledgeNameKey(a)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(a)
    if (out.length >= max) break
  }
  return out
}

function cleanNode(x: unknown, noteIndex: ReadonlySet<string>, seen: Set<string>): KnowledgeNode | undefined {
  if (!x || typeof x !== 'object') return undefined
  const n = x as Record<string, unknown>
  if (!isNodeId(n.id) || seen.has(n.id)) return undefined
  if (typeof n.kind !== 'string' || !KNOWLEDGE_KEY_RE.test(n.kind)) return undefined
  const name = cleanName(n.name)
  if (name === undefined) return undefined
  const source = cleanSource(n.source)
  if (!source || !finite(n.createdAt) || !finite(n.updatedAt)) return undefined
  const factIds = new Set<string>()
  const facts: KnowledgeFact[] = []
  if (Array.isArray(n.facts)) {
    for (const f of n.facts) {
      const fact = cleanFact(f, factIds)
      if (fact) facts.push(fact)
      if (facts.length >= KNOWLEDGE_NODE_FACTS_MAX) break
    }
  }
  const aliases = Array.isArray(n.aliases) ? dedupeAliases(n.aliases.map(cleanName).filter((a): a is string => a !== undefined), name, KNOWLEDGE_ALIASES_MAX) : []
  const noteIds = Array.isArray(n.noteIds) ? [...new Set(n.noteIds.filter((id): id is string => typeof id === 'string' && noteIndex.has(id)))].slice(0, KNOWLEDGE_NODE_NOTES_MAX) : []
  const summary = typeof n.summary === 'string' && n.summary.length <= KNOWLEDGE_SUMMARY_MAX_CHARS && n.summary.trim() && !hiddenCharIn(n.summary, { multiline: true }) ? n.summary : undefined
  const updatedBy = cleanSource(n.updatedBy)
  seen.add(n.id)
  return {
    id: n.id,
    kind: n.kind,
    name,
    ...(aliases.length ? { aliases } : {}),
    ...(summary !== undefined ? { summary } : {}),
    facts,
    ...(noteIds.length ? { noteIds } : {}),
    source,
    ...(updatedBy ? { updatedBy } : {}),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    ...(n.retired === true ? { retired: true } : {})
  }
}

const tripleKey = (e: Pick<KnowledgeEdge, 'from' | 'to' | 'relation'>): string => `${e.from}\u0000${e.to}\u0000${e.relation}`

function cleanEdge(x: unknown, nodeIds: ReadonlySet<string>, seenIds: Set<string>, seenTriples: Set<string>): KnowledgeEdge | undefined {
  if (!x || typeof x !== 'object') return undefined
  const e = x as Record<string, unknown>
  if (!isEdgeId(e.id) || seenIds.has(e.id)) return undefined
  if (typeof e.from !== 'string' || typeof e.to !== 'string' || !nodeIds.has(e.from) || !nodeIds.has(e.to) || e.from === e.to) return undefined
  if (typeof e.relation !== 'string' || !KNOWLEDGE_KEY_RE.test(e.relation)) return undefined
  const source = cleanSource(e.source)
  if (!source || !finite(e.createdAt)) return undefined
  const key = tripleKey({ from: e.from, to: e.to, relation: e.relation })
  if (seenTriples.has(key)) return undefined
  seenIds.add(e.id)
  seenTriples.add(key)
  const note = typeof e.note === 'string' && e.note.length <= KNOWLEDGE_EDGE_NOTE_MAX_CHARS && e.note.trim() && !hiddenCharIn(e.note, { multiline: true }) ? e.note : undefined
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    relation: e.relation,
    ...(note !== undefined ? { note } : {}),
    source,
    createdAt: e.createdAt,
    ...(e.retired === true ? { retired: true } : {})
  }
}

/** A graph from parsed JSON of any shape: junk entries dropped, caps applied, dangling edges and duplicate triples dropped. */
function cleanGraph(parsed: unknown, noteIndex: ReadonlySet<string>): KnowledgeGraph {
  const graph = emptyKnowledgeGraph()
  if (!parsed || typeof parsed !== 'object') return graph
  const g = parsed as Record<string, unknown>
  const nodeIds = new Set<string>()
  if (Array.isArray(g.nodes)) {
    for (const n of g.nodes) {
      const node = cleanNode(n, noteIndex, nodeIds)
      if (node) graph.nodes.push(node)
      if (graph.nodes.length >= KNOWLEDGE_NODES_MAX) break
    }
  }
  const edgeIds = new Set<string>()
  const triples = new Set<string>()
  if (Array.isArray(g.edges)) {
    for (const e of g.edges) {
      const edge = cleanEdge(e, nodeIds, edgeIds, triples)
      if (edge) graph.edges.push(edge)
      if (graph.edges.length >= KNOWLEDGE_EDGES_MAX) break
    }
  }
  if (finite(g.updatedAt)) graph.updatedAt = g.updatedAt
  return graph
}

/**
 * The file cap (KNOWLEDGE_FILE_MAX_BYTES) as the store applies it on read and write. Tests lower `maxBytes` to
 * exercise the over-size refusals without writing 64 MB files; nothing else assigns it.
 */
export const knowledgeFileLimits = { maxBytes: KNOWLEDGE_FILE_MAX_BYTES }

/**
 * How knowledge.json stands: 'missing' (no file; writes create it), 'ok' (a graph; junk inside dropped item by
 * item), 'unreadable' (present but not readable as a graph: over the cap, not a regular file, not JSON, or a root
 * without version 1 and node / edge arrays; reads are empty and writes refuse).
 */
export type KnowledgeFileState = 'missing' | 'ok' | 'unreadable'

/** A parsed root that is a graph at all: an object with version 1 and node / edge arrays (their items are checked later). */
function isGraphRoot(parsed: unknown): parsed is { version: 1; nodes: unknown[]; edges: unknown[] } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const g = parsed as Record<string, unknown>
  return g.version === 1 && Array.isArray(g.nodes) && Array.isArray(g.edges)
}

/** The stored graph with the file's state. Throws only on an unsafe project id. */
function loadGraph(dataDir: string, projectId: string): { graph: KnowledgeGraph; state: KnowledgeFileState } {
  const file = knowledgeFile(dataDir, projectId)
  try {
    lstatSync(file)
  } catch {
    return { graph: emptyKnowledgeGraph(), state: 'missing' }
  }
  const unreadable = { graph: emptyKnowledgeGraph(), state: 'unreadable' as const }
  const raw = readPlain(file, knowledgeFileLimits.maxBytes)
  if (!raw) return unreadable
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.text)
  } catch {
    return unreadable
  }
  if (!isGraphRoot(parsed)) return unreadable
  return { graph: cleanGraph(parsed, new Set(listNotes(dataDir, projectId).map((n) => n.id))), state: 'ok' }
}

/**
 * The graph as stored: empty when there is no file or it is unreadable (see KnowledgeFileState). Entries that fail
 * the contract are dropped, note links whose note is not in the index are dropped, and the caps apply on read too.
 * Never throws.
 */
export function readKnowledge(dataDir: string, projectId: string): KnowledgeGraph {
  try {
    return loadGraph(dataDir, projectId).graph
  } catch {
    return emptyKnowledgeGraph()
  }
}

/** The state of the project's knowledge.json (for the IPC layer to tell the user a file needs attention). Throws on an unsafe id. */
export function knowledgeFileState(dataDir: string, projectId: string): KnowledgeFileState {
  return loadGraph(dataDir, projectId).state
}

/** The refusal of every write while the file is present but unreadable (the path is the file to fix or remove). */
export function unreadableMessage(file: string): string {
  return `The knowledge graph file could not be read (too large or damaged); nothing was saved. Fix or remove ${file}.`
}

/** The graph for a write: a missing file is an empty graph, an unreadable one refuses (never overwritten). */
function loadForWrite(dataDir: string, projectId: string): KnowledgeGraph {
  const { graph, state } = loadGraph(dataDir, projectId)
  if (state === 'unreadable') throw new Error(unreadableMessage(knowledgeFile(dataDir, projectId)))
  return graph
}

/** Nodes in the stored graph (0 when there is no file or on any failure), for the project removal result. */
export function knowledgeNodeCount(dataDir: string, projectId: string): number {
  try {
    return readKnowledge(dataDir, projectId).nodes.length
  } catch {
    return 0
  }
}

// ---------- Validation of writes (refused, never cut) ----------

function checkKey(label: 'kind' | 'relation', raw: unknown): string {
  const key = normalizeKnowledgeKey(raw)
  if (!key) {
    const example = label === 'kind' ? 'person or open-question' : 'works-at or depends-on'
    throw new Error(`The ${label} must be 1..40 characters of letters, digits and dashes, e.g. ${example}.`)
  }
  return key
}

/** A name or alias: trimmed, 1..KNOWLEDGE_NAME_MAX_CHARS, one line, no hidden characters. */
function checkName(label: string, raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(`${label} must be text.`)
  const name = raw.trim()
  if (!name) throw new Error(`${label} is empty.`)
  if (name.length > KNOWLEDGE_NAME_MAX_CHARS) {
    throw new Error(`${label} is longer than ${KNOWLEDGE_NAME_MAX_CHARS} characters (${fmt(name.length)}). Shorten it; nothing was saved.`)
  }
  const problem = hiddenCharProblem(label, name)
  if (problem) throw new Error(problem)
  return name
}

/** Multi-line text (summary, fact, edge note): at most `max`, tab / LF / CR allowed, other hidden characters refused. */
function checkText(label: string, raw: unknown, max: number): string {
  if (typeof raw !== 'string') throw new Error(`${label} must be text.`)
  if (raw.length > max) throw new Error(`${label} is longer than ${fmt(max)} characters (${fmt(raw.length)}). Shorten it; nothing was saved.`)
  const problem = hiddenCharProblem(label, raw, { multiline: true })
  if (problem) throw new Error(problem)
  return raw
}

/** A fact's text: like checkText and not blank. */
function checkFactText(raw: unknown): string {
  const text = checkText('A fact', raw, KNOWLEDGE_FACT_MAX_CHARS)
  if (!text.trim()) throw new Error('A fact is empty.')
  return text
}

/** An optional summary / note: undefined = not given; '' (blank) = none. */
function checkOptionalText(label: string, raw: unknown, max: number): string | undefined {
  if (raw === undefined) return undefined
  const text = checkText(label, raw, max).trim()
  return text
}

function checkAliases(raw: unknown, name: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('Aliases must be a list of names.')
  const cleaned = raw.map((a) => checkName('An alias', a))
  const aliases = dedupeAliases(cleaned, name, Number.MAX_SAFE_INTEGER)
  if (aliases.length > KNOWLEDGE_ALIASES_MAX) throw new Error(`An entity keeps at most ${KNOWLEDGE_ALIASES_MAX} aliases (${aliases.length} given). Drop some; nothing was saved.`)
  return aliases
}

function checkNoteIds(raw: unknown, noteIndex: ReadonlySet<string>): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('Note links must be a list of note ids.')
  const out: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || !noteIndex.has(id)) throw new Error(`Unknown note id ${typeof id === 'string' ? JSON.stringify(id) : '(not text)'}.`)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > KNOWLEDGE_NODE_NOTES_MAX) throw new Error(`An entity links to at most ${KNOWLEDGE_NODE_NOTES_MAX} notes (${out.length} given). Drop some; nothing was saved.`)
  return out
}

function checkFactCount(n: number): void {
  if (n > KNOWLEDGE_NODE_FACTS_MAX) {
    throw new Error(`An entity keeps at most ${KNOWLEDGE_NODE_FACTS_MAX} facts (${n} would be stored). Retire or remove facts first; nothing was saved.`)
  }
}

function checkNodeCap(graph: KnowledgeGraph): void {
  if (graph.nodes.length >= KNOWLEDGE_NODES_MAX) throw new Error(`The knowledge graph is full (${fmt(KNOWLEDGE_NODES_MAX)} entities). Retire or remove entities first.`)
}

function checkEdgeCap(graph: KnowledgeGraph): void {
  if (graph.edges.length >= KNOWLEDGE_EDGES_MAX) throw new Error(`The knowledge graph is full (${fmt(KNOWLEDGE_EDGES_MAX)} relations). Remove relations first.`)
}

function checkRetired(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') throw new Error('retired must be true or false.')
  return raw
}

// ---------- Lookup and identity ----------

function nodeById(graph: KnowledgeGraph, id: unknown): KnowledgeNode {
  const node = typeof id === 'string' ? graph.nodes.find((n) => n.id === id) : undefined
  if (!node) throw new Error(`No entity with id ${typeof id === 'string' ? JSON.stringify(id) : '(not text)'}.`)
  return node
}

function edgeById(graph: KnowledgeGraph, id: unknown): KnowledgeEdge {
  const edge = typeof id === 'string' ? graph.edges.find((e) => e.id === id) : undefined
  if (!edge) throw new Error(`No relation with id ${typeof id === 'string' ? JSON.stringify(id) : '(not text)'}.`)
  return edge
}

/**
 * Nodes of `kind` named like `name` or like any of `aliases` (shared matchKnowledgeNodes over each): the nodes the
 * name matches first (graph order), then those only an alias matches, without `excludeId`. Retired nodes included.
 */
function matches(graph: KnowledgeGraph, kind: string, name: string, aliases: readonly string[], excludeId?: string): KnowledgeNode[] {
  const out: KnowledgeNode[] = []
  for (const candidate of [name, ...aliases]) {
    for (const n of matchKnowledgeNodes(graph, candidate, kind)) if (n.id !== excludeId && !out.includes(n)) out.push(n)
  }
  return out
}

function duplicateRefusal(kind: string, existing: KnowledgeNode): Error {
  return new Error(`An entity of kind ${kind} named ${JSON.stringify(existing.name)} already exists; edit it instead.`)
}

function newId(prefix: string, taken: ReadonlySet<string>): string {
  let id: string
  do id = `${prefix}${randomBytes(6).toString('hex')}`
  while (taken.has(id))
  return id
}

function factIdsOf(graph: KnowledgeGraph): Set<string> {
  return new Set(graph.nodes.flatMap((n) => n.facts.map((f) => f.id)))
}

// ---------- Write ----------

/** The refusal when the serialized graph would cross the file cap (nothing written). */
export const FILE_FULL_MESSAGE = `The knowledge graph file is full (${Math.round(KNOWLEDGE_FILE_MAX_BYTES / 1024 / 1024)} MB). Retire or remove entities first.`

/** Compact JSON (so the cap is meaningful); refused before anything touches the disk when it is over the cap. */
function writeGraph(dataDir: string, projectId: string, graph: KnowledgeGraph): void {
  ensurePlainDir(dataDir, projectId, projectDataDir(dataDir, projectId))
  const updatedAt = Date.now()
  const text = `${JSON.stringify({ ...graph, updatedAt })}\n`
  if (Buffer.byteLength(text, 'utf8') > knowledgeFileLimits.maxBytes) throw new Error(FILE_FULL_MESSAGE)
  atomicWrite(knowledgeFile(dataDir, projectId), text)
  graph.updatedAt = updatedAt
}

/** The user's source stamp. */
export function userSource(): KnowledgeSource {
  return { by: 'user', at: Date.now() }
}

/**
 * Agent upsert (KnowledgeStoreApi.upsertNode). Identity: `nodeId` when given (unknown = throw; a `kind` other than
 * the stored one is refused: "That entity is a <stored>, not a <given> ..."), else the first non-retired (kind, name /
 * alias) match (else the first match), else a new node. On a merge the stored name and kind stay (the input name
 * becomes an alias when it differs), new aliases are added (an alias naming another entity of the kind is skipped and
 * listed in `aliasesSkipped`), the summary is replaced when given and not blank unless the node is user-created
 * (then it is appended as a fact, deduped like the others, and `summaryKept` is true), facts are appended with the
 * caller's source unless a live fact with the same text exists (`factsAdded` counts them), note links are added; a
 * retired node stays retired (the caller reports it). Caps are checked before anything is written.
 */
export function upsertNode(dataDir: string, projectId: string, input: KnowledgeNodeUpsertInput, source: KnowledgeSource): KnowledgeNodeWriteResult {
  const graph = loadForWrite(dataDir, projectId)
  const kind = checkKey('kind', input.kind)
  const name = checkName('The name', input.name)
  const aliases = checkAliases(input.aliases, name)
  const summary = checkOptionalText('The summary', input.summary, KNOWLEDGE_SUMMARY_MAX_CHARS)
  if (input.facts !== undefined && !Array.isArray(input.facts)) throw new Error('Facts must be a list of texts.')
  const factTexts = (input.facts ?? []).map(checkFactText)
  const noteIds = checkNoteIds(input.noteIds, new Set(listNotes(dataDir, projectId).map((n) => n.id)))
  const now = Date.now()

  let target: KnowledgeNode | undefined
  if (input.nodeId !== undefined) {
    target = nodeById(graph, input.nodeId)
    if (target.kind !== kind) throw new Error(`That entity is a ${target.kind}, not a ${kind}. Retire it and create a new one, or pass its kind.`)
  } else {
    const found = matches(graph, kind, name, aliases)
    target = found.find((n) => !n.retired) ?? found[0]
  }

  if (!target) {
    checkNodeCap(graph)
    const texts = dedupeFactTexts(factTexts, [])
    checkFactCount(texts.length)
    const factIds = factIdsOf(graph)
    const facts = texts.map((text): KnowledgeFact => {
      const id = newId(FACT_PREFIX, factIds)
      factIds.add(id)
      return { id, text, source }
    })
    const node: KnowledgeNode = {
      id: newId(NODE_PREFIX, new Set(graph.nodes.map((n) => n.id))),
      kind,
      name,
      ...(aliases.length ? { aliases } : {}),
      ...(summary ? { summary } : {}),
      facts,
      ...(noteIds.length ? { noteIds } : {}),
      source,
      createdAt: now,
      updatedAt: now
    }
    graph.nodes.push(node)
    writeGraph(dataDir, projectId, graph)
    return { node, created: true, factsAdded: facts.length, aliasesSkipped: [] }
  }

  // Merge: aliases (the input name included) that the node does not answer to yet and no other entity of the kind owns.
  const addAliases: string[] = []
  const aliasesSkipped: string[] = []
  for (const candidate of [...aliases, name]) {
    if (knowledgeNodeNamed(target, candidate) || addAliases.some((a) => knowledgeNameKey(a) === knowledgeNameKey(candidate))) continue
    if (matchKnowledgeNodes(graph, candidate, target.kind).some((n) => n.id !== target.id)) {
      aliasesSkipped.push(candidate)
      continue
    }
    addAliases.push(candidate)
  }
  const mergedAliases = [...(target.aliases ?? []), ...addAliases]
  if (mergedAliases.length > KNOWLEDGE_ALIASES_MAX) {
    throw new Error(`An entity keeps at most ${KNOWLEDGE_ALIASES_MAX} aliases (${mergedAliases.length} would be stored). Drop some; nothing was saved.`)
  }
  // A user-created entity keeps the user's summary: an agent's summary becomes a fact instead (M1).
  const summaryKept = !!summary && target.source.by === 'user' && source.by !== 'user'
  const summaryFact = summaryKept && knowledgeNameKey(target.summary ?? '') !== knowledgeNameKey(summary) ? [summary] : []
  const newTexts = dedupeFactTexts([...factTexts, ...summaryFact], target.facts.filter((f) => !f.retired).map((f) => f.text))
  checkFactCount(target.facts.length + newTexts.length)
  const mergedNotes = [...new Set([...(target.noteIds ?? []), ...noteIds])]
  if (mergedNotes.length > KNOWLEDGE_NODE_NOTES_MAX) {
    throw new Error(`An entity links to at most ${KNOWLEDGE_NODE_NOTES_MAX} notes (${mergedNotes.length} would be stored). Drop some; nothing was saved.`)
  }
  const factIds = factIdsOf(graph)
  for (const text of newTexts) {
    const id = newId(FACT_PREFIX, factIds)
    factIds.add(id)
    target.facts.push({ id, text, source })
  }
  if (mergedAliases.length) target.aliases = mergedAliases
  if (summary && !summaryKept) target.summary = summary
  if (mergedNotes.length) target.noteIds = mergedNotes
  target.updatedBy = source
  target.updatedAt = now
  writeGraph(dataDir, projectId, graph)
  return { node: target, created: false, factsAdded: newTexts.length, aliasesSkipped, ...(summaryKept ? { summaryKept: true } : {}) }
}

/** The refusal of a compare-and-set save whose expectedUpdatedAt no longer matches (code 'stale'). */
export const STALE_NODE_MESSAGE = 'This item changed since you opened it. Reload it and try again.'

function staleError(): Error {
  return Object.assign(new Error(STALE_NODE_MESSAGE), { code: 'stale' })
}

/** saveNodeForUser's appendFacts: undefined = none; a list of at most KNOWLEDGE_NODE_FACTS_MAX fact texts. */
function checkAppendFacts(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('appendFacts must be a list of texts.')
  checkFactCount(raw.length)
  return raw.map(checkFactText)
}

/** Texts not already present (by knowledgeNameKey) in `existing`, without repeats among themselves. */
function dedupeFactTexts(texts: string[], existing: string[]): string[] {
  const seen = new Set(existing.map(knowledgeNameKey))
  const out: string[] = []
  for (const t of texts) {
    const k = knowledgeNameKey(t)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/**
 * The user's editor save (knowledge:saveNode; see KnowledgeNodeSaveInput). Without nodeId: a new node, refused when a
 * (kind, name / alias) match exists. With nodeId: field by field replacement (kind and name may change; uniqueness is
 * re-checked); `facts` given = the full list (an id keeps that fact's source, and its retired flag unless given; an
 * unknown id is refused; no id = a new user fact), omitted = unchanged; `aliases`, `summary`, `noteIds` given replace,
 * omitted keep; `retired` given sets it. The source stamp is the user's.
 *
 * cli-spec 3.6 item 3: `expectedUpdatedAt` (only with nodeId; a finite number) refuses the save with code 'stale'
 * when the stored node's updatedAt differs. `appendFacts` adds each text as a new user fact (after `facts`, when both
 * are given) unless a live fact with the same text (knowledgeNameKey, the agent upsert's rule) is already on the node
 * or earlier in the list; it works on create and update, and the KNOWLEDGE_NODE_FACTS_MAX cap counts the result.
 * The whole read-check-modify-write is one synchronous call (loadForWrite to writeGraph), so it is atomic in-process.
 */
export function saveNodeForUser(dataDir: string, projectId: string, input: Omit<KnowledgeNodeSaveInput, 'projectId'>): KnowledgeNode {
  const graph = loadForWrite(dataDir, projectId)
  const kind = checkKey('kind', input.kind)
  const name = checkName('The name', input.name)
  const aliases = input.aliases === undefined ? undefined : checkAliases(input.aliases, name)
  const summary = checkOptionalText('The summary', input.summary, KNOWLEDGE_SUMMARY_MAX_CHARS)
  const noteIds = input.noteIds === undefined ? undefined : checkNoteIds(input.noteIds, new Set(listNotes(dataDir, projectId).map((n) => n.id)))
  const retired = checkRetired(input.retired)
  if (input.facts !== undefined && !Array.isArray(input.facts)) throw new Error('Facts must be a list.')
  const factInputs = input.facts?.map((f): KnowledgeFactInput => {
    if (!f || typeof f !== 'object') throw new Error('A fact must be an object with text.')
    if (f.id !== undefined && !isFactId(f.id)) throw new Error(`Unknown fact id ${typeof f.id === 'string' ? JSON.stringify(f.id) : '(not text)'}.`)
    return { ...(f.id !== undefined ? { id: f.id } : {}), text: checkFactText(f.text), ...(f.retired !== undefined ? { retired: checkRetired(f.retired) } : {}) }
  })
  const appendTexts = checkAppendFacts(input.appendFacts)
  const expected = input.expectedUpdatedAt
  if (expected !== undefined) {
    if (typeof expected !== 'number' || !Number.isFinite(expected)) throw new Error('expectedUpdatedAt must be a finite number.')
    if (input.nodeId === undefined) throw new Error('expectedUpdatedAt needs the nodeId of the item being edited.')
  }
  const source = userSource()
  const now = source.at
  /** appendFacts as new user facts after `facts` (cli-spec 3.6 item 3), deduped like the agent upsert's facts. */
  const appended = (facts: KnowledgeFact[], factIds: Set<string>): KnowledgeFact[] => {
    const texts = dedupeFactTexts(appendTexts, facts.filter((f) => !f.retired).map((f) => f.text))
    return texts.map((text) => {
      const id = newId(FACT_PREFIX, factIds)
      factIds.add(id)
      return { id, text, source }
    })
  }

  if (input.nodeId === undefined) {
    const found = matches(graph, kind, name, aliases ?? [])
    if (found.length) throw duplicateRefusal(kind, found[0])
    checkNodeCap(graph)
    const factIds = factIdsOf(graph)
    const given = (factInputs ?? []).map((f): KnowledgeFact => {
      if (f.id !== undefined) throw new Error(`Unknown fact id ${JSON.stringify(f.id)}.`)
      const id = newId(FACT_PREFIX, factIds)
      factIds.add(id)
      return { id, text: f.text, source, ...(f.retired ? { retired: true } : {}) }
    })
    const facts = [...given, ...appended(given, factIds)]
    checkFactCount(facts.length)
    const node: KnowledgeNode = {
      id: newId(NODE_PREFIX, new Set(graph.nodes.map((n) => n.id))),
      kind,
      name,
      ...(aliases?.length ? { aliases } : {}),
      ...(summary ? { summary } : {}),
      facts,
      ...(noteIds?.length ? { noteIds } : {}),
      source,
      createdAt: now,
      updatedAt: now,
      ...(retired ? { retired: true } : {})
    }
    graph.nodes.push(node)
    writeGraph(dataDir, projectId, graph)
    return node
  }

  const node = nodeById(graph, input.nodeId)
  // Compare-and-set: checked on the graph just read, in the same synchronous call as the write below.
  if (expected !== undefined && node.updatedAt !== expected) throw staleError()
  const keptAliases = aliases ?? dedupeAliases(node.aliases ?? [], name, KNOWLEDGE_ALIASES_MAX)
  const found = matches(graph, kind, name, keptAliases, node.id)
  if (found.length) throw duplicateRefusal(kind, found[0])
  let facts = node.facts
  const factIds = factIdsOf(graph)
  if (factInputs) {
    const seen = new Set<string>()
    facts = factInputs.map((f): KnowledgeFact => {
      if (f.id !== undefined) {
        const old = node.facts.find((x) => x.id === f.id)
        if (!old) throw new Error(`Unknown fact id ${JSON.stringify(f.id)}.`)
        if (seen.has(f.id)) throw new Error(`Fact id ${JSON.stringify(f.id)} is listed twice.`)
        seen.add(f.id)
        const flag = f.retired ?? old.retired
        return { id: old.id, text: f.text, source: old.source, ...(flag ? { retired: true } : {}) }
      }
      const id = newId(FACT_PREFIX, factIds)
      factIds.add(id)
      return { id, text: f.text, source, ...(f.retired ? { retired: true } : {}) }
    })
    checkFactCount(facts.length)
  }
  if (appendTexts.length) {
    facts = [...facts, ...appended(facts, factIds)]
    checkFactCount(facts.length)
  }
  node.kind = kind
  node.name = name
  if (keptAliases.length) node.aliases = keptAliases
  else delete node.aliases
  if (summary !== undefined) {
    if (summary) node.summary = summary
    else delete node.summary
  }
  node.facts = facts
  if (noteIds !== undefined) {
    if (noteIds.length) node.noteIds = noteIds
    else delete node.noteIds
  }
  if (retired !== undefined) {
    if (retired) node.retired = true
    else delete node.retired
  }
  node.updatedBy = source
  node.updatedAt = now
  writeGraph(dataDir, projectId, graph)
  return node
}

/** Remove a node and every edge touching it (unknown id throws). Returns the graph afterwards. */
export function removeNode(dataDir: string, projectId: string, nodeId: string): KnowledgeGraph {
  const graph = loadForWrite(dataDir, projectId)
  const node = nodeById(graph, nodeId)
  graph.nodes = graph.nodes.filter((n) => n !== node)
  graph.edges = graph.edges.filter((e) => e.from !== node.id && e.to !== node.id)
  writeGraph(dataDir, projectId, graph)
  return graph
}

/**
 * Agent link or user edge save (KnowledgeStoreApi.saveEdge). from / to must be existing, distinct node ids. Without
 * edgeId a (from, to, relation) match is updated (note when given, retired when given; nothing else touched) and
 * reported as not created, else a new edge with the caller's source. With edgeId only that edge's note / retired
 * change, and from / to / relation must equal the stored edge's (refused otherwise: "That relation id names ...").
 */
export function saveEdge(dataDir: string, projectId: string, input: Omit<KnowledgeEdgeSaveInput, 'projectId'>, source: KnowledgeSource): KnowledgeEdgeWriteResult {
  const graph = loadForWrite(dataDir, projectId)
  const relation = checkKey('relation', input.relation)
  const note = checkOptionalText('The note', input.note, KNOWLEDGE_EDGE_NOTE_MAX_CHARS)
  const retired = checkRetired(input.retired)
  const nameOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id
  const apply = (edge: KnowledgeEdge): KnowledgeEdgeWriteResult => {
    if (note !== undefined) {
      if (note) edge.note = note
      else delete edge.note
    }
    if (retired !== undefined) {
      if (retired) edge.retired = true
      else delete edge.retired
    }
    writeGraph(dataDir, projectId, graph)
    return { edge, created: false }
  }
  if (input.edgeId !== undefined) {
    const edge = edgeById(graph, input.edgeId)
    if (input.from !== edge.from || input.to !== edge.to || relation !== edge.relation) {
      throw new Error(`That relation id names ${nameOf(edge.from)} ${edge.relation} ${nameOf(edge.to)}; from, to and relation cannot change. Remove it and link again.`)
    }
    return apply(edge)
  }
  const from = typeof input.from === 'string' ? graph.nodes.find((n) => n.id === input.from) : undefined
  if (!from) throw new Error(`The "from" entity ${typeof input.from === 'string' ? JSON.stringify(input.from) : '(not text)'} does not exist.`)
  const to = typeof input.to === 'string' ? graph.nodes.find((n) => n.id === input.to) : undefined
  if (!to) throw new Error(`The "to" entity ${typeof input.to === 'string' ? JSON.stringify(input.to) : '(not text)'} does not exist.`)
  if (from === to) throw new Error('An entity cannot relate to itself.')
  const key = tripleKey({ from: from.id, to: to.id, relation })
  const existing = graph.edges.find((e) => tripleKey(e) === key)
  if (existing) return apply(existing)
  checkEdgeCap(graph)
  const edge: KnowledgeEdge = {
    id: newId(EDGE_PREFIX, new Set(graph.edges.map((e) => e.id))),
    from: from.id,
    to: to.id,
    relation,
    ...(note ? { note } : {}),
    source,
    createdAt: source.at,
    ...(retired ? { retired: true } : {})
  }
  graph.edges.push(edge)
  writeGraph(dataDir, projectId, graph)
  return { edge, created: true }
}

/** Remove one edge (unknown id throws). Returns the graph afterwards. */
export function removeEdge(dataDir: string, projectId: string, edgeId: string): KnowledgeGraph {
  const graph = loadForWrite(dataDir, projectId)
  const edge = edgeById(graph, edgeId)
  graph.edges = graph.edges.filter((e) => e !== edge)
  writeGraph(dataDir, projectId, graph)
  return graph
}

/** Delete the graph file (a link is removed, never followed; an unreadable file too: this is the user's start-over). Returns the empty graph. */
export function clearKnowledge(dataDir: string, projectId: string): KnowledgeGraph {
  const file = knowledgeFile(dataDir, projectId)
  if (isLink(file) || existsSync(file)) rmSync(file, { force: true })
  return emptyKnowledgeGraph()
}

/**
 * Agent retire (KnowledgeStoreApi.retire): exactly one of nodeId / edgeId / factId. An item the user wrote is refused
 * for an agent caller ("Only the user can change that."); an already retired item is reported without a write.
 */
export function retireItem(dataDir: string, projectId: string, input: KnowledgeRetireInput, source: KnowledgeSource): KnowledgeRetireResult {
  const given = (['nodeId', 'edgeId', 'factId'] as const).filter((k) => input[k] !== undefined)
  if (given.length !== 1) throw new Error('Name exactly one of nodeId, edgeId or factId.')
  const graph = loadForWrite(dataDir, projectId)
  const guard = (item: { source: KnowledgeSource }): void => {
    if (item.source.by === 'user' && source.by !== 'user') throw new Error('Only the user can change that.')
  }
  const nameOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id
  if (given[0] === 'nodeId') {
    const node = nodeById(graph, input.nodeId)
    guard(node)
    const label = `${node.kind} ${node.name}`
    if (node.retired) return { item: 'node', id: node.id, label, alreadyRetired: true }
    node.retired = true
    node.updatedBy = source
    node.updatedAt = source.at
    writeGraph(dataDir, projectId, graph)
    return { item: 'node', id: node.id, label, alreadyRetired: false }
  }
  if (given[0] === 'edgeId') {
    const edge = edgeById(graph, input.edgeId)
    guard(edge)
    const label = `${nameOf(edge.from)} ${edge.relation} ${nameOf(edge.to)}`
    if (edge.retired) return { item: 'edge', id: edge.id, label, alreadyRetired: true }
    edge.retired = true
    writeGraph(dataDir, projectId, graph)
    return { item: 'edge', id: edge.id, label, alreadyRetired: false }
  }
  const fact = typeof input.factId === 'string' ? graph.nodes.flatMap((n) => n.facts).find((f) => f.id === input.factId) : undefined
  if (!fact) throw new Error(`No fact with id ${typeof input.factId === 'string' ? JSON.stringify(input.factId) : '(not text)'}.`)
  guard(fact)
  if (fact.retired) return { item: 'fact', id: fact.id, label: fact.text, alreadyRetired: true }
  fact.retired = true
  writeGraph(dataDir, projectId, graph)
  return { item: 'fact', id: fact.id, label: fact.text, alreadyRetired: false }
}

/** The store as RunManager and ipc.ts use it, bound to the data dir. */
export function knowledgeStore(dataDir: string): KnowledgeStoreApi {
  return {
    get: (projectId) => readKnowledge(dataDir, projectId),
    upsertNode: (projectId, input, source) => upsertNode(dataDir, projectId, input, source),
    saveEdge: (projectId, input, source) => saveEdge(dataDir, projectId, input, source),
    retire: (projectId, input, source) => retireItem(dataDir, projectId, input, source)
  }
}
