import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Project, RunEvent } from '@shared/types'

// Headless exec settlement on the Claude adapter (cli-spec 6.2(2), 6.2(3)): only `query` is faked (a scripted
// stand-in for the CLI, as in claude.test.ts); nothing spends tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    private out: Msg[] = []
    private waiters: { resolve: (r: IteratorResult<Msg>) => void; reject: (e: Error) => void }[] = []
    private done = false
    constructor(
      readonly prompt: AsyncIterable<Msg>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly options: Record<string, any>
    ) {
      void (async () => {
        for await (const m of prompt) this.inputs.push(m)
        this.end()
      })()
    }
    emit(m: Msg): void {
      const w = this.waiters.shift()
      if (w) w.resolve({ value: m, done: false })
      else this.out.push(m)
    }
    end(): void {
      this.done = true
      for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as never, done: true })
    }
    [Symbol.asyncIterator](): AsyncIterator<Msg> {
      return {
        next: () => {
          if (this.out.length) return Promise.resolve({ value: this.out.shift()!, done: false })
          if (this.done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
        }
      }
    }
    async setMcpServers(rec: Record<string, unknown>) {
      return { added: Object.keys(rec), removed: [], errors: {} }
    }
    async mcpServerStatus() {
      return state.status
    }
    async interrupt() {}
    close(): void {
      this.end()
    }
  }
  const state = {
    FakeQuery,
    queries: [] as FakeQuery[],
    status: [] as { name: string; status: string; tools?: { name: string }[] }[]
  }
  return state
})
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...orig,
    query: (args: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
      const q = new sdk.FakeQuery(args.prompt, args.options)
      sdk.queries.push(q)
      return q
    }
  }
})

import { ClaudeSession, MCP_RESTART_DELAY_MS } from './claude'
import { fakeCtx, mcpSpec, project } from './testHelpers'
import type { RootTurnEnd, RuntimeContext } from './types'

const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', claude_code_version: 'test', tools: [], mcp_servers: [] }
const result = (subtype = 'success', extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype,
  total_cost_usd: 0,
  modelUsage: {},
  result: 'ok',
  is_error: subtype !== 'success',
  usage: {},
  ...extra
})

