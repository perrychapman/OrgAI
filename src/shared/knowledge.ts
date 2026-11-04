import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSearchHit, KnowledgeSearchQuery, KnowledgeVocabulary } from './types'
import { KNOWLEDGE_KEY_RE, KNOWLEDGE_SEARCH_LIMIT } from './types'

/**
 * Pure helpers over an engagement's knowledge graph (types.ts "Engagement knowledge graph"). No I/O, no validation of
 * text limits (store/knowledge.ts does that): normalisation of kinds and relations, vocabulary counts, identity
 * matching and search. Main and the renderer share them.
 */

/** An empty graph (what code projects and new engagements read). */
export function emptyKnowledgeGraph(): KnowledgeGraph {
  return { version: 1, nodes: [], edges: [] }
}

/**
 * A kind or relation as stored: trimmed, lower-cased, runs of whitespace and underscores turned into one '-', runs of
 * '-' collapsed. Null when the result does not match KNOWLEDGE_KEY_RE (empty, too long, other characters).
 */
export function normalizeKnowledgeKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
  return KNOWLEDGE_KEY_RE.test(key) ? key : null
}

/** A name or alias as compared: trimmed, inner whitespace collapsed, case folded. */
export function knowledgeNameKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** True when `node` is named `name` (its name or one of its aliases), case-insensitively. */
export function knowledgeNodeNamed(node: Pick<KnowledgeNode, 'name' | 'aliases'>, name: string): boolean {
  const key = knowledgeNameKey(name)
  if (!key) return false
  if (knowledgeNameKey(node.name) === key) return true
  return (node.aliases ?? []).some((a) => knowledgeNameKey(a) === key)
}

/**
 * Nodes matching a name (name or alias), optionally within one normalised kind. Retired nodes are included: a merge
 * must find them so a retired entity is not re-created beside itself.
 */
export function matchKnowledgeNodes(graph: Pick<KnowledgeGraph, 'nodes'>, name: string, kind?: string): KnowledgeNode[] {
  return graph.nodes.filter((n) => (kind === undefined || n.kind === kind) && knowledgeNodeNamed(n, name))
}

/**
 * Resolve an agent's node reference: an id (`kn_...`) first, else the nodes named like it in any kind. One hit =
 * { node }; several = { candidates } (the caller refuses and lists them); none = null.
 */
export function resolveKnowledgeNode(graph: Pick<KnowledgeGraph, 'nodes'>, ref: string): { node: KnowledgeNode } | { candidates: KnowledgeNode[] } | null {
  const want = ref.trim()
  if (!want) return null
  const byId = graph.nodes.find((n) => n.id === want)
  if (byId) return { node: byId }
  const named = matchKnowledgeNodes(graph, want)
  if (named.length === 1) return { node: named[0] }
  if (named.length > 1) return { candidates: named }
  return null
}

/** Edges touching a node in either direction (retired ones included unless `liveOnly`). */
export function knowledgeEdgesOf(graph: Pick<KnowledgeGraph, 'edges'>, nodeId: string, liveOnly = false): KnowledgeEdge[] {
  return graph.edges.filter((e) => (e.from === nodeId || e.to === nodeId) && (!liveOnly || !e.retired))
}

/** Kinds and relations in use over live (non-retired) items, most used first, then alphabetical. */
export function knowledgeVocabulary(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>): KnowledgeVocabulary {
  const count = (keys: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }
  const sorted = (m: Map<string, number>): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const retiredNodes = new Set(graph.nodes.filter((n) => n.retired).map((n) => n.id))
  return {
    kinds: sorted(count(graph.nodes.filter((n) => !n.retired).map((n) => n.kind))).map(([kind, c]) => ({ kind, count: c })),
    relations: sorted(count(graph.edges.filter((e) => !e.retired && !retiredNodes.has(e.from) && !retiredNodes.has(e.to)).map((e) => e.relation))).map(([relation, c]) => ({ relation, count: c }))
  }
}

/** The search limit as applied: 1..KNOWLEDGE_SEARCH_LIMIT, default KNOWLEDGE_SEARCH_LIMIT. */
export function knowledgeSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return KNOWLEDGE_SEARCH_LIMIT
  return Math.min(KNOWLEDGE_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * Case-insensitive substring search over name, aliases, summary and live fact texts, optionally within one kind.
 * Name / alias hits first, then the most recently updated. Without a query (and with or without a kind) the most
 * recently updated nodes. Retired nodes are left out unless `includeRetired`. At most `limit` hits.
 */
export function searchKnowledge(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, q: KnowledgeSearchQuery = {}): KnowledgeSearchHit[] {
  const text = knowledgeNameKey(q.query ?? '')
  const kind = q.kind === undefined || q.kind === '' ? undefined : q.kind
  const limit = knowledgeSearchLimit(q.limit)
  const matched: { node: KnowledgeNode; nameHit: boolean }[] = []
  for (const node of graph.nodes) {
    if (node.retired && !q.includeRetired) continue
    if (kind !== undefined && node.kind !== kind) continue
    let nameHit = false
    if (text) {
      nameHit = knowledgeNameKey(node.name).includes(text) || (node.aliases ?? []).some((a) => knowledgeNameKey(a).includes(text))
      const other =
        !nameHit &&
        ((node.summary !== undefined && knowledgeNameKey(node.summary).includes(text)) || node.facts.some((f) => !f.retired && knowledgeNameKey(f.text).includes(text)))
      if (!nameHit && !other) continue
    }
    matched.push({ node, nameHit })
  }
  matched.sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || b.node.updatedAt - a.node.updatedAt || a.node.name.localeCompare(b.node.name))
  // Edge counts only for the hits returned, through one pass over the edges (a full graph is 2,000 x 5,000 otherwise).
  const top = matched.slice(0, limit)
  const counts = new Map<string, number>(top.map((h) => [h.node.id, 0]))
  for (const e of graph.edges) {
    if (e.retired) continue
    const f = counts.get(e.from)
    if (f !== undefined) counts.set(e.from, f + 1)
    if (e.to !== e.from) {
      const t = counts.get(e.to)
      if (t !== undefined) counts.set(e.to, t + 1)
    }
  }
  return top.map((h) => ({ ...h, edgeCount: counts.get(h.node.id) ?? 0 }))
}
