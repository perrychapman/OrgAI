import type { KnowledgeEdge, KnowledgeInferredLink, KnowledgeNode } from '@shared/types'
import { normalizeKnowledgeKey } from '@shared/knowledge'
import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'
import { keyWords } from './knowledge'

/** Possible connections in the detail panel (docs/design/knowledge-graph-2.md section 2.2). Pure; the view is KnowledgePossible.tsx. */

/** Rows shown before "Show N more". */
export const POSSIBLE_VISIBLE = 5
export const POSSIBLE_QUIET = 'OrgAI found these by matching names in the text. They may be wrong.'
export const POSSIBLE_BLANK_WORD = 'Add a word for how they relate, such as works at.'
export const POSSIBLE_BAD_WORD = 'Use letters, digits, spaces and hyphens, at most 40 characters.'
export const POSSIBLE_LOAD_FAILED = 'Could not check for possible connections.'

/** KnowledgeInferredResult.partial: the name matcher stopped at its budget. Optional until every build has the field. */
export interface PossiblePartial {
  scannedEntities: number
  totalEntities: number
}

/** The honest line when the matcher stopped early; null when it read everything or the counts are not usable. */
export function possiblePartialNote(partial: PossiblePartial | null | undefined): string | null {
  if (!partial) return null
  const { scannedEntities: s, totalEntities: t } = partial
  if (!Number.isFinite(s) || !Number.isFinite(t) || s < 0 || t <= 0) return null
  return `This list is partial: OrgAI checked ${Math.min(s, t).toLocaleString('en-GB')} of ${t.toLocaleString('en-GB')} items before stopping.`
}

/** The evidence line without its `Fact: "..."` / `Summary: "..."` label, as plain text. */
export function splitEvidence(evidence: string): { label: 'fact' | 'summary' | null; snippet: string } {
  const clean = evidence.replace(HIDDEN_OR_CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim()
  const m = /^(Fact|Summary):\s*"?(.*?)"?$/s.exec(clean)
  if (!m) return { label: null, snippet: clean }
  return { label: m[1] === 'Fact' ? 'fact' : 'summary', snippet: m[2]!.trim() }
}

export interface LinkWhy {
  /** The other end's node id. */
  otherId: string
  sameName: boolean
  /** True when this item is the one that names the other (`from`). */
  named: boolean
  /** "Named in a fact" / "Names this in its summary" ...; empty for a same-name link. */
  lead: string
  /** The evidence snippet; empty for a same-name link (evidence is not shown). */
  snippet: string
}

/** Why a link is offered, seen from `thisId`. This item is `from`: it names the other; `to`: the other names it. */
export function linkWhy(link: Pick<KnowledgeInferredLink, 'from' | 'to' | 'basis' | 'evidence' | 'evidenceFactId'>, thisId: string): LinkWhy {
  const named = link.from === thisId
  const otherId = named ? link.to : link.from
  if (link.basis === 'same-name') return { otherId, sameName: true, named, lead: '', snippet: '' }
  const { label, snippet } = splitEvidence(link.evidence)
  const inFact = label ? label === 'fact' : !!link.evidenceFactId
  const where = inFact ? 'a fact' : 'the summary'
  const lead = named ? `Named in ${where}` : `Names this in ${inFact ? 'a fact' : 'its summary'}`
  return { otherId, sameName: false, named, lead, snippet }
}

/** The why line as one string (screen readers, tests). */
export function whyText(why: LinkWhy, otherName: string): string {
  return why.sameName ? `Same name as ${otherName}: might be the same thing` : why.snippet ? `${why.lead}: ${why.snippet}` : why.lead
}

export interface PossibleRow {
  link: KnowledgeInferredLink
  other: KnowledgeNode
  from: KnowledgeNode
  to: KnowledgeNode
  why: LinkWhy
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/**
 * The rows for one item: links that touch it, whose other end is a known live node, minus pairs that already have an
 * edge in the graph the view holds (main skips them too; this hides a row the moment a confirm lands). Strongest first,
 * then by count, then the other item's name and the link id so the order is stable.
 */
export function possibleRows(links: readonly KnowledgeInferredLink[], thisId: string, nodes: readonly KnowledgeNode[], edges: readonly Pick<KnowledgeEdge, 'from' | 'to'>[]): PossibleRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const linked = new Set(edges.map((e) => pairKey(e.from, e.to)))
  const me = byId.get(thisId)
  if (!me || me.retired) return []
  const out: PossibleRow[] = []
  for (const link of links) {
    if (link.from !== thisId && link.to !== thisId) continue
    const from = byId.get(link.from)
    const to = byId.get(link.to)
    if (!from || !to || from.retired || to.retired || link.from === link.to) continue
    if (linked.has(pairKey(link.from, link.to))) continue
    const why = linkWhy(link, thisId)
    out.push({ link, other: link.from === thisId ? to : from, from, to, why })
  }
  return out.sort((a, b) => b.link.strength - a.link.strength || b.link.count - a.link.count || a.other.name.localeCompare(b.other.name) || a.link.id.localeCompare(b.link.id))
}

/** The word a row starts with: the suggestion as plain words, else blank. */
export const initialWord = (link: Pick<KnowledgeInferredLink, 'suggestedRelation'>): string => (link.suggestedRelation ? keyWords(link.suggestedRelation) : '')

/** The typed word as a relation key, or the message to show. */
export function confirmWord(word: string): { key: string } | { error: string } {
  if (!word.trim()) return { error: POSSIBLE_BLANK_WORD }
  const key = normalizeKnowledgeKey(word)
  return key ? { key } : { error: POSSIBLE_BAD_WORD }
}

export const linkedStatus = (from: string, word: string, to: string): string => `Linked ${from} ${word} ${to}.`
export const dismissLabel = (otherName: string): string => `Dismiss the possible connection with ${otherName}`
export const moreLabel = (n: number): string => `Show ${n} more`

/** The row to focus after `id` left the list: the next one that is still there, else null (the caller falls back to "Add a relation"). */
export function rowAfterRemoval(before: readonly string[], now: readonly string[], id: string): string | null {
  const i = before.indexOf(id)
  const present = new Set(now)
  if (i >= 0) for (let j = i + 1; j < before.length; j++) if (present.has(before[j]!)) return before[j]!
  return null
}

/** How many inferred links connect two nodes among `ids` (the "Showing N inferred links." status). */
export function visibleLinkCount(links: readonly Pick<KnowledgeInferredLink, 'from' | 'to'>[], ids: ReadonlySet<string>): number {
  return links.filter((l) => ids.has(l.from) && ids.has(l.to)).length
}

export const inferredStatus = (n: number): string => `Showing ${n} inferred ${n === 1 ? 'link' : 'links'}.`
