import { afterEach, describe, expect, it } from 'vitest'
import type { HostScope, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, Project } from '../../shared/types'
import { manageDeps } from '../manage'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, project, rpcError, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT, type CliContext } from '../types'
import { findNode, runKnowledge } from './knowledge'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realManage = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realManage)
  resetSkewWarning()
})

const ENG: Project = project('e1', '/work', { name: 'Acme engagement', kind: 'engagement' } as Partial<Project>)
const CODE: Project = project('c1', '/work', { name: 'Code' })

const user = { by: 'user' as const, at: 1_700_000_000_000 }
const node = (id: string, kind: string, name: string, extra: Partial<KnowledgeNode> = {}): KnowledgeNode => ({
  id,
  kind,
  name,
  facts: [],
  source: user,
  createdAt: 1,
  updatedAt: 100,
  ...extra
})
const edge = (id: string, from: string, to: string, relation: string): KnowledgeEdge => ({ id, from, to, relation, source: user, createdAt: 1 })

function graph(): KnowledgeGraph {
  return {
    version: 1,
    nodes: [
      node('kn_acme', 'organisation', 'Acme Corp', { aliases: ['Acme'], facts: [{ id: 'kf_1', text: 'HQ in Leeds', source: { by: 'agent', role: 'Analyst', runId: 'run_1', at: 2 } }] }),
      node('kn_jane', 'person', 'Jane \u001b[31mDoe'),
      node('kn_old', 'risk', 'Old risk', { retired: true })
    ],
    edges: [edge('ke_1', 'kn_jane', 'kn_acme', 'works-at')]
  }
}

function setup(answers: Record<string, (p: unknown) => unknown> = {}, opts: FakeContextOptions & { proj?: Project } = {}) {
  const g = graph()
  const client = new FakeHostClient({ 'projects:list': () => [opts.proj ?? ENG], 'knowledge:get': () => g, ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: '/work', ...opts })
  lastClient = client
  return { client, g, ...f }
}

/** Each command closes its connection; the fake client is reused, so reopen it first. */
let lastClient: FakeHostClient | undefined
async function run(ctx: CliContext, args: string[]): Promise<{ code: number; message?: string }> {
  if (lastClient) lastClient.closed = false
  try {
    return { code: await runKnowledge(ctx, args) }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, message: e.message }
    throw e
  }
}

