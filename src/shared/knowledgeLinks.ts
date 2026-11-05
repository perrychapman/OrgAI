import type { KnowledgeAppearance, KnowledgeGraph, KnowledgeInferencePartial, KnowledgeInferredLink, KnowledgeInferredResult, KnowledgeLinkBasis, KnowledgeNode } from './types'
import { KNOWLEDGE_INFERRED_LINKS_MAX, KNOWLEDGE_MATCH_BUDGET } from './types'
import type { KnowledgeMatchBudget, KnowledgeMatcherRules } from './knowledgeIndex'
import { knowledgeCompare, knowledgeHash, knowledgeNameMatcher } from './knowledgeIndex'

/**
 * Connections derived from the graph beyond the recorded edges (types.ts KnowledgeInferredLink). Pure, nothing is
 * stored. What is built here is what passed the evaluation in docs/design/knowledge-connections.md; the rest is
 * recorded by agents as ordinary relations (KNOWLEDGE_COMMON_RELATIONS).
 */

type GraphLike = Pick<KnowledgeGraph, 'nodes' | 'edges'> & Partial<Pick<KnowledgeGraph, 'updatedAt' | 'dismissedLinks'>>

/** A mention link at or above this strength may appear in knowledge_recall (basis 'mention' only). */
export const KNOWLEDGE_STRONG_MENTION = 0.65
const EVIDENCE_MAX = 200

/** `kl_` + 16 hex over basis and endpoints only, so an edit to the evidence keeps the id. Symmetric bases sort the endpoints. */
export function knowledgeLinkId(basis: KnowledgeLinkBasis, a: string, b: string): string {
  const [x, y] = basis === 'mention' ? [a, b] : a <= b ? [a, b] : [b, a]
  return `kl_${knowledgeHash(`${basis}\u0000${x}\u0000${y}`)}`
}

/**
 * Relation word suggested for a mention link, by the kinds of the entity whose text mentions (`from`) and the one
 * mentioned (`to`). Only pairs that were measured (docs/design/knowledge-connections.md) are listed.
 */
export const KNOWLEDGE_KIND_PAIR_RELATIONS: Readonly<Record<string, string>> = {
  'risk>system': 'affects',
  'person>organisation': 'works-at'
}

export function suggestKnowledgeRelation(fromKind: string, toKind: string): string | undefined {
  return KNOWLEDGE_KIND_PAIR_RELATIONS[`${fromKind}>${toKind}`]
}

const LINE_BREAKERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

function oneLine(s: string): string {
  return s.replace(LINE_BREAKERS, ' ').replace(/\s+/g, ' ').trim()
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd() + '…'
}

function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 60)
  const to = Math.min(text.length, end + 60)
  return `${from > 0 ? '…' : ''}${oneLine(text.slice(from, to))}${to < text.length ? '…' : ''}`
}

interface MentionAgg {
  from: string
  to: string
  count: number
  multi: boolean
  /** In how many of the backing texts the span also named another entity with the same name. */
  ambiguous: number
  evidence: string
  factId?: string
}

/** A span that names two entities (equal names across kinds) cannot say which one is meant: never at or above this. */
const AMBIGUOUS_STRENGTH_MAX = 0.49

function mentionStrength(a: MentionAgg): number {
  const strength = Math.max(0, Math.min(1, 0.35 + 0.15 * Math.min(a.count, 3) + (a.multi ? 0.2 : 0)))
  // Always below the 0.5 line the evaluation draws, and so below KNOWLEDGE_STRONG_MENTION, however often it is repeated.
  return a.ambiguous >= a.count ? Math.min(AMBIGUOUS_STRENGTH_MAX, Math.max(0, strength - 0.3)) : strength
}

/** The first time a pair is seen also builds its evidence snippet, so it counts for more than a plain match. */
const NEW_PAIR_COST = 8

interface MentionPass {
  aggs: MentionAgg[]
  /** Set when KNOWLEDGE_MATCH_BUDGET stopped the pass. */
  partial?: KnowledgeInferencePartial
}

