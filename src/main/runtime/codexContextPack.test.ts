import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeSpawnInput, BridgeSpawnResult, BridgedRole, RuntimeContext, RuntimeSession } from './types'
import type { Role } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import { CONTEXT_PACK_HEADING } from './contextPack'
import { WAITING_NOTE } from './waitingNote'

// Context pack (split-execution 3.2) and the one-report-and-waiting note (3.6) on the Codex adapter, against a scripted
// app-server (no codex binary, no tokens). FakeServer is the one in codexStaffing.test.ts.

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


function chart(required: string[] = []): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev', 'r-ext'], ...(required.length ? { requiredReports: required } : {}) }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read'], reportsTo: 'r-lead' }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', tools: ['Read'], reportsTo: 'r-lead' }),
    role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: 'r-lead' })
  ]
}
const BRIDGED: BridgedRole = { roleId: 'r-ext', slug: 'analyst', name: 'Analyst', connection: 'anthropic', connectionName: 'Anthropic', adapter: 'claude' }
const call = (threadId: string, callId: string, tool: string, args: Record<string, unknown>) => ({ threadId, turnId: 'tu-1', callId, namespace: null, tool, arguments: args })

describe('Codex spawn_report: context pack and waiting note', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-pack-')))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'contract.ts'), 'export interface Contract { id: string }\n')
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    rmSync(`${dir}-elsewhere.txt`, { force: true })
  })

  async function start(over: Partial<RuntimeContext> = {}, required: string[] = []) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({ createServer: (o) => (servers.push(new FakeServer(o)), servers.at(-1)!) })
    const roles = chart(required)
    const ctx = fakeCtx({ project: project({ path: dir, roles, isolateWriters: false }), roles, autoContinue: false, ...over })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(1))
    return { ctx, s }
  }
  const plan = (s: FakeServer, steps: unknown[]) => s.ask('item/tool/call', call('th-1', 'cp', 'set_plan', { goal: 'Ship', steps }))
  const spawn = (s: FakeServer, id: string, args: Record<string, unknown>) => s.ask('item/tool/call', call('th-1', id, 'spawn_report', { brief: 'Do it', ...args }))
  const firstMessage = (s: FakeServer, threadId: string): string => s.turnStarts(threadId)[0].params.input[0].text

  it('inlines the named files into the first message and lists every file left out in the result', async () => {
    const { ctx, s } = await start()
    writeFileSync(`${dir}-elsewhere.txt`, 'outside the project')
    const out = await spawn(s, 'c1', { role: 'engineer', files: ['src/contract.ts', `${dir}-elsewhere.txt`, 'missing.ts'] })
    expect(out.success).toBe(true)
    const text = out.contentItems[0].text as string
    expect(text).toContain('Inlined 1 file into its brief: src/contract.ts.')
    expect(text).toContain(`${dir}-elsewhere.txt (outside the folders the report may read)`)
    expect(text).toContain('missing.ts (not found)')
    const msg = firstMessage(s, 'th-2')
    expect(msg.startsWith('Do it')).toBe(true)
    expect(msg).toContain(`${CONTEXT_PACK_HEADING}\n\nFile: src/contract.ts\n\`\`\`\nexport interface Contract { id: string }\n\`\`\``)
    // The transcript keeps the brief only.
    const userRows = ctx.events.filter((e) => e.type === 'transcript' && e.entry.block.kind === 'user').map((e) => (e as { entry: { block: { text: string } } }).entry.block.text)
    expect(userRows).toContain('Do it')
    expect(userRows.some((t) => t.includes(CONTEXT_PACK_HEADING))).toBe(false)
  })

  it("the root's prompt asks for files only where a pack can be inlined (contextPackRefusal)", async () => {
    const clause = 'pass the files you read as files'
    const { s } = await start()
    expect(s.of('thread/start')[0].params.developerInstructions).toContain(clause)
    await session?.stop()
    session = undefined
    const restricted = await start({ run: runSummary({ buildWorkspace: dir }) })
    expect(restricted.s.of('thread/start')[0].params.developerInstructions).not.toContain(clause)
  })

  it('without files the first message and the result are as before', async () => {
    const { s } = await start()
    const out = await spawn(s, 'c1', { role: 'engineer' })
    expect(out.contentItems[0].text).not.toContain('nlined')
    expect(firstMessage(s, 'th-2')).not.toContain(CONTEXT_PACK_HEADING)
  })

  it('refuses OrgAI control files and fails closed when the protected paths are unavailable', async () => {
    const { s } = await start({ controlProtectedPaths: () => [] })
    const out = await spawn(s, 'c1', { role: 'engineer', files: ['src/contract.ts'] })
    expect(out.contentItems[0].text).toContain('src/contract.ts (OrgAI could not check it against its control files)')
    expect(firstMessage(s, 'th-2')).not.toContain(CONTEXT_PACK_HEADING)
  })

  it('a bridged report gets no pack and the result says so', async () => {
    const spawnBridge = vi.fn((input: BridgeSpawnInput) => new Promise<BridgeSpawnResult>(() => input.onStarted?.({ agentId: 'b1', handle: 'analyst-1' })))
    const { s } = await start({ bridge: { roles: () => [BRIDGED], spawn: spawnBridge } })
    const out = await spawn(s, 'c1', { role: 'analyst', files: ['src/contract.ts'] })
    expect(out.contentItems[0].text).toContain('The files you named were not inlined')
    expect(spawnBridge.mock.calls[0]![0].brief).toBe('Do it')
  })

  it('the waiting note: once, when the root hands out one piece and does nothing itself', async () => {
    const { s } = await start()
    await plan(s, [{ title: 'Module A', staff: { role: 'engineer' } }, { title: 'Module B' }, { title: 'Verify', after: ['p1', 'p2'] }])
    const first = await spawn(s, 'c1', { role: 'engineer' })
    expect(first.contentItems[0].text).toContain(WAITING_NOTE)
    // Not again in this run.
    s.push('turn/completed', { threadId: 'th-2', turn: { id: 'tu-2', status: 'completed', items: [], error: null } })
    await vi.waitFor(() => expect(s.of('turn/start').length + s.of('turn/steer').length).toBeGreaterThan(2))
    const again = await spawn(s, 'c2', { role: 'reviewer' })
    expect(again.contentItems[0].text).not.toContain(WAITING_NOTE)
  })

  it('no waiting note while the root works a step itself, with two reports, or for a required report', async () => {
    const busy = await start()
    await plan(busy.s, [{ title: 'Module A', staff: { role: 'engineer' } }, { title: 'Module B' }])
    await busy.s.ask('item/tool/call', call('th-1', 'cu', 'orgai_update_plan', { steps: [{ id: 'p2', status: 'in_progress' }] }))
    expect((await spawn(busy.s, 'c1', { role: 'engineer' })).contentItems[0].text).not.toContain(WAITING_NOTE)
    await session?.stop()

    // Two reports running: the first spawn came while the root worked p1, the second leaves two running.
    const two = await start()
    await plan(two.s, [{ title: 'A' }, { title: 'B' }, { title: 'C' }])
    await two.s.ask('item/tool/call', call('th-1', 'cu', 'orgai_update_plan', { steps: [{ id: 'p1', status: 'in_progress' }] }))
    expect((await spawn(two.s, 'c1', { role: 'engineer' })).contentItems[0].text).not.toContain(WAITING_NOTE)
    await two.s.ask('item/tool/call', call('th-1', 'cd', 'orgai_update_plan', { steps: [{ id: 'p1', status: 'done' }] }))
    expect((await spawn(two.s, 'c2', { role: 'reviewer' })).contentItems[0].text).not.toContain(WAITING_NOTE)
    await session?.stop()

    const req = await start({}, ['r-eng'])
    await plan(req.s, [{ title: 'A' }, { title: 'B' }])
    expect((await spawn(req.s, 'c1', { role: 'engineer' })).contentItems[0].text).not.toContain(WAITING_NOTE)
  })
})
