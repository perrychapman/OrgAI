import { describe, expect, it } from 'vitest'
import type { KnowledgeGraph, KnowledgeNode } from './types'
import { KNOWLEDGE_MATCH_BUDGET, KNOWLEDGE_NAME_GAP_MAX, KNOWLEDGE_NAME_TOKENS_MAX, KNOWLEDGE_SAME_NAME_MAX } from './types'
import { knowledgeContextBlock, knowledgeNameMatcher, type KnowledgeMatchBudget } from './knowledgeIndex'
import { knowledgeInferredResult } from './knowledgeLinks'

/**
 * The attack the review found on the first matcher (a map first token -> candidates): within one run's 500 writes an
 * agent records entities whose name and 10 aliases all start "a a a ..." and end in a different last word, each with 50
 * facts that are nothing but "a a a ...". Every candidate then walks nearly its whole length at every position of every
 * fact. Nothing ever matches, it runs on the main thread, and the file keeps it across restarts.
 *
 * Run against the old matcher (2026-11-05): one fact took 2,672 ms, and the whole-pass test below was still running when
 * `timeout 120` killed it (exit 124); by arithmetic 25,000 facts x 2.7 s x 2 passes is about 37 hours. Now both are below.
 */

const NAME_MAX = 120

/** A name of `words` "a" tokens and a last word that differs per name. */
function attackName(tag: string, words: number): string {
  return `${Array.from({ length: words }, () => 'a').join(' ')} ${tag}`
}

const FACT = 'a '.repeat(500).trim()

function attackGraph(nodes: number, facts: number, nameWords: (tag: string) => string): KnowledgeGraph {
  const list: KnowledgeNode[] = []
  for (let i = 0; i < nodes; i++) {
    const id = i.toString(16).padStart(8, '0')
    list.push({
      id: `kn_${id}`,
      kind: 'system',
      name: nameWords(`z${i}`),
      aliases: Array.from({ length: 10 }, (_, j) => nameWords(`y${i}x${j}`)),
      facts: Array.from({ length: facts }, (_, j) => ({ id: `kf_${id}${j}`, text: FACT, source: { by: 'agent' as const, at: 1 } })),
      source: { by: 'agent', at: 1 },
      createdAt: 1,
      updatedAt: 1
    })
  }
  return { version: 1, nodes: list, edges: [], updatedAt: 1 }
}

/** As long as a stored name may be: the names of the original attack. */
const longest = (tag: string): string => attackName(tag, Math.floor((NAME_MAX - tag.length - 1) / 2))
/** Exactly at the token cap, so they stay in the trie and every position walks its full depth. */
const atCap = (tag: string): string => attackName(tag, KNOWLEDGE_NAME_TOKENS_MAX - 1)

describe('the name matcher under the 500-write attack', () => {
  it('one fact is matched in well under a second', () => {
    const graph = attackGraph(500, 1, longest)
    const matcher = knowledgeNameMatcher(graph.nodes)
    const t = performance.now()
    const found = matcher.find(FACT)
    const ms = performance.now() - t
    console.log(`\nadversarial: one 1,000-character fact against ${graph.nodes.length * 11} attack names: ${ms.toFixed(1)} ms, ${found.length} matches\n`)
    expect(found).toEqual([])
    expect(ms).toBeLessThan(1000)
  })

  it('a whole inference pass over the full attack graph finishes inside a generous limit', () => {
    const graph = attackGraph(500, 50, longest)
    const t = performance.now()
    const result = knowledgeInferredResult(graph)
    const ms = performance.now() - t
    console.log(`\nadversarial: inference over ${graph.nodes.length} nodes x 50 facts: ${ms.toFixed(0)} ms, ${result.links.length} links, partial ${JSON.stringify(result.partial ?? null)}\n`)
    expect(ms).toBeLessThan(15_000)
  })

  it('names exactly at the token cap walk the full depth everywhere: the budget stops the pass and says so', () => {
    const graph = attackGraph(2000, 50, atCap)
    const t = performance.now()
    const result = knowledgeInferredResult(graph)
    const ms = performance.now() - t
    console.log(`\nadversarial: inference with names at the token cap, ${graph.nodes.length} nodes x 50 facts: ${ms.toFixed(0)} ms, partial ${JSON.stringify(result.partial ?? null)}\n`)
    expect(result.partial).toBeDefined()
    expect(result.partial!.totalEntities).toBe(2000)
    expect(result.partial!.scannedEntities).toBeLessThan(2000)
    expect(ms).toBeLessThan(15_000)
  })

  it('the automatic context block over the same names stays fast, and agent-created names are not even in its matcher', () => {
    const graph = attackGraph(500, 1, atCap)
    const t = performance.now()
    expect(knowledgeContextBlock(graph, 'a '.repeat(30_000))).toBeNull()
    expect(performance.now() - t).toBeLessThan(5_000)
    // The same names written by the user (the worst case the block can still be asked to match) stay bounded too.
    const mine: KnowledgeGraph = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, aliases: [], source: { by: 'user' as const, at: 1 } })) }
    const t2 = performance.now()
    expect(knowledgeContextBlock(mine, 'a '.repeat(30_000))).toBeNull()
    expect(performance.now() - t2).toBeLessThan(5_000)
  })

  it('agent-written text cannot use up the pass: the user\'s entities are scanned first and no entity takes more than its share', () => {
    const user = { by: 'user' as const, at: 1 }
    const small = (id: string, name: string, summary: string | undefined, source: KnowledgeNode['source']): KnowledgeNode => ({
      id,
      kind: 'person',
      name,
      ...(summary ? { summary } : {}),
      facts: [],
      source,
      createdAt: 1,
      updatedAt: 1
    })
    // 1) 400 agent entities whose facts would each cost about 800,000 units (the pass is 4,000,000): even capped at the
    //    20,000 floor they exhaust it, so the agent tail goes unscanned and the pass says so. The user's pair sits LAST in
    //    graph order and is still found because user entities are scanned first.
    const big = attackGraph(400, 50, atCap)
    const pair = [small('kn_u1', 'Quill Rowe', undefined, user), small('kn_u2', 'Ines Duarte', 'Engagement lead at Quill Rowe.', user)]
    const withUser = knowledgeInferredResult({ ...big, nodes: [...big.nodes, ...pair] })
    expect(withUser.partial).toBeDefined()
    expect(withUser.links.some((l) => l.basis === 'mention' && l.from === 'kn_u2' && l.to === 'kn_u1')).toBe(true)
    // 2) Ten big agent entities then an agent pair, last: each big entity is capped at its even share (4,000,000 / 12), so
    //    ten of them leave room and the pass reaches the pair as well (uncapped, ten would cost 8,000,000).
    const ten = attackGraph(10, 50, atCap)
    const agentPair = [small('kn_a1', 'Zed Corp', undefined, { by: 'agent', at: 1 }), small('kn_a2', 'Ola Hart', 'Works with Zed Corp.', { by: 'agent', at: 1 })]
    const withAgent = knowledgeInferredResult({ ...ten, nodes: [...ten.nodes, ...agentPair] })
    expect(withAgent.partial).toBeUndefined()
    expect(withAgent.links.some((l) => l.basis === 'mention' && l.from === 'kn_a2' && l.to === 'kn_a1')).toBe(true)
  })

  it('a pile of equal names is capped per span and bounded by the budget', () => {
    const nodes: KnowledgeNode[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `kn_${i.toString(16).padStart(8, '0')}`,
      kind: `k${i}`,
      name: 'Foo',
      facts: [],
      source: { by: 'agent', at: 1 },
      createdAt: 1,
      updatedAt: 1
    }))
    const matcher = knowledgeNameMatcher(nodes)
    expect(matcher.find('Foo')).toHaveLength(KNOWLEDGE_SAME_NAME_MAX)
    const budget: KnowledgeMatchBudget = { left: 100 }
    const found = matcher.find('Foo '.repeat(1000), budget)
    expect(budget.exhausted).toBe(true)
    expect(found.length).toBeLessThan(200)
  })
})

