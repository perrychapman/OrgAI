import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgChartProposalPayload, Proposal, ProposalOutcome, Role, RunEvent } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { applyRosterChange } from './runRoster'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import type { RuntimeContext, RuntimeSession } from './types'
import { fakeCtx, orgChart, project, role } from './testHelpers'

/**
 * An approved org chart in the same run on the Codex adapter (ConfigChange.roles, RuntimeSession.liveRoster), against a
 * scripted app-server (no codex binary, no tokens). RunManager's part (ctx.roles rewritten in place, removed roles in
 * ctx.retiredRoles()) is played with the real applyRosterChange.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private threadCount = 0
  private turnCount = 0
  closed = false
  readonly exited: Promise<void>
  private markExited!: () => void
  constructor(
    readonly options: CodexAppServerOptions,
    private counters: { threads: number; turns: number; onRequest?: (method: string, params: any) => Promise<void> | void }
  ) {
    this.exited = new Promise((r) => (this.markExited = r))
  }
  async start(): Promise<unknown> {
    return {}
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    await this.counters.onRequest?.(method, params)
    switch (method) {
      case 'thread/start':
        return { thread: { id: `th-${++this.counters.threads}` }, model: 'gpt-test', cwd: (params as { cwd?: string })?.cwd } as T
      case 'thread/resume':
        return { thread: { id: (params as { threadId: string }).threadId }, model: 'gpt-test' } as T
      case 'turn/start':
        return { turn: { id: `tu-${++this.counters.turns}` } } as T
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

const turnDone = (threadId: string, turnId: string) => ({ threadId, turn: { id: turnId, status: 'completed', items: [], error: null } })

let dir = ''
let session: RuntimeSession | undefined

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-roster-')))
})
afterEach(async () => {
  await session?.stop()
  session = undefined
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

type Rig = { ctx: RuntimeContext & { events: RunEvent[] }; servers: FakeServer[]; retired: Role[] }

/** A team work run on a copy of the chart, with RunManager's org-change apply available as `apply`. */
async function start(
  over: Partial<RuntimeContext> = {},
  onRequest?: (method: string, params: any) => Promise<void> | void
): Promise<Rig & { apply: (next: Role[]) => NonNullable<ConfigChange['roles']> }> {
  const servers: FakeServer[] = []
  const counters = { threads: 0, turns: 0, onRequest }
  const adapter = new CodexAdapter({
    createServer: (options) => {
      const s = new FakeServer(options, counters)
      servers.push(s)
      return s
    }
  })
  const retired: Role[] = []
  const p = project({ path: dir, isolateWriters: false })
  const ctx = fakeCtx({ project: p, continuationDelayMs: 5, autoContinue: false, resolvedMcpServers: async () => [], ...over })
  ctx.roles = structuredClone(p.roles)
  ctx.retiredRoles = () => retired
  session = await adapter.start(ctx)
  await vi.waitFor(() => expect(servers[0]?.turnStarts('th-1')).toHaveLength(1))
  const apply = (next: Role[]): NonNullable<ConfigChange['roles']> => {
    const out = applyRosterChange({ running: ctx.roles, saved: next, proposed: next })
    retired.push(...out.retired)
    ctx.project = { ...ctx.project, roles: structuredClone(next) }
    return { added: out.change.added, changed: out.change.changed, removed: out.change.removed }
  }
  return { ctx, servers, retired, apply }
}

const configChanged = (change: ConfigChange): Promise<ConfigChangeResult> => (session as any).configChanged(change)
const spawn = (s: FakeServer, role: string, callId = `c-${role}`, threadId = 'th-1') =>
  s.ask('item/tool/call', { threadId, turnId: 'tu-1', callId, namespace: null, tool: 'spawn_report', arguments: { role, brief: `Work for ${role}` } })

