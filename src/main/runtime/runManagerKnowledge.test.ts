import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, EngagementChangedEvent, EngagementNote, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSource, RunEvent } from '@shared/types'
import { KNOWLEDGE_RUN_WRITES_MAX, QUICK_PROJECT_ID } from '@shared/types'
import { fixtureId, knowledgeFixture } from '@shared/knowledge.fixture'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { ROOT_AGENT_ID, type KnowledgeStoreApi, type RuntimeAdapter, type RuntimeContext } from './types'
import { project as makeProject } from './testHelpers'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-knowledge-')))
  events = []
  warn.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RunManagerOptions = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, ctxs, store }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

const engagement = (over: Parameters<typeof makeProject>[0] = {}) => makeProject({ id: 'p1', path: folder(), kind: 'engagement', ...over })

const nodeOf = (id: string, kind: string, name: string, source: KnowledgeSource): KnowledgeNode => ({ id, kind, name, facts: [], source, createdAt: 1, updatedAt: 1 })

/** A KnowledgeStoreApi whose calls are recorded; the graph it returns is `graph`. */
function fakeStore(graph: KnowledgeGraph = { version: 1, nodes: [], edges: [] }) {
  const calls: { fn: string; projectId: string; input: unknown; source: KnowledgeSource }[] = []
  const api: KnowledgeStoreApi & { calls: typeof calls } = {
    calls,
    get: vi.fn(() => graph),
    upsertNode: vi.fn((projectId, input, source) => {
      calls.push({ fn: 'upsertNode', projectId, input, source })
      const existing = input.nodeId ? graph.nodes.find((n) => n.id === input.nodeId) : undefined
      if (existing) return { node: existing, created: false }
      const node = nodeOf(`kn_${calls.length}`, input.kind, input.name, source)
      graph.nodes.push(node)
      return { node, created: true }
    }),
    saveEdge: vi.fn((projectId, input, source) => {
      calls.push({ fn: 'saveEdge', projectId, input, source })
      const edge: KnowledgeEdge = { id: `ke_${calls.length}`, from: input.from, to: input.to, relation: input.relation, source, createdAt: 1 }
      graph.edges.push(edge)
      return { edge, created: true }
    }),
    retire: vi.fn((projectId, input, source) => {
      calls.push({ fn: 'retire', projectId, input, source })
      if (input.nodeId === 'kn_retired') return { item: 'node' as const, id: 'kn_retired', label: 'risk Gone', alreadyRetired: true }
      if (input.nodeId === 'kn_user') throw new Error('Only the user can change that.')
      if (input.factId === 'kf_long') return { item: 'fact' as const, id: 'kf_long', label: `line one <x>\nline two ${'y'.repeat(300)}`, alreadyRetired: false }
      return { item: 'fact' as const, id: input.factId ?? 'kf_1', label: 'Owns invoices', alreadyRetired: false }
    })
  }
  return api
}

const agentWith = (over: Partial<AgentInstance> & { id: string }): AgentInstance => ({
  roleId: 'r-eng',
  roleSlug: 'engineer',
  name: 'engineer-1',
  parentId: ROOT_AGENT_ID,
  spawnToolUseId: 't1',
  state: 'thinking',
  activity: 'x',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...over
})

const rows = (): { agentId: string; text: string; source?: string }[] =>
  events
    .filter((e): e is Extract<RunEvent, { type: 'transcript' }> => e.type === 'transcript')
    .filter((e) => e.entry.block.kind === 'system')
    .map((e) => ({ agentId: e.entry.agentId, text: (e.entry.block as { text: string }).text, source: e.entry.source }))

