import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, BridgedRoleChoice, Project, Role, RunEvent } from '@shared/types'
import { BRIDGE_RESULT_MAX_CHARS } from '@shared/types'
import { BRIDGE_POLL_MS, BridgedSessions, bridgeKey, connectionSecrets, cutResult, redactText } from './bridge'
import { ROOT_AGENT_ID, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type SessionSettlement } from './types'
import { fakeCtx, project as makeProject, role } from './testHelpers'

// ---------- fakes ----------

class FakeSession implements RuntimeSession {
  settlementValue: SessionSettlement | undefined = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }
  stop = vi.fn(async () => {
    this.end()
  })
  finished: Promise<void>
  private end!: () => void
  private fail!: (e: Error) => void
  constructor(public ctx: RuntimeContext) {
    this.finished = new Promise<void>((res, rej) => {
      this.end = res
      this.fail = rej
    })
  }
  send = vi.fn(async () => {})
  interrupt = vi.fn(async () => {})
  settlement = (): SessionSettlement => this.settlementValue as SessionSettlement
  crash(e: Error): void {
    this.fail(e)
  }
  status(status: 'running' | 'idle' | 'error' | 'finished' | 'paused', extra: { error?: string } = {}): void {
    this.ctx.emit({ type: 'run.status', runId: this.ctx.run.id, status, ...extra })
  }
  agent(over: Partial<AgentInstance> & { id: string }): void {
    this.ctx.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: agentOf(over) })
  }
  text(agentId: string, text: string): void {
    this.ctx.emit({ type: 'transcript', runId: this.ctx.run.id, entry: { id: `t-${Math.random()}`, agentId, at: 1, block: { kind: 'text', text } } })
  }
}

function agentOf(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return { roleId: null, roleSlug: 'x', name: 'x', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Working', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over }
}

class FakeAdapter implements RuntimeAdapter {
  sessions: FakeSession[] = []
  startError: Error | undefined
  /** When set, start() waits for it (a child still opening). */
  gate: Promise<void> | undefined
  /** Runs inside start(), before the session exists (events during start). */
  duringStart: ((ctx: RuntimeContext) => void) | undefined
  constructor(public id: 'claude' | 'codex' | 'mock') {}
  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    if (this.startError) throw this.startError
    if (this.gate) await this.gate
    this.duringStart?.(ctx)
    const s = new FakeSession(ctx)
    this.sessions.push(s)
    return s
  }
  async complete(): Promise<string> {
    return ''
  }
  get ctx(): RuntimeContext {
    return this.sessions[this.sessions.length - 1]!.ctx
  }
}

const OPENAI_CONN: RunConnection = { connection: 'openai', adapter: 'codex', apiKey: 'sk-openai-secret-999', env: { CODEX_HOME: '/data/codex', OPENAI_BASE_URL: 'https://api.openai.example/v1', OPENAI_TOKEN: 'tok-env-secret-123' } }
const ROOT_CONN: RunConnection = { connection: 'anthropic', adapter: 'claude', env: { ANTHROPIC_API_KEY: 'sk-root-secret-456' } }

function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-oa', 'r-eng', 'r-solo'] }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead' }),
    role({ id: 'r-oa', slug: 'oa', name: 'OpenAI lead', reportsTo: 'r-lead', canSpawn: true, spawnable: ['r-oa2', 'r-eng', 'r-solo'], connection: 'openai' }),
    role({ id: 'r-oa2', slug: 'oa2', name: 'OpenAI helper', reportsTo: 'r-oa', connection: 'openai' }),
    role({ id: 'r-solo', slug: 'solo', name: 'Solo', reportsTo: 'r-lead', connection: 'proxy-1' })
  ]
}

const BRIDGED: BridgedRoleChoice[] = [
  { roleId: 'r-oa', connection: 'openai', adapter: 'codex' },
  { roleId: 'r-oa2', connection: 'openai', adapter: 'codex' },
  { roleId: 'r-solo', connection: 'proxy-1', adapter: 'claude' }
]

interface Rig {
  b: BridgedSessions
  codex: FakeAdapter
  claude: FakeAdapter
  events: RunEvent[]
  parent: ReturnType<typeof fakeCtx>
  agents: Map<string, AgentInstance>
  logs: string[]
}

