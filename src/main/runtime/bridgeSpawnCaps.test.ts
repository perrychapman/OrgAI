import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, BridgedRoleChoice, Project, Role, RunEvent } from '@shared/types'
import { BridgedSessions, bridgeKey } from './bridge'
import { ROOT_AGENT_ID, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { fakeCtx, project as makeProject, role } from './testHelpers'

// The UI overhaul spawn caps (Role.maxConcurrent, Project.maxAgentsPerRun) on the bridge's delegate path.

function agentOf(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return { roleId: null, roleSlug: 'x', name: 'x', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Working', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over }
}

class FakeSession implements RuntimeSession {
  finished: Promise<void>
  private end!: () => void
  constructor(public ctx: RuntimeContext) {
    this.finished = new Promise<void>((res) => (this.end = res))
  }
  stop = vi.fn(async () => this.end())
  send = vi.fn(async () => {})
  interrupt = vi.fn(async () => {})
  /** The child root's turn ends with a report. */
  report(text = 'done'): void {
    this.ctx.emit({ type: 'transcript', runId: this.ctx.run.id, entry: { id: `t-${Math.random()}`, agentId: ROOT_AGENT_ID, at: 1, block: { kind: 'text', text } } })
    this.ctx.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
  }
}

class FakeAdapter implements RuntimeAdapter {
  sessions: FakeSession[] = []
  constructor(public id: 'claude' | 'codex' | 'mock') {}
  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    const s = new FakeSession(ctx)
    this.sessions.push(s)
    return s
  }
  async complete(): Promise<string> {
    return ''
  }
}

const OPENAI_CONN: RunConnection = { connection: 'openai', adapter: 'codex', apiKey: 'sk-openai-secret-999' }

const chart = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-oa', 'r-eng', 'r-solo'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead' }),
  role({ id: 'r-oa', slug: 'oa', name: 'OpenAI lead', reportsTo: 'r-lead', connection: 'openai' }),
  role({ id: 'r-solo', slug: 'solo', name: 'Solo', reportsTo: 'r-lead', connection: 'proxy-1' })
]

const BRIDGED: BridgedRoleChoice[] = [
  { roleId: 'r-oa', connection: 'openai', adapter: 'codex' },
  { roleId: 'r-solo', connection: 'proxy-1', adapter: 'claude' }
]