describe('RuntimeContext.knowledge: where it is bound', () => {
  it('is bound on engagement work runs of any team, never on code projects, setup, Chat or build sessions', async () => {
    const knowledge = fakeStore()
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'team' })
    await m.start({ project: engagement({ id: 'p2', path: folder('b') }), prompt: 'single', team: 'single' })
    await m.start({ project: makeProject({ id: 'p3', path: folder('c') }), prompt: 'code' })
    await m.start({ project: engagement({ id: 'p4', path: folder('d') }), prompt: 'setup', kind: 'setup' })
    const quickFolder = folder('quick')
    await m.start({
      project: makeProject({ id: QUICK_PROJECT_ID, path: quickFolder, kind: 'engagement' }),
      prompt: 'chat',
      quick: { folder: quickFolder, team: 'single', allowEdits: false, gitRepo: false, scratch: true }
    })
    const ws = folder('ws')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws, kind: 'engagement' }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(ctxs.map((c) => c.knowledge !== undefined)).toEqual([true, true, false, false, false, false])
    expect(ctxs[0].knowledge?.graph()).toEqual({ version: 1, nodes: [], edges: [] })
    expect(knowledge.get).toHaveBeenCalledWith('p1')
    await m.stopAll()
  })

  it('is absent without the store option', async () => {
    const { m, ctxs } = rig()
    await m.start({ project: engagement(), prompt: 'go' })
    expect(ctxs[0].knowledge).toBeUndefined()
    await m.stopAll()
  })
})

