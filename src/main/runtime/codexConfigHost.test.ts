import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, RunEvent } from '@shared/types'
import { CODEX_RESTART_WAIT_WARN_TURNS, CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { HOST_CHANGE_LEAD } from './hostConfigNotice'
import type { RunSkill, RuntimeContext, RuntimeSession } from './types'
import { fakeCtx, mcpSpec, project, runSummary } from './testHelpers'

/**
 * Config changes on a live Codex session against a scripted app-server (no codex binary, no tokens): the restart notice
 * of a held run, RuntimeSession.hostConfigChanged (the user's change in OrgAI: told once, never with a turn of its own)
 * and the "still waiting" log.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  closed = false
  readonly exited: Promise<void>
  private markExited!: () => void
  constructor(
    readonly options: CodexAppServerOptions,
    private counters: { threads: number; turns: number }
  ) {
    this.exited = new Promise((r) => (this.markExited = r))
  }
  async start(): Promise<unknown> {
    return {}
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
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
  /** Every text sent to a thread (turn/start and turn/steer). */
  sent(threadId: string): string[] {
    return this.requests.filter((r) => (r.method === 'turn/start' || r.method === 'turn/steer') && r.params.threadId === threadId).map((r) => String(r.params.input[0].text))
  }
}

const turnDone = (threadId: string, turnId: string, status = 'completed') => ({ threadId, turn: { id: turnId, status, items: [], error: null } })

let dir = ''
let session: RuntimeSession | undefined
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-host-')))
})
afterEach(async () => {
  await session?.stop()
  session = undefined
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

async function start(over: Partial<RuntimeContext> = {}) {
  const servers: FakeServer[] = []
  const counters = { threads: 0, turns: 0 }
  const adapter = new CodexAdapter({
    createServer: (options) => {
      const s = new FakeServer(options, counters)
      servers.push(s)
      return s
    }
  })
  const mcp: McpServerSpec[] = []
  let skills: RunSkill[] = []
  const p = project({ path: dir, isolateWriters: false })
  const ctx = fakeCtx({
    project: p,
    continuationDelayMs: 5,
    autoContinue: false,
    mcpServers: () => mcp,
    resolvedMcpServers: async () => mcp.map((spec) => ({ spec, env: {}, headers: {} })),
    skills: () => skills,
    ...over
  })
  ctx.roles = structuredClone(p.roles)
  session = await adapter.start(ctx)
  await vi.waitFor(() => expect(servers[0]?.of('turn/start')).toHaveLength(1))
  return { ctx, servers, mcp, setSkills: (s: RunSkill[]) => (skills = s) }
}

const configChanged = (change: ConfigChange): Promise<ConfigChangeResult> => (session as any).configChanged(change)
// RuntimeSession.hostConfigChanged is optional in the shared contract; CodexSession implements it.
const host = (change: ConfigChange): Promise<ConfigChangeResult> => (session as unknown as { hostConfigChanged(c: ConfigChange): Promise<ConfigChangeResult> }).hostConfigChanged(change)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rows = (ctx: { events: RunEvent[] }) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'system' ? [e.entry.block] : []))

describe('Codex restart notice while the run is held', () => {
  it('an approved MCP change whose restart lands after an interrupt does not start a turn; it comes with the user\'s next message', async () => {
    const { servers, mcp } = await start()
    const s1 = servers[0]!
    mcp.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['lead'] }))
    expect(await configChanged({ mcp: { upserted: ['notes'], removed: [] } })).toEqual({ availability: 'after-idle' })
    await session!.interrupt()
    s1.push('turn/completed', turnDone('th-1', 'tu-1', 'interrupted'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    const s2 = servers[1]!
    await vi.waitFor(() => expect(s2.of('thread/resume')).toHaveLength(1))
    await sleep(50)
    // Regression: the notice started a root turn against the user's interrupt.
    expect(s2.of('turn/start')).toHaveLength(0)
    await session!.send('go on')
    await vi.waitFor(() => expect(s2.sent('th-1')).toHaveLength(1))
    expect(s2.sent('th-1')[0]).toContain('the MCP server you requested is connected now. Tool names start with mcp__notes__')
    expect(s2.sent('th-1')[0]).toContain('go on')
  })
})

