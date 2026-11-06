import { describe, expect, it } from 'vitest'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSource } from './types'
import { KNOWLEDGE_SEARCH_LIMIT } from './types'
import {
  knowledgeAutoContextOn,
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

  describe('ranked search', () => {
    const t = (id: string, name: string, over: Partial<KnowledgeNode> = {}): KnowledgeNode => node({ id, name, ...over })
    const rg = graph([
      t('a', 'Billing Migration', { kind: 'decision', updatedAt: 5, summary: 'Move billing for Acme' }),
      t('b', 'Acme Corp', { kind: 'organisation', updatedAt: 4 }),
      t('c', 'Migration Tooling', { kind: 'system', updatedAt: 9 }),
      t('d', 'Retired Billing', { kind: 'system', updatedAt: 99, retired: true })
    ])

    it('finds an entity per word, not only the whole query as a substring', () => {
      expect(searchKnowledge(rg, { query: 'Acme billing migration' }).map((h) => h.node.id)).toEqual(['a', 'c', 'b'])
    })

    it('matches 3+ character words by prefix and shorter words exactly', () => {
      expect(searchKnowledge(rg, { query: 'migr' }).map((h) => h.node.id)).toEqual(['c', 'a'])
      // "mi" is too short for a prefix hit, so the ranked step is empty and the substring fallback answers (name hits, newest first)
      expect(searchKnowledge(rg, { query: 'mi' }).map((h) => [h.node.id, h.nameHit])).toEqual([
        ['c', true],
        ['a', true]
      ])
    })

    it('puts name hits before summary hits and excludes retired nodes unless asked', () => {
      expect(searchKnowledge(rg, { query: 'billing' }).map((h) => [h.node.id, h.nameHit])).toEqual([['a', true]])
      expect(searchKnowledge(rg, { query: 'billing', includeRetired: true }).map((h) => h.node.id)).toEqual(['d', 'a'])
      expect(searchKnowledge(rg, { query: 'acme' }).map((h) => [h.node.id, h.nameHit])).toEqual([
        ['b', true],
        ['a', false]
      ])
    })

    it('falls back to the whole-query substring match only when the words find nothing', () => {
      const fg = graph([t('x', '請求書の移行'), t('y', 'Plain', { summary: 'xyzzy-12345 marker' })])
      expect(searchKnowledge(fg, { query: '請求書' }).map((h) => h.node.id)).toEqual(['x'])
      // a mid-word fragment has no word prefix to hit, so the substring fallback finds it
      expect(searchKnowledge(fg, { query: 'zzy-123' }).map((h) => h.node.id)).toEqual(['y'])
      // a ranked hit wins: the fallback does not add substring-only nodes beside it
      expect(searchKnowledge(rg, { query: 'tool' }).map((h) => h.node.id)).toEqual(['c'])
    })

    it('keeps the kind filter and the limit', () => {
      expect(searchKnowledge(rg, { query: 'migration', kind: 'system' }).map((h) => h.node.id)).toEqual(['c'])
      expect(searchKnowledge(rg, { query: 'acme billing migration', limit: 1 }).map((h) => h.node.id)).toEqual(['a'])
    })
  })

  it('knowledgeAutoContextOn is off only for an explicit false', () => {
    expect(knowledgeAutoContextOn(undefined)).toBe(true)
    expect(knowledgeAutoContextOn(null)).toBe(true)
    expect(knowledgeAutoContextOn({})).toBe(true)
    expect(knowledgeAutoContextOn({ knowledgeAutoContext: true })).toBe(true)
    expect(knowledgeAutoContextOn({ knowledgeAutoContext: false })).toBe(false)
  })

  it('knowledgeEdgesOf lists both directions and can drop retired edges', () => {
    expect(knowledgeEdgesOf(g, 'kn_1').map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(knowledgeEdgesOf(g, 'kn_1', true).map((e) => e.id)).toEqual(['e1'])
    expect(knowledgeEdgesOf(g, 'kn_2').map((e) => e.id)).toEqual(['e1'])
  })
})