describe('RuntimeContext.knowledge: writes', () => {
  it('upsertNode fills the provenance from the run and the agent record, writes a row and pushes the change', async () => {
    const knowledge = fakeStore()
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ knowledge, engagementChanged })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agentWith({ id: 'a-sub', roleSlug: 'engineer' }) })
    const before = Date.now()
    const r = ctx.knowledge!.upsertNode({ kind: 'person', name: 'Alice' }, { agentId: 'a-sub' })
    expect(r.created).toBe(true)
    const call = knowledge.calls[0]
    expect(call.projectId).toBe('p1')
    expect(call.input).toEqual({ kind: 'person', name: 'Alice' })
    expect(call.source).toMatchObject({ by: 'agent', runId: run.id, agentId: 'a-sub', role: 'Engineer' })
    expect(call.source.at).toBeGreaterThanOrEqual(before)
    expect(rows()).toEqual([{ agentId: 'a-sub', text: 'Recorded person Alice', source: 'harness' }])
    expect(engagementChanged).toHaveBeenCalledWith({ projectId: 'p1', what: 'knowledge', ids: ['kn_1'] } satisfies EngagementChangedEvent)
    // An update of an existing node reads "Updated".
    ctx.knowledge!.upsertNode({ nodeId: 'kn_1', kind: 'person', name: 'Alice', facts: ['x'] }, { agentId: 'a-sub' })
    expect(rows().at(-1)).toEqual({ agentId: 'a-sub', text: 'Updated person Alice', source: 'harness' })
    await m.stopAll()
  })

  it('the root, an unknown agent with a roleId, and an unknown agent without one resolve their role in that order', async () => {
    const knowledge = fakeStore()
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const kg = ctxs[0].knowledge!
    kg.upsertNode({ kind: 'person', name: 'A' }, {})
    kg.upsertNode({ kind: 'person', name: 'B' }, { agentId: 'ghost', roleId: 'r-rev' })
    kg.upsertNode({ kind: 'person', name: 'C' }, { agentId: 'ghost-2' })
    kg.upsertNode({ kind: 'person', name: 'D' }, { agentId: 'ghost-3', roleId: 'no-such-role' })
    expect(knowledge.calls.map((c) => [c.source.agentId, c.source.role])).toEqual([
      [ROOT_AGENT_ID, 'Lead'],
      ['ghost', 'Reviewer'],
      ['ghost-2', 'Lead'],
      ['ghost-3', 'Lead']
    ])
    // The source keeps the adapter's agent id, but a row on an agent the record does not know would be invisible, so
    // those rows fall back to the root (review L9).
    expect(rows().map((r) => r.agentId)).toEqual([ROOT_AGENT_ID, ROOT_AGENT_ID, ROOT_AGENT_ID, ROOT_AGENT_ID])
    // A recorded agent whose slug no role knows keeps the slug as its role.
    ctxs[0].emit({ type: 'agent.upsert', runId: ctxs[0].run.id, agent: agentWith({ id: 'odd', roleSlug: 'contractor', roleId: null }) })
    kg.upsertNode({ kind: 'person', name: 'E' }, { agentId: 'odd' })
    expect(knowledge.calls.at(-1)?.source.role).toBe('contractor')
    await m.stopAll()
  })

  it('link names both ends from the graph in its row and pushes the edge id', async () => {
    const graph: KnowledgeGraph = { version: 1, nodes: [nodeOf('kn_a', 'person', 'Alice', { by: 'user', at: 1 }), nodeOf('kn_b', 'organisation', 'Acme', { by: 'user', at: 1 })], edges: [] }
    const knowledge = fakeStore(graph)
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ knowledge, engagementChanged })
    await m.start({ project: engagement(), prompt: 'go' })
    const r = ctxs[0].knowledge!.link({ from: 'kn_a', to: 'kn_b', relation: 'works-at', note: 'n' }, { agentId: 'root' })
    expect(r.created).toBe(true)
    expect(knowledge.calls[0]).toMatchObject({ fn: 'saveEdge', projectId: 'p1', input: { from: 'kn_a', to: 'kn_b', relation: 'works-at', note: 'n' } })
    expect(rows()).toEqual([{ agentId: 'root', text: 'Linked Alice works-at Acme', source: 'harness' }])
    expect(engagementChanged).toHaveBeenLastCalledWith({ projectId: 'p1', what: 'knowledge', ids: ['ke_1'] })
    await m.stopAll()
  })

  it('retire writes a row with the reason; an already retired item writes nothing and pushes nothing', async () => {
    const knowledge = fakeStore()
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ knowledge, engagementChanged })
    await m.start({ project: engagement(), prompt: 'go' })
    const kg = ctxs[0].knowledge!
    expect(kg.retire({ factId: 'kf_1', reason: 'superseded by <the new org chart>\nsee note' }, {})).toMatchObject({ alreadyRetired: false })
    expect(rows()).toEqual([{ agentId: ROOT_AGENT_ID, text: 'Retired fact Owns invoices (superseded by ‹the new org chart› see note)', source: 'harness' }])
    expect(engagementChanged).toHaveBeenCalledWith({ projectId: 'p1', what: 'knowledge', ids: ['kf_1'] })
    kg.retire({ factId: 'kf_2' }, {})
    expect(rows().at(-1)?.text).toBe('Retired fact Owns invoices')
    expect(kg.retire({ nodeId: 'kn_retired' }, {})).toMatchObject({ alreadyRetired: true })
    expect(rows()).toHaveLength(2)
    expect(engagementChanged).toHaveBeenCalledTimes(2)
    expect(knowledge.calls).toHaveLength(3)
    // A fact's label is its text: the row is one line, brackets replaced, cut at 160 characters (review M2).
    kg.retire({ factId: 'kf_long' }, {})
    const long = rows().at(-1)?.text ?? ''
    expect(long.startsWith('Retired fact line one ‹x› line two yyyy')).toBe(true)
    expect(long).not.toContain('\n')
    expect(long.length).toBe('Retired fact '.length + 160)
    await m.stopAll()
  })

  it('a store throw propagates unchanged, with no row, no count and no push', async () => {
    const knowledge = fakeStore()
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ knowledge, engagementChanged })
    await m.start({ project: engagement(), prompt: 'go' })
    const kg = ctxs[0].knowledge!
    expect(() => kg.retire({ nodeId: 'kn_user' }, {})).toThrow('Only the user can change that.')
    vi.mocked(knowledge.upsertNode).mockImplementationOnce(() => {
      throw new Error('The knowledge graph is full (2000 entities).')
    })
    expect(() => kg.upsertNode({ kind: 'person', name: 'X' }, {})).toThrow('The knowledge graph is full (2000 entities).')
    expect(rows()).toEqual([])
    expect(engagementChanged).not.toHaveBeenCalled()
    // A failing broadcaster never reaches the tool.
    engagementChanged.mockImplementation(() => {
      throw new Error('window gone')
    })
    expect(() => kg.upsertNode({ kind: 'person', name: 'Y' }, {})).not.toThrow()
    await m.stopAll()
  })

  it('refuses every write past KNOWLEDGE_RUN_WRITES_MAX before the store is called and logs the cap once', async () => {
    const knowledge = fakeStore()
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ knowledge, engagementChanged })
    await m.start({ project: engagement(), prompt: 'go' })
    const kg = ctxs[0].knowledge!
    for (let i = 0; i < KNOWLEDGE_RUN_WRITES_MAX; i++) kg.retire({ factId: `kf_${i}` }, {})
    expect(knowledge.calls).toHaveLength(KNOWLEDGE_RUN_WRITES_MAX)
    const refusal = `The knowledge graph write limit for this run (${KNOWLEDGE_RUN_WRITES_MAX}) is reached; nothing was saved.`
    expect(() => kg.upsertNode({ kind: 'person', name: 'X' }, {})).toThrow(refusal)
    expect(() => kg.link({ from: 'a', to: 'b', relation: 'r' }, {})).toThrow(refusal)
    expect(() => kg.retire({ factId: 'kf_x' }, {})).toThrow(refusal)
    expect(knowledge.calls).toHaveLength(KNOWLEDGE_RUN_WRITES_MAX)
    expect(rows()).toHaveLength(KNOWLEDGE_RUN_WRITES_MAX)
    expect(engagementChanged).toHaveBeenCalledTimes(KNOWLEDGE_RUN_WRITES_MAX)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('knowledge graph write limit'))).toHaveLength(1)
    await m.stopAll()
  })

  it('an already retired item does not count toward the cap', async () => {
    const knowledge = fakeStore()
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const kg = ctxs[0].knowledge!
    for (let i = 0; i < KNOWLEDGE_RUN_WRITES_MAX; i++) kg.retire({ nodeId: 'kn_retired' }, {})
    expect(() => kg.retire({ factId: 'kf_1' }, {})).not.toThrow()
    await m.stopAll()
  })
})

