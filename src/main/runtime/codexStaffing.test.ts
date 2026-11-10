import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeSpawnInput, BridgeSpawnResult, BridgedRole, RuntimeContext, RuntimeSession } from './types'
import type { Role } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { fakeCtx, project, role } from './testHelpers'

// Run staffing on the Codex adapter (orchestration-efficiency 4.3 "Mechanics"): spawn_report tier / effort, the thread's
// model and the effort every message to it carries, against a scripted app-server (no codex binary, no tokens).

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private threadCount = 0
  private turnCount = 0
  /** thread/start numbers (1-based, counting every start) that fail. */
  failStarts = new Set<number>()
  private startCount = 0
  /** turn/start numbers (1-based, counting every start) that fail. */
  failTurns = new Set<number>()
  private turnStartCount = 0
  readonly exited: Promise<void>
  private markExited!: () => void
  constructor(readonly options: CodexAppServerOptions) {
    this.exited = new Promise((r) => (this.markExited = r))
  }
  async start(): Promise<unknown> {
    return {}
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    switch (method) {
      case 'thread/start':
        if (this.failStarts.has(++this.startCount)) throw new Error('thread/start refused')
        return { thread: { id: `th-${++this.threadCount}` }, model: 'gpt-test', cwd: (params as { cwd?: string })?.cwd } as T
      case 'turn/start':
        if (this.failTurns.has(++this.turnStartCount)) throw new Error('turn/start refused')
        return { turn: { id: `tu-${++this.turnCount}` } } as T
      case 'turn/steer':
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId } as T
      default:
        return {} as T
    }
  }
  notify(): void {}
  onNotification(h: (m: string, p: unknown) => void): () => void {
    this.notify_.push(h)
    return () => void this.notify_.splice(this.notify_.indexOf(h), 1)
  }
  onServerRequest(h: (m: string, p: unknown) => Promise<unknown>): void {
    this.serverRequest_ = h
  }
  onExit(): () => void {
    return () => {}
  }
  close(): void {
    this.markExited()
  }
  push(method: string, params: unknown): void {
    for (const h of [...this.notify_]) h(method, params)
  }
  ask(method: string, params: unknown): Promise<any> {
    return this.serverRequest_!(method, params) as Promise<any>
  }
  of(method: string): { method: string; params: any }[] {
    return this.requests.filter((r) => r.method === method)
  }
  turnStarts(threadId: string): any[] {
    return this.of('turn/start').filter((r) => r.params.threadId === threadId)
  }
}

const TIER_MODELS = { top: 'gpt-top', deep: 'gpt-deep', everyday: 'gpt-everyday', fast: 'gpt-fast' }
const CONNECTION = { connection: 'chatgpt' as never, adapter: 'codex' as const, tierModels: TIER_MODELS }

/** Lead (root, deep) -> engineer (everyday, effort high), analyst2 (everyday, effort xhigh) and a bridged analyst. */
function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-x', 'r-ext'], model: 'deep', tier: 'deep', effort: 'high' }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read'], reportsTo: 'r-lead', model: 'everyday', tier: 'everyday', effort: 'high' }),
    role({ id: 'r-x', slug: 'xeng', name: 'Xeng', tools: ['Read'], reportsTo: 'r-lead', model: 'everyday', tier: 'everyday', effort: 'xhigh' }),
    role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: 'r-lead', model: 'claude-sonnet-4-5' })
  ]
}
const BRIDGED: BridgedRole = { roleId: 'r-ext', slug: 'analyst', name: 'Analyst', connection: 'anthropic', connectionName: 'Anthropic', adapter: 'claude' }

const call = (threadId: string, callId: string, tool: string, args: Record<string, unknown>) => ({ threadId, turnId: 'tu-1', callId, namespace: null, tool, arguments: args })
const turnDone = (threadId: string, turnId: string) => ({ threadId, turn: { id: turnId, status: 'completed', items: [], error: null } })
const turnFailed = (threadId: string, turnId: string) => ({ threadId, turn: { id: turnId, status: 'failed', items: [], error: { message: 'boom' } } })
const agentMessage = (threadId: string, id: string, body: string) => ({ threadId, turnId: 'x', item: { type: 'agentMessage', id, text: body, phase: 'final_answer' } })