function rig(project: Partial<Project> = {}, roles: Role[] = chart(), bridged: BridgedRoleChoice[] = BRIDGED) {
  const p = makeProject({ roles, maxSubagentDepth: 3, maxConcurrentSubagents: 10, ...project })
  const parent = fakeCtx({ project: p, roles })
  const events: RunEvent[] = []
  const agents = new Map<string, AgentInstance>([[ROOT_AGENT_ID, agentOf({ id: ROOT_AGENT_ID, roleId: 'r-lead', roleSlug: 'lead', name: 'Lead' })]])
  const codex = new FakeAdapter('codex')
  const claude = new FakeAdapter('claude')
  const b = new BridgedSessions({
    adapters: { codex, claude },
    parent: () => parent,
    bridged,
    connections: new Map([
      [bridgeKey('openai', 'codex'), OPENAI_CONN],
      [bridgeKey('proxy-1', 'claude'), { connection: 'proxy-1', adapter: 'claude' }]
    ]),
    emit: (e) => {
      events.push(e)
      if (e.type === 'agent.upsert') agents.set(e.agent.id, e.agent)
      if (e.type === 'agent.remove') agents.delete(e.agentId)
    },
    agents: () => [...agents.values()],
    connectionName: (id) => (id === 'openai' ? 'OpenAI' : 'Acme proxy')
  })
  return { b, parent, agents, codex, claude, events }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const delegate = (r: ReturnType<typeof rig>, slug: string) => r.b.spawn({ role: slug, brief: 'go', parentAgentId: ROOT_AGENT_ID })

describe('BridgedSessions.spawn spawn caps', () => {
  it('Role.maxConcurrent refuses the N+1th delegate and allows again after one ends', async () => {
    const roles = chart().map((x) => (x.id === 'r-oa' ? { ...x, maxConcurrent: 2 } : x))
    const r = rig({}, roles)
    void delegate(r, 'oa')
    void delegate(r, 'oa')
    await tick()
    await expect(delegate(r, 'oa')).rejects.toThrow(/Concurrent limit for oa reached \(2 running at once\)/)
    // Another role is not held by that cap.
    void delegate(r, 'solo')
    await tick()
    expect(r.claude.sessions).toHaveLength(1)
    // One report ends: a slot is free.
    r.codex.sessions[0]!.report()
    await tick()
    void delegate(r, 'oa')
    await tick()
    expect(r.codex.sessions).toHaveLength(3)
    await expect(delegate(r, 'oa')).rejects.toThrow(/Concurrent limit for oa/)
  })

  it('Project.maxAgentsPerRun counts the root session and ended agents, never the root', async () => {
    const r = rig({ maxAgentsPerRun: 3 })
    // Two agents the root session already started, one of them ended.
    r.agents.set('cl-1', agentOf({ id: 'cl-1', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID, state: 'done' }))
    r.agents.set('cl-2', agentOf({ id: 'cl-2', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID }))
    void delegate(r, 'oa')
    await tick()
    const err = await delegate(r, 'solo').then(
      () => undefined,
      (e: Error) => e.message
    )
    expect(err).toMatch(/Agent limit reached \(this run may start 3 agents in total and 3 have started\)/)
    // The first bridged report ends: it still counts (the total never frees up).
    r.codex.sessions[0]!.report()
    await tick()
    await expect(delegate(r, 'oa')).rejects.toThrow(/Agent limit reached/)
  })

  it('counts agents inside a bridged child toward the run total', async () => {
    const r = rig({ maxAgentsPerRun: 3 })
    void delegate(r, 'oa')
    await tick()
    const ctx = r.codex.sessions[0]!.ctx
    // The child's own session starts two helpers; their remapped agents are in the run's record.
    ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: agentOf({ id: 'h1', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID }) })
    ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: agentOf({ id: 'h2', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID }) })
    await expect(delegate(r, 'solo')).rejects.toThrow(/Agent limit reached \(this run may start 3 agents in total and 3 have started\)/)
  })

  it('counts a started child the record does not show yet, so parallel delegate calls cannot all pass', async () => {
    const roles = chart().map((x) => (x.id === 'r-oa' ? { ...x, maxConcurrent: 1 } : x))
    const r = rig({ maxAgentsPerRun: 2 }, roles)
    // The run's record lags: it shows only the root.
    const root = r.agents.get(ROOT_AGENT_ID)!
    ;(r.b as unknown as { deps: { agents: () => AgentInstance[] } }).deps.agents = () => [root]
    void delegate(r, 'oa')
    await expect(delegate(r, 'oa')).rejects.toThrow(/Concurrent limit for oa reached \(1 running at once\)/)
    void delegate(r, 'solo')
    await expect(delegate(r, 'solo')).rejects.toThrow(/Agent limit reached \(this run may start 2 agents in total and 2 have started\)/)
  })

  it('reads the limits live from the parent context', async () => {
    const r = rig()
    void delegate(r, 'oa')
    void delegate(r, 'oa')
    await tick()
    r.parent.project.maxAgentsPerRun = 2
    await expect(delegate(r, 'oa')).rejects.toThrow(/Agent limit reached/)
    r.parent.project.maxAgentsPerRun = undefined
    void delegate(r, 'oa')
    await tick()
    expect(r.codex.sessions).toHaveLength(3)
    const oa = r.parent.roles.find((x) => x.id === 'r-oa')!
    oa.maxConcurrent = 3
    await expect(delegate(r, 'oa')).rejects.toThrow(/Concurrent limit for oa reached \(3 running at once\)/)
  })

  it('without caps nothing changes: the existing concurrency limit is the only gate', async () => {
    const r = rig({ maxConcurrentSubagents: 3 })
    for (let i = 0; i < 3; i++) void delegate(r, 'oa')
    await tick()
    expect(r.codex.sessions).toHaveLength(3)
    await expect(delegate(r, 'oa')).rejects.toThrow(/3 reports are already working; the limit is 3/)
  })
})

