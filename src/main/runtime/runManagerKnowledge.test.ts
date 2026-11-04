import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, EngagementChangedEvent, EngagementNote, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSource, RunEvent } from '@shared/types'
import { KNOWLEDGE_RUN_WRITES_MAX, QUICK_PROJECT_ID } from '@shared/types'
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
    expect(rows().map((r) => r.agentId)).toEqual([ROOT_AGENT_ID, 'ghost', 'ghost-2', 'ghost-3'])
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
