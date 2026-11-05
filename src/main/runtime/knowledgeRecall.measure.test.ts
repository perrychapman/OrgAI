import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { KNOWLEDGE_FILE_MAX_BYTES, KNOWLEDGE_MATCH_BUDGET, KNOWLEDGE_RECALL_TOOL, KNOWLEDGE_TOOL } from '@shared/types'
import { KNOWLEDGE_FIXTURE_QUESTIONS, KNOWLEDGE_FIXTURE_TRUTH, knowledgeFixture } from '@shared/knowledge.fixture'
import { buildKnowledgeIndex, rankKnowledge, rankKnowledgeOrSubstring, recallKnowledge } from '@shared/knowledgeIndex'
import { knowledgeInferredResult, strongMentionLinks } from '@shared/knowledgeLinks'
import { harnessToolsFor, type HarnessTool } from './harnessTools'
import { readKnowledge, resetKnowledgeCache, upsertNode } from '../store/knowledge'
import { fakeCtx, project, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

/**
 * Measurement, not a behaviour spec of the UI: knowledge_recall against today's flow (engagement_knowledge vocabulary +
 * search + one get per entity), on the shared fixture, through the real tool handlers. No network, no model. The
 * "tokens" column is chars / 4, an ESTIMATE (no tokenizer ran). Timings are logged, never asserted.
 */

const ctxFor = (graph: KnowledgeGraph): { ctx: RuntimeContext; tools: Map<string, HarnessTool> } => {
  // A recall fake with the same "already shown" rule RunManager applies: named agents only, complete entities only.
  const shownByAgent = new Map<string, Map<string, string>>()
  const ctx = fakeCtx({
    project: project({ kind: 'engagement' }),
    run: runSummary({ kind: 'work' }),
    knowledge: { graph: () => graph, upsertNode: () => { throw new Error('read-only measurement') }, link: () => { throw new Error('read-only measurement') }, retire: () => { throw new Error('read-only measurement') } },
    knowledgeRecall: (input, caller) => {
      const shown = caller.agentId ? (shownByAgent.get(caller.agentId) ?? new Map<string, string>()) : undefined
      if (caller.agentId && shown) shownByAgent.set(caller.agentId, shown)
      const r = recallKnowledge(graph, input.query, { budget: input.budget, fresh: input.fresh, ...(shown ? { shown } : {}), inferred: strongMentionLinks(knowledgeInferredResult(graph)) })
      if (shown) for (const s of r.served) if (s.complete) shown.set(s.id, s.signature)
      return r.text || `Nothing in the knowledge graph matches "${input.query}".`
    }
  })
  const tools = new Map(harnessToolsFor(ctx, {}, { nativeSkills: true }).map((t) => [t.name, t]))
  return { ctx, tools }
}

const idOf = (name: string): string | undefined => KNOWLEDGE_FIXTURE_TRUTH.ids[name]

describe('knowledge_recall vs the search + get flow (fixture)', () => {
  const graph = knowledgeFixture()
  const rows: { question: string; today: number; recall: number; tokensToday: number; tokensRecall: number; callsToday: number; callsRecall: number; found: string }[] = []

  afterAll(() => {
    const line = (r: (typeof rows)[number]): string =>
      // Sizes quoted in docs/design/knowledge-connections.md section 6; pinned by the test below.
      `${r.question.slice(0, 44).padEnd(44)} | ${String(r.today).padStart(6)} | ${String(r.recall).padStart(6)} | ~${String(r.tokensToday).padStart(5)} -> ~${String(r.tokensRecall).padStart(5)} | ${String(r.callsToday).padStart(2)} -> ${r.callsRecall} | ${r.found}`
    const header = `${'question'.padEnd(44)} | ${'today'.padStart(6)} | ${'recall'.padStart(6)} | est. tokens (chars/4, ESTIMATE) | calls | names found`
    console.log(`\nknowledge_recall vs vocabulary + search + get (chars of tool output)\n${header}\n${rows.map(line).join('\n')}\n`)
  })

  for (const q of KNOWLEDGE_FIXTURE_QUESTIONS) {
    it(`"${q.question}": smaller than today's flow and every expected name is in the answer`, async () => {
      const { tools } = ctxFor(graph)
      const kg = tools.get(KNOWLEDGE_TOOL)!
      const recall = tools.get(KNOWLEDGE_RECALL_TOOL)!
      // Today, best case: an agent that already knows which entities it needs.
      const outputs = [await kg.call({ action: 'vocabulary' }), await kg.call({ action: 'search', query: q.keyword })]
      for (const name of q.expectedNames) {
        const id = idOf(name)
        outputs.push(await kg.call(id ? { action: 'get', nodeId: id } : { action: 'get', name }))
      }
      const today = outputs.reduce((n, o) => n + o.length, 0)
      const answer = await recall.call({ query: q.question })
      const missing = q.expectedNames.filter((n) => !answer.includes(n))
      rows.push({
        question: q.question,
        today,
        recall: answer.length,
        tokensToday: Math.round(today / 4),
        tokensRecall: Math.round(answer.length / 4),
        callsToday: outputs.length,
        callsRecall: 1,
        found: `${q.expectedNames.length - missing.length}/${q.expectedNames.length}${missing.length ? ` MISSING: ${missing.join('; ')}` : ''}`
      })
      expect(missing).toEqual([])
      expect(answer.length).toBeLessThan(today)
    })
  }

  it('pins the sizes the evaluation doc quotes (section 6)', () => {
    expect(rows.map((r) => r.today)).toEqual([5400, 3391, 4824, 4656, 3625])
    expect(rows.map((r) => r.recall)).toEqual([1483, 1046, 1225, 1486, 1174])
    expect(rows.map((r) => r.callsToday)).toEqual([5, 5, 5, 6, 5])
    expect(rows.every((r) => r.callsRecall === 1 && !r.found.includes('MISSING'))).toBe(true)
  })

  it('the same agent asking again gets "already shown" lines and, once every match fits, a much smaller answer; fresh brings the detail back', async () => {
    const { tools } = ctxFor(graph)
    const recall = tools.get(KNOWLEDGE_RECALL_TOOL)!
    const atDefault: string[] = []
    const atMax: string[] = []
    for (const q of KNOWLEDGE_FIXTURE_QUESTIONS) {
      // Default budget (1500): the budget may cut strong matches, so a repeat can still bring the next strong ones.
      const first = await recall.call({ query: q.question }, { agentId: 'd' })
      const again = await recall.call({ query: q.question }, { agentId: 'd' })
      expect(again).toContain('already shown')
      expect(await recall.call({ query: q.question, fresh: true }, { agentId: 'd' })).not.toContain('already shown')
      atDefault.push(`${first.length} -> ${again.length}`)
      // Budget 6000: every strong match fits the first time, so the repeat is one short line per entity plus the same
      // "N more:" line. Weak matches never refill the budget (KNOWLEDGE_RECALL_RELEVANCE_FLOOR).
      const big = await recall.call({ query: q.question, budget: 6000 }, { agentId: 'm' })
      const bigAgain = await recall.call({ query: q.question, budget: 6000 }, { agentId: 'm' })
      atMax.push(`${big.length} -> ${bigAgain.length}`)
      expect(bigAgain.length).toBeLessThan(big.length * 0.75)
    }
    console.log(`\ndedupe, first -> repeat chars. default budget 1500: ${atDefault.join(', ')}. budget 6000: ${atMax.join(', ')}\n`)
    expect(atDefault).toEqual(['1483 -> 930', '1046 -> 470', '1225 -> 529', '1486 -> 812', '979 -> 562'])
  })
})

// ---------- a synthetic full graph ----------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const SYL = ['ar', 'ben', 'cor', 'del', 'fen', 'gal', 'hol', 'ist', 'jor', 'kel', 'lum', 'mar', 'nor', 'ost', 'pra', 'qui', 'rav', 'sel', 'tor', 'ul', 'vex', 'wen', 'xan', 'yor', 'zel']
const KINDS = ['person', 'organisation', 'system', 'document', 'decision', 'risk', 'requirement', 'open-question']
const RELS = ['works-at', 'owns', 'depends-on', 'decided-by', 'affects', 'raised-by', 'evidence-for', 'mitigates']
const WORDS = ['invoice', 'billing', 'export', 'approval', 'cut-over', 'tax', 'credit', 'ledger', 'vendor', 'migration', 'schema', 'review', 'quarter', 'budget', 'freight', 'contract']

function syntheticGraph(nodeCount: number, edgeCount: number): KnowledgeGraph {
  const rand = rng(42)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const word = (): string => `${pick(SYL)}${pick(SYL)}${pick(SYL)}`
  const sentence = (n: number): string => Array.from({ length: n }, () => (rand() < 0.35 ? pick(WORDS) : word())).join(' ')
  const nodes: KnowledgeNode[] = []
  const hex = (i: number): string => i.toString(16).padStart(10, '0')
  for (let i = 0; i < nodeCount; i++) {
    const facts = Array.from({ length: Math.floor(rand() * 5) }, (_, j) => ({ id: `kf_${hex(i)}${j}`, text: `${sentence(14)}.`, source: { by: 'agent' as const, at: 1_700_000_000_000 + i * 1000 + j } }))
    nodes.push({
      id: `kn_${hex(i)}`,
      kind: pick(KINDS),
      name: `${word()} ${word()} ${i}`,
      ...(rand() < 0.3 ? { aliases: [word()] } : {}),
      ...(rand() < 0.7 ? { summary: `${sentence(28)}.` } : {}),
      facts,
      source: { by: i % 3 === 0 ? ('user' as const) : ('agent' as const), at: 1_700_000_000_000 + i * 1000 },
      createdAt: 1_700_000_000_000 + i * 1000,
      updatedAt: 1_700_000_000_000 + i * 1000
    })
  }
  const edges: KnowledgeGraph['edges'] = []
  const seen = new Set<string>()
  while (edges.length < edgeCount) {
    const a = Math.floor(rand() * nodeCount)
    const b = Math.floor(rand() * nodeCount)
    const relation = pick(RELS)
    const key = `${a}>${b}>${relation}`
    if (a === b || seen.has(key)) continue
    seen.add(key)
    edges.push({ id: `ke_${hex(edges.length)}`, from: nodes[a].id, to: nodes[b].id, relation, source: { by: 'agent', at: 1_700_000_000_000 + edges.length }, createdAt: 1_700_000_000_000 + edges.length })
  }
  return { version: 1, nodes, edges, updatedAt: 1_700_000_000_000 }
}

describe('a full graph (2,000 entities, 5,000 relations): timings are logged, not asserted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-knowledge-measure-'))
  afterAll(() => {
    resetKnowledgeCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('index, rank, recall and inferred links; cold store read vs cached read', () => {
    const graph = syntheticGraph(2000, 5000)
    const ms = <T,>(f: () => T): { out: T; ms: number } => {
      const t = performance.now()
      const out = f()
      return { out, ms: Math.round((performance.now() - t) * 10) / 10 }
    }
    const index = ms(() => buildKnowledgeIndex(graph))
    const rank = ms(() => rankKnowledge(graph, 'invoice approval cut-over'))
    const recall = ms(() => recallKnowledge(graph, 'invoice approval cut-over'))
    const inferred = ms(() => knowledgeInferredResult(graph))
    const again = ms(() => knowledgeInferredResult(graph))

    const folder = join(dir, 'projects', 'p1')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'knowledge.json'), JSON.stringify(graph))
    resetKnowledgeCache()
    const cold = ms(() => readKnowledge(dir, 'p1'))
    const warm = ms(() => readKnowledge(dir, 'p1'))
    const warmAgain = ms(() => readKnowledge(dir, 'p1'))
    const bytes = JSON.stringify(graph).length

    console.log(
      `\nfull graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${(bytes / 1024 / 1024).toFixed(1)} MB JSON\n` +
        `  buildKnowledgeIndex ${index.ms} ms | rankKnowledge ${rank.ms} ms (${rank.out.length} hits) | recallKnowledge ${recall.ms} ms (${recall.out.text.length} chars)\n` +
        `  knowledgeInferredResult first ${inferred.ms} ms (${inferred.out.links.length} links), memoized ${again.ms} ms\n` +
        `  store read cold (parse + clean) ${cold.ms} ms | cached ${warm.ms} ms, ${warmAgain.ms} ms\n`
    )
    expect(cold.out.nodes).toHaveLength(2000)
    expect(warm.out).toBe(cold.out)
  })
})

