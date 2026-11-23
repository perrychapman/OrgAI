import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, BridgedRoleChoice, Project, Role, RunEvent } from '@shared/types'
import { BridgedSessions, bridgeKey } from './bridge'
import { ROOT_AGENT_ID, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { spawnCapRefusal } from './spawnCaps'
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
  // RunManager provides the run's accessor from its BridgedSessions the same way.
  parent.spawnCapAgents = () => b.spawnCapAgents()
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

describe('a bridged child holds the whole run\'s caps, read live (security review L3, then the live count)', () => {
  // r-oa can delegate to a helper on the same connection, so the child has a role it may spawn.
  const withHelper = (helperCap?: number): Role[] => [
    ...chart().map((x) => (x.id === 'r-oa' ? { ...x, canSpawn: true, spawnable: ['r-oa2'] } : x)),
    role({ id: 'r-oa2', slug: 'oa2', name: 'OpenAI helper', reportsTo: 'r-oa', connection: 'openai', ...(helperCap ? { maxConcurrent: helperCap } : {}) })
  ]
  const BRIDGED2: BridgedRoleChoice[] = [...BRIDGED, { roleId: 'r-oa2', connection: 'openai', adapter: 'codex' }]
  const childCtx = (r: ReturnType<typeof rig>): RuntimeContext => r.codex.sessions.at(-1)!.ctx

  it('hands the child the whole Project.maxAgentsPerRun, read live from the run, not a snapshot of what was left', async () => {
    const r = rig({ maxAgentsPerRun: 5 }, withHelper(), BRIDGED2)
    r.agents.set('cl-1', agentOf({ id: 'cl-1', roleId: 'r-eng', roleSlug: 'engineer', parentId: ROOT_AGENT_ID, state: 'done' }))
    void delegate(r, 'oa')
    await tick()
    expect(childCtx(r).project.maxAgentsPerRun).toBe(5)
    expect(childCtx(r).roles.find((x) => x.id === 'r-oa')!.spawnable).toEqual(['r-oa2'])
    // The user lowers (or removes) the cap mid-run: the child's next spawn reads it.
    r.parent.project.maxAgentsPerRun = 2
    expect(childCtx(r).project.maxAgentsPerRun).toBe(2)
    r.parent.project.maxAgentsPerRun = undefined
    expect(childCtx(r).project.maxAgentsPerRun).toBeUndefined()
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

  it('keeps a capped role\'s own cap for the child (the live count, not a snapshot of free slots, does the holding)', async () => {
    const r = rig({}, withHelper(2), BRIDGED2)
    r.agents.set('h-1', agentOf({ id: 'h-1', roleId: 'r-oa2', roleSlug: 'oa2', parentId: ROOT_AGENT_ID }))
    void delegate(r, 'oa')
    await tick()
    const ctx = childCtx(r)
    expect(ctx.roles.find((x) => x.id === 'r-oa2')!.maxConcurrent).toBe(2)
    // The native helper is live, so one slot is taken: the child sees it through spawnCapAgents.
    expect(spawnCapRefusal({ project: ctx.project, roles: ctx.roles, roleId: 'r-oa2', agents: [], extraAgents: ctx.spawnCapAgents!() })).toBeUndefined()
    r.agents.set('h-2', agentOf({ id: 'h-2', roleId: 'r-oa2', roleSlug: 'oa2', parentId: ROOT_AGENT_ID }))
    expect(spawnCapRefusal({ project: ctx.project, roles: ctx.roles, roleId: 'r-oa2', agents: [], extraAgents: ctx.spawnCapAgents!() })).toMatch(/Concurrent limit for oa2 reached \(2 running at once\)/)
    // A native helper ends: the slot is free again (a start-time snapshot of "0 left" would have hidden the role for good).
    r.agents.set('h-2', agentOf({ id: 'h-2', roleId: 'r-oa2', roleSlug: 'oa2', parentId: ROOT_AGENT_ID, state: 'done' }))
    expect(spawnCapRefusal({ project: ctx.project, roles: ctx.roles, roleId: 'r-oa2', agents: [], extraAgents: ctx.spawnCapAgents!() })).toBeUndefined()
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

describe('maxAgentsPerRun and Role.maxConcurrent hold across native and bridged spawns, in every order', () => {
  const helperChart = (cap?: number): Role[] => [
    ...chart().map((x) => (x.id === 'r-oa' ? { ...x, canSpawn: true, spawnable: ['r-oa2'] } : x)),
    role({ id: 'r-oa2', slug: 'oa2', name: 'OpenAI helper', reportsTo: 'r-oa', connection: 'openai', ...(cap ? { maxConcurrent: cap } : {}) })
  ]
  const BRIDGED2: BridgedRoleChoice[] = [...BRIDGED, { roleId: 'r-oa2', connection: 'openai', adapter: 'codex' }]
  type Rig = ReturnType<typeof rig>

  let seq = 0
  /** A native spawn by the root session, as an adapter does it: the cap check with the accessor, then it registers the agent. */
  function nativeSpawn(r: Rig, roleId: string, natives: AgentInstance[], state: AgentInstance['state'] = 'thinking'): string | undefined {
    const refusal = spawnCapRefusal({ project: r.parent.project, roles: r.parent.roles, roleId, agents: natives, extraAgents: r.parent.spawnCapAgents!() })
    if (refusal) return refusal
    const a = agentOf({ id: `nat-${++seq}`, roleId, roleSlug: 'x', parentId: ROOT_AGENT_ID, state })
    natives.push(a)
    r.agents.set(a.id, a)
    return undefined
  }
  /** A spawn inside a bridged child, as the child's adapter does it: its own agents, plus what the run says is outside it. */
  function childSpawn(r: Rig, index: number, roleId: string, own: AgentInstance[]): string | undefined {
    const ctx = r.codex.sessions[index]!.ctx
    const refusal = spawnCapRefusal({ project: ctx.project, roles: ctx.roles, roleId, agents: own, extraAgents: ctx.spawnCapAgents!() })
    if (refusal) return refusal
    const a = agentOf({ id: `own-${++seq}`, roleId, roleSlug: 'oa2', parentId: ROOT_AGENT_ID })
    own.push(a)
    ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: a })
    return undefined
  }
  const LIMIT = /Agent limit reached \(this run may start 3 agents in total and 3 have started\)/

  it('bridged first, then native: the third agent is the last (the root and the child count as the run does)', async () => {
    const r = rig({ maxAgentsPerRun: 3 }, helperChart(), BRIDGED2)
    const natives: AgentInstance[] = []
    const own: AgentInstance[] = []
    void delegate(r, 'oa') // 1
    await tick()
    expect(childSpawn(r, 0, 'r-oa2', own)).toBeUndefined() // 2
    expect(nativeSpawn(r, 'r-eng', natives)).toBeUndefined() // 3
    expect(nativeSpawn(r, 'r-eng', natives)).toMatch(LIMIT) // 4: refused
    expect(childSpawn(r, 0, 'r-oa2', own)).toMatch(LIMIT)
    await expect(delegate(r, 'solo')).rejects.toThrow(LIMIT)
  })

  it('native first, then bridged: the child is told the run is full, not what was left when it started', async () => {
    const r = rig({ maxAgentsPerRun: 3 }, helperChart(), BRIDGED2)
    const natives: AgentInstance[] = []
    const own: AgentInstance[] = []
    expect(nativeSpawn(r, 'r-eng', natives)).toBeUndefined() // 1
    void delegate(r, 'oa') // 2
    await tick()
    // A second native agent after the child started: 3. The child's own spawn would be the 4th.
    expect(nativeSpawn(r, 'r-eng', natives)).toBeUndefined()
    expect(childSpawn(r, 0, 'r-oa2', own)).toMatch(LIMIT)
    expect(own).toHaveLength(0)
    await expect(delegate(r, 'solo')).rejects.toThrow(LIMIT)
  })

  it('two bridged children racing under the cap: the check and the registration are one step, so exactly the allowed ones start', async () => {
    const r = rig({ maxAgentsPerRun: 3 }, helperChart(), BRIDGED2)
    const natives: AgentInstance[] = []
    expect(nativeSpawn(r, 'r-eng', natives)).toBeUndefined() // 1
    // Nothing awaited between the calls, and the run's record shows none of them until the manager catches up.
    const root = r.agents.get(ROOT_AGENT_ID)!
    const native = natives[0]!
    ;(r.b as unknown as { deps: { agents: () => AgentInstance[] } }).deps.agents = () => [root, native]
    const outcomes = [delegate(r, 'oa'), delegate(r, 'solo'), delegate(r, 'oa')].map((p) =>
      p.then(
        () => 'resolved',
        (e: Error) => e.message
      )
    )
    await tick()
    expect(r.codex.sessions.length + r.claude.sessions.length).toBe(2)
    expect(await Promise.race([outcomes[2]!, tick().then(() => 'pending')])).toMatch(LIMIT)
    // The child's accessor shows the other child's root and the native agent even though the record does not list the other child.
    const seen = r.codex.sessions[0]!.ctx.spawnCapAgents!().map((a) => a.id)
    expect(seen).toContain('run:' + native.id)
    expect(seen).toHaveLength(3)
  })

  it('a capped role cannot pass maxConcurrent across native and bridged spawns', async () => {
    const r = rig({}, helperChart(2), BRIDGED2)
    const natives: AgentInstance[] = []
    const own: AgentInstance[] = []
    void delegate(r, 'oa')
    await tick()
    expect(nativeSpawn(r, 'r-oa2', natives)).toBeUndefined() // one live oa2
    expect(childSpawn(r, 0, 'r-oa2', own)).toBeUndefined() // two live
    expect(nativeSpawn(r, 'r-oa2', natives)).toMatch(/Concurrent limit for oa2 reached \(2 running at once\)/)
    expect(childSpawn(r, 0, 'r-oa2', own)).toMatch(/Concurrent limit for oa2/)
    // A native one ends: a slot is free for the child (and then for nobody else).
    natives[0]!.state = 'done'
    expect(childSpawn(r, 0, 'r-oa2', own)).toBeUndefined()
    expect(nativeSpawn(r, 'r-oa2', natives)).toMatch(/Concurrent limit for oa2/)
  })

  it('lowering the cap mid-run applies to the next spawn on either side', async () => {
    const r = rig({ maxAgentsPerRun: 6 }, helperChart(), BRIDGED2)
    const natives: AgentInstance[] = []
    const own: AgentInstance[] = []
    void delegate(r, 'oa')
    await tick()
    expect(childSpawn(r, 0, 'r-oa2', own)).toBeUndefined()
    r.parent.project.maxAgentsPerRun = 2
    expect(childSpawn(r, 0, 'r-oa2', own)).toMatch(/Agent limit reached \(this run may start 2 agents in total and 2 have started\)/)
    expect(nativeSpawn(r, 'r-eng', natives)).toMatch(/Agent limit reached/)
  })

  it('spawnCapAgents: the run session sees every child agent, a child sees the run outside itself and never its own descendants', async () => {
    const r = rig({}, helperChart(), BRIDGED2)
    const own: AgentInstance[] = []
    const natives: AgentInstance[] = []
    expect(nativeSpawn(r, 'r-eng', natives)).toBeUndefined()
    void delegate(r, 'oa')
    void delegate(r, 'solo')
    await tick()
    expect(childSpawn(r, 0, 'r-oa2', own)).toBeUndefined()
    const idOfRoot = (i: number): string => r.parent.spawnCapAgents!().map((a) => a.id).filter((id) => !id.includes(':'))[i]!
    // The run session: both child roots and the child's helper (remapped), no native agent, no run root.
    const runSide = r.parent.spawnCapAgents!().map((a) => a.id)
    expect(runSide).toHaveLength(3)
    expect(runSide.some((id) => id === natives[0]!.id)).toBe(false)
    expect(runSide).toContain(`${idOfRoot(0)}:${own[0]!.id}`)
    // The first child: the native agent (prefixed), the other child's root and its own root; not its own helper.
    const childSide = r.codex.sessions[0]!.ctx.spawnCapAgents!().map((a) => a.id)
    expect(childSide).toHaveLength(3)
    expect(childSide).toContain(`run:${natives[0]!.id}`)
    expect(childSide).toContain(idOfRoot(0))
    expect(childSide).toContain(idOfRoot(1))
    expect(childSide.some((id) => id.includes(own[0]!.id))).toBe(false)
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