describe('RuntimeContext.engagementNotes.save', () => {
  const saved = (over: Partial<EngagementNote> = {}): EngagementNote => ({ id: 'n7', title: 'Findings', excerpt: 'Alpha', createdAt: 1, updatedAt: 1, chars: 5, source: 'agent', ...over })
  type NoteSave = NonNullable<NonNullable<RunManagerOptions['engagementNotes']>['save']>
  const notes = (save?: NoteSave) => ({
    list: vi.fn(() => []),
    read: vi.fn(() => null),
    ...(save ? { save } : {})
  })

  it('saves with an agent writer carrying the run and the role, writes the row, counts and pushes', async () => {
    const save = vi.fn(() => saved())
    const engagementChanged = vi.fn()
    const { m, ctxs } = rig({ engagementNotes: notes(save), knowledge: fakeStore(), engagementChanged })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agentWith({ id: 'a-sub', roleSlug: 'reviewer', roleId: 'r-rev' }) })
    const note = ctx.engagementNotes!.save({ noteId: 'n7', title: 'Findings', text: 'Alpha' }, { agentId: 'a-sub' })
    expect(note).toEqual(saved())
    expect(save).toHaveBeenCalledWith('p1', { noteId: 'n7', title: 'Findings', text: 'Alpha' }, { by: 'agent', runId: run.id, role: 'Reviewer' })
    expect(rows()).toEqual([{ agentId: 'a-sub', text: 'Saved note Findings', source: 'harness' }])
    expect(engagementChanged).toHaveBeenCalledWith({ projectId: 'p1', what: 'notes', ids: ['n7'] })
    // The root's save names the root role and counts toward the same cap as graph writes.
    ctx.engagementNotes!.save({ title: 'More', text: 'x' }, {})
    expect(save).toHaveBeenLastCalledWith('p1', { title: 'More', text: 'x' }, { by: 'agent', runId: run.id, role: 'Lead' })
    expect(rows().at(-1)?.agentId).toBe(ROOT_AGENT_ID)
    await m.stopAll()
  })

  it('on a single engagement run the role is the single assistant', async () => {
    const save = vi.fn(() => saved())
    const { m, ctxs } = rig({ engagementNotes: notes(save) })
    const run = await m.start({ project: engagement(), prompt: 'go', team: 'single' })
    ctxs[0].engagementNotes!.save({ title: 'T', text: 'x' }, {})
    expect(save).toHaveBeenCalledWith('p1', { title: 'T', text: 'x' }, { by: 'agent', runId: run.id, role: ctxs[0].roles[0].name })
    await m.stopAll()
  })

  it('refuses without the store save, and relays a store throw unchanged with nothing written', async () => {
    const engagementChanged = vi.fn()
    const none = rig({ engagementNotes: notes(), engagementChanged })
    await none.m.start({ project: engagement(), prompt: 'go' })
    expect(() => none.ctxs[0].engagementNotes!.save({ title: 'T', text: 'x' }, {})).toThrow('Notes cannot be saved in this run.')
    await none.m.stopAll()

    const save = vi.fn(() => {
      throw new Error('Only the user can change that note; save a new one instead.')
    })
    const { m, ctxs } = rig({ engagementNotes: notes(save), engagementChanged })
    await m.start({ project: engagement(), prompt: 'go' })
    expect(() => ctxs[0].engagementNotes!.save({ noteId: 'n1', title: 'T', text: 'x' }, {})).toThrow('Only the user can change that note; save a new one instead.')
    expect(rows()).toEqual([])
    expect(engagementChanged).not.toHaveBeenCalled()
    await m.stopAll()
  })

  it('shares the writes cap with the graph: the cap refuses before the store is called', async () => {
    const save = vi.fn(() => saved())
    const knowledge = fakeStore()
    const { m, ctxs } = rig({ engagementNotes: notes(save), knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    for (let i = 0; i < KNOWLEDGE_RUN_WRITES_MAX - 1; i++) ctxs[0].knowledge!.retire({ factId: `kf_${i}` }, {})
    ctxs[0].engagementNotes!.save({ title: 'Last', text: 'x' }, {})
    expect(() => ctxs[0].engagementNotes!.save({ title: 'One too many', text: 'x' }, {})).toThrow(`The knowledge graph write limit for this run (${KNOWLEDGE_RUN_WRITES_MAX}) is reached; nothing was saved.`)
    expect(save).toHaveBeenCalledTimes(1)
    await m.stopAll()
  })
})