// ---------- a graph with near-maximum text (review M6) ----------

/** `facts` facts of 1,000 characters on each of `nodeCount` nodes, plus a 2,000-character summary: most of the file cap. */
function fullTextGraph(nodeCount: number, facts: number): KnowledgeGraph {
  const rand = rng(7)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const word = (): string => `${pick(SYL)}${pick(SYL)}${rand() < 0.5 ? pick(SYL) : ''}`
  const text = (chars: number): string => {
    let s = ''
    while (s.length < chars) s += `${rand() < 0.35 ? pick(WORDS) : word()} `
    return s.slice(0, chars).trim()
  }
  const hex = (i: number): string => i.toString(16).padStart(10, '0')
  const nodes: KnowledgeNode[] = []
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `kn_${hex(i)}`,
      kind: pick(KINDS),
      name: `${word()} ${word()} ${i}`,
      summary: text(2000),
      facts: Array.from({ length: facts }, (_, j) => ({ id: `kf_${hex(i)}${j.toString(36)}`, text: text(1000), source: { by: 'agent' as const, at: 1_700_000_000_000 + j } })),
      source: { by: 'agent', at: 1_700_000_000_000 },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    })
  }
  return { version: 1, nodes, edges: [], updatedAt: 1_700_000_000_000 }
}