/**
 * Every mention of a live entity in another live entity's summary or live facts, as aggregates, under one
 * KNOWLEDGE_MATCH_BUDGET (`budget` replaces it for a test). Entities are scanned in graph order; past the budget the pass
 * stops and says how far it got.
 */
function mentionAggregates(graph: GraphLike, rules?: KnowledgeMatcherRules, budgetTotal: number = KNOWLEDGE_MATCH_BUDGET): MentionPass {
  const live = graph.nodes.filter((n) => !n.retired)
  const matcher = knowledgeNameMatcher(live, rules)
  if (matcher.size === 0) return { aggs: [] }
  const budget: KnowledgeMatchBudget = { left: budgetTotal }
  const agg = new Map<string, MentionAgg>()
  const scan = (owner: KnowledgeNode, text: string | undefined, label: string, factId?: string): void => {
    if (!text) return
    const seen = new Set<string>()
    const found = matcher.find(text, budget)
    // A span that names the owner itself ("Stripe" in Stripe's own text) is not also a mention of an entity that shares the name.
    const selfAt = new Set(found.filter((m) => m.id === owner.id).map((m) => m.charStart))
    const idsAt = new Map<number, Set<string>>()
    for (const m of found) (idsAt.get(m.charStart) ?? idsAt.set(m.charStart, new Set()).get(m.charStart)!).add(m.id)
    for (const m of found) {
      if (m.id === owner.id || selfAt.has(m.charStart) || seen.has(m.id)) continue
      seen.add(m.id)
      const key = `${owner.id}\u0000${m.id}`
      const multi = m.tokenEnd - m.tokenStart > 1
      const amb = (idsAt.get(m.charStart)?.size ?? 1) > 1 ? 1 : 0
      const hit = agg.get(key)
      if (hit) {
        hit.count++
        hit.ambiguous += amb
        hit.multi = hit.multi || multi
      } else {
        budget.left -= NEW_PAIR_COST
        agg.set(key, { from: owner.id, to: m.id, count: 1, multi, ambiguous: amb, evidence: clip(`${label}: "${snippet(text, m.charStart, m.charEnd)}"`, EVIDENCE_MAX), ...(factId ? { factId } : {}) })
      }
    }
  }
  let scanned = 0
  for (const n of live) {
    scan(n, n.summary, 'Summary')
    for (const f of n.facts) if (!f.retired) scan(n, f.text, 'Fact', f.id)
    if (budget.exhausted) break
    scanned++
  }
  return { aggs: [...agg.values()], ...(budget.exhausted ? { partial: { scannedEntities: scanned, totalEntities: live.length } } : {}) }
}

function toMentionLink(a: MentionAgg, kinds: Map<string, string>): KnowledgeInferredLink {
  const rel = suggestKnowledgeRelation(kinds.get(a.from) ?? '', kinds.get(a.to) ?? '')
  return {
    id: knowledgeLinkId('mention', a.from, a.to),
    from: a.from,
    to: a.to,
    basis: 'mention',
    ...(rel ? { suggestedRelation: rel } : {}),
    evidence: a.evidence,
    ...(a.factId ? { evidenceFactId: a.factId } : {}),
    strength: mentionStrength(a),
    count: a.count
  }
}

function kindMap(graph: GraphLike): Map<string, string> {
  return new Map(graph.nodes.map((n) => [n.id, n.kind]))
}

function byStrength(a: KnowledgeInferredLink, b: KnowledgeInferredLink): number {
  return b.strength - a.strength || b.count - a.count || knowledgeCompare(a.basis, b.basis) || knowledgeCompare(a.from, b.from) || knowledgeCompare(a.to, b.to)
}

/**
 * Every mention of a live entity in another live entity's summary or live facts: uncapped, not filtered by existing
 * edges, not hub-limited, dismissed ones left out. Strongest first.
 */
export function knowledgeMentions(graph: GraphLike, rules?: KnowledgeMatcherRules): KnowledgeInferredLink[] {
  return mentionsFrom(graph, mentionAggregates(graph, rules).aggs)
}

function mentionsFrom(graph: GraphLike, aggs: readonly MentionAgg[]): KnowledgeInferredLink[] {
  const dismissed = new Set(graph.dismissedLinks ?? [])
  const kinds = kindMap(graph)
  return aggs
    .map((a) => toMentionLink(a, kinds))
    .filter((l) => !dismissed.has(l.id))
    .sort(byStrength)
}