// ---------- round 2: recall, automatic context, brief ----------

describe('knowledge reads: where they are bound', () => {
  it('recall, context and brief are bound exactly where knowledge is, never on code, setup, Chat, build or restricted runs', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'team' })
    await m.start({ project: engagement({ id: 'p2', path: folder('b') }), prompt: 'single', team: 'single' })
    await m.start({ project: makeProject({ id: 'p3', path: folder('c') }), prompt: 'code' })
    await m.start({ project: engagement({ id: 'p4', path: folder('d') }), prompt: 'setup', kind: 'setup' })
    const quickFolder = folder('quick')
    await m.start({ project: makeProject({ id: QUICK_PROJECT_ID, path: quickFolder, kind: 'engagement' }), prompt: 'chat', quick: { folder: quickFolder, team: 'single', allowEdits: false, gitRepo: false, scratch: true } })
    const ws = folder('ws')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws, kind: 'engagement' }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    const has = (c: RuntimeContext): boolean[] => [c.knowledgeRecall !== undefined, c.knowledgeContext !== undefined, c.knowledgeBrief !== undefined]
    expect(has(ctxs[0])).toEqual([true, true, true])
    expect(has(ctxs[1])).toEqual([true, true, true])
    for (const c of ctxs.slice(2)) expect(has(c)).toEqual([false, false, false])
    await m.stopAll()
  })
})