describe('Codex hostConfigChanged', () => {
  it('MCP while idle: the app-server restarts at once, the notice waits for the user\'s next message', async () => {
    const { ctx, servers, mcp } = await start()
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    mcp.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['lead'] }))
    expect(await host({ mcp: { upserted: ['notes'], removed: [] } })).toEqual({ availability: 'after-idle' })
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    const s2 = servers[1]!
    await vi.waitFor(() => expect(rows(ctx).some((b) => b.detail?.includes(HOST_CHANGE_LEAD))).toBe(true))
    expect(s2.of('turn/start')).toHaveLength(0)
    await session!.send('next')
    await vi.waitFor(() => expect(s2.sent('th-1')).toHaveLength(1))
    const text = s2.sent('th-1')[0]!
    expect(text).toContain(HOST_CHANGE_LEAD)
    expect(text).toContain('the MCP server is connected now. Tool names start with mcp__notes__')
    expect(text).not.toContain('you requested')
    expect(text.match(/The user changed this project/g)).toHaveLength(1)
  })

  it("skills while idle: 'now' (load_skill reads them live), no turn; the next message carries the notice", async () => {
    const { ctx, servers, setSkills } = await start()
    const s1 = servers[0]!
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    setSkills([{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }])
    expect(await host({ skills: true })).toEqual({ availability: 'now' })
    await sleep(30)
    expect(s1.of('turn/start')).toHaveLength(1)
    expect(servers).toHaveLength(1)
    // A thread started before the change can list the new skill (the tools read ctx.skills() at call time).
    const listed = await s1.ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-ls', namespace: null, tool: 'list_skills', arguments: {} })
    expect(JSON.stringify(listed)).toContain('alpha')
    await session!.send('use it')
    await vi.waitFor(() => expect(s1.sent('th-1')).toHaveLength(2))
    expect(s1.sent('th-1')[1]).toContain('Skills granted now: alpha for Lead (lead). Load one with load_skill.')
  })

  it('skills mid-turn: delivered in line (steered into the running turn)', async () => {
    const { servers, setSkills } = await start()
    const s1 = servers[0]!
    setSkills([{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }])
    expect(await host({ skills: true })).toEqual({ availability: 'now' })
    await vi.waitFor(() => expect(s1.of('turn/steer')).toHaveLength(1))
    expect(s1.sent('th-1').at(-1)).toContain(HOST_CHANGE_LEAD)
  })

  it('rejects for a setup-like or ending session', async () => {
    await start({ run: runSummary({ kind: 'setup' }) })
    await expect(host({ skills: true })).rejects.toThrow('Setup-like')
    await session!.stop()
    session = undefined
    await start()
    await session!.stop()
    await expect(host({ skills: true })).rejects.toThrow('ending')
  })
})

describe('Codex restart waiting log', () => {
  it('says so after a few root turn ends while a report keeps the restart from starting', async () => {
    const { ctx, servers, mcp } = await start()
    const s1 = servers[0]!
    expect(await s1.ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-eng', namespace: null, tool: 'spawn_report', arguments: { role: 'engineer', brief: 'Work' } })).toMatchObject({ success: true })
    mcp.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['lead'] }))
    await configChanged({ mcp: { upserted: ['notes'], removed: [] } })
    // The engineer's turn (th-2) keeps running across three root turns.
    for (let i = 0; i < CODEX_RESTART_WAIT_WARN_TURNS; i++) s1.push('turn/completed', turnDone('th-1', i === 0 ? 'tu-1' : `tu-root-${i}`))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'log' && e.message.includes(`has waited ${CODEX_RESTART_WAIT_WARN_TURNS} turns for Codex to restart`))).toBe(true))
    expect(servers).toHaveLength(1)
  })
})