/** Run by hand: KNOWLEDGE_MEASURE_FULL=1 npx vitest run src/main/runtime/knowledgeRecall.measure.test.ts. It takes minutes and a few GB. */
describe.runIf(process.env.KNOWLEDGE_MEASURE_FULL === '1')('near-maximum text: timings are logged, not asserted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-knowledge-full-'))
  afterAll(() => {
    resetKnowledgeCache()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const [nodes, facts] of [[1100, 50], [2000, 50]] as const) {
    it(`${nodes} nodes x ${facts} facts of 1,000 characters`, { timeout: 600_000 }, () => {
      const ms = <T,>(f: () => T): { out: T; ms: number } => {
        const t = performance.now()
        const out = f()
        return { out, ms: Math.round(performance.now() - t) }
      }
      const graph = fullTextGraph(nodes, facts)
      const json = JSON.stringify(graph)
      const mb = Buffer.byteLength(json) / 1024 / 1024
      const index = ms(() => buildKnowledgeIndex(graph))
      const memoed = { ...graph }
      const hit = ms(() => rankKnowledge(memoed, 'invoice approval'))
      const miss1 = ms(() => rankKnowledgeOrSubstring(memoed, 'qqqzzz'))
      const miss2 = ms(() => rankKnowledgeOrSubstring(memoed, 'qqqyyy'))
      const inferred = ms(() => knowledgeInferredResult(graph))
      const lines = [
        `\n${nodes} nodes x ${facts} facts x 1,000 chars: ${mb.toFixed(1)} MB JSON (file cap ${KNOWLEDGE_FILE_MAX_BYTES / 1024 / 1024} MB)`,
        `  buildKnowledgeIndex ${index.ms} ms | rankKnowledge first ${hit.ms} ms | substring miss first ${miss1.ms} ms, second ${miss2.ms} ms`,
        `  knowledgeInferredResult ${inferred.ms} ms, partial ${JSON.stringify(inferred.out.partial ?? null)} (budget ${KNOWLEDGE_MATCH_BUDGET})`
      ]
      if (mb < KNOWLEDGE_FILE_MAX_BYTES / 1024 / 1024) {
        const folder = join(dir, 'projects', `p${nodes}`)
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, 'knowledge.json'), json)
        resetKnowledgeCache()
        const cold = ms(() => readKnowledge(dir, `p${nodes}`))
        const write = ms(() => upsertNode(dir, `p${nodes}`, { kind: 'person', name: 'Newcomer', facts: ['x'] }, { by: 'agent', at: 1 }))
        lines.push(`  store cold read ${cold.ms} ms | one agent write (parse, clean, stringify, atomic rename) ${write.ms} ms`)
        expect(write.out.created).toBe(true)
      } else lines.push('  over the file cap: the store would refuse this graph')
      console.log(lines.join('\n'))
    })
  }
})
