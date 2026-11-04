import { describe, expect, it } from 'vitest'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSource } from './types'
import { KNOWLEDGE_SEARCH_LIMIT } from './types'
import {
  emptyKnowledgeGraph,
  knowledgeEdgesOf,
  knowledgeNameKey,
  knowledgeNodeNamed,
  knowledgeSearchLimit,
  knowledgeVocabulary,
  matchKnowledgeNodes,
  normalizeKnowledgeKey,
  resolveKnowledgeNode,
  searchKnowledge
} from './knowledge'

const src: KnowledgeSource = { by: 'user', at: 1 }

function node(over: Partial<KnowledgeNode> & { id: string; name: string }): KnowledgeNode {
  return { kind: 'person', facts: [], source: src, createdAt: 1, updatedAt: 1, ...over }
}

function edge(over: Partial<KnowledgeEdge> & { id: string; from: string; to: string }): KnowledgeEdge {
  return { relation: 'works-at', source: src, createdAt: 1, ...over }
}

function graph(nodes: KnowledgeNode[], edges: KnowledgeEdge[] = []): KnowledgeGraph {
  return { version: 1, nodes, edges }
}

describe('normalizeKnowledgeKey', () => {
  it('trims, lower-cases and turns whitespace and underscores into one dash', () => {
    expect(normalizeKnowledgeKey('  Open  Question ')).toBe('open-question')
    expect(normalizeKnowledgeKey('works_at')).toBe('works-at')
    expect(normalizeKnowledgeKey('Depends -- On')).toBe('depends-on')
    expect(normalizeKnowledgeKey('Person')).toBe('person')
  })

  it('refuses empty, long and non-key strings', () => {
    expect(normalizeKnowledgeKey('')).toBeNull()
    expect(normalizeKnowledgeKey('   ')).toBeNull()
    expect(normalizeKnowledgeKey('-leading')).toBeNull()
    expect(normalizeKnowledgeKey('a'.repeat(41))).toBeNull()
    expect(normalizeKnowledgeKey('a'.repeat(40))).toBe('a'.repeat(40))
    expect(normalizeKnowledgeKey('näme')).toBeNull()
    expect(normalizeKnowledgeKey('a/b')).toBeNull()
    expect(normalizeKnowledgeKey(42)).toBeNull()
    expect(normalizeKnowledgeKey(null)).toBeNull()
  })
})

describe('identity matching', () => {
  const jane = node({ id: 'kn_1', name: 'Jane Doe', aliases: ['JD', 'J. Doe'] })
  const acme = node({ id: 'kn_2', kind: 'organisation', name: 'Acme Corp' })
  const janeOrg = node({ id: 'kn_3', kind: 'organisation', name: 'jane doe', retired: true })
  const g = graph([jane, acme, janeOrg])

  it('folds case and inner whitespace in names and aliases', () => {
    expect(knowledgeNameKey('  Jane   DOE ')).toBe('jane doe')
    expect(knowledgeNodeNamed(jane, 'jane doe')).toBe(true)
    expect(knowledgeNodeNamed(jane, 'jd')).toBe(true)
    expect(knowledgeNodeNamed(jane, 'j.  doe')).toBe(true)
    expect(knowledgeNodeNamed(jane, 'Jane')).toBe(false)
    expect(knowledgeNodeNamed(jane, '')).toBe(false)
  })

  it('matches within a kind and across kinds, retired nodes included', () => {
    expect(matchKnowledgeNodes(g, 'Jane Doe', 'person').map((n) => n.id)).toEqual(['kn_1'])
    expect(matchKnowledgeNodes(g, 'Jane Doe').map((n) => n.id)).toEqual(['kn_1', 'kn_3'])
    expect(matchKnowledgeNodes(g, 'Nobody')).toEqual([])
  })

  it('resolves by id, by a unique name, reports ambiguity, else null', () => {
    expect(resolveKnowledgeNode(g, 'kn_2')).toEqual({ node: acme })
    expect(resolveKnowledgeNode(g, 'acme corp')).toEqual({ node: acme })
    expect(resolveKnowledgeNode(g, 'JD')).toEqual({ node: jane })
    const amb = resolveKnowledgeNode(g, 'Jane Doe')
    expect(amb && 'candidates' in amb ? amb.candidates.map((n) => n.id) : null).toEqual(['kn_1', 'kn_3'])
    expect(resolveKnowledgeNode(g, 'kn_9')).toBeNull()
    expect(resolveKnowledgeNode(g, '   ')).toBeNull()
  })
})

describe('knowledgeVocabulary', () => {
  it('counts live kinds and relations, most used first then alphabetical', () => {
    const g = graph(
      [
        node({ id: 'a', name: 'A' }),
        node({ id: 'b', name: 'B' }),
        node({ id: 'c', name: 'C', kind: 'organisation' }),
        node({ id: 'd', name: 'D', kind: 'decision', retired: true }),
        node({ id: 'e', name: 'E', kind: 'alpha' })
      ],
      [
        edge({ id: 'e1', from: 'a', to: 'c' }),
        edge({ id: 'e2', from: 'b', to: 'c' }),
        edge({ id: 'e3', from: 'a', to: 'b', relation: 'knows' }),
        edge({ id: 'e4', from: 'a', to: 'b', relation: 'zz', retired: true }),
        edge({ id: 'e5', from: 'a', to: 'd', relation: 'decided' })
      ]
    )
    expect(knowledgeVocabulary(g)).toEqual({
      kinds: [
        { kind: 'person', count: 2 },
        { kind: 'alpha', count: 1 },
        { kind: 'organisation', count: 1 }
      ],
      relations: [
        { relation: 'works-at', count: 2 },
        { relation: 'knows', count: 1 }
      ]
    })
    expect(knowledgeVocabulary(emptyKnowledgeGraph())).toEqual({ kinds: [], relations: [] })
  })
})

