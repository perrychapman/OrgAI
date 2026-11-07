import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role, RunEvent } from '@shared/types'
import { BRIDGE_BRIEF_MAX_CHARS } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { fakeCtx, project, role } from './testHelpers'
import { ROOT_AGENT_ID, type BridgeSpawnInput, type BridgeSpawnResult, type BridgedRole, type RuntimeContext, type RuntimeSession } from './types'

// Multi-provider org charts (bridged reports) on the Codex adapter, against a scripted app-server (no codex binary).

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: any }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private threadCount = 0
  private turnCount = 0
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
        return { thread: { id: `th-${++this.threadCount}` }, model: 'gpt-test', cwd: (params as { cwd?: string })?.cwd } as T
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

/** Lead (root) -> engineer (a lead itself) + reviewer + analyst (bridged, on OpenAI). The engineer may spawn the analyst. */
function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev', 'r-ext'] }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read'], reportsTo: 'r-lead', canSpawn: true, spawnable: ['r-ext'] }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', tools: ['Read'], reportsTo: 'r-lead' }),
    role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: 'r-lead', model: 'claude-sonnet-4-5' })
  ]
}
const BRIDGED: BridgedRole = { roleId: 'r-ext', slug: 'analyst', name: 'Analyst', connection: 'anthropic', connectionName: 'Anthropic', adapter: 'claude' }

/** A bridge whose spawn calls onStarted at once and settles when the test says so. */
function fakeBridge() {
  const pending: { input: BridgeSpawnInput; resolve: (r: BridgeSpawnResult) => void; reject: (e: Error) => void }[] = []
  let n = 0
  const spawn = vi.fn((input: BridgeSpawnInput) => {
    const id = `b${++n}`
    const handle = input.name ?? `analyst-${n}`
    return new Promise<BridgeSpawnResult>((resolve, reject) => {
      pending.push({ input, resolve: (r) => resolve(r), reject })
      input.onStarted?.({ agentId: id, handle })
    })
  })
  return { bridge: { roles: () => [BRIDGED], spawn }, spawn, pending }
}

const turnDone = (threadId: string, turnId: string) => ({ threadId, turn: { id: turnId, status: 'completed', items: [], error: null } })
const call = (threadId: string, callId: string, tool: string, args: Record<string, unknown>) => ({ threadId, turnId: 'tu-1', callId, namespace: null, tool, arguments: args })