describe('knowledge_recall through RunManager', () => {
  it('serves fenced data, writes the row on the caller, counts usage and writes nothing to the graph', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agentWith({ id: 'a-sub' }) })
    const text = ctx.knowledgeRecall!({ query: 'Priya Raman' }, { agentId: 'a-sub' })
    expect(text).toContain('<<<')
    expect(text).toContain('Priya Raman')
    expect(text.length).toBeLessThanOrEqual(1500)
    const row = rows().at(-1)!
    expect(row.agentId).toBe('a-sub')
    expect(row.source).toBe('harness')
    expect(row.text).toMatch(/^Recalled \d+ items? about Priya Raman$/)
    const usage = m.summaryOf(run.id)?.usage?.knowledge
    expect(usage).toMatchObject({ recalls: 1, autoContexts: 0 })
    expect(usage!.itemsServed).toBeGreaterThan(0)
    expect(usage!.charsServed).toBe(text.length)
    expect(knowledge.calls).toEqual([])
    await m.stopAll()
  })

  it('a repeat by the same agent is much shorter; another agent and fresh get the full answer; reads never hit the writes cap', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    // Every match fits the largest budget, so the repeat is one short line per entity.
    const root = { agentId: ROOT_AGENT_ID }
    const first = ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, root)
    const again = ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, root)
    expect(again.length).toBeLessThan(first.length / 2)
    expect(again).toContain('already shown (fresh: true shows it again)')
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, { agentId: 'someone-else' })).toBe(first)
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000, fresh: true }, root)).toBe(first)
    for (let i = 0; i < KNOWLEDGE_RUN_WRITES_MAX + 5; i++) ctx.knowledgeRecall!({ query: 'cut-over' }, root)
    expect(ctx.knowledgeRecall!({ query: 'cut-over' }, root)).toContain('already shown')
    expect(knowledge.calls).toEqual([])
    await m.stopAll()
  })

  it('a caller with no agent id gets no dedupe and does not share the root\'s state; its row still lands on the root', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    const first = ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, {})
    expect(rows().at(-1)!.agentId).toBe(ROOT_AGENT_ID)
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, {})).toBe(first)
    // Neither did the unknown caller's calls mark anything shown for the root itself.
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, { agentId: ROOT_AGENT_ID })).toBe(first)
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, { agentId: ROOT_AGENT_ID })).toContain('already shown')
    expect(ctx.knowledgeRecall!({ query: 'cut-over', budget: 6000 }, {})).toBe(first)
    await m.stopAll()
  })

  it('ranks on the store\'s recall view when it has one, and takes its inferred links from it', async () => {
    const graph = knowledgeFixture()
    const knowledge = fakeStore(graph)
    knowledge.inferred = vi.fn(() => ({ links: [], appearances: {} }))
    const older: KnowledgeGraph = { version: 1, nodes: graph.nodes.filter((n) => n.name !== 'Lena Koster'), edges: [] }
    knowledge.recallView = vi.fn(() => ({ rankOn: older, inferred: { links: [], appearances: {} } }))
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    expect(ctxs[0].knowledgeRecall!({ query: 'Priya Raman' }, {})).toContain('Priya Raman')
    expect(ctxs[0].knowledgeRecall!({ query: 'Lena Koster' }, {})).not.toContain(`${fixtureId('Lena Koster')} | Lena Koster`)
    expect(knowledge.recallView).toHaveBeenCalledWith('p1')
    expect(knowledge.inferred).not.toHaveBeenCalled()
    await m.stopAll()
  })

  it('answers an empty match plainly (the query fenced), still counts it and emits no event', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const text = ctxs[0].knowledgeRecall!({ query: 'zzzqqq <<<>>> nothing' }, {})
    expect(text).toBe('Nothing in the knowledge graph matches "zzzqqq ‹‹‹››› nothing".')
    expect(m.summaryOf(run.id)?.usage?.knowledge).toMatchObject({ recalls: 1, itemsServed: 0 })
    expect(events.filter((e) => e.type === 'knowledge.recalled')).toEqual([])
    await m.stopAll()
  })

  it('a store failure answers a fixed sentence and never throws', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    vi.mocked(knowledge.get).mockImplementationOnce(() => {
      throw new Error('disk gone')
    })
    expect(ctxs[0].knowledgeRecall!({ query: 'Stripe' }, {})).toBe('The knowledge graph could not be read right now.')
    await m.stopAll()
  })

  it('asks the store for inferred links when it has them', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    knowledge.inferred = vi.fn(() => ({ links: [], appearances: {} }))
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    ctxs[0].knowledgeRecall!({ query: 'Stripe' }, {})
    expect(knowledge.inferred).toHaveBeenCalledWith('p1')
    await m.stopAll()
  })
})

describe('knowledge.recalled throttle', () => {
  it('goes out at once the first time, merges calls inside the second into one trailing event and flushes before the end', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    vi.useFakeTimers()
    try {
      const recalled = (): Extract<RunEvent, { type: 'knowledge.recalled' }>[] => events.filter((e): e is Extract<RunEvent, { type: 'knowledge.recalled' }> => e.type === 'knowledge.recalled')
      ctx.knowledgeRecall!({ query: 'Priya Raman' }, {})
      expect(recalled()).toHaveLength(1)
      expect(recalled()[0]).toMatchObject({ runId: run.id, agentId: ROOT_AGENT_ID, via: 'recall' })
      expect(recalled()[0].nodeIds).toContain(fixtureId('Priya Raman'))
      ctx.knowledgeRecall!({ query: 'Stripe' }, {})
      ctx.knowledgeRecall!({ query: 'tax' }, { agentId: ROOT_AGENT_ID })
      expect(recalled()).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(recalled()).toHaveLength(2)
      expect(new Set(recalled()[1].nodeIds).size).toBe(recalled()[1].nodeIds.length)
      expect(recalled()[1].nodeIds.length).toBeLessThanOrEqual(50)
      // A pending event is sent before the terminal status, never after it.
      vi.advanceTimersByTime(1000)
      ctx.knowledgeRecall!({ query: 'legacy export' }, {})
      const sent = recalled().length
      ctx.knowledgeRecall!({ query: 'Atlas' }, {})
      expect(recalled()).toHaveLength(sent)
      ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
      const types = events.map((e) => e.type)
      expect(types.lastIndexOf('knowledge.recalled')).toBeLessThan(types.lastIndexOf('run.status'))
      expect(recalled()).toHaveLength(sent + 1)
      vi.advanceTimersByTime(5000)
      expect(recalled()).toHaveLength(sent + 1)
      ctx.knowledgeRecall!({ query: 'tax' }, {})
      expect(recalled()).toHaveLength(sent + 1)
    } finally {
      vi.useRealTimers()
    }
    await m.stopAll()
  })
})

