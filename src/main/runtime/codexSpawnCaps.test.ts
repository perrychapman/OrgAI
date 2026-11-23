import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BRIEF_MAX_CHARS, type AgentInstance, type RunEvent } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { fakeCtx, project, role } from './testHelpers'
import type { RuntimeContext, RuntimeSession } from './types'

// UI overhaul on Codex against a scripted app-server (same shape as codexDelegation.test.ts): the spawn caps
// (Role.maxConcurrent, Project.maxAgentsPerRun) at spawn_report, AgentInstance.brief and RuntimeSession.stopAgent through
// turn/interrupt of the report's thread. No tokens.

class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private exit_: ((code: number | null, error?: Error) => void)[] = []
  closed = false
  private threadCount = 0
  private turnCount = 0
  overrides: Record<string, (params: any) => unknown> = {}
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
    const override = this.overrides[method]
    if (override) return override(params) as T
    switch (method) {
      case 'thread/start':
        return { thread: { id: `th-${++this.threadCount}` }, model: 'gpt-test', cwd: (params as { cwd?: string })?.cwd } as T
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

const turnDone = (threadId: string, turnId: string, status = 'completed') => ({ threadId, turn: { id: turnId, status, items: [], error: null } })
const call = (s: FakeServer, threadId: string, callId: string, tool: string, args: unknown) => s.ask('item/tool/call', { threadId, turnId: 'tu-x', callId, namespace: null, tool, arguments: args })

describe('CodexAdapter: spawn caps, brief and stopAgent', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-caps-')))
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  const chart = (eng: Record<string, unknown> = {}) => [
    role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-eng', 'r-help'] }),
    role({ id: 'r-eng', slug: 'engineer', canSpawn: true, spawnable: ['r-help'], reportsTo: 'r-lead', ...eng }),
    role({ id: 'r-help', slug: 'helper', reportsTo: 'r-lead' })
  ]

  async function start(roles = chart(), projectOver: Record<string, unknown> = {}, over: Partial<RuntimeContext> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => { const s = new FakeServer(o); servers.push(s); return s } })
    const ctx = fakeCtx({ project: project({ path: dir, isolateWriters: false, roles, maxConcurrentSubagents: 8, ...projectOver }), roles, continuationDelayMs: 5, autoContinue: false, ...over })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    return { s, ctx }
  }
  const idOf = (ctx: ReturnType<typeof fakeCtx>, handle: string) => ctx.events.find((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.handle === handle)!.agent.id
  const lastOf = (ctx: ReturnType<typeof fakeCtx>, id: string): AgentInstance => ctx.events.filter((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === id).at(-1)!.agent
  const sentTo = (s: FakeServer, threadId: string): string[] => [...s.turnStarts(threadId), ...s.of('turn/steer').filter((r) => r.params.threadId === threadId)].map((r) => JSON.stringify(r.params.input))
  const spawnEng = (s: FakeServer, id: string, role = 'engineer', from = 'th-1') => call(s, from, id, 'spawn_report', { role, brief: `Brief for ${id}` })

  it('a role cap refuses the N+1th live spawn of the role and allows after one ended', async () => {
    const { s } = await start(chart({ maxConcurrent: 2 }))
    expect((await spawnEng(s, 'c1')).success).toBe(true)
    expect((await spawnEng(s, 'c2')).success).toBe(true)
    const refused = await spawnEng(s, 'c3')
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0].text).toContain('Concurrent limit for engineer reached (2 running at once)')
    // Another role is not affected.
    expect((await spawnEng(s, 'c4', 'helper')).success).toBe(true)
    // th-2 (the first engineer) reports: a slot frees.
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    expect((await spawnEng(s, 'c5')).success).toBe(true)
    expect((await spawnEng(s, 'c6')).success).toBe(false)
  })

  it('the run total refuses the N+1th agent even after earlier ones ended', async () => {
    const { s } = await start(chart(), { maxAgentsPerRun: 2 })
    expect((await spawnEng(s, 'c1')).success).toBe(true)
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    expect((await spawnEng(s, 'c2', 'helper')).success).toBe(true)
    s.push('turn/completed', turnDone('th-3', 'tu-3'))
    const refused = await spawnEng(s, 'c3')
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0].text).toContain('Agent limit reached (this run may start 2 agents in total and 2 have started)')
    // The refused spawn started no thread.
    expect(s.of('thread/start')).toHaveLength(3)
  })

  it('both caps are read live from ctx', async () => {
    const { s, ctx } = await start(chart({ maxConcurrent: 1 }), { maxAgentsPerRun: 1 })
    expect((await spawnEng(s, 'c1')).success).toBe(true)
    expect((await spawnEng(s, 'c2', 'helper')).contentItems[0].text).toContain('Agent limit reached')
    ctx.project = { ...ctx.project, maxAgentsPerRun: 5 }
    expect((await spawnEng(s, 'c3', 'helper')).success).toBe(true)
    expect((await spawnEng(s, 'c4')).contentItems[0].text).toContain('Concurrent limit for engineer')
    ctx.roles.find((r) => r.id === 'r-eng')!.maxConcurrent = 2
    expect((await spawnEng(s, 'c5')).success).toBe(true)
  })

  it('counts the run\'s bridged agents (ctx.spawnCapAgents, read live) toward the total and a role cap', async () => {
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = [
      { id: 'ag_b', state: 'thinking', roleId: 'r-oa' },
      { id: 'ag_b:h1', state: 'thinking', roleId: 'r-eng' }
    ]
    const { s } = await start(chart({ maxConcurrent: 2 }), { maxAgentsPerRun: 3 }, { spawnCapAgents: () => bridged })
    // Two of the three agents belong to a bridged child: one native spawn fits, the next does not (any role).
    expect((await spawnEng(s, 'c1')).success).toBe(true)
    const refused = await spawnEng(s, 'c2', 'helper')
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0].text).toContain('Agent limit reached (this run may start 3 agents in total and 3 have started)')
    expect(s.of('thread/start')).toHaveLength(2)
    // The accessor is live: an agent leaving the bridged list frees the total.
    bridged.pop()
    expect((await spawnEng(s, 'c3', 'helper')).success).toBe(true)
  })

  it('a bridged agent that is also a member (an adopted report) counts once', async () => {
    // The member of a bridged spawn_report carries the bridged agent's id; the accessor lists the same agent.
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = []
    const { s, ctx } = await start(chart(), { maxAgentsPerRun: 2 }, { spawnCapAgents: () => bridged })
    expect((await spawnEng(s, 'c1')).success).toBe(true)
    const own = idOf(ctx, 'engineer-1')
    bridged.push({ id: own, state: 'thinking', roleId: 'r-eng' })
    expect((await spawnEng(s, 'c2', 'helper')).success).toBe(true)
    expect((await spawnEng(s, 'c3', 'helper')).success).toBe(false)
  })

  it('no caps set: unchanged behaviour', async () => {
    const { s } = await start()
    for (let i = 0; i < 4; i++) expect((await spawnEng(s, `c${i}`)).success).toBe(true)
  })

  it('AgentInstance.brief is the spawn_report brief, cut to AGENT_BRIEF_MAX_CHARS; the root has none', async () => {
    const { s, ctx } = await start()
    expect((await call(s, 'th-1', 'c1', 'spawn_report', { role: 'engineer', brief: 'Build the parser.' })).success).toBe(true)
    expect(lastOf(ctx, idOf(ctx, 'engineer-1')).brief).toBe('Build the parser.')
    const long = 'y'.repeat(AGENT_BRIEF_MAX_CHARS + 200)
    expect((await call(s, 'th-1', 'c2', 'spawn_report', { role: 'helper', brief: long })).success).toBe(true)
    expect(lastOf(ctx, idOf(ctx, 'helper-1')).brief).toHaveLength(AGENT_BRIEF_MAX_CHARS)
    expect(lastOf(ctx, 'root').brief).toBeUndefined()
  })

  it('stopAgent: never the root, false for an unknown agent', async () => {
    const { s } = await start()
    expect(await session!.stopAgent!('root')).toBe(false)
    expect(await session!.stopAgent!('nope')).toBe(false)
    expect(s.of('turn/interrupt')).toHaveLength(0)
  })

  it('stopAgent interrupts the report\'s turn; its interrupted end reads "Stopped by you" and the parent is told', async () => {
    const { s, ctx } = await start()
    await spawnEng(s, 'c1')
    await spawnEng(s, 'c2', 'helper')
    const eng = idOf(ctx, 'engineer-1')
    expect(await session!.stopAgent!(eng)).toBe(true)
    expect(s.of('turn/interrupt')).toEqual([{ method: 'turn/interrupt', params: { threadId: 'th-2', turnId: 'tu-2' } }])
    // The app-server completes the turn as interrupted.
    s.push('turn/completed', turnDone('th-2', 'tu-2', 'interrupted'))
    expect(lastOf(ctx, eng)).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    await vi.waitFor(() => expect(sentTo(s, 'th-1').join()).toContain('was stopped by the user before it finished'))
    // The other report keeps running; a second stop of the ended one is false.
    expect(lastOf(ctx, idOf(ctx, 'helper-1')).state).not.toBe('done')
    expect(await session!.stopAgent!(eng)).toBe(false)
    expect(s.of('turn/interrupt')).toHaveLength(1)
  })

  it('stopAgent also interrupts the reports under it, deepest first, and tells only the stopped report\'s parent', async () => {
    const { s, ctx } = await start()
    await spawnEng(s, 'c1')
    await call(s, 'th-2', 'c2', 'spawn_report', { role: 'helper', brief: 'Part' })
    await vi.waitFor(() => expect(s.turnStarts('th-3')).toHaveLength(1))
    const eng = idOf(ctx, 'engineer-1')
    const help = idOf(ctx, 'helper-1')
    expect(await session!.stopAgent!(eng)).toBe(true)
    expect(s.of('turn/interrupt').map((r) => r.params.threadId)).toEqual(['th-3', 'th-2'])
    s.push('turn/completed', turnDone('th-3', 'tu-3', 'interrupted'))
    s.push('turn/completed', turnDone('th-2', 'tu-2', 'interrupted'))
    expect(lastOf(ctx, help)).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    expect(lastOf(ctx, eng)).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    await vi.waitFor(() => expect(sentTo(s, 'th-1').join()).toContain('was stopped by the user'))
    // The helper's lead (the stopped engineer) is not messaged.
    expect(sentTo(s, 'th-2').join()).not.toContain('was stopped by the user')
  })

  it('stopAgent is false when the app-server refuses the interrupt; the report keeps running', async () => {
    const { s, ctx } = await start()
    await spawnEng(s, 'c1')
    s.overrides['turn/interrupt'] = () => {
      throw new Error('no such turn')
    }
    const eng = idOf(ctx, 'engineer-1')
    expect(await session!.stopAgent!(eng)).toBe(false)
    expect(lastOf(ctx, eng).state).not.toBe('done')
    // A later ordinary end of that turn is not mislabelled as a stop.
    s.push('turn/completed', turnDone('th-2', 'tu-2', 'interrupted'))
    expect(lastOf(ctx, eng).activity).toBe('Interrupted')
  })
})