describe('Codex run staffing', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-staffing-')))
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  async function start(over: Partial<RuntimeContext> = {}, projectOver: Partial<ReturnType<typeof project>> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => (servers.push(new FakeServer(o)), servers.at(-1)!) })
    const roles = chart()
    const ctx = fakeCtx({ project: project({ path: dir, roles, isolateWriters: false, ...projectOver }), roles, connection: CONNECTION, autoContinue: false, ...over })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    return { ctx, s }
  }
  const plan = (s: FakeServer, steps: unknown[]) => s.ask('item/tool/call', call('th-1', 'cp', 'set_plan', { goal: 'Ship', steps }))
  const spawn = (s: FakeServer, id: string, args: Record<string, unknown>) => s.ask('item/tool/call', call('th-1', id, 'spawn_report', { brief: 'Do it', ...args }))
  const efforts = (s: FakeServer, threadId: string) => s.turnStarts(threadId).map((r) => r.params.effort)

  it('applies a plan step\'s pick: the thread starts on the tier\'s model and every message carries the effort', async () => {
    const { ctx, s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    const out = await spawn(s, 'c1', { role: 'engineer' })
    expect(out.success).toBe(true)
    expect(out.contentItems[0].text).toContain('Spawned engineer-1 (engineer) on fast / low (chosen by the orchestrator)')
    expect(s.of('thread/start')[1]!.params.model).toBe('gpt-fast')
    expect(efforts(s, 'th-2')).toEqual(['low'])
    // A later message to the report still carries the effort.
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    await s.ask('item/tool/call', call('th-1', 'c2', 'message_agent', { to: 'engineer-1', message: 'More' }))
    await vi.waitFor(() => expect(s.turnStarts('th-2').length + s.of('turn/steer').length).toBeGreaterThan(1))
    expect(efforts(s, 'th-2').filter(Boolean).every((e) => e === 'low')).toBe(true)
    // The root is untouched.
    expect(s.of('thread/start')[0]!.params).not.toHaveProperty('model')
    expect(efforts(s, 'th-1')).toEqual(['high'])
    // The row carries the report's agent id and the step id.
    const childId = ctx.events.find((e) => e.type === 'agent.upsert' && e.agent.handle === 'engineer-1')!
    const row = ctx.getStaffing()!.assignments[0]!
    expect(row).toMatchObject({ roleId: 'r-eng', stepId: 'p1', tier: 'fast', effort: 'low', source: 'orchestrator' })
    expect(row.agentId).toBe((childId as { agent: { id: string } }).agent.id)
  })

  it('a value on the call wins over the plan step, field by field', async () => {
    const { s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'everyday', effort: 'low' } }])
    const out = await spawn(s, 'c1', { role: 'engineer', tier: 'fast', effort: 'medium' })
    expect(out.contentItems[0].text).toContain('fast / medium (chosen by the orchestrator)')
    expect(s.of('thread/start')[1]!.params.model).toBe('gpt-fast')
    expect(efforts(s, 'th-2')).toEqual(['medium'])
  })

  it('clamps a request above the role\'s ceiling and says so; the thread runs as the chart has it', async () => {
    const { s } = await start()
    const out = await spawn(s, 'c1', { role: 'engineer', tier: 'top', effort: 'max' })
    const text = out.contentItems[0].text as string
    expect(text).toMatch(/everyday \/ high \(.*top/)
    expect(s.of('thread/start')[1]!.params.model).toBe('gpt-test')
    expect(efforts(s, 'th-2')).toEqual(['high'])
  })

  it('maps an effort Codex cannot send (xhigh) down to the nearest it can', async () => {
    const { s } = await start()
    const out = await spawn(s, 'c1', { role: 'xeng', effort: 'xhigh' })
    expect(out.success).toBe(true)
    expect(efforts(s, 'th-2')).toEqual(['high'])
    expect(out.contentItems[0].text).toContain('everyday / high')
  })

  it('Project.staffing fixed changes nothing: the model and the effort sent are the chart\'s', async () => {
    const { ctx, s } = await start({}, { staffing: 'fixed' })
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    await spawn(s, 'c1', { role: 'engineer', tier: 'fast', effort: 'low' })
    // Today: a tier-named role sends no model of its own (the thread takes its parent's, 'gpt-test'), and the role's own effort goes on the first message only.
    expect(s.of('thread/start')[1]!.params.model).toBe('gpt-test')
    expect(efforts(s, 'th-2')).toEqual(['high'])
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    await s.ask('item/tool/call', call('th-1', 'c2', 'message_agent', { to: 'engineer-1', message: 'More' }))
    await vi.waitFor(() => expect(s.turnStarts('th-2').length + s.of('turn/steer').length).toBeGreaterThan(1))
    expect(efforts(s, 'th-2').slice(1).every((e) => e === undefined)).toBe(true)
    // The same for a role with an effort Codex cannot send: nothing is sent, as today.
    await spawn(s, 'c3', { role: 'xeng', effort: 'low' })
    expect(efforts(s, 'th-3')).toEqual([undefined])
    void ctx
  })

  it('a spawn whose result does not override behaves exactly as today (the parent\'s model, the role\'s effort on the first message only)', async () => {
    const { s } = await start()
    await spawn(s, 'c1', { role: 'engineer' })
    expect(s.of('thread/start')[1]!.params.model).toBe('gpt-test')
    expect(efforts(s, 'th-2')).toEqual(['high'])
  })

  it('a bridged role keeps its chart tier and effort: tier and effort on the call are ignored and the result says so', async () => {
    const spawnBridge = vi.fn((input: BridgeSpawnInput) => new Promise<BridgeSpawnResult>(() => input.onStarted?.({ agentId: 'b1', handle: 'analyst-1' })))
    const { ctx, s } = await start({ bridge: { roles: () => [BRIDGED], spawn: spawnBridge } })
    const out = await spawn(s, 'c1', { role: 'analyst', tier: 'top', effort: 'max' })
    expect(out.success).toBe(true)
    expect(out.contentItems[0].text).toContain('ignored')
    expect(spawnBridge.mock.calls[0]![0]).not.toHaveProperty('tier')
    expect(ctx.updateStaffing).not.toHaveBeenCalled()
  })

  it('cancels the decision when the thread fails to start, so the step is still unattempted', async () => {
    const { ctx, s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    s.failStarts.add(2)
    const failed = await spawn(s, 'c1', { role: 'engineer' })
    expect(failed.success).toBe(false)
    expect(ctx.updateStaffing).not.toHaveBeenCalled()
    const out = await spawn(s, 'c2', { role: 'engineer' })
    expect(out.success).toBe(true)
    expect(ctx.getStaffing()!.assignments).toHaveLength(1)
    expect(ctx.getStaffing()!.assignments[0]).toMatchObject({ stepId: 'p1', source: 'orchestrator', tier: 'fast', effort: 'low' })
  })

  it('leaves no row and no attempt when the first message to the new thread is refused', async () => {
    const { ctx, s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    s.failTurns.add(2) // the root's turn is 1; the report's first message is 2
    const failed = await spawn(s, 'c1', { role: 'engineer' })
    expect(failed.success).toBe(false)
    expect(failed.contentItems[0].text).toContain('Could not start')
    expect(ctx.updateStaffing).not.toHaveBeenCalled()
    expect(ctx.getStaffing()?.assignments ?? []).toHaveLength(0)
    // The next spawn is a first attempt of the same step, not a retry.
    const out = await spawn(s, 'c2', { role: 'engineer' })
    expect(out.success).toBe(true)
    const rows = ctx.getStaffing()!.assignments
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ stepId: 'p1', source: 'orchestrator', tier: 'fast', effort: 'low' })
  })

  it('a second spawn after a report that finished without failure is a plain attempt, not an escalation', async () => {
    const { ctx, s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    await spawn(s, 'c1', { role: 'engineer' })
    s.push('item/completed', agentMessage('th-2', 'm1', 'Done'))
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.handle === 'engineer-1' && e.agent.state === 'done')).toBe(true))
    await spawn(s, 'c2', { role: 'engineer' })
    const rows = ctx.getStaffing()!.assignments
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ stepId: 'p1', source: 'orchestrator', tier: 'fast', effort: 'low' })
  })

  it('tells the orchestrator when a pick on the call is ignored because the project is fixed', async () => {
    const { s } = await start({}, { staffing: 'fixed' })
    const out = await spawn(s, 'c1', { role: 'engineer', tier: 'fast' })
    expect(out.success).toBe(true)
    expect(out.contentItems[0].text).toContain('the tier you gave was ignored')
    const none = await spawn(s, 'c2', { role: 'engineer' })
    expect(none.contentItems[0].text).not.toContain('ignored')
  })

  it('a second spawn for a step whose first report failed goes one step up', async () => {
    const { ctx, s } = await start()
    await plan(s, [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'low' } }])
    await spawn(s, 'c1', { role: 'engineer' })
    s.push('item/completed', agentMessage('th-2', 'm1', 'Could not finish'))
    s.push('turn/completed', turnFailed('th-2', 'tu-2'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.handle === 'engineer-1' && e.agent.state === 'error')).toBe(true))
    const out = await spawn(s, 'c2', { role: 'engineer' })
    expect(out.success).toBe(true)
    const rows = ctx.getStaffing()!.assignments
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ stepId: 'p1', source: 'escalated' })
    expect(rows[1]!.tier !== 'fast' || rows[1]!.effort !== 'low').toBe(true)
  })
})

describe('codexRootTier', () => {
  it('reads the chart tier until the root switches models, then the tier the new model maps to', async () => {
    const { codexRootTier } = await import('./codex')
    const map = { deep: 'gpt-6-sol', everyday: 'gpt-6-terra', fast: 'gpt-6-luna' }
    expect(codexRootTier({ model: 'gpt-6-sol', tier: 'deep' }, undefined, map)).toBe('deep')
    expect(codexRootTier({ model: 'everyday' }, undefined, map)).toBe('everyday')
    expect(codexRootTier({ model: 'gpt-6-sol', tier: 'deep' }, 'gpt-6-luna', map)).toBe('fast')
    expect(codexRootTier({ model: 'gpt-6-sol', tier: 'deep' }, 'fast', map)).toBe('fast')
    // A model nothing describes: unknown, never the stale chart tier.
    expect(codexRootTier({ model: 'gpt-6-sol', tier: 'deep' }, 'some-other-model', map)).toBeUndefined()
    expect(codexRootTier({ model: 'gpt-6-sol', tier: 'deep' }, '  ', map)).toBe('deep')
  })
})