describe('knowledge context through RunManager', () => {
  it('adds a block for known names, writes the "Added" row, counts it and dedupes per agent', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    const run = await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    const block = ctx.knowledgeContext!('Please ask Priya Raman.', { agentId: 'a-new', purpose: 'spawn' })
    expect(block).toContain('Priya Raman')
    expect(block).toContain('<<<')
    const row = rows().at(-1)!
    expect(row.text).toMatch(/^Added \d+ known items?: /)
    expect(row.text.length).toBeLessThanOrEqual(200)
    expect(row.agentId).toBe(ROOT_AGENT_ID)
    expect(m.summaryOf(run.id)?.usage?.knowledge).toMatchObject({ autoContexts: 1, recalls: 0 })
    // The same agent hears the same names again: nothing new, no row.
    const rowsBefore = rows().length
    expect(ctx.knowledgeContext!('Priya Raman again', { agentId: 'a-new', purpose: 'message' })).toBeNull()
    expect(rows()).toHaveLength(rowsBefore)
    // Another agent, and calls with no agent id (no dedupe), still get it.
    expect(ctx.knowledgeContext!('Priya Raman', { agentId: 'a-other', purpose: 'spawn' })).not.toBeNull()
    expect(ctx.knowledgeContext!('Priya Raman', { purpose: 'message' })).not.toBeNull()
    expect(ctx.knowledgeContext!('Priya Raman', { purpose: 'message' })).not.toBeNull()
    // Nothing known in the text, or not text at all.
    expect(ctx.knowledgeContext!('hello there', { purpose: 'message' })).toBeNull()
    expect(ctx.knowledgeContext!(undefined as unknown as string, { purpose: 'message' })).toBeNull()
    expect(knowledge.calls).toEqual([])
    await m.stopAll()
  })

  it('a single name reads "Added 1 known item: X"; a block that left something out does not count as shown for a recall', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    ctx.knowledgeContext!('Lena Koster', { agentId: 'a1', purpose: 'message' })
    expect(rows().at(-1)!.text).toBe('Added 1 known item: Lena Koster')
    // The block held only part of her (an agent wrote the rest), so a recall still gives the detail ...
    const recall = ctx.knowledgeRecall!({ query: 'Lena Koster' }, { agentId: 'a1' })
    expect(recall).toContain('Lena Koster')
    expect(recall).not.toContain(`${fixtureId('Lena Koster')} | Lena Koster | already shown`)
    // ... and the next block does not repeat her either.
    expect(ctx.knowledgeContext!('Lena Koster', { agentId: 'a1', purpose: 'message' })).toBeNull()
    await m.stopAll()
  })

  it('a block that printed everything (all user-written, within the caps) is shared with the recall dedupe', async () => {
    const user = { by: 'user' as const, at: 1 }
    const g: KnowledgeGraph = { version: 1, nodes: [{ id: 'kn_u', kind: 'person', name: 'Una Field', summary: 'Sponsor', facts: [], source: user, createdAt: 1, updatedAt: 1 }], edges: [] }
    const { m, ctxs } = rig({ knowledge: fakeStore(g) })
    await m.start({ project: engagement(), prompt: 'go' })
    ctxs[0].knowledgeContext!('Una Field', { agentId: 'a1', purpose: 'message' })
    expect(ctxs[0].knowledgeRecall!({ query: 'Una Field' }, { agentId: 'a1' })).toContain('kn_u | Una Field | already shown')
    await m.stopAll()
  })

  it('a long row never cuts a surrogate pair and a comma in a name does not read as two items', async () => {
    const agent = { by: 'agent' as const, at: 1 }
    const mk = (id: string, name: string, aliases?: string[]) => ({ id, kind: 'person', name, ...(aliases ? { aliases } : {}), facts: [], source: agent, createdAt: 1, updatedAt: 1 })
    // Three names of 60 characters make a 217-character row. With the 'x' offset the cut at 199 falls inside a pair of astral letters.
    const astral = (i: number, pad: string): string => `${pad}${'𠀀'.repeat(28)} word${i}`
    const nameSets = ['', 'x'].map((pad) => Array.from({ length: 5 }, (_, i) => astral(i, pad)))
    const nodes = [mk('kn_c', 'Acme, Beta', ['Zedcorp']), ...nameSets.flatMap((names, s) => names.map((n, i) => mk(`kn_${s}_${i}`, n)))]
    const { m, ctxs } = rig({ knowledge: fakeStore({ version: 1, nodes, edges: [] }) })
    await m.start({ project: engagement(), prompt: 'go' })
    for (const names of nameSets) {
      expect(ctxs[0].knowledgeContext!(names.join(' and '), { purpose: 'message' })).not.toBeNull()
      const row = rows().at(-1)!.text
      expect(row).toMatch(/^Added 5 known items: .*…$/)
      expect(row.length).toBeLessThanOrEqual(200)
      expect(row).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    }
    expect(ctxs[0].knowledgeContext!('Ask Zedcorp', { purpose: 'message' })).not.toBeNull()
    expect(rows().at(-1)!.text).toBe('Added 1 known item: Acme‚ Beta')
    await m.stopAll()
  })

  it('is null when the saved project turns it off, read at call time; unset means on', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    let saved = engagement()
    const { m, ctxs } = rig({ knowledge, resolveProject: () => saved })
    await m.start({ project: engagement(), prompt: 'go' })
    const ctx = ctxs[0]
    expect(ctx.knowledgeContext!('Lena Koster', { purpose: 'message' })).not.toBeNull()
    saved = { ...saved, knowledgeAutoContext: false }
    expect(ctx.knowledgeContext!('Lena Koster', { purpose: 'message' })).toBeNull()
    saved = { ...saved, knowledgeAutoContext: true }
    expect(ctx.knowledgeContext!('Lena Koster', { purpose: 'message' })).not.toBeNull()
    await m.stopAll()
  })

  it('a store failure returns null with a warning, never a throw', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    vi.mocked(knowledge.get).mockImplementationOnce(() => {
      throw new Error('disk gone')
    })
    expect(ctxs[0].knowledgeContext!('Lena Koster', { purpose: 'message' })).toBeNull()
    expect(warn).toHaveBeenCalled()
    await m.stopAll()
  })
})

