import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import { CodexAdapter, type CodexServerLike } from './codex'
import type { CodexAppServerOptions } from './codexAppServer'
import { fakeCtx, project } from './testHelpers'
import type { RootTurnEnd, RuntimeContext, RuntimeSession } from './types'

// Headless exec settlement on the Codex adapter (cli-spec 6.2(2)) against a scripted app-server; nothing spends tokens.

/** A scripted app-server: answers requests and lets the test push notifications and server requests. */
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
    if (override) return (await override(params)) as T
    switch (method) {
      case 'thread/start':
        return { thread: { id: `th-${++this.threadCount}` }, model: 'gpt-test' } as T
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
  turnStarts(threadId: string): any[] {
    return this.requests.filter((r) => r.method === 'turn/start' && r.params.threadId === threadId)
  }
}

const turnDone = (threadId: string, turnId: string, status = 'completed', error: unknown = null) => ({ threadId, turn: { id: turnId, status, items: [], error } })

describe('CodexSession exec settlement (fake app-server)', () => {
  let dir = ''
  let session: RuntimeSession | undefined
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-codex-exec-')))
  })
  afterEach(async () => {
    await session?.stop()
    session = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(over: Partial<RuntimeContext> = {}) {
    const servers: FakeServer[] = []
    const adapter = new CodexAdapter({
      createServer: (options) => {
        const s = new FakeServer(options)
        servers.push(s)
        return s
      }
    })
    const log: string[] = []
    const ends: RootTurnEnd[] = []
    const activity: string[] = []
    const base = fakeCtx({ project: project({ path: dir, isolateWriters: false }), continuationDelayMs: 5, autoContinue: false, ...over })
    const emit = base.emit
    const ctx = Object.assign(base, {
      emit: (e: RunEvent) => {
        if (e.type === 'run.status') log.push(`status:${e.status}`)
        emit(e)
      },
      onRootTurnEnded: (e: RootTurnEnd) => {
        ends.push(e)
        log.push(`end:${e.turnGen}`)
      },
      noteActivity: (r: string) => activity.push(r)
    })
    session = await adapter.start(ctx)
    await vi.waitFor(() => expect(servers[0]?.turnStarts('th-1')).toHaveLength(1))
    return { ctx, s: servers[0]!, log, ends, activity, session }
  }

  it('reports completed, failed (non-auth and auth) and interrupted root turns before run.status idle', async () => {
    const { s, log, ends } = await start()
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    s.push('turn/completed', turnDone('th-1', 'tu-2', 'failed', { message: 'boom', codexErrorInfo: null }))
    s.push('turn/completed', turnDone('th-1', 'tu-3', 'failed', { message: 'unexpected status 401 Unauthorized: invalid api key', codexErrorInfo: null }))
    s.push('turn/completed', turnDone('th-1', 'tu-4', 'interrupted'))
    expect(ends).toEqual([
      { turnGen: 1, ok: true },
      { turnGen: 2, ok: false, errorSubtype: 'failed', isAuthError: false },
      { turnGen: 3, ok: false, errorSubtype: 'failed', isAuthError: true },
      { turnGen: 4, ok: true, interrupted: true }
    ])
    const order = log.filter((l) => l.startsWith('end:') || l === 'status:idle')
    expect(order).toEqual(['end:1', 'status:idle', 'end:2', 'status:idle', 'end:3', 'status:idle', 'end:4', 'status:idle'])
  })

  it('a usage-limited failed turn is reported limited before the session ends', async () => {
    const { s, ends, session: sess } = await start()
    s.overrides['account/rateLimits/read'] = () => ({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1_900_000_000 }, secondary: null } })
    const err = { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' }
    s.push('error', { threadId: 'th-1', turnId: 'tu-1', willRetry: false, error: err })
    await new Promise((r) => setTimeout(r, 10))
    s.push('turn/completed', turnDone('th-1', 'tu-1', 'failed', err))
    await sess.finished
    expect(ends).toEqual([{ turnGen: 1, ok: false, errorSubtype: 'failed', isAuthError: false, limited: true }])
  })

  it('settlement(): root turn, driver off, quiescent', async () => {
    const { s, session: sess } = await start()
    expect(sess.settlement!()).toMatchObject({ rootTurnGen: 0, rootIdle: false, continuationSettled: false })
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(sess.settlement!()).toEqual({ rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }))
  })

  it('settlement(): the set-plan nudge leaves the turn unsettled; the next completed turn settles; a failed one is skipped', async () => {
    const { s, session: sess, activity } = await start({ autoContinue: true })
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    await vi.waitFor(() => expect(sess.settlement!().nudgeTurn1Sent).toBe(true))
    expect(sess.settlement!().continuationSettled).toBe(false)
    expect(activity).toContain('message')
    await vi.waitFor(() => expect(s.turnStarts('th-1')).toHaveLength(2))
    s.push('turn/completed', turnDone('th-1', 'tu-2'))
    await vi.waitFor(() => expect(sess.settlement!()).toMatchObject({ rootTurnGen: 2, continuationSettled: true, quiescent: true }))
    expect(activity).toContain('continuation')
    s.push('turn/completed', turnDone('th-1', 'tu-3', 'failed', { message: 'boom', codexErrorInfo: null }))
    expect(sess.settlement!()).toMatchObject({ rootTurnGen: 3, continuationSettled: true })
  })

  it('settlement(): a pending app-server restart and a thread start in flight are not quiescent', async () => {
    const { s, session: sess } = await start()
    s.push('turn/completed', turnDone('th-1', 'tu-1'))
    expect(sess.settlement!().quiescent).toBe(true)
    // A spawn whose thread/start has not answered yet.
    let release: (() => void) | undefined
    s.overrides['thread/start'] = () => new Promise((r) => (release = () => r({ thread: { id: 'th-2' }, model: 'gpt-test' })))
    const spawn = s.ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-spawn', namespace: null, tool: 'spawn_report', arguments: { role: 'engineer', brief: 'Build it' } })
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(sess.settlement!().quiescent).toBe(false)
    release!()
    await spawn
    // The child thread's first turn is now running; its completion notes a report.
    const settledAfterSpawn = sess.settlement!()
    expect(settledAfterSpawn.rootIdle).toBe(true)
    // A pending MCP restart (an approved install waits for idle) is not quiescent either.
    ;(sess as unknown as { mcpRestartPending: boolean }).mcpRestartPending = true
    expect(sess.settlement!().quiescent).toBe(false)
    ;(sess as unknown as { mcpRestartPending: boolean }).mcpRestartPending = false
  })

  it('notes subagent activity at a thread start and a report at its finish', async () => {
    const { s, activity } = await start()
    await s.ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-spawn', namespace: null, tool: 'spawn_report', arguments: { role: 'engineer', brief: 'Build it' } })
    expect(activity).toContain('subagent')
    await vi.waitFor(() => expect(s.turnStarts('th-2')).toHaveLength(1))
    s.push('turn/completed', turnDone('th-2', 'tu-2'))
    expect(activity).toContain('report')
  })
})