export interface InferKnowledgeOptions {
  /** At most this many links, 1..KNOWLEDGE_INFERRED_LINKS_MAX (default the maximum). */
  cap?: number
  includeDismissed?: boolean
  /**
   * Drop mention suggestions whose target is named by more than this many different entities. Off by default: the
   * evaluation found no precision gain from it (docs/design/knowledge-connections.md); the cap bounds the volume.
   */
  hubCutoff?: number
  /** Matcher rules; the defaults are the shipped ones (the evaluation turns them off to measure them). */
  matcherRules?: KnowledgeMatcherRules
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** The entity's own spelling of a folded name key (its name or the alias that folds to it). */
function spellingOf(n: KnowledgeNode, key: string): string {
  return [n.name, ...(n.aliases ?? [])].find((s) => s.trim().replace(/\s+/g, ' ').toLowerCase() === key) ?? key
}

/**
 * Suggested connections for the user to confirm or dismiss: mentions (an entity's summary or live fact names another)
 * and equal names across kinds. Both ends live, never self, no pair that already has a live edge or a retired edge the
 * user wrote (an agent could otherwise silence a suggestion by linking and retiring), dismissed ids left out, strongest
 * first, at most KNOWLEDGE_INFERRED_LINKS_MAX. The cost is bounded, not linear in general: one pass costs at most tokens x
 * KNOWLEDGE_NAME_TOKENS_MAX trie steps plus the matches, and KNOWLEDGE_MATCH_BUDGET caps the total (knowledgeInferredResult
 * reports a pass it stopped). Equal-name groups are bounded at 6. Shared context notes and same-relation siblings were
 * evaluated and rejected (see the doc).
 */
export function inferKnowledgeLinks(graph: GraphLike, opts: InferKnowledgeOptions = {}): KnowledgeInferredLink[] {
  return linksFrom(graph, mentionAggregates(graph, opts.matcherRules).aggs, opts)
}

function linksFrom(graph: GraphLike, aggs: readonly MentionAgg[], opts: InferKnowledgeOptions = {}): KnowledgeInferredLink[] {
  const cap = Math.min(KNOWLEDGE_INFERRED_LINKS_MAX, Math.max(1, Math.floor(opts.cap ?? KNOWLEDGE_INFERRED_LINKS_MAX)))
  const hub = opts.hubCutoff === undefined ? Infinity : Math.max(1, Math.floor(opts.hubCutoff))
  const live = graph.nodes.filter((n) => !n.retired)
  const kinds = kindMap(graph)
  const connected = new Set<string>()
  for (const e of graph.edges) if (!e.retired || e.source.by === 'user') connected.add(pairKey(e.from, e.to))
  const out: KnowledgeInferredLink[] = []

  const mentioners = new Map<string, number>()
  for (const a of aggs) mentioners.set(a.to, (mentioners.get(a.to) ?? 0) + 1)
  for (const a of aggs) {
    // An ambiguous mention (the span names two entities) is counted in appearances but never suggested: it was wrong about half the time.
    if (a.ambiguous >= a.count || (mentioners.get(a.to) ?? 0) > hub || connected.has(pairKey(a.from, a.to))) continue
    out.push(toMentionLink(a, kinds))
  }

  // equal name or alias across different kinds
  const byName = new Map<string, KnowledgeNode[]>()
  for (const n of live) {
    for (const nm of new Set([n.name, ...(n.aliases ?? [])].map((s) => s.trim().replace(/\s+/g, ' ').toLowerCase()).filter((s) => s.length >= 3))) {
      ;(byName.get(nm) ?? byName.set(nm, []).get(nm)!).push(n)
    }
  }
  const nameAgg = new Map<string, { a: KnowledgeNode; b: KnowledgeNode; name: string }>()
  for (const [name, group] of byName) {
    if (group.length < 2 || group.length > 6) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].kind === group[j].kind || group[i].id === group[j].id) continue
        const k = pairKey(group[i].id, group[j].id)
        if (!nameAgg.has(k)) nameAgg.set(k, { a: group[i], b: group[j], name: spellingOf(group[i], name) })
      }
    }
  }
  for (const g of nameAgg.values()) {
    if (connected.has(pairKey(g.a.id, g.b.id))) continue
    const [x, y] = g.a.id <= g.b.id ? [g.a, g.b] : [g.b, g.a]
    out.push({
      id: knowledgeLinkId('same-name', x.id, y.id),
      from: x.id,
      to: y.id,
      basis: 'same-name',
      evidence: clip(`Both are called "${oneLine(g.name)}": a ${oneLine(x.kind)} and a ${oneLine(y.kind)}.`, EVIDENCE_MAX),
      strength: 0.6,
      count: 1
    })
  }

  const dismissed = opts.includeDismissed ? new Set<string>() : new Set(graph.dismissedLinks ?? [])
  return out.filter((l) => !dismissed.has(l.id)).sort(byStrength).slice(0, cap)
}