describe('ClaudeSession exec settlement (fake query)', () => {
  const sessions: ClaudeSession[] = []
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop()
    sdk.queries.length = 0
    sdk.status = []
  })

  /** Start a session; `log` records root turn ends and run.status events in order. */
  function start(over: Partial<RuntimeContext> = {}, projectOver: Partial<Project> = {}) {
    const log: string[] = []
    const ends: RootTurnEnd[] = []
    const activity: string[] = []
    const base = fakeCtx({ project: project({ path: mkdtempSync(join(tmpdir(), 'orgai-claude-exec-')), ...projectOver }), autoContinue: false, ...over })
    const emit = base.emit
    const ctx: RuntimeContext & { events: RunEvent[] } = Object.assign(base, {
      emit: (e: RunEvent) => {
        if (e.type === 'run.status') log.push(`status:${e.status}`)
        emit(e)
      },
      onRootTurnEnded: (e: RootTurnEnd) => {
        ends.push(e)
        log.push(`end:${e.turnGen}:${e.ok ? 'ok' : (e.errorSubtype ?? 'fail')}${e.isAuthError ? ':auth' : ''}`)
      },
      noteActivity: (r: string) => activity.push(r)
    })
    const session = new ClaudeSession(ctx)
    sessions.push(session)
    return { ctx, session, log, ends, activity }
  }

  async function firstQuery() {
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
    return sdk.queries[0]!
  }

  it('an interrupted root turn is reported as interrupted, never as a failed turn', async () => {
    const { session, ends, ctx } = start()
    const q = await firstQuery()
    q.emit(init)
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert')).toBe(true))
    await session.interrupt()
    q.emit(result('error_during_execution'))
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]).toMatchObject({ ok: false, interrupted: true, errorSubtype: 'error_during_execution' })
    const root = [...ctx.events].reverse().find((e) => e.type === 'agent.upsert' && e.agent.id === 'root')
    expect(root && root.type === 'agent.upsert' ? root.agent.state : undefined).toBe('idle')
    // The next turn's failure is a real failure again.
    q.emit(init)
    q.emit(result('error_during_execution'))
    await vi.waitFor(() => expect(ends).toHaveLength(2))
    expect(ends[1].interrupted).toBeUndefined()
  })

  it('reports every root turn end before run.status idle, failed ones included, with increasing turnGen', async () => {
    const { log, ends } = start()
    const q = await firstQuery()
    q.emit(init)
    for (const subtype of ['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd']) {
      q.emit(init)
      q.emit(result(subtype))
    }
    await vi.waitFor(() => expect(ends).toHaveLength(4))
    expect(ends.map((e) => e.turnGen)).toEqual([1, 2, 3, 4])
    expect(ends.map((e) => e.errorSubtype)).toEqual([undefined, 'error_max_turns', 'error_during_execution', 'error_max_budget_usd'])
    expect(ends.map((e) => e.ok)).toEqual([true, false, false, false])
    const turnLog = log.filter((l) => l.startsWith('end:') || l === 'status:idle')
    expect(turnLog).toEqual([
      'end:1:ok',
      'status:idle',
      'end:2:error_max_turns',
      'status:idle',
      'end:3:error_during_execution',
      'status:idle',
      'end:4:error_max_budget_usd',
      'status:idle'
    ])
  })

  it('reports an auth failure as a failed root turn end before the run ends in error', async () => {
    const { log, ends } = start()
    const q = await firstQuery()
    q.emit(init)
    q.emit(result('success'))
    q.emit(init)
    q.emit({ ...result('success'), is_error: true, result: 'Invalid API key · Please run /login' })
    await vi.waitFor(() => expect(log).toContain('status:error'))
    expect(ends.map((e) => [e.turnGen, e.ok, !!e.isAuthError])).toEqual([
      [1, true, false],
      [2, false, true]
    ])
    expect(log.indexOf('end:2:fail:auth')).toBeLessThan(log.indexOf('status:error'))
  })

  it('settlement() follows the root turn, background tasks and a deferred MCP restart', async () => {
    const servers: McpServerSpec[] = []
    const { session } = start({ mcpServers: () => servers, resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })) })
    const q = await firstQuery()
    expect(session.settlement().rootIdle).toBe(false)
    q.emit(init)
    await vi.waitFor(() => expect(q.inputs.length).toBeGreaterThan(0))
    expect(session.settlement()).toMatchObject({ rootTurnGen: 0, rootIdle: false })
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement().rootTurnGen).toBe(1))
    // autoContinue off: the driver settles the turn at once.
    expect(session.settlement()).toEqual({ rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true })

    // A background shell task keeps the session from being quiescent until its notification.
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'npm test', session_id: 'sess-1', uuid: 'u1' })
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(false))
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'bash-1', status: 'completed', output_file: '', summary: 'ok', session_id: 'sess-1', uuid: 'u2' })
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(true))

    // An attached MCP server waits for a restart: not quiescent.
    const pg = mcpSpec({ id: 'mcp-pg', name: 'pg', roles: ['engineer', 'lead'], secretEnv: [] })
    servers.push(pg)
    sdk.status = [{ name: 'pg', status: 'connected', tools: [{ name: 'query' }] }]
    await (session as unknown as { addMcpServer(x: McpServerSpec): Promise<unknown> }).addMcpServer(pg)
    expect(session.settlement().quiescent).toBe(false)
  })

  it('a deferred turn end keeps the session unsettled until the restart decides; the restart notes activity', async () => {
    const servers: McpServerSpec[] = []
    const { session, activity } = start({
      autoContinue: true,
      continuationDelayMs: 10,
      mcpServers: () => servers,
      resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} }))
    })
    const q = await firstQuery()
    q.emit(init)
    await vi.waitFor(() => expect(q.inputs.length).toBeGreaterThan(0))
    const pg = mcpSpec({ id: 'mcp-pg', name: 'pg', roles: ['engineer', 'lead'], secretEnv: [] })
    servers.push(pg)
    sdk.status = [{ name: 'pg', status: 'connected', tools: [{ name: 'query' }] }]
    await (session as unknown as { addMcpServer(x: McpServerSpec): Promise<unknown> }).addMcpServer(pg)
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement().rootTurnGen).toBe(1))
    const s = session.settlement()
    expect(s.quiescent).toBe(false)
    expect(s.continuationSettled).toBe(false)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), { timeout: MCP_RESTART_DELAY_MS + 3000 })
    expect(activity).toContain('restart')
  }, 10_000)

  it('continuation settling: the turn-1 set-plan nudge is sent, then the follow-up turn settles', async () => {
    const { session, activity } = start({ autoContinue: true, continuationDelayMs: 10 })
    const q = await firstQuery()
    q.emit(init)
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement().nudgeTurn1Sent).toBe(true))
    expect(session.settlement().continuationSettled).toBe(false)
    expect(activity).toContain('message')
    q.emit(init)
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement()).toMatchObject({ rootTurnGen: 2, rootIdle: true, continuationSettled: true, quiescent: true }))
    expect(activity).toContain('continuation')
  })

  it('a failed turn is skipped by the driver (settled at once, no nudge)', async () => {
    const { session } = start({ autoContinue: true, continuationDelayMs: 10 })
    const q = await firstQuery()
    q.emit(init)
    q.emit(result('error_during_execution'))
    await vi.waitFor(() => expect(session.settlement().rootTurnGen).toBe(1))
    expect(session.settlement()).toMatchObject({ continuationSettled: true, nudgeTurn1Sent: false })
    await new Promise((r) => setTimeout(r, 50))
    expect(session.settlement().nudgeTurn1Sent).toBe(false)
  })

  it('subagent start and report finish note activity', async () => {
    const { activity } = start()
    const q = await firstQuery()
    q.emit(init)
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu1', subagent_type: 'engineer', description: 'Do it', session_id: 'sess-1', uuid: 'u1' })
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', output_file: '', summary: 'done', session_id: 'sess-1', uuid: 'u2' })
    await vi.waitFor(() => expect(activity).toEqual(expect.arrayContaining(['subagent', 'report'])))
  })

  it('a finished report keeps the session unsettled until the SDK resumes the root with it, or the grace passes', async () => {
    const { session } = start({ continuationDelayMs: 300 })
    const q = await firstQuery()
    q.emit(init)
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu1', subagent_type: 'engineer', description: 'Do it', session_id: 'sess-1', uuid: 'u1' })
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement()).toMatchObject({ rootTurnGen: 1, rootIdle: true, quiescent: true }))
    // The report lands while the root is idle: the SDK is about to start a turn with its result.
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', output_file: '', summary: 'done', session_id: 'sess-1', uuid: 'u2' })
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(false))
    expect(session.settlement().rootIdle).toBe(true)
    // The hand-back turn starts: in flight, then settled again after its result.
    q.emit(init)
    await vi.waitFor(() => expect(session.settlement().rootIdle).toBe(false))
    q.emit(result())
    await vi.waitFor(() => expect(session.settlement()).toMatchObject({ rootTurnGen: 2, rootIdle: true, quiescent: true }))

    // A second report whose hand-back never comes: quiescent again once the grace has passed.
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a2', tool_use_id: 'tu2', subagent_type: 'engineer', description: 'More', session_id: 'sess-1', uuid: 'u3' })
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a2', status: 'completed', output_file: '', summary: 'done', session_id: 'sess-1', uuid: 'u4' })
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(false))
    await new Promise((r) => setTimeout(r, 350))
    expect(session.settlement().quiescent).toBe(true)
  })

  describe('budget (cli-spec 6.2(3))', () => {
    it('a stored project cap of 0 means no cap outside exec (ctx.budgetUsd 0 is the real $0 budget)', async () => {
      start({}, { maxBudgetUsd: 0 })
      const q = await firstQuery()
      expect('maxBudgetUsd' in q.options).toBe(false)
    })

    it('ctx.budgetUsd replaces the project budget (0 included); no budget leaves the option unset', async () => {
      start({ budgetUsd: 0.5 }, { maxBudgetUsd: 5 })
      expect((await firstQuery()).options.maxBudgetUsd).toBe(0.5)
      sdk.queries.length = 0
      start({ budgetUsd: 0 }, { maxBudgetUsd: 5 })
      expect((await firstQuery()).options.maxBudgetUsd).toBe(0)
      sdk.queries.length = 0
      start({ budgetUsd: 2 })
      expect((await firstQuery()).options.maxBudgetUsd).toBe(2)
      sdk.queries.length = 0
      start()
      expect('maxBudgetUsd' in (await firstQuery()).options).toBe(false)
    })

    it('a restarted query gets ctx.budgetUsd minus this run cost', async () => {
      const servers: McpServerSpec[] = []
      const { session } = start(
        { budgetUsd: 1, mcpServers: () => servers, resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })) },
        { maxBudgetUsd: 5 }
      )
      const q = await firstQuery()
      expect(q.options.maxBudgetUsd).toBe(1)
      q.emit(init)
      await vi.waitFor(() => expect(q.inputs.length).toBeGreaterThan(0))
      const pg = mcpSpec({ id: 'mcp-pg', name: 'pg', roles: ['engineer', 'lead'], secretEnv: [] })
      servers.push(pg)
      sdk.status = [{ name: 'pg', status: 'connected', tools: [{ name: 'query' }] }]
      await (session as unknown as { addMcpServer(x: McpServerSpec): Promise<unknown> }).addMcpServer(pg)
      q.emit(result('success', { total_cost_usd: 0.4 }))
      await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), { timeout: MCP_RESTART_DELAY_MS + 3000 })
      expect(sdk.queries[1]!.options.maxBudgetUsd).toBeCloseTo(0.6, 6)
    }, 10_000)
  })
})