describe('searchKnowledge', () => {
  const g = graph(
    [
      node({ id: 'kn_1', name: 'Jane Doe', aliases: ['JD'], updatedAt: 10, summary: 'Sponsor of the rollout' }),
      node({ id: 'kn_2', kind: 'organisation', name: 'Acme Corp', updatedAt: 30, facts: [{ id: 'kf_1', text: 'Jane is their CFO', source: src }] }),
      node({ id: 'kn_3', kind: 'system', name: 'Billing', updatedAt: 20, facts: [{ id: 'kf_2', text: 'mentions jane', source: src, retired: true }] }),
      node({ id: 'kn_4', kind: 'person', name: 'Old Timer', updatedAt: 40, retired: true }),
      node({ id: 'kn_5', kind: 'decision', name: 'Go live in May', updatedAt: 25, summary: 'Agreed with the sponsor' })
    ],
    [edge({ id: 'e1', from: 'kn_1', to: 'kn_2' }), edge({ id: 'e2', from: 'kn_1', to: 'kn_3', relation: 'uses', retired: true })]
  )

  it('puts name and alias hits first, then summary and live fact hits by recency', () => {
    const hits = searchKnowledge(g, { query: 'jane' })
    expect(hits.map((h) => [h.node.id, h.nameHit])).toEqual([
      ['kn_1', true],
      ['kn_2', false]
    ])
    expect(hits[0].edgeCount).toBe(1)
    expect(searchKnowledge(g, { query: 'jd' }).map((h) => h.node.id)).toEqual(['kn_1'])
    expect(searchKnowledge(g, { query: 'SPONSOR' }).map((h) => h.node.id)).toEqual(['kn_5', 'kn_1'])
  })

  it('filters by kind and lists the most recently updated without a query', () => {
    expect(searchKnowledge(g).map((h) => h.node.id)).toEqual(['kn_2', 'kn_5', 'kn_3', 'kn_1'])
    expect(searchKnowledge(g, { kind: 'person' }).map((h) => h.node.id)).toEqual(['kn_1'])
    expect(searchKnowledge(g, { kind: 'person', includeRetired: true }).map((h) => h.node.id)).toEqual(['kn_4', 'kn_1'])
    expect(searchKnowledge(g, { query: 'jane', kind: 'organisation' }).map((h) => h.node.id)).toEqual(['kn_2'])
  })

  it('leaves retired nodes out unless asked and never matches a retired fact', () => {
    expect(searchKnowledge(g, { query: 'old timer' })).toEqual([])
    expect(searchKnowledge(g, { query: 'old timer', includeRetired: true }).map((h) => h.node.id)).toEqual(['kn_4'])
    expect(searchKnowledge(g, { query: 'mentions' })).toEqual([])
  })

  it('caps the limit at KNOWLEDGE_SEARCH_LIMIT and floors it at 1', () => {
    expect(knowledgeSearchLimit(undefined)).toBe(KNOWLEDGE_SEARCH_LIMIT)
    expect(knowledgeSearchLimit(0)).toBe(1)
    expect(knowledgeSearchLimit(2.7)).toBe(2)
    expect(knowledgeSearchLimit(10_000)).toBe(KNOWLEDGE_SEARCH_LIMIT)
    expect(knowledgeSearchLimit(Number.NaN)).toBe(KNOWLEDGE_SEARCH_LIMIT)
    expect(searchKnowledge(g, { limit: 1 }).map((h) => h.node.id)).toEqual(['kn_2'])
    const many = graph(Array.from({ length: KNOWLEDGE_SEARCH_LIMIT + 5 }, (_, i) => node({ id: `kn_${i}`, name: `N${i}`, updatedAt: i })))
    expect(searchKnowledge(many)).toHaveLength(KNOWLEDGE_SEARCH_LIMIT)
  })

  it('counts edges only for the hits it returns, both directions, retired edges left out', () => {
    const g2 = graph(
      [node({ id: 'kn_1', name: 'A', updatedAt: 3 }), node({ id: 'kn_2', name: 'B', updatedAt: 2 }), node({ id: 'kn_3', name: 'C', updatedAt: 1 })],
      [
        edge({ id: 'e1', from: 'kn_1', to: 'kn_2' }),
        edge({ id: 'e2', from: 'kn_3', to: 'kn_1', relation: 'knows' }),
        edge({ id: 'e3', from: 'kn_2', to: 'kn_3', relation: 'knows' }),
        edge({ id: 'e4', from: 'kn_1', to: 'kn_3', relation: 'zz', retired: true })
      ]
    )
    expect(searchKnowledge(g2, { limit: 1 }).map((h) => [h.node.id, h.edgeCount])).toEqual([['kn_1', 2]])
    expect(searchKnowledge(g2).map((h) => [h.node.id, h.edgeCount])).toEqual([
      ['kn_1', 2],
      ['kn_2', 2],
      ['kn_3', 2]
    ])
  })

  it('knowledgeEdgesOf lists both directions and can drop retired edges', () => {
    expect(knowledgeEdgesOf(g, 'kn_1').map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(knowledgeEdgesOf(g, 'kn_1', true).map((e) => e.id)).toEqual(['e1'])
    expect(knowledgeEdgesOf(g, 'kn_2').map((e) => e.id)).toEqual(['e1'])
  })
})
