import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode, RunEvent } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { SELF_CONTROL_REFUSAL_TEXT, controlProtectedPaths } from './selfControlGate'
import { fakeCtx, project } from './testHelpers'
import type { RuntimeContext, RuntimeSession } from './types'

/** A scripted app-server (the codex.test.ts pattern, reduced): answers requests, lets the test push and ask. */
class FakeServer implements CodexServerLike {
  requests: { method: string; params: unknown }[] = []
  private notify_: ((m: string, p: unknown) => void)[] = []
  private serverRequest_?: (m: string, p: unknown) => Promise<unknown>
  private threadCount = 0
  private turnCount = 0
  readonly exited: Promise<void>
  private markExited!: () => void
  closed = false
  constructor(readonly options: CodexAppServerOptions) {
    this.exited = new Promise((r) => (this.markExited = r))
  }
  async start(): Promise<unknown> {
    return {}
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'thread/start') return { thread: { id: `th-${++this.threadCount}` }, model: 'gpt-test' } as T
    if (method === 'turn/start') return { turn: { id: `tu-${++this.turnCount}` } } as T
    return {} as T
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
  ask(method: string, params: unknown): Promise<unknown> {
    return this.serverRequest_!(method, params)
  }
  turnStarts(): unknown[] {
    return this.requests.filter((r) => r.method === 'turn/start')
  }
}