/** The chart with QA added under the root and the root allowed to spawn it. */
function withQa(): Role[] {
  const next = orgChart()
  next[0] = { ...next[0], spawnable: [...next[0].spawnable, 'r-qa'] }
  return [...next, role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead', tools: ['Read', 'Grep'] })]
}

describe('Codex live roster (configChanged roles)', () => {
  it('declares liveRoster', async () => {
    await start()
    expect(session!.liveRoster).toBe(true)
  })

  it('add: spawn_report takes the new role at once; the root is resumed with instructions listing it after idle, then told', async () => {
    const { ctx, servers, apply } = await start()
    const s1 = servers[0]
    const before = s1.of('thread/start')[0].params.developerInstructions as string
    expect(before).not.toContain('qa')
    const roles = apply(withQa())
    expect(roles).toEqual({ added: ['r-qa'], changed: ['r-lead'], removed: [] })
    // The root's instructions list its reports, so they are behind: not a false 'now'.
    expect(await configChanged({ roles })).toEqual({ availability: 'after-idle' })
    // The spawn gate already reads ctx.roles.
    const out = await spawn(s1, 'qa')
    expect(out).toMatchObject({ success: true })
    expect(out.contentItems[0].text).toContain('Spawned qa-1 (qa)')
    const qaStart = s1.of('thread/start')[1].params
    expect(qaStart.developerInstructions).toContain('You are qa.')
    expect(servers).toHaveLength(1) // turns are running
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    s1.push('turn/completed', turnDone('th-2', 'tu-2'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    const s2 = servers[1]
    await vi.waitFor(() => expect(s2.of('thread/resume').map((r) => r.params.threadId).sort()).toEqual(['th-1', 'th-2']))
    const rootResume = s2.of('thread/resume').find((r) => r.params.threadId === 'th-1')!.params
    expect(rootResume.developerInstructions).toContain('qa')
    expect(rootResume.developerInstructions).not.toBe(before)
    // One harness message once it is in place (the report's result may also arrive; find ours).
    await vi.waitFor(() => expect(s2.turnStarts('th-1').some((t) => String(t.params.input[0].text).includes('org chart change is in place'))).toBe(true))
    const msg = s2.turnStarts('th-1').map((t) => String(t.params.input[0].text)).find((t) => t.includes('org chart change is in place'))!
    expect(msg).toContain('You can delegate to QA')
    expect(ctx.events.some((e) => e.type === 'log' && e.message.includes("orchestrator's instructions are updated when the agents are idle"))).toBe(true)
  })

  it("change of a report's prompt only: 'now', no restart, and the next thread of that role starts on the new prompt", async () => {
    const { servers, apply } = await start()
    const s1 = servers[0]
    const next = orgChart()
    next[1] = { ...next[1], prompt: 'You are the new engineer.' }
    const roles = apply(next)
    expect(roles).toEqual({ added: [], changed: ['r-eng'], removed: [] })
    expect(await configChanged({ roles })).toEqual({ availability: 'now' })
    await spawn(s1, 'engineer')
    expect(s1.of('thread/start')[1].params.developerInstructions).toContain('You are the new engineer.')
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    s1.push('turn/completed', turnDone('th-2', 'tu-2'))
    await new Promise((r) => setTimeout(r, 40))
    expect(servers).toHaveLength(1)
  })

  it('remove: a new agent of the removed role is refused at once; a running one finishes on its start-time definition, also through a restart', async () => {
    const { ctx, servers, retired, apply } = await start()
    const s1 = servers[0]
    expect(await spawn(s1, 'reviewer')).toMatchObject({ success: true })
    const revStart = s1.of('thread/start')[1].params.developerInstructions as string
    const revId = ctx.events.find((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.handle === 'reviewer-1')!.agent.id
    const next = orgChart().filter((r) => r.id !== 'r-rev')
    next[0] = { ...next[0], spawnable: ['r-eng'] }
    const roles = apply(next)
    expect(roles).toEqual({ added: [], changed: ['r-lead'], removed: ['r-rev'] })
    expect(retired.map((r) => r.id)).toEqual(['r-rev'])
    expect(await configChanged({ roles })).toEqual({ availability: 'after-idle' })
    const refused = await spawn(s1, 'reviewer', 'c-rev-2')
    expect(refused).toMatchObject({ success: false })
    expect(refused.contentItems[0].text).toContain('does not let lead spawn "reviewer"')
    // The running reviewer is untouched: still live, and resumed after the restart with the instructions it started on.
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    s1.push('turn/completed', turnDone('th-2', 'tu-2'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    await vi.waitFor(() => expect(servers[1].of('thread/resume')).toHaveLength(2))
    const revResume = servers[1].of('thread/resume').find((r) => r.params.threadId === 'th-2')!.params
    expect(revResume.developerInstructions).toBe(revStart)
    const root = servers[1].of('thread/resume').find((r) => r.params.threadId === 'th-1')!.params
    expect(root.developerInstructions).not.toContain('reviewer')
    const last = ctx.events.flatMap((e) => (e.type === 'agent.upsert' && e.agent.id === revId ? [e.agent] : [])).at(-1)
    expect(last).toMatchObject({ name: 'Reviewer', roleSlug: 'reviewer' })
    expect(last?.state).not.toBe('error')
  })

  it('a running report of a changed role keeps its start-time instructions and model through the restart', async () => {
    const { servers, apply } = await start()
    const s1 = servers[0]
    await spawn(s1, 'engineer')
    const engStart = s1.of('thread/start')[1].params
    const next = orgChart()
    next[0] = { ...next[0], prompt: 'You are the lead, version two.' }
    next[1] = { ...next[1], prompt: 'Engineer, version two.', model: 'gpt-other' }
    const roles = apply(next)
    expect(roles.changed.sort()).toEqual(['r-eng', 'r-lead'])
    expect(await configChanged({ roles })).toEqual({ availability: 'after-idle' })
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    s1.push('turn/completed', turnDone('th-2', 'tu-2'))
    await vi.waitFor(() => expect(servers[1]?.of('thread/resume')).toHaveLength(2))
    const resumes = servers[1].of('thread/resume')
    const eng = resumes.find((r) => r.params.threadId === 'th-2')!.params
    expect(eng.developerInstructions).toBe(engStart.developerInstructions)
    expect(eng.developerInstructions).not.toContain('version two')
    // Not the changed role's new model (a resume carries no parent model, as before this change).
    expect(eng.model).not.toBe('gpt-other')
    expect(engStart.model).not.toBe('gpt-other')
    // The root (root change): its new prompt.
    expect(resumes.find((r) => r.params.threadId === 'th-1')!.params.developerInstructions).toContain('You are the lead, version two.')
    // A new engineer starts on the new definition.
    await vi.waitFor(() => expect(servers[1].turnStarts('th-1').length).toBeGreaterThan(0))
    await spawn(servers[1], 'engineer', 'c-eng-2')
    const fresh = servers[1].of('thread/start').at(-1)!.params
    expect(fresh.developerInstructions).toContain('Engineer, version two.')
    expect(fresh.model).toBe('gpt-other')
  })

  it("a change of the root's own tools (it can no longer spawn) is rejected: Codex cannot change a running thread's tools", async () => {
    const { apply } = await start()
    const next = orgChart()
    next[0] = { ...next[0], canSpawn: false, spawnable: [] }
    const roles = apply(next)
    await expect(configChanged({ roles })).rejects.toThrow(/orchestrator's own tools/)
  })

  it('coalesces with a pending MCP change: one restart, one message naming both', async () => {
    const mcp: any[] = []
    const { servers, apply } = await start({ resolvedMcpServers: async () => mcp, mcpServers: () => mcp.map((m) => m.spec) })
    const s1 = servers[0]
    mcp.push({ spec: { id: 'f', name: 'fresh', transport: 'stdio', command: 'fresh-cmd', enabled: true, source: 'user', addedAt: '' }, env: {}, headers: {} })
    expect(await configChanged({ mcp: { upserted: ['fresh'], removed: [] } })).toEqual({ availability: 'after-idle' })
    expect(await configChanged({ roles: apply(withQa()) })).toEqual({ availability: 'after-idle' })
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    const s2 = servers[1]
    expect(s2.options.config).toContain('mcp_servers.fresh.command="fresh-cmd"')
    expect(s2.of('thread/resume')[0].params.developerInstructions).toContain('qa')
    await vi.waitFor(() => expect(s2.turnStarts('th-1')).toHaveLength(1))
    const text = String(s2.turnStarts('th-1')[0].params.input[0].text)
    expect(text).toContain('mcp__fresh__')
    expect(text).toContain('org chart change is in place')
    await new Promise((r) => setTimeout(r, 40))
    expect(servers).toHaveLength(2)
  })

  it('a roster change during an in-flight restart is not lost: the root ends up resumed with it', async () => {
    const mcp: any[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const { servers, apply } = await start({
      resolvedMcpServers: async () => {
        calls += 1
        if (calls === 2) await gate // the MCP restart's read waits; the roster change lands meanwhile
        return mcp
      },
      mcpServers: () => []
    })
    const s1 = servers[0]
    expect(await configChanged({ mcp: { upserted: [], removed: ['old'] } })).toEqual({ availability: 'after-idle' })
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(calls).toBe(2))
    const roles = apply(withQa())
    expect(await configChanged({ roles })).toEqual({ availability: 'after-idle' })
    release()
    await vi.waitFor(() => expect(servers.length).toBeGreaterThanOrEqual(2))
    // The in-flight restart resumed the root from the live roster (it already had QA), so the roster part is in place:
    // its message arrives, and the root's last instructions list QA.
    const all = () => servers.slice(1).flatMap((s) => s.turnStarts('th-1').map((t) => String(t.params.input[0].text)))
    await vi.waitFor(() => expect(all().some((t) => t.includes('org chart change is in place'))).toBe(true))
    const lastResume = servers.at(-1)!.of('thread/resume').find((r) => r.params.threadId === 'th-1')!.params
    expect(lastResume.developerInstructions).toContain('qa')
  })

  it('a roster change that lands after the restart resumed the root restarts again once idle and is told then', async () => {
    const mcp: any[] = []
    let late: (() => Promise<void>) | undefined
    const rig = await start({ resolvedMcpServers: async () => mcp, mcpServers: () => [] }, async (method, params) => {
      // While the restart resumes the root (its params already built), the org change is approved.
      if (method === 'thread/resume' && params.threadId === 'th-1' && late) {
        const run = late
        late = undefined
        await run()
      }
    })
    const { servers, apply } = rig
    expect(await configChanged({ mcp: { upserted: [], removed: ['old'] } })).toEqual({ availability: 'after-idle' })
    let answer: ConfigChangeResult | undefined
    late = async () => {
      answer = await configChanged({ roles: apply(withQa()) })
    }
    servers[0].push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    expect(answer).toEqual({ availability: 'after-idle' })
    // The MCP message went out; the roster is still behind (the root was resumed without QA).
    await vi.waitFor(() => expect(servers[1].turnStarts('th-1')).toHaveLength(1))
    expect(servers[1].of('thread/resume')[0].params.developerInstructions).not.toContain('qa')
    expect(String(servers[1].turnStarts('th-1')[0].params.input[0].text)).not.toContain('org chart change is in place')
    // That message's turn ends: the pending roster change restarts once more and the root is told.
    servers[1].push('turn/completed', turnDone('th-1', 'tu-2'))
    await vi.waitFor(() => expect(servers).toHaveLength(3))
    expect(servers[2].of('thread/resume')[0].params.developerInstructions).toContain('qa')
    await vi.waitFor(() => expect(servers[2].turnStarts('th-1')).toHaveLength(1))
    expect(String(servers[2].turnStarts('th-1')[0].params.input[0].text)).toContain('You can delegate to QA')
  })

  it('through the real tool: propose_org_change approved says it takes effect after idle on Codex', async () => {
    let apply!: (next: Role[]) => NonNullable<ConfigChange['roles']>
    const rig = await start({
      requestProposal: vi.fn(async (req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>): Promise<ProposalOutcome> => {
        const roles = apply((req.payload as OrgChartProposalPayload).roles)
        return { behavior: 'approve', roster: { ...roles, deferred: [] } }
      })
    })
    apply = rig.apply
    const drafts = [
      { slug: 'lead', name: 'Lead', description: 'lead description', responsibilities: [], prompt: 'You are lead.', tools: ['Read'], canSpawn: true, spawnable: ['engineer', 'reviewer', 'QA'], reportsTo: null },
      { slug: 'engineer', name: 'Engineer', description: 'engineer description', responsibilities: [], prompt: 'You are engineer.', tools: ['Read', 'Edit', 'Write'], canSpawn: false, spawnable: [], reportsTo: 'Lead' },
      { slug: 'reviewer', name: 'Reviewer', description: 'reviewer description', responsibilities: [], prompt: 'You are reviewer.', tools: ['Read', 'Grep'], canSpawn: false, spawnable: [], reportsTo: 'Lead' },
      { name: 'QA', description: 'Checks.', responsibilities: [], prompt: 'You are QA.', tools: ['Read'], canSpawn: false, spawnable: [], reportsTo: 'Lead' }
    ]
    const out = await rig.servers[0].ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-org', namespace: null, tool: 'propose_org_change', arguments: { title: 'Add QA', rationale: 'r', roles: drafts } })
    const text = String(out.contentItems[0].text)
    expect(text).toMatch(/^APPROVED\./)
    expect(text).toContain('It takes effect once the agents are idle and the session restarts')
    expect(text).not.toContain('Available now')
    expect(rig.ctx.roles.some((r) => r.name === 'QA')).toBe(true)
  })
})