describe('knowledge', () => {
  it('a code project is exit 2', async () => {
    const f = setup({}, { proj: CODE })
    const r = await run(f.ctx, ['list'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.message).toContain('engagements')
  })

  it('list hides retired items unless --retired; text sanitized', async () => {
    const f = setup()
    expect((await run(f.ctx, ['list'])).code).toBe(0)
    expect(f.out()).toContain('Acme Corp')
    expect(f.out()).not.toContain('Old risk')
    expect(f.out()).not.toContain('\u001b')
    const g = setup({}, { globals: { outputFormat: 'json' } })
    await run(g.ctx, ['list', '--retired', '--kind', 'risk'])
    expect(JSON.parse(g.out()).nodes.map((n: KnowledgeNode) => n.id)).toEqual(['kn_old'])
  })

  it('--origin filters', async () => {
    const f = setup({}, { globals: { outputFormat: 'json' } })
    await run(f.ctx, ['list', '--origin', 'agent'])
    expect(JSON.parse(f.out()).nodes).toEqual([])
    expect((await run(setup().ctx, ['list', '--origin', 'bot'])).code).toBe(EXIT.usage)
  })

  it('search and show', async () => {
    const f = setup()
    await run(f.ctx, ['search', 'leeds'])
    expect(f.out()).toContain('Acme Corp')
    const g = setup()
    expect((await run(g.ctx, ['show', 'organisation:acme'])).code).toBe(0)
    expect(g.out()).toContain('HQ in Leeds')
    expect(g.out()).toContain('Analyst in run_1')
    expect(g.out()).toContain('works-at')
    expect(g.out()).toContain('Also known as: Acme')
  })

  it('findNode: id, kind:name, alias, unknown and ambiguous', () => {
    const g = graph()
    expect(findNode(g, 'kn_jane').id).toBe('kn_jane')
    expect(findNode(g, 'Acme').id).toBe('kn_acme')
    expect(() => findNode(g, 'nobody')).toThrow(CliError)
    g.nodes.push(node('kn_acme2', 'system', 'Acme'))
    expect(() => findNode(g, 'Acme')).toThrow(/2 items/)
    expect(findNode(g, 'system:Acme').id).toBe('kn_acme2')
  })

  it('upsert of a new node creates it with appendFacts', async () => {
    const f = setup({ 'knowledge:saveNode': () => node('kn_new', 'system', 'Billing') })
    expect((await run(f.ctx, ['upsert', '--kind', 'System', '--name', 'Billing', '--alias', 'Bill', '--summary', 'S', '--fact', 'Runs nightly'])).code).toBe(0)
    expect(f.client.callsOf('knowledge:saveNode')).toEqual([[{ projectId: 'e1', kind: 'system', name: 'Billing', aliases: ['Bill'], summary: 'S', appendFacts: ['Runs nightly'] }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('a fact on an existing node is an append-only save, never a full facts list', async () => {
    const f = setup({ 'knowledge:saveNode': () => node('kn_acme', 'organisation', 'Acme Corp') })
    await run(f.ctx, ['upsert', '--kind', 'organisation', '--name', 'acme', '--fact', 'FY ends in March'])
    const [input] = f.client.callsOf('knowledge:saveNode')[0] as [Record<string, unknown>]
    expect(input).toEqual({ projectId: 'e1', nodeId: 'kn_acme', expectedUpdatedAt: 100, appendFacts: ['FY ends in March'] })
    expect(input).not.toHaveProperty('facts')
    expect(input).not.toHaveProperty('name')
  })

  it('summary and new aliases on an existing node carry expectedUpdatedAt', async () => {
    const f = setup({ 'knowledge:saveNode': () => node('kn_acme', 'organisation', 'Acme Corp') })
    await run(f.ctx, ['upsert', '--kind', 'organisation', '--name', 'Acme Corp', '--summary', 'A client', '--alias', 'ACME', '--alias', 'Acme Ltd'])
    expect(f.client.callsOf('knowledge:saveNode')).toEqual([[{ projectId: 'e1', nodeId: 'kn_acme', expectedUpdatedAt: 100, summary: 'A client', aliases: ['Acme', 'Acme Ltd'] }]])
  })

  it('stale_revision without --if-updated-at re-reads and retries (up to 3 times)', async () => {
    let n = 0
    const f = setup({
      'knowledge:saveNode': () => (n++ < 2 ? Promise.reject(rpcError({ code: 'stale_revision', message: 'changed' })) : node('kn_acme', 'organisation', 'Acme Corp'))
    })
    expect((await run(f.ctx, ['upsert', '--kind', 'organisation', '--name', 'Acme', '--fact', 'x'])).code).toBe(0)
    expect(f.client.callsOf('knowledge:saveNode')).toHaveLength(3)
    expect(f.client.callsOf('knowledge:get')).toHaveLength(3)

    const always = setup({ 'knowledge:saveNode': () => Promise.reject(rpcError({ code: 'stale_revision', message: 'changed' })) })
    expect((await run(always.ctx, ['upsert', '--kind', 'organisation', '--name', 'Acme', '--fact', 'x'])).code).toBe(1)
    expect(always.client.callsOf('knowledge:saveNode')).toHaveLength(4)
  })

  it('stale_revision with --if-updated-at is exit 1 without retry', async () => {
    const f = setup({ 'knowledge:saveNode': () => Promise.reject(rpcError({ code: 'stale_revision', message: 'changed' })) })
    const r = await run(f.ctx, ['upsert', '--kind', 'organisation', '--name', 'Acme', '--fact', 'x', '--if-updated-at', '99'])
    expect(r.code).toBe(1)
    expect(r.message).toMatch(/The item changed since .*; read it again/)
    expect(f.client.callsOf('knowledge:saveNode')).toEqual([[{ projectId: 'e1', nodeId: 'kn_acme', expectedUpdatedAt: 99, appendFacts: ['x'] }]])
  })

  it('link / unlink payloads', async () => {
    const f = setup({ 'knowledge:saveEdge': () => edge('ke_2', 'kn_acme', 'kn_jane', 'employs'), 'knowledge:removeEdge': () => graph() })
    await run(f.ctx, ['link', 'Acme', 'Employs', 'kn_jane', '--note', 'since 2020'])
    expect(f.client.callsOf('knowledge:saveEdge')).toEqual([[{ projectId: 'e1', from: 'kn_acme', to: 'kn_jane', relation: 'employs', note: 'since 2020' }]])
    await run(f.ctx, ['unlink', 'kn_jane', 'works-at', 'Acme'])
    await run(f.ctx, ['unlink', 'ke_1'])
    expect(f.client.callsOf('knowledge:removeEdge')).toEqual([[{ projectId: 'e1', edgeId: 'ke_1' }], [{ projectId: 'e1', edgeId: 'ke_1' }]])
  })

  it('retire / restore of a node, an edge and a fact', async () => {
    const f = setup({ 'knowledge:saveNode': (p) => ({ ...graph().nodes[0], ...(p as unknown[])[0] as object }), 'knowledge:saveEdge': () => edge('ke_1', 'kn_jane', 'kn_acme', 'works-at') })
    await run(f.ctx, ['retire', 'Acme'])
    await run(f.ctx, ['restore', 'ke_1'])
    await run(f.ctx, ['retire', 'kf_1'])
    const saves = f.client.callsOf('knowledge:saveNode')
    expect(saves[0]).toEqual([{ projectId: 'e1', nodeId: 'kn_acme', retired: true }])
    expect(f.client.callsOf('knowledge:saveEdge')).toEqual([[{ projectId: 'e1', edgeId: 'ke_1', from: 'kn_jane', to: 'kn_acme', relation: 'works-at', retired: false }]])
    expect(saves[1]).toEqual([{ projectId: 'e1', nodeId: 'kn_acme', expectedUpdatedAt: 100, facts: [{ id: 'kf_1', text: 'HQ in Leeds', retired: true }] }])
  })

  it('remove confirms and names the relations it takes', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), true)
    const f = setup({ 'knowledge:removeNode': () => graph() }, { stdinIsTTY: true })
    f.ctx.io.stdout.isTTY = true
    expect((await run(f.ctx, ['remove', 'Acme'])).code).toBe(0)
    expect(asked[0]).toContain('1 relation')
    expect(f.client.callsOf('knowledge:removeNode')).toEqual([[{ projectId: 'e1', nodeId: 'kn_acme' }]])
    const g = setup({ 'knowledge:removeNode': () => graph() })
    expect((await run(g.ctx, ['remove', 'Acme'])).code).toBe(EXIT.usage)
    expect(g.client.callsOf('knowledge:removeNode')).toEqual([])
  })

  it('clear needs confirmation and prints the counts', async () => {
    const f = setup({ 'knowledge:clear': () => ({ version: 1, nodes: [], edges: [] }) })
    expect((await run(f.ctx, ['clear'])).code).toBe(EXIT.usage)
    expect(f.client.callsOf('knowledge:clear')).toEqual([])
    const g = setup({ 'knowledge:clear': () => ({ version: 1, nodes: [], edges: [] }) })
    expect((await run(g.ctx, ['clear', '--yes'])).code).toBe(0)
    expect(g.client.callsOf('knowledge:clear')).toEqual([['e1']])
    expect(g.out()).toContain('3 items (1 retired), 1 fact, 1 relation')
  })

  it('a host refusal is exit 1', async () => {
    const f = setup({ 'knowledge:saveEdge': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Only the user can change that.' })) })
    expect((await run(f.ctx, ['link', 'Acme', 'owns', 'Jane \u001b[31mDoe'])).code).toBe(1)
  })
})