describe('Codex bridged reports', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-bridge-')))
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  async function start(over: Partial<RuntimeContext> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => (servers.push(new FakeServer(o)), servers.at(-1)!) })
    const roles = over.roles ?? chart()
    const ctx = fakeCtx({ project: project({ path: dir, roles, isolateWriters: false }), roles, continuationDelayMs: 5, ...over })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    return { ctx, s }
  }
  const harnessRows = (ctx: { events: RunEvent[] }) =>
    ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.source === 'harness' ? [e.entry.block.text] : []))

  it('offers no delegate_agent and marks the bridged role "spawn it as usual" in the prompt', async () => {
    const { bridge } = fakeBridge()
    const { s } = await start({ bridge })
    const root = s.of('thread/start')[0]!.params
    const names = root.dynamicTools.map((t: { name: string }) => t.name)
    expect(names).toContain('spawn_agent')
    expect(names).not.toContain('delegate_agent')
    expect(root.developerInstructions).toContain('- analyst (runs on Anthropic: spawn it as usual; the harness runs it on that connection and messages you its final report)')
  })

  it('spawn_agent for a bridged role calls bridge.spawn (no thread), answers at once and hands the final text to the parent', async () => {
    const { bridge, spawn, pending } = fakeBridge()
    const { ctx, s } = await start({ bridge })
    const out = await s.ask('item/tool/call', call('th-1', 'c1', 'spawn_agent', { role: 'analyst', brief: 'Analyse the logs', description: 'Log analysis' }))
    expect(out.success).toBe(true)
    expect(out.contentItems[0].text).toContain('Spawned analyst-1 (analyst) on Anthropic')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0]).toMatchObject({ role: 'r-ext', brief: 'Analyse the logs', description: 'Log analysis', parentAgentId: ROOT_AGENT_ID, parentRoleId: 'r-lead', toolUseId: 'c1' })
    expect(spawn.mock.calls[0]![0].name).toBeUndefined()
    // No thread of its own: the only thread is the root's.
    expect(s.of('thread/start')).toHaveLength(1)
    // list_agents shows it as a running report.
    const list = await s.ask('item/tool/call', call('th-1', 'c2', 'list_agents', {}))
    expect(list.contentItems[0].text).toContain('analyst-1 · analyst · running on Anthropic')

    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    await new Promise((r) => setTimeout(r, 20))
    pending[0]!.resolve({ agentId: 'b1', handle: 'analyst-1', text: 'Found 3 errors.', ok: true })
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(2))
    const delivered = s.turnStarts('th-1')[1].params.input[0].text as string
    expect(delivered).toContain('Harness: Bridged report analyst-1 (Analyst) finished.')
    expect(delivered).toContain('Found 3 errors.')
    expect(harnessRows(ctx).some((t) => t.includes('Bridged report analyst-1'))).toBe(true)
  })

  it('a bridged report still working counts as a live report: no plan nudge at the root turn end', async () => {
    const { bridge, pending } = fakeBridge()
    const { s } = await start({ bridge, autoContinue: true })
    await s.ask('item/tool/call', call('th-1', 'c-plan', 'set_plan', { goal: 'Ship', steps: [{ title: 'Analyse' }] }))
    await s.ask('item/tool/call', call('th-1', 'c1', 'spawn_agent', { role: 'analyst', brief: 'Analyse' }))
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    await new Promise((r) => setTimeout(r, 60))
    expect(s.turnStarts('th-1')).toHaveLength(1)
    // Control: once it reported, the next root turn end with the step still pending is nudged.
    pending[0]!.resolve({ agentId: 'b1', handle: 'analyst-1', text: 'Done.', ok: true })
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(2))
    s.push('turn/completed', turnDone('th-1', 'tu-2'))
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(3), { timeout: 2000 })
  })

  it('a failed child delivers its failure text; a refusal before it exists answers the tool call unsuccessfully', async () => {
    const { bridge, pending, spawn } = fakeBridge()
    const { s } = await start({ bridge })
    await s.ask('item/tool/call', call('th-1', 'c1', 'spawn_agent', { role: 'analyst', brief: 'Analyse' }))
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    pending[0]!.resolve({ agentId: 'b1', handle: 'analyst-1', text: 'The connection refused the key.', ok: false })
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(2))
    const delivered = s.turnStarts('th-1')[1].params.input[0].text as string
    expect(delivered).toContain('Harness: Bridged report analyst-1 (Analyst) failed.')
    expect(delivered).toContain('The connection refused the key.')

    spawn.mockImplementationOnce(async () => {
      throw new Error('Concurrent subagent limit reached.')
    })
    const refused = await s.ask('item/tool/call', call('th-1', 'c2', 'spawn_agent', { role: 'analyst', brief: 'Again' }))
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0].text).toBe('Could not start analyst: Concurrent subagent limit reached.')
  })

  it('L5: a bridged spawn_agent refuses a brief over BRIDGE_BRIEF_MAX_CHARS with delegate_agent\'s wording, and frees the reservation', async () => {
    const { bridge, spawn } = fakeBridge()
    const { s } = await start({ bridge })
    const long = await s.ask('item/tool/call', call('th-1', 'c1', 'spawn_agent', { role: 'analyst', brief: 'x'.repeat(BRIDGE_BRIEF_MAX_CHARS + 1) }))
    expect(long.success).toBe(false)
    expect(long.contentItems[0].text).toBe(`REFUSED: the brief is longer than ${BRIDGE_BRIEF_MAX_CHARS} characters. Shorten it.`)
    expect(spawn).not.toHaveBeenCalled()
    // At the cap it goes through, and the refused call left no reserved handle behind.
    const ok = await s.ask('item/tool/call', call('th-1', 'c2', 'spawn_agent', { role: 'analyst', brief: 'x'.repeat(BRIDGE_BRIEF_MAX_CHARS) }))
    expect(ok.success).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a report lead spawning it passes its own agent and role ids, and gets the result in its own thread', async () => {
    const { bridge, spawn, pending } = fakeBridge()
    const { ctx, s } = await start({ bridge })
    await s.ask('item/tool/call', call('th-1', 'c1', 'spawn_agent', { role: 'engineer', brief: 'Build' }))
    const engId = ctx.events.find((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.handle === 'engineer-1')!.agent.id
    await vi.waitFor(() => expect(s.turnStarts('th-2')).toHaveLength(1))
    const out = await s.ask('item/tool/call', call('th-2', 'c2', 'spawn_agent', { role: 'analyst', brief: 'Check', name: 'ext-a' }))
    expect(out.success).toBe(true)
    expect(spawn.mock.calls[0]![0]).toMatchObject({ role: 'r-ext', name: 'ext-a', parentAgentId: engId, parentRoleId: 'r-eng' })
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    pending[0]!.resolve({ agentId: 'b1', handle: 'ext-a', text: 'Checked.', ok: true })
    await vi.waitFor(() => expect(s.turnStarts('th-2')).toHaveLength(2))
    expect(s.turnStarts('th-2')[1].params.input[0].text).toContain('Bridged report ext-a (Analyst) finished.')
  })

  it('a bridged child session: its root gets the report prompt and no root-audience tools', async () => {
    const roles = [role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: null })]
    const { s } = await start({ roles, bridgedChild: { agentId: 'b1', parentAgentId: ROOT_AGENT_ID, roleId: 'r-ext' }, autoContinue: false })
    const root = s.of('thread/start')[0]!.params
    const names: string[] = root.dynamicTools.map((t: { name: string }) => t.name)
    for (const t of ['set_plan', 'orgai_update_plan', 'complete_plan', 'ask_user', 'delegate_agent']) expect(names).not.toContain(t)
    expect(root.developerInstructions).toContain('You were delegated this work by another agent of the team')
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    await new Promise((r) => setTimeout(r, 40))
    expect(s.turnStarts('th-1')).toHaveLength(1)
  })
})