function rig(over: { project?: Partial<Project>; roles?: Role[]; parent?: Partial<RuntimeContext> } = {}): Rig {
  const roles = over.roles ?? chart()
  const p = makeProject({ roles, maxSubagentDepth: 3, maxConcurrentSubagents: 3, isolateWriters: true, ...over.project })
  const parent = fakeCtx({ project: p, roles, ...over.parent })
  const events: RunEvent[] = []
  const agents = new Map<string, AgentInstance>([[ROOT_AGENT_ID, agentOf({ id: ROOT_AGENT_ID, roleId: 'r-lead', roleSlug: 'lead', name: 'Lead' })]])
  const codex = new FakeAdapter('codex')
  const claude = new FakeAdapter('claude')
  const logs: string[] = []
  const b = new BridgedSessions({
    adapters: { codex, claude },
    parent: () => parent,
    bridged: BRIDGED,
    connections: new Map([
      [bridgeKey('openai', 'codex'), OPENAI_CONN],
      [bridgeKey('proxy-1', 'claude'), { connection: 'proxy-1', adapter: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'proxy-token-secret-1' } }]
    ]),
    extraConnections: [ROOT_CONN],
    emit: (e) => {
      events.push(e)
      if (e.type === 'agent.upsert') agents.set(e.agent.id, e.agent)
      if (e.type === 'agent.remove') agents.delete(e.agentId)
    },
    agents: () => [...agents.values()],
    connectionName: (id) => (id === 'openai' ? 'OpenAI' : id === 'proxy-1' ? 'Acme proxy' : 'Anthropic'),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
  })
  return { b, codex, claude, events, parent, agents, logs }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const upserts = (events: RunEvent[]): AgentInstance[] => events.flatMap((e) => (e.type === 'agent.upsert' ? [e.agent] : []))

afterEach(() => {
  vi.useRealTimers()
})

// ---------- tests ----------