describe('CodexAdapter self-control gate (fake app-server)', () => {
  let base = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-self-')))
    mkdirSync(join(base, 'repo'))
    mkdirSync(join(base, 'data', 'codex'), { recursive: true })
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    rmSync(base, { recursive: true, force: true })
  })

  async function started(mode: PermissionMode, over: Partial<RuntimeContext> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({
      createServer: (options) => {
        const s = new FakeServer(options)
        servers.push(s)
        return s
      }
    })
    const repo = join(base, 'repo')
    const data = join(base, 'data')
    const ctx = fakeCtx({
      project: project({ path: repo, isolateWriters: false, permissionMode: mode }),
      continuationDelayMs: 5,
      controlProtectedPaths: () => controlProtectedPaths(data),
      ...over
    })
    session = await adapter.start(ctx)
    const s = servers[0]!
    await vi.waitFor(() => expect(s.turnStarts()).toHaveLength(1))
    return { ctx, s, repo, data }
  }

  const rows = (events: RunEvent[]) =>
    events.filter((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === SELF_CONTROL_REFUSAL_TEXT && e.entry.source === 'harness')
  const cmd = (command: string, cwd: string) => ({ threadId: 'th-1', turnId: 'tu-1', itemId: 'i-1', command, cwd, startedAtMs: 1 })

  for (const mode of ['bypassPermissions', 'acceptEdits', 'default'] as const) {
    it(`declines orgai daemon stop and a change under <dataDir>/codex with no card under ${mode}`, async () => {
      const { ctx, s, repo, data } = await started(mode, { allowedRules: () => ['Bash(*)', 'Edit', 'Write'] })
      expect(await s.ask('item/commandExecution/requestApproval', cmd('orgai daemon stop', repo))).toEqual({ decision: 'decline' })
      expect(await s.ask('item/commandExecution/requestApproval', cmd(`/bin/zsh -lc 'cat ${join(data, 'codex', 'auth.json')}'`, repo))).toEqual({ decision: 'decline' })
      s.push('item/started', {
        threadId: 'th-1',
        turnId: 'tu-1',
        item: { type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: join(data, 'codex', 'config.toml'), kind: { type: 'update', move_path: null }, diff: '' }] }
      })
      expect(await s.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'f', startedAtMs: 1 })).toEqual({ decision: 'decline' })
      // A grantRoot under a protected path is declined as well.
      expect(await s.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'none', startedAtMs: 1, grantRoot: join(data, 'run') })).toEqual({ decision: 'decline' })
      expect(ctx.requestPermission).not.toHaveBeenCalled()
      expect(rows(ctx.events)).toHaveLength(4)
      expect(ctx.events.filter((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('OrgAI control files or the orgai command'))).toHaveLength(4)
    })
  }

  it('declines with no card an update in the repo whose move destination is under <dataDir>/codex (review H1)', async () => {
    const { ctx, s, repo, data } = await started('bypassPermissions', { allowedRules: () => ['Edit', 'Write'] })
    s.push('item/started', {
      threadId: 'th-1',
      turnId: 'tu-1',
      item: { type: 'fileChange', id: 'mv', status: 'inProgress', changes: [{ path: join(repo, 'a.md'), kind: { type: 'update', move_path: join(data, 'codex', 'config.toml') }, diff: '' }] }
    })
    expect(await s.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'mv', startedAtMs: 1 })).toEqual({ decision: 'decline' })
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(rows(ctx.events)).toHaveLength(1)
  })

  it('declines a permissions request whose folders reach OrgAI control files, with no card (review L)', async () => {
    const { ctx, s, data, repo } = await started('default')
    const perm = (permissions: unknown, reason?: string) => ({ threadId: 'th-1', itemId: 'p-1', permissions, ...(reason ? { reason } : {}) })
    for (const permissions of [
      { fileSystem: { writableRoots: [join(data, 'run')] } },
      { fileSystem: { readableRoots: [join(data, 'codex', 'auth.json')] } },
      { fileSystem: { writableRoots: [data] } },
      { fileSystem: { writableRoots: [base] } }
    ]) {
      expect(await s.ask('item/permissions/requestApproval', perm(permissions, 'need to run the tests'))).toEqual({ permissions: {}, scope: 'turn' })
    }
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(rows(ctx.events)).toHaveLength(4)
    // A folder elsewhere still goes to the usual card.
    void s.ask('item/permissions/requestApproval', perm({ fileSystem: { writableRoots: [join(repo, 'build')] } }))
    await vi.waitFor(() => expect(ctx.requestPermission).toHaveBeenCalledTimes(1))
  })

  it('leaves ordinary approvals to the usual checks', async () => {
    const { ctx, s, repo } = await started('default', { allowedRules: () => ['Bash(npm test:*)'] })
    expect(await s.ask('item/commandExecution/requestApproval', cmd('npm test', repo))).toEqual({ decision: 'accept' })
    expect(await s.ask('item/commandExecution/requestApproval', cmd('npm test && orgai status', repo))).toEqual({ decision: 'decline' })
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(rows(ctx.events)).toHaveLength(1)
  })

  it('declines every command with no card when the protected paths are unavailable (review M2)', async () => {
    for (const source of [() => [], () => {
      throw new Error('boom')
    }]) {
      const { ctx, s, repo } = await started('bypassPermissions', { controlProtectedPaths: source, allowedRules: () => ['Bash(*)'] })
      expect(await s.ask('item/commandExecution/requestApproval', cmd('ls', repo))).toEqual({ decision: 'decline' })
      expect(ctx.requestPermission).not.toHaveBeenCalled()
      expect(rows(ctx.events)).toHaveLength(1)
      expect(ctx.events.filter((e) => e.type === 'log' && e.message.includes('control paths are unavailable'))).toHaveLength(1)
      await session?.stop()
    }
  })

  it('keeps OrgAI control variables out of the MCP server config', async () => {
    const { s } = await started('default', {
      resolvedMcpServers: async () => [
        {
          spec: { id: 'm', name: 'files', transport: 'stdio', command: 'npx', args: ['srv'], env: { A: '1', ORGAI_DATA_DIR: '/d' }, secretEnv: ['ORGAI_SECRET_T'], enabled: true, source: 'user', addedAt: '' },
          env: { A: '1', ORGAI_DATA_DIR: '/d', ELECTRON_RUN_AS_NODE: '1', ORGAI_SECRET_T: 'v' },
          headers: {}
        }
      ]
    })
    const config = (s.options.config ?? []).join('\n')
    expect(config).toContain('mcp_servers.files.command')
    expect(config).toContain('A')
    expect(config).not.toMatch(/ORGAI_DATA_DIR|ELECTRON_RUN_AS_NODE|ORGAI_SECRET_T/)
    expect(Object.keys(s.options.env ?? {})).not.toContain('ORGAI_SECRET_T')
  })

  it('a file change with no usable path is not denied by the gate', async () => {
    const { ctx, s } = await started('dontAsk')
    expect(await s.ask('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'tu-1', itemId: 'missing', startedAtMs: 1 })).toEqual({ decision: 'decline' })
    expect(rows(ctx.events)).toHaveLength(0)
  })
})