describe('matcher limits', () => {
  const node = (id: string, name: string): KnowledgeNode => ({ id, kind: 'system', name, facts: [], source: { by: 'agent', at: 1 }, createdAt: 1, updatedAt: 1 })

  it('does not match a name of more than KNOWLEDGE_NAME_TOKENS_MAX tokens', () => {
    const words = Array.from({ length: KNOWLEDGE_NAME_TOKENS_MAX }, (_, i) => `word${i}`)
    const atLimit = words.join(' ')
    const over = `${atLimit} extra`
    const m = knowledgeNameMatcher([node('kn_a', atLimit), node('kn_b', over)])
    expect(m.size).toBe(1)
    expect(m.find(`see ${over} here`).map((x) => x.id)).toEqual(['kn_a'])
  })

  it('breaks a name at a gap wider than KNOWLEDGE_NAME_GAP_MAX', () => {
    const m = knowledgeNameMatcher([node('kn_a', 'Billing Core')])
    expect(m.find(`Billing${' '.repeat(KNOWLEDGE_NAME_GAP_MAX)}Core`)).toHaveLength(1)
    expect(m.find(`Billing${' '.repeat(KNOWLEDGE_NAME_GAP_MAX + 1)}Core`)).toHaveLength(0)
  })

  it('still prefers the longest name, falls back to a shorter one and consumes its words', () => {
    const m = knowledgeNameMatcher([node('kn_c', 'Core'), node('kn_bc', 'Billing Core'), node('kn_bcx', 'Billing Core Extended Unit'), node('kn_b', 'Billing')])
    expect(m.find('the Billing Core Extended thing').map((x) => x.id)).toEqual(['kn_bc'])
    expect(m.find('the Billing Core Extended Unit').map((x) => x.id)).toEqual(['kn_bcx'])
    expect(m.find('the Billing system').map((x) => x.id)).toEqual(['kn_b'])
  })

  it('a budget stops find, keeps what it found and marks itself', () => {
    const m = knowledgeNameMatcher([node('kn_a', 'Stripe')])
    // 9 tokens scanned leave 3 units: one match costs a step and a match, the next token the last unit.
    const budget: KnowledgeMatchBudget = { left: 12 }
    const text = 'Stripe x y z Stripe x y z Stripe'
    const found = m.find(text, budget)
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThan(3)
    expect(budget.exhausted).toBe(true)
    expect(m.find('Stripe', budget)).toEqual([])
  })

  it('an ordinary graph is scanned whole: no partial marker', () => {
    const graph: KnowledgeGraph = { version: 1, nodes: [node('kn_a', 'Stripe'), { ...node('kn_b', 'Other'), summary: 'Uses Stripe.' }], edges: [] }
    const r = knowledgeInferredResult(graph)
    expect(r.partial).toBeUndefined()
    expect(r.links).toHaveLength(1)
    expect(KNOWLEDGE_MATCH_BUDGET).toBeGreaterThan(1_000_000)
  })
})
