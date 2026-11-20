import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, RunEvent } from '@shared/types'
import { CODEX_RESTART_WAIT_WARN_TURNS, CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { HOST_CHANGE_LEAD, hostChangeNotice } from './hostConfigNotice'
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
    if (method === 'turn/steer' && faults.steer) throw new Error('no active turn to steer')
    if (method === 'thread/resume' && faults.resume) throw new Error(faults.resume)
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

/** Scripted failures of the fake app-server: a refused turn/steer, a thread/resume that throws (with this message). */
const faults: { steer: boolean; resume: string } = { steer: false, resume: '' }

let dir = ''
let session: RuntimeSession | undefined
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-host-')))
  faults.steer = false
  faults.resume = ''
})
afterEach(async () => {
  await session?.stop()
  session = undefined
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

async function start(over: Partial<RuntimeContext> = {}, initialMcp: McpServerSpec[] = []) {
  const servers: FakeServer[] = []
  const counters = { threads: 0, turns: 0 }
  const adapter = new CodexAdapter({
    createServer: (options) => {
      const s = new FakeServer(options, counters)
      servers.push(s)
      return s
    }
  })
  const mcp: McpServerSpec[] = [...initialMcp]
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

  it('M1: a refused steer never falls back to turn/start; the notice waits for the next message', async () => {
    const { ctx, servers, setSkills } = await start()
    const s1 = servers[0]!
    faults.steer = true
    setSkills([{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }])
    expect(await host({ skills: true })).toEqual({ availability: 'now' })
    await vi.waitFor(() => expect(s1.of('turn/steer')).toHaveLength(1))
    await sleep(50)
    // Regression: sendToThread fell back to turn/start, a turn of its own for the user's change.
    expect(s1.of('turn/start')).toHaveLength(1)
    expect(rows(ctx).some((b) => b.detail?.includes(HOST_CHANGE_LEAD))).toBe(true)
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    await sleep(30)
    expect(s1.of('turn/start')).toHaveLength(1)
    faults.steer = false
    await session!.send('next')
    await vi.waitFor(() => expect(s1.of('turn/start')).toHaveLength(2))
    const sent = s1.sent('th-1').at(-1)!
    expect(sent).toContain(HOST_CHANGE_LEAD)
    expect(sent).toContain('next')
    expect(sent.match(/The user changed this project/g)).toHaveLength(1)
  })

  it('M1: busy by state with no running root turn: nothing is sent; the notice waits', async () => {
    const { ctx, servers, setSkills } = await start()
    const s1 = servers[0]!
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    // The root still shows busy (e.g. a state not yet settled) while no root turn is active.
    ;(session as unknown as { setState(id: string, s: string, a: string): void }).setState('root', 'thinking', 'Thinking…')
    setSkills([{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }])
    expect(await host({ skills: true })).toEqual({ availability: 'now' })
    await sleep(50)
    expect(s1.of('turn/start')).toHaveLength(1)
    expect(s1.of('turn/steer')).toHaveLength(0)
    await session!.send('go')
    await vi.waitFor(() => expect(s1.of('turn/start')).toHaveLength(2))
    expect(s1.sent('th-1').at(-1)).toContain(HOST_CHANGE_LEAD)
  })

  it('M3: a restart for the user\'s change alone that throws pauses for the user (no auto-resume) instead of failing the run', async () => {
    const { ctx, servers, mcp } = await start()
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    faults.resume = 'resume refused Bearer abc.def.ghi'
    mcp.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['lead'] }))
    expect(await host({ mcp: { upserted: ['notes'], removed: [] } })).toEqual({ availability: 'after-idle' })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && (e.status === 'paused' || e.status === 'error'))).toBe(true))
    // Regression: the run ended 'error' ("Could not restart Codex to attach the MCP server").
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'error')).toBe(false)
    const paused = ctx.events.find((e) => e.type === 'run.status' && e.status === 'paused') as { autoResume?: boolean; pausedUntil?: number; pauseReason?: string }
    expect(paused.autoResume).toBe(false)
    expect(paused.pausedUntil).toBeUndefined()
    expect(paused.pauseReason).toContain('the run waits for your next message')
    const warns = ctx.events.filter((e) => e.type === 'log' && e.level === 'warn').map((e) => (e as { message: string }).message)
    expect(warns.filter((m) => m.includes('Could not restart Codex to apply the change you made in OrgAI'))).toHaveLength(1)
    expect(warns.join('\n')).not.toContain('abc.def.ghi')
  })

  it('M3 counterpart: a restart for the run\'s own change that throws still fails the run', async () => {
    const { ctx, servers, mcp } = await start()
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    faults.resume = 'resume refused'
    mcp.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['lead'] }))
    await configChanged({ mcp: { upserted: ['notes'], removed: [] } })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'error')).toBe(true))
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(false)
  })

  it('L5: a failure listing the change is logged redacted', async () => {
    let fail = false
    const { ctx } = await start({
      skills: () => {
        if (fail) throw new Error('could not read skills (Bearer tok-123456789 sk-live-abcdef123)')
        return []
      }
    })
    fail = true
    expect(await host({ skills: true })).toEqual({ availability: 'now' })
    const line = ctx.events.filter((e) => e.type === 'log').map((e) => (e as { message: string }).message).find((m) => m.startsWith('Could not list the changed configuration')) ?? ''
    expect(line).toContain('could not read skills')
    expect(line).not.toContain('tok-123456789')
    expect(line).not.toContain('sk-live-abcdef123')
  })

  it('item 2: a refused root thread resume at run start is logged redacted', async () => {
    faults.resume = 'thread not found (Bearer tok-123456789, api_key=sk-live-abcdef123)'
    const { ctx, servers } = await start({ resumeSessionId: 'th-old' })
    expect(servers[0]!.of('thread/resume')).toHaveLength(1)
    const line = ctx.events.filter((e) => e.type === 'log').map((e) => (e as { message: string }).message).find((m) => m.startsWith('Could not resume Codex thread th-old')) ?? ''
    expect(line).toContain('thread not found')
    // Regression: e.message went into the log raw.
    expect(line).not.toContain('tok-123456789')
    expect(line).not.toContain('sk-live-abcdef123')
  })

  it('item 2: an app-server turn failure is redacted in the log and the root activity', async () => {
    const { ctx, servers } = await start()
    servers[0]!.push('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'failed', items: [], error: { message: 'upstream said Bearer tok-123456789' } } })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'log' && e.message.startsWith('Run turn failed'))).toBe(true))
    const text = JSON.stringify(ctx.events)
    expect(text).toContain('upstream said')
    expect(text).not.toContain('tok-123456789')
  })

  it('item 4: a server the user removes mid-turn stays reachable until the restart, and the orchestrator is told so in line (no turn of its own)', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['lead'], secretEnv: [] })
    const { ctx, servers, mcp } = await start({}, [gh])
    const s1 = servers[0]!
    expect((s1.options.config ?? []).some((l) => l.startsWith('mcp_servers.github.'))).toBe(true)
    mcp.splice(0, 1)
    expect(await host({ mcp: { upserted: [], removed: ['github'] } })).toEqual({ availability: 'after-idle' })
    // Steered into the running root turn; never turn/start.
    await vi.waitFor(() => expect(s1.of('turn/steer')).toHaveLength(1))
    expect(s1.of('turn/start')).toHaveLength(1)
    const steered = s1.sent('th-1').at(-1)!
    expect(steered).toContain(HOST_CHANGE_LEAD)
    expect(steered).toContain('MCP servers removed or turned off: github. Do not call their tools. They stay reachable until Codex restarts when the agents are idle')
    // Regression: nothing said the server was still reachable; "refused" would be untrue on Codex.
    expect(steered).not.toContain('refused')
    const warns = ctx.events.filter((e) => e.type === 'log' && e.level === 'warn').map((e) => (e as { message: string }).message)
    expect(warns.some((m) => m.includes('MCP server github was removed or turned off, but stays reachable to every agent of this run until Codex restarts'))).toBe(true)
    // The turn ends: the restart at idle drops the server.
    s1.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    expect((servers[1]!.options.config ?? []).some((l) => l.startsWith('mcp_servers.github.'))).toBe(false)
  })

  it('item 4: idle, the restart comes at once: the "still reachable" notice is taken back, the restart notice alone is delivered', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['lead'], secretEnv: [] })
    const { ctx, servers, mcp } = await start({}, [gh])
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    mcp.splice(0, 1)
    expect(await host({ mcp: { upserted: [], removed: ['github'] } })).toEqual({ availability: 'after-idle' })
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    const s2 = servers[1]!
    await vi.waitFor(() => expect(rows(ctx).filter((b) => b.detail?.includes(HOST_CHANGE_LEAD)).length).toBeGreaterThanOrEqual(2))
    expect(s2.of('turn/start')).toHaveLength(0)
    await session!.send('next')
    await vi.waitFor(() => expect(s2.sent('th-1')).toHaveLength(1))
    const text = s2.sent('th-1')[0]!
    expect(text).not.toContain('They stay reachable until Codex restarts')
    expect(text).toContain('Tools of servers that were disabled or removed are gone.')
    expect(text.match(/The user changed this project/g)).toHaveLength(1)
  })

  it('M1: a removal that lands after the restart read the server list keeps its "still reachable" notice (true for that app-server) and one more restart follows', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['lead'], secretEnv: [] })
    let mcpRef: McpServerSpec[] = []
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { servers, mcp } = await start(
      {
        resolvedMcpServers: async () => {
          const snapshot = mcpRef.map((spec) => ({ spec, env: {}, headers: {} }))
          calls += 1
          if (calls === 2) {
            // The restart has read [github, notes]; the user removes github before the resume.
            mcpRef.splice(0, mcpRef.length, ...mcpRef.filter((s) => s.name !== 'github'))
            await host({ mcp: { upserted: [], removed: ['github'] } })
          }
          if (calls === 3) await gate
          return snapshot
        }
      },
      [gh]
    )
    mcpRef = mcp
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await sleep(20)
    mcp.push(mcpSpec({ name: 'notes', roles: ['lead'], secretEnv: [] }))
    await host({ mcp: { upserted: ['notes'], removed: [] } })
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    // The second app-server still has github: the notice stays, and the restart's own notice does not claim it is gone.
    expect((servers[1]!.options.config ?? []).some((l) => l.startsWith('mcp_servers.github.'))).toBe(true)
    await vi.waitFor(() => expect(calls).toBe(3))
    const pending = JSON.stringify((session as any).hostNotes)
    expect(pending).toContain('stay reachable until Codex restarts')
    expect(pending).not.toContain('are gone')
    release()
    // The further restart drops it.
    await vi.waitFor(() => expect(servers).toHaveLength(3))
    expect((servers[2]!.options.config ?? []).some((l) => l.startsWith('mcp_servers.github.'))).toBe(false)
  })

  it('L1: two removals naming different servers before one restart: neither unsent notice survives it', async () => {
    const a = mcpSpec({ name: 'alpha', roles: ['lead'], secretEnv: [] })
    const b = mcpSpec({ name: 'beta', roles: ['lead'], secretEnv: [] })
    const { servers, mcp } = await start({}, [a, b])
    faults.steer = true // both notices wait in the queue
    mcp.splice(0, 1)
    await host({ mcp: { upserted: [], removed: ['alpha'] } })
    mcp.splice(0, 1)
    await host({ mcp: { upserted: [], removed: ['beta'] } })
    servers[0]!.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(servers).toHaveLength(2))
    await sleep(30)
    const notes = JSON.stringify((session as any).hostNotes)
    // Regression: the first removal's notice (alpha) survived and told the orchestrator it "stays reachable" after the restart.
    expect(notes).not.toContain('stay reachable until Codex restarts')
    expect((session as any).reachableNotes).toEqual([])
  })

  it('item 4: the run\'s own approved removal is logged as still reachable, with no extra notice', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['lead'], secretEnv: [] })
    const { ctx, servers, mcp } = await start({}, [gh])
    mcp.splice(0, 1)
    await configChanged({ mcp: { upserted: [], removed: ['github'] } })
    await sleep(30)
    expect(servers[0]!.of('turn/steer')).toHaveLength(0)
    expect(ctx.events.some((e) => e.type === 'log' && e.message.includes('stays reachable to every agent of this run until Codex restarts'))).toBe(true)
  })

  it('L2: a Codex notice without an MCP part never says removed MCP tools are refused at once', () => {
    const text = hostChangeNotice({ prefix: 'Harness:', skills: [{ name: 'alpha', roles: [{ name: 'Lead', slug: 'lead' }] }] })
    expect(text).not.toContain('removed or ungranted tools are refused at once')
    expect(text).not.toContain('MCP')
    expect(text).toContain('skills and roles taken away are refused at once')
    expect(hostChangeNotice({ prefix: 'Harness:', removed: ['gh'] })).toContain('removed or ungranted tools are refused at once')
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