describe('BridgedSessions.spawn', () => {
  it('shows the agent at once, calls onStarted synchronously and builds a clean child context', async () => {
    const r = rig()
    let started: { agentId: string; handle: string } | undefined
    const done = r.b.spawn({ role: 'oa', brief: 'Review the patch', description: 'Reviewing', toolUseId: 'tu-1', onStarted: (i) => (started = i) })
    // Synchronously: the first agent.upsert is out and onStarted ran, before the adapter started.
    expect(started).toBeDefined()
    const first = upserts(r.events)[0]!
    expect(first).toMatchObject({ id: started!.agentId, handle: 'oa-1', roleId: 'r-oa', roleSlug: 'oa', name: 'OpenAI lead', parentId: ROOT_AGENT_ID, spawnToolUseId: 'tu-1', connection: 'openai', activity: 'Reviewing' })
    expect(r.b.hasActive()).toBe(true)
    await tick()
    const ctx = r.codex.ctx
    expect(ctx.bridge).toBeUndefined()
    expect(ctx.listRuns).toBeUndefined()
    expect(ctx.messageRun).toBeUndefined()
    expect(ctx.listProjects).toBeUndefined()
    expect(ctx.quickSessionEdits).toBeUndefined()
    expect(ctx.onRootTurnEnded).toBeUndefined()
    expect(ctx.budgetUsd).toBeUndefined()
    expect(ctx.resumeSessionId).toBeUndefined()
    expect(ctx.connection).toBe(OPENAI_CONN)
    expect(ctx.project.isolateWriters).toBe(false)
    expect(ctx.autoContinue).toBe(false)
    expect(ctx.maxAutoContinues).toBe(0)
    expect(ctx.prompt).toBe('Review the patch')
    expect(ctx.run.id).toBe(r.parent.run.id)
    expect(ctx.bridgedChild).toEqual({ agentId: started!.agentId, parentAgentId: ROOT_AGENT_ID, roleId: 'r-oa' })
    // Roles: the bridged role as root plus its same-pair reachable helper; the native engineer and the other-pair solo are gone.
    expect(ctx.roles.map((x) => x.id).sort()).toEqual(['r-oa', 'r-oa2'])
    const oa = ctx.roles.find((x) => x.id === 'r-oa')!
    expect(oa.reportsTo).toBeNull()
    expect(oa.spawnable).toEqual(['r-oa2'])
    expect(ctx.project.roles).toBe(ctx.roles)
    // The parent's own roles are untouched copies.
    expect(r.parent.roles.find((x) => x.id === 'r-oa')!.spawnable).toEqual(['r-oa2', 'r-eng', 'r-solo'])
    expect(r.parent.project.isolateWriters).toBe(true)
    r.codex.sessions[0]!.status('idle')
    r.codex.sessions[0]!.text(ROOT_AGENT_ID, 'done')
    void done
  })

  it('remaps ids of the child root and its nested agents, handles included', async () => {
    const r = rig()
    const done = r.b.spawn({ role: 'oa', brief: 'go', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const s = r.codex.sessions[0]!
    const rootId = [...r.agents.keys()].find((k) => k !== ROOT_AGENT_ID)!
    s.agent({ id: ROOT_AGENT_ID, roleSlug: 'oa', name: 'whatever', handle: 'child-root', state: 'thinking', activity: 'Thinking', usage: undefined })
    s.agent({ id: 'sub1', parentId: ROOT_AGENT_ID, roleId: 'r-oa2', roleSlug: 'oa2', name: 'OpenAI helper 1', handle: 'oa2-1' })
    s.agent({ id: 'sub2', parentId: 'sub1', roleId: 'r-oa2', roleSlug: 'oa2', name: 'OpenAI helper 2', handle: 'oa2-2' })
    s.text('sub1', 'helper text')
    s.ctx.emit({ type: 'agent.partial', runId: s.ctx.run.id, agentId: 'sub2', text: 'partial' })
    s.ctx.emit({ type: 'agent.message', runId: s.ctx.run.id, from: 'sub2', to: 'sub1', toHandle: 'oa2-1', text: 'hi', at: 1 })
    s.ctx.emit({ type: 'agent.message', runId: s.ctx.run.id, from: 'sub1', to: null, toHandle: 'user', text: 'hello', at: 2 })
    s.ctx.emit({ type: 'skill.used', runId: s.ctx.run.id, agentId: 'sub1', skillId: 'sk', name: 'S', at: 1 })
    s.ctx.emit({ type: 'agent.remove', runId: s.ctx.run.id, agentId: 'sub2' })

    const root = r.agents.get(rootId)!
    expect(root).toMatchObject({ roleId: 'r-oa', roleSlug: 'oa', name: 'OpenAI lead', handle: 'oa-1', parentId: ROOT_AGENT_ID, connection: 'openai' })
    const sub1 = r.agents.get(`${rootId}:sub1`)!
    expect(sub1).toMatchObject({ parentId: rootId, handle: 'oa-1.oa2-1', connection: 'openai' })
    expect(r.agents.has(`${rootId}:sub2`)).toBe(false)
    const sub2 = upserts(r.events).find((a) => a.id === `${rootId}:sub2`)!
    expect(sub2.parentId).toBe(`${rootId}:sub1`)
    expect(sub2.handle).toBe('oa-1.oa2-2')
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'transcript', entry: expect.objectContaining({ agentId: `${rootId}:sub1` }) }))
    expect(r.events).toContainEqual({ type: 'agent.partial', runId: s.ctx.run.id, agentId: `${rootId}:sub2`, text: 'partial' })
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'agent.message', from: `${rootId}:sub2`, to: `${rootId}:sub1` }))
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'agent.message', from: `${rootId}:sub1`, to: null }))
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'skill.used', agentId: `${rootId}:sub1` }))
    expect(r.events).toContainEqual({ type: 'agent.remove', runId: s.ctx.run.id, agentId: `${rootId}:sub2` })
    s.text(ROOT_AGENT_ID, 'final')
    s.status('idle')
    expect((await done).ok).toBe(true)
  })

  it('nests a bridged child under a report that delegated and keeps handles unique across the run', async () => {
    const r = rig()
    r.agents.set('rep', agentOf({ id: 'rep', roleId: 'r-eng', roleSlug: 'engineer', name: 'Engineer', parentId: ROOT_AGENT_ID, handle: 'engineer-1', state: 'thinking' }))
    r.agents.set('x', agentOf({ id: 'x', roleSlug: 'oa', handle: 'oa-1', state: 'done' }))
    // engineer cannot delegate (canSpawn false).
    await expect(r.b.spawn({ role: 'oa', brief: 'b', parentAgentId: 'rep' })).rejects.toThrow('Role Engineer may not delegate to OpenAI lead.')
    // A requested name that is taken is replaced by a generated one.
    const p = r.b.spawn({ role: 'oa', brief: 'b', name: 'engineer-1' })
    expect(upserts(r.events)[0]!.handle).toBe('oa-2')
    // A free requested name is kept.
    const q = r.b.spawn({ role: 'oa2', brief: 'b', name: 'my-name', parentRoleId: 'r-oa' })
    expect(upserts(r.events)[1]!.handle).toBe('my-name')
    await r.b.stopAll('test')
    expect((await p).ok).toBe(false)
    expect((await q).ok).toBe(false)
  })

  it('refuses unknown or native roles, a caller that may not delegate, depth and concurrency', async () => {
    const r = rig()
    await expect(r.b.spawn({ role: 'engineer', brief: 'b' })).rejects.toThrow('engineer does not run on another connection.')
    await expect(r.b.spawn({ role: 'nope', brief: 'b' })).rejects.toThrow('does not run on another connection')
    // The caller role is the named one: oa2 cannot spawn anything.
    await expect(r.b.spawn({ role: 'oa', brief: 'b', parentRoleId: 'r-oa2' })).rejects.toThrow('Role OpenAI helper may not delegate to OpenAI lead.')
    // The lead may not spawn a role missing from its spawnable list.
    const roles = chart()
    roles[0]!.spawnable = ['r-eng']
    const r2 = rig({ roles })
    await expect(r2.b.spawn({ role: 'oa', brief: 'b' })).rejects.toThrow('Role Lead may not delegate to OpenAI lead.')
    // Depth: a report at depth 3 cannot delegate under maxDepth 3.
    const r3 = rig()
    const lead = r3.parent.roles.find((x) => x.id === 'r-lead')!
    lead.spawnable = ['r-oa']
    r3.agents.set('a1', agentOf({ id: 'a1', parentId: ROOT_AGENT_ID, state: 'done' }))
    r3.agents.set('a2', agentOf({ id: 'a2', parentId: 'a1', state: 'done' }))
    r3.agents.set('a3', agentOf({ id: 'a3', parentId: 'a2', roleId: 'r-lead', state: 'done' }))
    await expect(r3.b.spawn({ role: 'oa', brief: 'b', parentAgentId: 'a3', parentRoleId: 'r-lead' })).rejects.toThrow('nest reports 4 deep; the limit is 3')
    // Concurrency: three live non-root agents (native and bridged) fill the limit.
    const r4 = rig()
    for (const id of ['c1', 'c2', 'c3']) r4.agents.set(id, agentOf({ id, parentId: ROOT_AGENT_ID, state: 'thinking' }))
    await expect(r4.b.spawn({ role: 'oa', brief: 'b' })).rejects.toThrow('3 reports are already working; the limit is 3')
    r4.agents.get('c3')!.state = 'done'
    const ok = r4.b.spawn({ role: 'oa', brief: 'b' })
    await r4.b.stopAll('test')
    expect((await ok).ok).toBe(false)
  })

  it('completes on idle and quiescent with the root’s last text, and drops run-level events', async () => {
    const r = rig()
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    const s = r.codex.sessions[0]!
    const before = r.events.length
    s.ctx.emit({ type: 'run.title', runId: s.ctx.run.id, title: 't' })
    s.ctx.emit({ type: 'run.cost', runId: s.ctx.run.id, totalCostUsd: 3 })
    s.ctx.emit({ type: 'run.usage', runId: s.ctx.run.id, usage: {} as never })
    s.ctx.emit({ type: 'plan.updated', runId: s.ctx.run.id, plan: {} as never })
    s.ctx.emit({ type: 'staffing.updated', runId: s.ctx.run.id, staffing: { goal: 'cost', assignments: [] } })
    s.ctx.emit({ type: 'usage.status', runId: s.ctx.run.id, usage: {} as never })
    s.ctx.emit({ type: 'run.finalized', runId: s.ctx.run.id, outcome: 'completed', summary: {} as never })
    s.ctx.emit({ type: 'run.message', runId: s.ctx.run.id, direction: 'in', peerRunId: 'x', peerProjectId: 'x', peerProjectName: 'x', peerPrompt: '', text: '', at: 1 })
    s.status('running')
    expect(r.events.length).toBe(before)
    s.status('finished')
    // The 'finished' above ended an unfinished child with no text: a failure. Use a fresh one for the happy path.
    expect(await done).toMatchObject({ ok: false, text: 'Bridged report failed: the session ended without a report.' })

    const r2 = rig()
    const d2 = r2.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    const s2 = r2.codex.sessions[0]!
    s2.status('running')
    s2.text(ROOT_AGENT_ID, 'first thoughts')
    s2.text(ROOT_AGENT_ID, 'The final report')
    s2.status('idle')
    const res = await d2
    expect(res).toMatchObject({ ok: true, text: 'The final report', handle: 'oa-1' })
    expect(s2.stop).toHaveBeenCalled()
    expect(r2.b.hasActive()).toBe(false)
    // The child's root settles Finished and its final upsert is out.
    const root = r2.agents.get(res.agentId)!
    expect(root.activity).toBe('Finished')
    expect(root.state).toBe('done')
    // Events after completion are ignored.
    const n = r2.events.length
    s2.text(ROOT_AGENT_ID, 'late')
    expect(r2.events.length).toBe(n)
  })

  it('waits while the session is not quiescent and polls again', async () => {
    vi.useFakeTimers()
    const r = rig()
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await vi.advanceTimersByTimeAsync(0)
    const s = r.codex.sessions[0]!
    s.settlementValue = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: false }
    s.text(ROOT_AGENT_ID, 'report')
    s.status('idle')
    let settled = false
    void done.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 2)
    expect(settled).toBe(false)
    s.settlementValue = { ...s.settlementValue, quiescent: true }
    await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS)
    expect((await done).text).toBe('report')
    // A root that woke up again (running) before the check does not complete.
    const r2 = rig()
    const d2 = r2.b.spawn({ role: 'oa', brief: 'go' })
    await vi.advanceTimersByTimeAsync(0)
    const s2 = r2.codex.sessions[0]!
    s2.settlementValue = { rootTurnGen: 1, rootIdle: false, continuationSettled: true, nudgeTurn1Sent: false, quiescent: false }
    s2.status('idle')
    s2.status('running')
    s2.settlementValue = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }
    await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 2)
    expect(r2.b.hasActive()).toBe(true)
    s2.text(ROOT_AGENT_ID, 'later')
    s2.status('idle')
    expect((await d2).text).toBe('later')
  })

  it('completes when the session has no settlement view, and when idle arrives during start', async () => {
    const r = rig()
    r.codex.duringStart = (ctx) => {
      ctx.emit({ type: 'transcript', runId: ctx.run.id, entry: { id: 't', agentId: ROOT_AGENT_ID, at: 1, block: { kind: 'text', text: 'quick answer' } } })
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'idle' })
    }
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r.codex.sessions[0]!.settlement = undefined as never
    // idle came before the session existed: the check runs once start resolves (settlement() was present then).
    expect((await done).text).toBe('quick answer')
  })

  it('resolves ok:false (never rejects) when start throws, the child errors or its session crashes', async () => {
    const r = rig()
    r.codex.startError = new Error('spawn codex ENOENT')
    expect(await r.b.spawn({ role: 'oa', brief: 'go' })).toMatchObject({ ok: false, text: 'Bridged report failed: spawn codex ENOENT' })
    expect(r.b.hasActive()).toBe(false)
    expect(r.agents.get([...r.agents.keys()].find((k) => k !== ROOT_AGENT_ID)!)!.activity).toBe('Failed')

    const r2 = rig()
    const d2 = r2.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r2.codex.sessions[0]!.status('error', { error: 'boom' })
    expect(await d2).toMatchObject({ ok: false, text: 'Bridged report failed: boom' })

    const r3 = rig()
    const d3 = r3.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r3.codex.sessions[0]!.crash(new Error('process died'))
    expect(await d3).toMatchObject({ ok: false, text: 'Bridged report failed: process died' })

    const r4 = rig()
    const d4 = r4.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r4.codex.sessions[0]!.status('paused')
    expect((await d4).ok).toBe(false)
  })

  it('stopAll stops every child and resolves their spawns "Stopped: <reason>"', async () => {
    const r = rig()
    const a = r.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    const c = r.b.spawn({ role: 'solo', brief: 'two', parentAgentId: ROOT_AGENT_ID })
    await tick()
    expect(r.b.activeCount()).toBe(2)
    await r.b.stopAll('the run was stopped')
    expect(await a).toMatchObject({ ok: false, text: 'Stopped: the run was stopped', stopped: true })
    expect(await c).toMatchObject({ ok: false, text: 'Stopped: the run was stopped' })
    expect(r.codex.sessions[0]!.stop).toHaveBeenCalledTimes(1)
    expect(r.claude.sessions[0]!.stop).toHaveBeenCalledTimes(1)
    expect(r.b.hasActive()).toBe(false)
    const ids = [...r.agents.values()].filter((x) => x.id !== ROOT_AGENT_ID)
    expect(ids.every((x) => x.activity === 'Stopped')).toBe(true)
  })

  it('stops a child that was still opening when stopAll ran', async () => {
    const r = rig()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const orig = r.codex.start.bind(r.codex)
    r.codex.start = async (ctx) => {
      await gate
      return orig(ctx)
    }
    const d = r.b.spawn({ role: 'oa', brief: 'go' })
    await r.b.stopAll('quit')
    expect((await d).text).toBe('Stopped: quit')
    release()
    await tick()
    await tick()
    expect(r.codex.sessions[0]!.stop).toHaveBeenCalled()
  })

  it('redacts every connection secret from forwarded texts and results, but not routing values', async () => {
    const r = rig()
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    const s = r.codex.sessions[0]!
    s.ctx.emit({ type: 'log', runId: s.ctx.run.id, level: 'warn', message: 'auth failed with sk-openai-secret-999 and sk-root-secret-456 at /data/codex' })
    s.agent({ id: ROOT_AGENT_ID, lastText: 'key tok-env-secret-123', activity: 'using proxy-token-secret-1' })
    s.text(ROOT_AGENT_ID, 'token is tok-env-secret-123 ok')
    s.status('idle')
    const res = await done
    expect(res.text).toBe('token is [redacted] ok')
    const all = JSON.stringify(r.events)
    expect(all).not.toContain('sk-openai-secret-999')
    expect(all).not.toContain('sk-root-secret-456')
    expect(all).not.toContain('tok-env-secret-123')
    expect(all).toContain('/data/codex')
    expect(connectionSecrets([OPENAI_CONN])).toEqual(expect.arrayContaining(['sk-openai-secret-999', 'tok-env-secret-123']))
    expect(connectionSecrets([OPENAI_CONN])).not.toContain('/data/codex')
    expect(connectionSecrets([OPENAI_CONN])).not.toContain('https://api.openai.example/v1')
    expect(redactText('a sk-x-123456 b', ['sk-x-123456'])).toBe('a [redacted] b')
    // Failure texts are redacted too.
    const r2 = rig()
    const d2 = r2.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r2.codex.sessions[0]!.status('error', { error: 'bad key sk-openai-secret-999' })
    expect((await d2).text).toBe('Bridged report failed: bad key [redacted]')
  })

  it('cuts a long result to BRIDGE_RESULT_MAX_CHARS with a note', async () => {
    const r = rig()
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    r.codex.sessions[0]!.text(ROOT_AGENT_ID, 'x'.repeat(BRIDGE_RESULT_MAX_CHARS + 500))
    r.codex.sessions[0]!.status('idle')
    const res = await done
    expect(res.text.length).toBeLessThanOrEqual(BRIDGE_RESULT_MAX_CHARS)
    expect(res.text.endsWith('[cut]')).toBe(true)
    expect(cutResult('short')).toBe('short')
  })

  it('passes cards through to the parent with remapped agent ids and own-connection only', async () => {
    const r = rig({ parent: { allowedRules: () => ['Bash(npm test:*)'], skills: () => [] } })
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    const ctx = r.codex.ctx
    const rootId = [...r.agents.keys()].find((k) => k !== ROOT_AGENT_ID)!
    await ctx.requestPermission({ agentId: ROOT_AGENT_ID, toolName: 'Bash' } as never)
    await ctx.requestPermission({ agentId: 'sub9', toolName: 'Bash' } as never)
    await ctx.requestQuestion({ agentId: ROOT_AGENT_ID } as never)
    const reqs = (r.parent.requestPermission as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { agentId: string }).agentId)
    expect(reqs).toEqual([rootId, `${rootId}:sub9`])
    expect((r.parent.requestQuestion as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ agentId: rootId })
    await ctx.requestMcpInstall!({ agentId: 'sub9' } as never)
    expect((r.parent.requestMcpInstall as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ agentId: `${rootId}:sub9` })
    expect(ctx.allowedRules!()).toEqual(['Bash(npm test:*)'])
    expect(ctx.skills).toBeTypeOf('function')
    // Proposals, merge reviews and setup are refused; the plan is not shared.
    expect(await ctx.requestProposal({} as never)).toMatchObject({ behavior: 'decline' })
    expect(await ctx.requestMergeReview({} as never)).toEqual({ behavior: 'hold' })
    expect(r.parent.requestProposal).not.toHaveBeenCalled()
    expect(ctx.getPlan()).toBeUndefined()
    await ctx.updatePlan({} as never)
    expect(r.parent.updatePlan).not.toHaveBeenCalled()
    // Staffing mirrors the plan: the child has none and its updates never reach the parent run.
    expect(ctx.getStaffing()).toBeUndefined()
    await ctx.updateStaffing({ goal: 'speed', assignments: [] })
    expect(r.parent.updateStaffing).not.toHaveBeenCalled()
    expect(ctx.getStaffing()).toBeUndefined()
    ctx.rateLimited({ window: 'five_hour' })
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'log', level: 'warn', message: expect.stringContaining('usage limit') }))
    expect(r.parent.rateLimited).not.toHaveBeenCalled()
    // Knowledge callers are remapped too.
    r.codex.sessions[0]!.status('idle')
    await done
  })

  it('gives the child the parent run\'s staffing goal, and none when the parent has none', async () => {
    const r = rig({ parent: { staffingGoal: 'cost' } })
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    expect(r.codex.ctx.staffingGoal).toBe('cost')
    r.codex.sessions[0]!.status('idle')
    await done
    const plain = rig()
    const d2 = plain.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    expect('staffingGoal' in plain.codex.ctx).toBe(false)
    plain.codex.sessions[0]!.status('idle')
    await d2
  })

  it('maps knowledge and note callers to the remapped agent id', async () => {
    const upsertNode = vi.fn((_i: unknown, _c: unknown) => ({ ok: true }) as never)
    const save = vi.fn((_i: unknown, _c: unknown) => ({ id: "n" }) as never)
    const r = rig({
      parent: {
        knowledge: { graph: () => ({}) as never, upsertNode, link: vi.fn() as never, retire: vi.fn() as never },
        engagementNotes: { list: () => [], read: () => null, save },
        knowledgeRecall: vi.fn(() => 'recall') as never
      }
    })
    const done = r.b.spawn({ role: 'oa', brief: 'go' })
    await tick()
    const ctx = r.codex.ctx
    const rootId = [...r.agents.keys()].find((k) => k !== ROOT_AGENT_ID)!
    ctx.knowledge!.upsertNode({} as never, { agentId: ROOT_AGENT_ID, roleId: 'r-oa' })
    expect(upsertNode.mock.calls[0]![1]).toEqual({ agentId: rootId, roleId: 'r-oa' })
    ctx.engagementNotes!.save({ title: 't', text: 'x' }, { agentId: 'sub1' })
    expect(save.mock.calls[0]![1]).toEqual({ agentId: `${rootId}:sub1` })
    expect(ctx.knowledgeRecall!({} as never, {})).toBe('recall')
    r.codex.sessions[0]!.status('idle')
    await done
  })
})