describe('knowledge brief through RunManager', () => {
  it('is computed once per run, memoised including an empty answer, and never throws', async () => {
    const knowledge = fakeStore(knowledgeFixture())
    const { m, ctxs } = rig({ knowledge })
    await m.start({ project: engagement(), prompt: 'go' })
    const first = ctxs[0].knowledgeBrief!()
    expect(first).toContain('Knowledge graph index')
    const calls = vi.mocked(knowledge.get).mock.calls.length
    expect(ctxs[0].knowledgeBrief!()).toBe(first)
    expect(vi.mocked(knowledge.get).mock.calls.length).toBe(calls)

    const empty = fakeStore()
    const other = rig({ knowledge: empty })
    await other.m.start({ project: engagement({ id: 'p9', path: folder('e') }), prompt: 'go' })
    expect(other.ctxs[0].knowledgeBrief!()).toBeUndefined()
    empty.get = vi.fn(() => knowledgeFixture())
    expect(other.ctxs[0].knowledgeBrief!()).toBeUndefined()

    const broken = fakeStore()
    broken.get = vi.fn(() => {
      throw new Error('boom')
    })
    const third = rig({ knowledge: broken })
    await third.m.start({ project: engagement({ id: 'p8', path: folder('f') }), prompt: 'go' })
    expect(third.ctxs[0].knowledgeBrief!()).toBeUndefined()
    await m.stopAll()
    await other.m.stopAll()
    await third.m.stopAll()
  })
})
