import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, RunEvent } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { WorktreeIntegrator } from './integration'
import { fakeCtx, project, role } from './testHelpers'
import type { DelegationCompletion, DelegationGate, RuntimeContext, RuntimeSession } from './types'

// Required-delegation wiring of the Codex adapter (docs/design/delegation-enforcement.md 5.5), against a scripted app-server.

/** A scripted app-server: records requests, answers them, and lets the test push notifications and server requests. */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private exit_: ((code: number | null, error?: Error) => void)[] = []
  closed = false
  started = false
  private threadCount = 0
  private turnCount = 0
  threads: string[] = []
  overrides: Record<string, (params: any) => unknown> = {}
  readonly exited: Promise<void>
  private markExited!: () => void

  constructor(readonly options: CodexAppServerOptions) {
    this.exited = new Promise((r) => (this.markExited = r))
  }

  async start(): Promise<unknown> {
    this.started = true
    return {}
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    const override = this.overrides[method]
    if (override) return override(params) as T
    switch (method) {
      case 'thread/start': {
        const id = `th-${++this.threadCount}`
        this.threads.push(id)
        return { thread: { id }, model: 'gpt-test', cwd: (params as { cwd?: string })?.cwd } as T
      }
      case 'thread/resume':
        return { thread: { id: (params as { threadId: string }).threadId }, model: 'gpt-test' } as T
      case 'turn/start':
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
  onExit(h: (code: number | null, error?: Error) => void): () => void {
    this.exit_.push(h)
    return () => void this.exit_.splice(this.exit_.indexOf(h), 1)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.markExited()
  }

  // ---- test controls ----
  push(method: string, params: unknown): void {
    for (const h of [...this.notify_]) h(method, params)
  }
  ask(method: string, params: unknown): Promise<any> {
    return this.serverRequest_!(method, params) as Promise<any>
  }
  die(code = 1): void {
    for (const h of [...this.exit_]) h(code)
  }
  of(method: string): { method: string; params: any }[] {
    return this.requests.filter((r) => r.method === method)
  }
  turnStarts(threadId: string): any[] {
    return this.of('turn/start').filter((r) => r.params.threadId === threadId)
  }
}


const turnDone = (threadId: string, turnId: string, status = 'completed') => ({ threadId, turn: { id: turnId, status, items: [], error: null } })
const agentMessage = (threadId: string, id: string, body: string) => ({ threadId, turnId: 'x', item: { type: 'agentMessage', id, text: body, phase: 'final_answer' } })
const call = (s: FakeServer, threadId: string, callId: string, tool: string, args: unknown) => s.ask('item/tool/call', { threadId, turnId: 'tu-x', callId, namespace: null, tool, arguments: args })

/** The agent's final message, then its turn end. */
function finish(s: FakeServer, threadId: string, turnId: string, result: string): void {
  s.push('item/completed', agentMessage(threadId, `m-${turnId}`, result))
  s.push('turn/completed', turnDone(threadId, turnId))
}

type Completion = Partial<DelegationCompletion> & { action: DelegationCompletion['action'] }

describe('CodexAdapter delegation gate', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-deleg-')))
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  /** lead -> mgr (-> w1, w2); lead may also spawn w2 directly (the concurrency test). */
  const roles = [
    role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-mgr', 'r-w2'] }),
    role({ id: 'r-mgr', slug: 'mgr', canSpawn: true, spawnable: ['r-w1', 'r-w2'], reportsTo: 'r-lead' }),
    role({ id: 'r-w1', slug: 'w1', reportsTo: 'r-mgr' }),
    role({ id: 'r-w2', slug: 'w2', reportsTo: 'r-mgr' })
  ]

  function makeGate(script: (agentId: string, n: number) => Completion) {
    const spawns: { childId: string; parentId: string; roleId: string }[] = []
    const calls: Record<string, number> = {}
    const gate = {
      noteSpawn: vi.fn((childId: string, parentId: string, roleId: string) => void spawns.push({ childId, parentId, roleId })),
      completion: vi.fn((agentId: string, _opts?: { reportText: string; canCorrect: boolean; canWait: boolean }) => {
        calls[agentId] = (calls[agentId] ?? 0) + 1
        return script(agentId, calls[agentId]!)
      }),
      ended: vi.fn(),
      delivered: vi.fn(),
      receiptText: vi.fn((id: string) => `RECEIPT(${id})`),
      nativeStrike: vi.fn(() => 1)
    }
    return { gate: gate as unknown as DelegationGate & typeof gate, spawns }
  }

  async function start(gate: DelegationGate, over: Partial<RuntimeContext> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => { const s = new FakeServer(o); servers.push(s); return s } })
    const ctx = fakeCtx({ project: project({ path: dir, isolateWriters: false, roles }), roles, continuationDelayMs: 5, autoContinue: false, delegation: gate, ...over })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    return { s, ctx }
  }
  const idOf = (ctx: ReturnType<typeof fakeCtx>, handle: string) => ctx.events.find((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.handle === handle)!.agent.id
  const lastOf = (ctx: ReturnType<typeof fakeCtx>, id: string): AgentInstance => ctx.events.filter((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === id).at(-1)!.agent
  const sentTo = (s: FakeServer, threadId: string): string[] => [...s.turnStarts(threadId), ...s.of('turn/steer').filter((r) => r.params.threadId === threadId)].map((r) => JSON.stringify(r.params.input))
  /** lead spawns mgr (th-2); mgr spawns w1 (th-3). */
  async function tree(s: FakeServer) {
    expect((await call(s, 'th-1', 'c1', 'spawn_report', { role: 'mgr', brief: 'Run it' })).success).toBe(true)
    await vi.waitFor(() => expect(s.turnStarts('th-2')).toHaveLength(1))
    expect((await call(s, 'th-2', 'c2', 'spawn_report', { role: 'w1', brief: 'Part one' })).success).toBe(true)
    await vi.waitFor(() => expect(s.turnStarts('th-3')).toHaveLength(1))
  }

  it('registers each spawn with the gate (child, parent, role)', async () => {
    const { gate, spawns } = makeGate(() => ({ action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    expect(spawns).toEqual([
      { childId: idOf(ctx, 'mgr-1'), parentId: 'root', roleId: 'r-mgr' },
      { childId: idOf(ctx, 'w1-1'), parentId: idOf(ctx, 'mgr-1'), roleId: 'r-w1' }
    ])
  })

  it('wait: holds the report and parks the manager; a child hand-off wakes it, drops the held report and evaluates its next turn', async () => {
    const { gate } = makeGate((id, n) => (id.startsWith('cx') && n === 1 && gate.noteSpawn.mock.calls[0]?.[0] === id ? { action: 'wait', text: 'waiting' } : { action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    const mgr = idOf(ctx, 'mgr-1')
    const w1 = idOf(ctx, 'w1-1')
    finish(s, 'th-2', 'tu-2', 'mgr early report')
    expect(lastOf(ctx, mgr)).toMatchObject({ state: 'waiting', activity: 'Waiting for reports' })
    expect(sentTo(s, 'th-1').join()).not.toContain('mgr early report')
    expect(gate.delivered).not.toHaveBeenCalled()
    finish(s, 'th-3', 'tu-3', 'w1 report')
    await vi.waitFor(() => expect(sentTo(s, 'th-2').join()).toContain('w1 report'))
    expect(sentTo(s, 'th-2').join()).toContain(`RECEIPT(${w1})`)
    expect(lastOf(ctx, mgr).state).toBe('thinking')
    // Its next turn is evaluated again (call 2: allow) and the report reaches the lead with the receipt.
    finish(s, 'th-2', 'tu-4', 'mgr final')
    await vi.waitFor(() => expect(sentTo(s, 'th-1').join()).toContain('mgr final'))
    expect(sentTo(s, 'th-1').join()).not.toContain('mgr early report')
    expect(sentTo(s, 'th-1').join()).toContain(`RECEIPT(${mgr})`)
    expect(gate.completion.mock.calls.filter((c) => c[0] === mgr)).toHaveLength(2)
    await vi.waitFor(() => expect(gate.delivered).toHaveBeenCalledWith(mgr))
  })

  it('wait, then the last child is interrupted: the manager is evaluated again with its held report and corrected', async () => {
    const { gate } = makeGate((id, n) => {
      if (id === gate.noteSpawn.mock.calls[0]?.[0]) return n === 1 ? { action: 'wait', text: 'w' } : { action: 'correct', text: 'CORRECT NOW' }
      return { action: 'allow' }
    })
    const { s, ctx } = await start(gate)
    await tree(s)
    const mgr = idOf(ctx, 'mgr-1')
    const w1 = idOf(ctx, 'w1-1')
    finish(s, 'th-2', 'tu-2', 'held text')
    expect(lastOf(ctx, mgr).state).toBe('waiting')
    s.push('turn/completed', turnDone('th-3', 'tu-3', 'interrupted'))
    expect(gate.ended).toHaveBeenCalledWith(w1)
    await vi.waitFor(() => expect(sentTo(s, 'th-2').join()).toContain('CORRECT NOW'))
    expect(gate.completion.mock.calls.filter((c) => c[0] === mgr)[1]![1]).toMatchObject({ reportText: 'held text', canCorrect: true, canWait: true })
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === 'CORRECT NOW')).toBe(true)
    expect(sentTo(s, 'th-1').join()).not.toContain('held text')
  })

  it('correct: the text goes to the manager thread, nothing is delivered, the manager stays live', async () => {
    const { gate } = makeGate((id, n) => (id === gate.noteSpawn.mock.calls[0]?.[0] && n === 1 ? { action: 'correct', text: 'Please delegate' } : { action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    const mgr = idOf(ctx, 'mgr-1')
    finish(s, 'th-2', 'tu-2', 'too soon')
    await vi.waitFor(() => expect(sentTo(s, 'th-2').join()).toContain('Please delegate'))
    expect(lastOf(ctx, mgr).state).toBe('thinking')
    expect(sentTo(s, 'th-1').join()).not.toContain('too soon')
    expect(gate.delivered).not.toHaveBeenCalled()
  })

  it('allow: delivers receipt + report, and calls delivered only after the send resolves', async () => {
    const { gate } = makeGate(() => ({ action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    const mgr = idOf(ctx, 'mgr-1')
    let release!: () => void
    s.overrides['turn/steer'] = (p) => (p.threadId === 'th-1' ? new Promise((r) => (release = () => r({ turnId: p.expectedTurnId }))) : { turnId: p.expectedTurnId })
    finish(s, 'th-2', 'tu-2', 'all done')
    await vi.waitFor(() => expect(s.of('turn/steer').some((r) => r.params.threadId === 'th-1')).toBe(true))
    const msg = JSON.stringify(s.of('turn/steer').find((r) => r.params.threadId === 'th-1')!.params.input)
    expect(msg).toContain(`RECEIPT(${mgr})`)
    expect(msg).toContain('all done')
    expect(msg.indexOf('RECEIPT')).toBeLessThan(msg.indexOf('all done'))
    expect(gate.delivered).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(gate.delivered).toHaveBeenCalledWith(mgr))
  })

  it('a rejected root delivery is a warning and never calls delivered', async () => {
    const { gate } = makeGate(() => ({ action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    s.overrides['turn/steer'] = (p) => (p.threadId === 'th-1' ? Promise.reject(new Error('boom')) : { turnId: p.expectedTurnId })
    s.overrides['turn/start'] = (p) => (p.threadId === 'th-1' ? Promise.reject(new Error('boom')) : { turn: { id: 'tu-z' } })
    finish(s, 'th-2', 'tu-2', 'lost')
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('boom'))).toBe(true))
    expect(gate.delivered).not.toHaveBeenCalled()
    expect(lastOf(ctx, idOf(ctx, 'mgr-1')).state).toBe('done')
  })

  it('fail: holds the branch, shows Skipped required reports and delivers the failure line with the report', async () => {
    const hold = vi.spyOn(WorktreeIntegrator.prototype, 'holdFailed').mockResolvedValue()
    const done = vi.spyOn(WorktreeIntegrator.prototype, 'onSubagentFinished').mockResolvedValue()
    const { gate } = makeGate((id) => (id === gate.noteSpawn.mock.calls[0]?.[0] ? { action: 'fail', missing: 'w2 never spawned' } : { action: 'allow' }))
    gate.receiptText.mockImplementation((id: string) => `FAILED(${id}) w2 never spawned`)
    const { s, ctx } = await start(gate)
    await tree(s)
    const mgr = idOf(ctx, 'mgr-1')
    finish(s, 'th-2', 'tu-2', 'claims done')
    await vi.waitFor(() => expect(sentTo(s, 'th-1').join()).toContain('claims done'))
    expect(sentTo(s, 'th-1').join()).toContain(`FAILED(${mgr}) w2 never spawned`)
    expect(lastOf(ctx, mgr)).toMatchObject({ state: 'done', activity: 'Skipped required reports' })
    expect(hold).toHaveBeenCalledWith(mgr, 'w2 never spawned')
    expect(done).not.toHaveBeenCalledWith(mgr)
    await vi.waitFor(() => expect(gate.delivered).toHaveBeenCalledWith(mgr))
  })

  it('a waiting manager is parked: it does not count against the concurrency limit', async () => {
    const { gate } = makeGate((id, n) => (id === gate.noteSpawn.mock.calls[0]?.[0] && n === 1 ? { action: 'wait', text: 'w' } : { action: 'allow' }))
    const { s } = await start(gate, { project: project({ path: dir, isolateWriters: false, roles, maxConcurrentSubagents: 2 }) })
    await tree(s)
    // mgr + w1 fill the limit of 2.
    const full = await call(s, 'th-1', 'c3', 'spawn_report', { role: 'w2', brief: 'x' })
    expect(full.success).toBe(false)
    expect(full.contentItems[0].text).toContain('Concurrent subagent limit')
    finish(s, 'th-2', 'tu-2', 'early')
    const ok = await call(s, 'th-1', 'c4', 'spawn_report', { role: 'w2', brief: 'x' })
    expect(ok.success).toBe(true)
  })

  it('a first send that fails after registration ends the child at the gate', async () => {
    const { gate, spawns } = makeGate(() => ({ action: 'allow' }))
    const { s } = await start(gate)
    s.overrides['turn/start'] = (p) => {
      if (p.threadId === 'th-2') throw new Error('no turn')
      return { turn: { id: 'tu-n' } }
    }
    const out = await call(s, 'th-1', 'c1', 'spawn_report', { role: 'mgr', brief: 'Run it' })
    expect(out.success).toBe(false)
    expect(spawns).toHaveLength(1)
    expect(gate.ended).toHaveBeenCalledWith(spawns[0]!.childId)
  })

  it('an interrupted or failed child turn is ended at the gate before today\'s handling', async () => {
    const { gate } = makeGate(() => ({ action: 'allow' }))
    const { s, ctx } = await start(gate)
    await tree(s)
    s.push('turn/completed', turnDone('th-3', 'tu-3', 'interrupted'))
    expect(gate.ended).toHaveBeenCalledWith(idOf(ctx, 'w1-1'))
    expect(lastOf(ctx, idOf(ctx, 'w1-1'))).toMatchObject({ state: 'done', activity: 'Interrupted' })
  })

  it('counts a native multi-agent item at the gate', async () => {
    const { gate } = makeGate(() => ({ action: 'allow' }))
    const { s } = await start(gate)
    s.push('item/started', { threadId: 'th-1', turnId: 'x', item: { type: 'collabAgentToolCall', id: 'n1', tool: 'spawnAgent', status: 'inProgress' } })
    expect(gate.nativeStrike).toHaveBeenCalledWith('root')
  })

  it('nudge sends the root a harness message', async () => {
    const { gate } = makeGate(() => ({ action: 'allow' }))
    const { s } = await start(gate)
    await session!.nudge!('Harness: finish the delegation')
    expect(sentTo(s, 'th-1').join()).toContain('Harness: finish the delegation')
  })

  it('without a gate the child hands off as before', async () => {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => { const s = new FakeServer(o); servers.push(s); return s } })
    const ctx = fakeCtx({ project: project({ path: dir, isolateWriters: false, roles }), roles, autoContinue: false })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    await tree(s)
    finish(s, 'th-3', 'tu-3', 'plain')
    await vi.waitFor(() => expect(sentTo(s, 'th-2').join()).toContain('plain'))
    expect(sentTo(s, 'th-2').join()).not.toContain('RECEIPT')
  })
})