describe('a bridged child gets what is left of the caps, not the whole of them (security review L3)', () => {
  // r-oa can delegate to a helper on the same connection, so the child has a role it may spawn.
  const withHelper = (helperCap?: number): Role[] => [
    ...chart().map((x) => (x.id === 'r-oa' ? { ...x, canSpawn: true, spawnable: ['r-oa2'] } : x)),
    role({ id: 'r-oa2', slug: 'oa2', name: 'OpenAI helper', reportsTo: 'r-oa', connection: 'openai', ...(helperCap ? { maxConcurrent: helperCap } : {}) })
  ]
  const BRIDGED2: BridgedRoleChoice[] = [...BRIDGED, { roleId: 'r-oa2', connection: 'openai', adapter: 'codex' }]
  const childCtx = (r: ReturnType<typeof rig>): RuntimeContext => r.codex.sessions.at(-1)!.ctx

  it('hands the child Project.maxAgentsPerRun minus the agents already started and itself', async () => {
    const r = rig({ maxAgentsPerRun: 5 }, withHelper(), BRIDGED2)
    r.agents.set('cl-1', agentOf({ id: 'cl-1', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID, state: 'done' }))
    void delegate(r, 'oa')
    await tick()
    expect(childCtx(r).project.maxAgentsPerRun).toBe(3)
    expect(childCtx(r).roles.find((x) => x.id === 'r-oa')!.spawnable).toEqual(['r-oa2'])
  })

  it('lets the child spawn nothing when the run has no agents left after it', async () => {
    const r = rig({ maxAgentsPerRun: 2 }, withHelper(), BRIDGED2)
    r.agents.set('cl-1', agentOf({ id: 'cl-1', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID }))
    void delegate(r, 'oa')
    await tick()
    const ctx = childCtx(r)
    expect(ctx.roles.map((x) => x.id)).toEqual(['r-oa'])
    expect(ctx.roles[0]).toMatchObject({ canSpawn: false, spawnable: [] })
  })

  it('hands the child the free slots of a capped role, and hides the role when none is free', async () => {
    const r = rig({}, withHelper(2), BRIDGED2)
    r.agents.set('h-1', agentOf({ id: 'h-1', roleId: 'r-oa2', roleSlug: 'oa2', parentId: ROOT_AGENT_ID }))
    void delegate(r, 'oa')
    await tick()
    expect(childCtx(r).roles.find((x) => x.id === 'r-oa2')!.maxConcurrent).toBe(1)

    const full = rig({}, withHelper(1), BRIDGED2)
    full.agents.set('h-1', agentOf({ id: 'h-1', roleId: 'r-oa2', roleSlug: 'oa2', parentId: ROOT_AGENT_ID }))
    void delegate(full, 'oa')
    await tick()
    const ctx = childCtx(full)
    expect(ctx.roles.map((x) => x.id)).toEqual(['r-oa'])
    expect(ctx.roles[0]).toMatchObject({ canSpawn: false, spawnable: [] })
  })

  it('leaves an uncapped run uncapped for the child', async () => {
    const r = rig({}, withHelper(), BRIDGED2)
    void delegate(r, 'oa')
    await tick()
    const ctx = childCtx(r)
    expect(ctx.project.maxAgentsPerRun).toBeUndefined()
    expect(ctx.roles.find((x) => x.id === 'r-oa2')!.maxConcurrent).toBeUndefined()
  })
})

describe('spawnAllowanceAfter', () => {
  it('counts the agent being started against the total and its own role, clamped at zero', async () => {
    const { spawnAllowanceAfter } = await import('./spawnCaps')
    const roles = [{ id: 'a', name: 'A', slug: 'a', maxConcurrent: 3 }, { id: 'b', name: 'B', slug: 'b' }]
    const agents = [{ id: ROOT_AGENT_ID, state: 'thinking' as const }, { id: 'x', state: 'thinking' as const, roleId: 'a' }, { id: 'y', state: 'done' as const, roleId: 'a' }]
    const out = spawnAllowanceAfter({ project: { maxAgentsPerRun: 4 }, roles, roleId: 'a', agents, pending: ['b'] })
    expect(out.agentsLeft).toBe(0) // 2 started + 1 pending + this one = 4
    expect([...out.roleLeft]).toEqual([['a', 1]]) // 3 - 1 live - this one
    expect(spawnAllowanceAfter({ project: {}, roles, roleId: 'b', agents }).agentsLeft).toBeUndefined()
  })
})