describe('bridge review fixes', () => {
  it('M1: refuses an unknown caller while a live non-root agent may delegate', async () => {
    const r = rig()
    r.agents.set('lead2', agentOf({ id: 'lead2', roleId: 'r-oa', roleSlug: 'oa', name: 'OpenAI lead', parentId: ROOT_AGENT_ID, handle: 'oa-9', state: 'thinking' }))
    await expect(r.b.spawn({ role: 'oa2', brief: 'b' })).rejects.toThrow('OrgAI could not tell which agent called delegate_agent; call it again when your reports are done.')
    r.agents.set('lead2', agentOf({ id: 'lead2', roleId: 'r-oa', roleSlug: 'oa', name: 'OpenAI lead', parentId: ROOT_AGENT_ID, handle: 'oa-9', state: 'done' }))
    const p = r.b.spawn({ role: 'oa', brief: 'b' })
    await r.b.stopAll('test')
    expect((await p).ok).toBe(false)
  })

  it('M2: secrets by name, userinfo, bearer and header parts, minimum 8 characters', () => {
    const s = connectionSecrets([
      {
        connection: 'openai',
        adapter: 'codex',
        apiKey: 'plain-api-key',
        env: {
          MY_AUTH_TOKEN: 'a/b\\c-value-1',
          PROXY_URL: 'https://user:hunter2hunter@proxy.example/v1',
          X_HEADER: 'Bearer bearer-value-99',
          Y_HEADER: 'x-api-key: header-value-77',
          SHORT_TOKEN: 'abc',
          OPENAI_BASE_URL: 'https://api.example/v1'
        }
      }
    ])
    expect(s).toEqual(expect.arrayContaining(['plain-api-key', 'a/b\\c-value-1', 'hunter2hunter', 'user:hunter2hunter', 'bearer-value-99', 'header-value-77']))
    expect(s).not.toContain('abc')
    expect(s).not.toContain('https://api.example/v1')
    expect(s).not.toContain('https://user:hunter2hunter@proxy.example/v1')
    expect(connectionSecrets([{ connection: 'openai', adapter: 'codex', apiKey: 'short' }])).toEqual([])
  })

  it('M3: the child gets the depth and concurrency left, and no spawning at the last level', async () => {
    const r = rig({ project: { maxSubagentDepth: 2, maxConcurrentSubagents: 4 } })
    r.agents.set('w1', agentOf({ id: 'w1', roleId: 'r-eng', parentId: ROOT_AGENT_ID, state: 'thinking' }))
    const p = r.b.spawn({ role: 'oa', brief: 'b', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const ctx = r.codex.ctx
    expect(ctx.project.maxSubagentDepth).toBe(1)
    expect(ctx.project.maxConcurrentSubagents).toBe(2)
    expect(ctx.roles.find((x) => x.id === 'r-oa')!.spawnable).toEqual(['r-oa2'])
    await r.b.stopAll('t')
    await p

    const r2 = rig({ project: { maxSubagentDepth: 1, maxConcurrentSubagents: 1 } })
    const q = r2.b.spawn({ role: 'oa', brief: 'b', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const c2 = r2.codex.ctx
    expect(c2.roles.map((x) => x.id)).toEqual(['r-oa'])
    expect(c2.roles[0]).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(c2.project.maxSubagentDepth).toBe(1)
    expect(c2.project.maxConcurrentSubagents).toBe(1)
    await r2.b.stopAll('t')
    await q
  })

  it('L1: card display text is redacted, decision fields are not', async () => {
    const r = rig({ parent: { requestPermissionRules: vi.fn(async () => ({ behavior: 'deny' as const })), requestMcpInstall: vi.fn(async () => ({ approved: false })) } as unknown as Partial<RuntimeContext> })
    const p = r.b.spawn({ role: 'oa', brief: 'b', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const ctx = r.codex.ctx
    const key = 'sk-openai-secret-999'
    await ctx.requestPermission({ agentId: ROOT_AGENT_ID, toolName: 'Bash', input: { command: `echo ${key}` }, summary: `Run echo ${key}` })
    await ctx.requestQuestion({ agentId: ROOT_AGENT_ID, question: `Use ${key}?`, options: [{ label: 'yes', description: `with ${key}` }], allowMultiple: false, allowFreeText: false })
    await ctx.requestPermissionRules!({ agentId: ROOT_AGENT_ID, rules: ['Bash(npm test:*)'], reason: `because ${key}` })
    await ctx.requestMcpInstall!({ agentId: ROOT_AGENT_ID, reason: `needs ${key}` } as never)
    const perm = (r.parent.requestPermission as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(perm.summary).toBe('Run echo [redacted]')
    expect(perm.input).toEqual({ command: `echo ${key}` })
    const q = (r.parent.requestQuestion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(q.question).toBe('Use [redacted]?')
    expect(q.options[0]).toEqual({ label: 'yes', description: 'with [redacted]' })
    expect((r.parent.requestPermissionRules as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ rules: ['Bash(npm test:*)'], reason: 'because [redacted]' })
    expect((r.parent.requestMcpInstall as ReturnType<typeof vi.fn>).mock.calls[0]![0].reason).toBe('needs [redacted]')
    await r.b.stopAll('t')
    await p
  })

  it('L4: stopAll waits for a child still opening and stops the session it produced', async () => {
    const r = rig()
    let open!: () => void
    r.codex.gate = new Promise<void>((res) => {
      open = res
    })
    const p = r.b.spawn({ role: 'oa', brief: 'b', parentAgentId: ROOT_AGENT_ID })
    await tick()
    let stopped = false
    const all = r.b.stopAll('quit').then(() => {
      stopped = true
    })
    await tick()
    expect(stopped).toBe(false)
    open()
    await all
    expect(r.codex.sessions).toHaveLength(1)
    expect(r.codex.sessions[0]!.stop).toHaveBeenCalledTimes(1)
    expect((await p).ok).toBe(false)
  })

  it('L4: stopAll gives up on a child that never opens after 5 s', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.codex.gate = new Promise<void>(() => {})
    void r.b.spawn({ role: 'oa', brief: 'b', parentAgentId: ROOT_AGENT_ID })
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    const all = r.b.stopAll('quit').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(4900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await all
    expect(done).toBe(true)
  })
})

describe('BridgedSessions.liveWiderThan (permission mode narrowing)', () => {
  it('counts live children whose start mode is wider than the new mode, never finished ones', async () => {
    const parentGrant = vi.fn()
    const r = rig({ project: { permissionMode: 'acceptEdits' }, parent: { acceptEditsGranted: parentGrant } })
    const a = r.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    expect(r.codex.sessions[0]!.ctx.project.permissionMode).toBe('acceptEdits')
    expect(r.b.liveWiderThan('default')).toBe(1)
    expect(r.b.liveWiderThan('plan')).toBe(1)
    expect(r.b.liveWiderThan('acceptEdits')).toBe(0)
    expect(r.b.liveWiderThan('bypassPermissions')).toBe(0)
    await r.b.stopAll('done')
    await a
    expect(r.b.liveWiderThan('plan')).toBe(0)
  })

  it('counts a child whose own "accept edits" grant is wider than the new mode, and never forwards that grant to the parent', async () => {
    const parentGrant = vi.fn()
    const r = rig({ project: { permissionMode: 'default' }, parent: { acceptEditsGranted: parentGrant } })
    const a = r.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    expect(r.b.liveWiderThan('default')).toBe(0)
    r.codex.sessions[0]!.ctx.acceptEditsGranted!()
    expect(parentGrant).not.toHaveBeenCalled()
    expect(r.b.liveWiderThan('default')).toBe(1)
    expect(r.b.liveWiderThan('plan')).toBe(1)
    expect(r.b.liveWiderThan('acceptEdits')).toBe(0)
    await r.b.stopAll('done')
    await a
    expect(r.b.liveWiderThan('plan')).toBe(0)
  })
})

describe('BridgedSessions child project follows a parent narrowed to Plan / Don\'t ask (M3)', () => {
  const setParentMode = (r: Rig, mode: Project['permissionMode']): void => {
    r.parent.project = { ...r.parent.project, permissionMode: mode }
  }

  it('reads the parent\'s Plan or Don\'t ask on every check, never a wider mode than the child started in', async () => {
    const r = rig({ project: { permissionMode: 'default' } })
    const a = r.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const project = r.codex.sessions[0]!.ctx.project
    expect(project.permissionMode).toBe('default')
    setParentMode(r, 'plan')
    expect(project.permissionMode).toBe('plan')
    setParentMode(r, 'dontAsk')
    expect(project.permissionMode).toBe('dontAsk')
    // The parent widening again (or moving to a mode that is not Plan / Don't ask) never widens or changes the child.
    setParentMode(r, 'acceptEdits')
    expect(project.permissionMode).toBe('default')
    setParentMode(r, 'bypassPermissions')
    expect(project.permissionMode).toBe('default')
    // The copy an adapter makes reads the value at that moment; the other fields are intact.
    setParentMode(r, 'plan')
    expect({ ...project }.permissionMode).toBe('plan')
    expect(project.isolateWriters).toBe(false)
    // The native child session is unchanged, so it is still counted.
    expect(r.b.liveWiderThan('plan')).toBe(1)
    await r.b.stopAll('done')
    await a
  })

  it('does not move a child that started in Plan to Don\'t ask (they do not compare), and narrows an acceptEdits child', async () => {
    const plan = rig({ project: { permissionMode: 'plan' } })
    const p = plan.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    setParentMode(plan, 'dontAsk')
    expect(plan.codex.sessions[0]!.ctx.project.permissionMode).toBe('plan')
    await plan.b.stopAll('done')
    await p
    const edits = rig({ project: { permissionMode: 'acceptEdits' } })
    const e = edits.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    setParentMode(edits, 'dontAsk')
    expect(edits.codex.sessions[0]!.ctx.project.permissionMode).toBe('dontAsk')
    await edits.b.stopAll('done')
    await e
  })

  it('warns on the parent run when a child turns on accept edits while the parent is in Plan or Don\'t ask, and not otherwise', async () => {
    const parentGrant = vi.fn()
    const r = rig({ project: { permissionMode: 'default' }, parent: { acceptEditsGranted: parentGrant } })
    const a = r.b.spawn({ role: 'oa', brief: 'one', parentAgentId: ROOT_AGENT_ID })
    await tick()
    const warns = (): string[] => r.events.flatMap((e) => (e.type === 'log' && e.level === 'warn' && e.message.includes('Accept edits') ? [e.message] : []))
    r.codex.sessions[0]!.ctx.acceptEditsGranted!()
    expect(warns()).toEqual([])
    setParentMode(r, 'plan')
    r.codex.sessions[0]!.ctx.acceptEditsGranted!()
    expect(warns()).toHaveLength(1)
    expect(warns()[0]).toContain('Plan')
    expect(r.events.some((e) => e.type === 'log' && e.runId === r.parent.run.id && e.level === 'warn')).toBe(true)
    expect(parentGrant).not.toHaveBeenCalled()
    await r.b.stopAll('done')
    await a
  })
})