/**
 * Per node id: how often it shows up. relations = live edges touching it whose other end is live; mentions = the sum
 * of `count` over the 'mention' links in `links` that point at it; notes = its context note links; total = their sum.
 * No hub cutoff. Nothing is written; agent recalls are not part of it.
 */
export function knowledgeAppearances(graph: GraphLike, links: readonly KnowledgeInferredLink[]): Record<string, KnowledgeAppearance> {
  const out: Record<string, KnowledgeAppearance> = {}
  const live = new Set<string>()
  for (const n of graph.nodes) {
    out[n.id] = { relations: 0, mentions: 0, notes: n.noteIds?.length ?? 0, total: 0 }
    if (!n.retired) live.add(n.id)
  }
  for (const e of graph.edges) {
    if (e.retired || !out[e.from] || !out[e.to]) continue
    if (live.has(e.to)) out[e.from].relations++
    if (e.to !== e.from && live.has(e.from)) out[e.to].relations++
  }
  for (const l of links) if (l.basis === 'mention' && out[l.to]) out[l.to].mentions += l.count
  for (const a of Object.values(out)) a.total = a.relations + a.mentions + a.notes
  return out
}

interface ResultMemo {
  nodes: unknown
  edges: unknown
  dismissed: unknown
  nodeCount: number
  edgeCount: number
  updatedAt: number | undefined
  result: KnowledgeInferredResult
}
const resultMemo = new WeakMap<object, ResultMemo>()

/**
 * knowledge:inferredLinks for a graph: the inferred links and the appearance counts, computed once per graph object
 * (the memo checks the node, edge and dismissed array identities, their lengths and updatedAt; build a new graph
 * object after editing a node in place).
 */
export function knowledgeInferredResult(graph: GraphLike): KnowledgeInferredResult {
  const hit = resultMemo.get(graph)
  if (hit && hit.nodes === graph.nodes && hit.edges === graph.edges && hit.dismissed === graph.dismissedLinks && hit.nodeCount === graph.nodes.length && hit.edgeCount === graph.edges.length && hit.updatedAt === graph.updatedAt) {
    return hit.result
  }
  // One pass over the text feeds both: the links filter its aggregates, the appearances count them.
  const pass = mentionAggregates(graph)
  const result: KnowledgeInferredResult = {
    links: linksFrom(graph, pass.aggs),
    appearances: knowledgeAppearances(graph, mentionsFrom(graph, pass.aggs)),
    ...(pass.partial ? { partial: pass.partial } : {})
  }
  resultMemo.set(graph, { nodes: graph.nodes, edges: graph.edges, dismissed: graph.dismissedLinks, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, updatedAt: graph.updatedAt, result })
  return result
}

/** The only links knowledge_recall may show: mentions at or above KNOWLEDGE_STRONG_MENTION. */
export function strongMentionLinks(source: KnowledgeInferredResult | readonly KnowledgeInferredLink[]): KnowledgeInferredLink[] {
  const links = Array.isArray(source) ? (source as readonly KnowledgeInferredLink[]) : (source as KnowledgeInferredResult).links
  return links.filter((l) => l.basis === 'mention' && l.strength >= KNOWLEDGE_STRONG_MENTION)
}
