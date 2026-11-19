import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Role } from '@shared/types'

// When an approved (or host) config change reaches a live Claude session: the restart at the first safe boundary, the
// hand-back race, the "still waiting" log, and hostConfigChanged's notice rules. Only `query` is faked (a scripted
// stand-in for the CLI); message and hook shapes follow claudeSplit.test.ts (sdk-facts check 12). No tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    setMcpCalls: Record<string, unknown>[] = []
    private out: Msg[] = []
    private waiters: ((r: IteratorResult<Msg>) => void)[] = []
    private done = false
    constructor(
      prompt: AsyncIterable<Msg>,
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
      if (w) w({ value: m, done: false })
      else this.out.push(m)
    }
    end(): void {
      this.done = true
      for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
    }
    [Symbol.asyncIterator](): AsyncIterator<Msg> {
      return {
        next: () => {
          if (this.out.length) return Promise.resolve({ value: this.out.shift()!, done: false })
          if (this.done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve) => this.waiters.push(resolve))
        }
      }
    }
    async setMcpServers(rec: Record<string, unknown>) {
      this.setMcpCalls.push(rec)
      return { added: Object.keys(rec), removed: [], errors: {} }
    }
    async mcpServerStatus() {
      return state.status
    }
    async interrupt() {}
    async stopTask() {}
    close(): void {
      this.end()
    }
  }
  const state = { FakeQuery, queries: [] as FakeQuery[], status: [] as { name: string; status: string; tools?: { name: string }[] }[] }
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

import { BACKGROUND_HANDBACK_WAIT_MS, ClaudeSession, HOST_CHANGE_LEAD, MCP_RESTART_DELAY_MS, RESTART_WAIT_WARN_TURNS } from './claude'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { fakeCtx, mcpSpec, project, role, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hook = (i: unknown, id: string, o: unknown) => Promise<any>

const sessions: ClaudeSession[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  sdk.status = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

const roles = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead' })
]

async function running(servers: McpServerSpec[], over: Partial<RuntimeContext> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-cfg-restart-')))
  dirs.push(dir)
  const rs = roles()
  const ctx = fakeCtx({
    project: project({ path: dir, roles: rs, isolateWriters: false }),
    roles: rs,
    run: runSummary(),
    autoContinue: false,
    mcpServers: () => servers,
    resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })),
    ...over
  })
  // Every server the tests add answers mcpServerStatus at once (an unknown one is polled for up to 5 s).
  sdk.status = ['notes', 'docs', 'github'].map((name) => ({ name, status: 'connected', tools: [{ name: 'read' }] }))
  const first = sdk.queries.length
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(first + 1))
  const q1 = sdk.queries[first]!
  q1.emit(init)
  await vi.waitFor(() => expect(q1.inputs.length).toBeGreaterThan(0))
  return { ctx, session, q1 }
}

const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', claude_code_version: 'test', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: {}, result: 'ok', is_error: false, usage: {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const restartWait = { timeout: MCP_RESTART_DELAY_MS + 4000 }
const texts = (q: Fake) => q.inputs.map((m) => String((m.message as { content: unknown }).content)).join('\n')
const change = (s: ClaudeSession, c: ConfigChange) => (s as unknown as { configChanged(x: ConfigChange): Promise<ConfigChangeResult> }).configChanged(c)
const notes = () => mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['engineer'], secretEnv: [] })
const hooksOf = (q: Fake, name: string): Hook => q.options.hooks[name][0].hooks[0]
const base = { session_id: 'sess-1', transcript_path: '', cwd: '/repo' }
const logs = (ctx: { events: unknown[] }, level = 'warn') =>
  (ctx.events as { type: string; level?: string; message?: string }[]).filter((e) => e.type === 'log' && e.level === level).map((e) => e.message ?? '')
const rows = (ctx: { events: unknown[] }) =>
  (ctx.events as { type: string; entry?: { block: { kind: string; text?: string; detail?: string } } }[]).filter((e) => e.type === 'transcript' && e.entry?.block.kind === 'system').map((e) => e.entry!.block)

/** A report the root launched in the background (Agent call `tu`, agent `id`), running. */
async function backgroundReport(ctx: { events: unknown[] }, q: Fake, id: string, tu: string) {
  await hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'Do it', subagent_type: 'engineer', name: 'eng-1', description: 'Work', run_in_background: true }, tool_use_id: tu, agent_type: 'lead' },
    'x',
    {}
  )
  q.emit({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_agent', tool_use_id: tu, subagent_type: 'engineer', description: 'work', session_id: 's', uuid: `u-${id}` })
  await vi.waitFor(() =>
    expect((ctx.events as { type: string; agent?: { id: string; spawnToolUseId?: string } }[]).some((e) => e.type === 'agent.upsert' && e.agent?.id === id && e.agent.spawnToolUseId === tu)).toBe(true)
  )
  await hooksOf(q, 'PostToolUse')(
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: id }, tool_use_id: tu, agent_type: 'lead' },
    'x',
    {}
  )
}

/** The background report ends (SubagentStop, then its task_notification) while the orchestrator is idle. */
async function backgroundEnds(q: Fake, id: string, tu: string) {
  await hooksOf(q, 'SubagentStop')({ ...base, hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'engineer', stop_hook_active: false }, 'x', {})
  q.emit({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: tu, status: 'completed', output_file: '', summary: 'done', session_id: 's', uuid: `n-${id}` })
}

describe('Claude config restart: the first safe boundary', () => {
  it('a turn the CLI starts on its own (init, no assistant message yet) holds the restart until its result', async () => {
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    servers.push(notes())
    expect((await change(session, { mcp: { upserted: ['notes'], removed: [] } })).availability).toBe('after-idle')
    q1.emit(result)
    // Before the restart check runs, the CLI starts a hand-back turn: init only, the model is still thinking.
    await sleep(MCP_RESTART_DELAY_MS / 3)
    q1.emit(init)
    await sleep(MCP_RESTART_DELAY_MS + 600)
    // Regression: the root showed 'idle' until its first assistant message, so the old query was closed mid-turn.
    expect(sdk.queries).toHaveLength(1)
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    expect(sdk.queries[1]!.options.agents.engineer.tools).toContain('mcp__notes')
  }, 15_000)

  it('a background report that ends while the orchestrator is idle lets the restart go ahead, even when the CLI never hands it back', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    await backgroundReport(ctx, q1, 'a1', 't1')
    servers.push(notes())
    expect((await change(session, { mcp: { upserted: ['notes'], removed: [] } })).availability).toBe('after-idle')
    // The turn ends with the report still running: blocked.
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 400)
    expect(sdk.queries).toHaveLength(1)
    await backgroundEnds(q1, 'a1', 't1')
    // The hand-back is due: no restart while the CLI may still start the turn that reads the report.
    await sleep(MCP_RESTART_DELAY_MS + 400)
    expect(sdk.queries).toHaveLength(1)
    // The CLI never starts that turn: once the bounded wait is over the restart goes ahead (regression: nothing ever
    // checked again, so the change waited for an event that never came).
    const now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now + BACKGROUND_HANDBACK_WAIT_MS + 1000)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    expect(sdk.queries[1]!.options.agents.engineer.tools).toContain('mcp__notes')
    expect(logs(ctx)).toContain('A background report ended but the orchestrator was not resumed with it; the session no longer waits for that.')
  }, 20_000)

  it('a background report handed back normally: the restart follows the hand-back turn', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    await backgroundReport(ctx, q1, 'a1', 't1')
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    q1.emit(result)
    await backgroundEnds(q1, 'a1', 't1')
    q1.emit(init)
    await sleep(MCP_RESTART_DELAY_MS + 400)
    expect(sdk.queries).toHaveLength(1)
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    await vi.waitFor(() => expect(texts(sdk.queries[1]!)).toContain('The MCP server notes is attached now.'))
  }, 15_000)

  it('says so in the run log when no safe boundary comes within a few turn ends', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    // A report that keeps running across the orchestrator's turns.
    q1.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', tool_use_id: 't1', subagent_type: 'engineer', description: 'work', session_id: 's', uuid: 'u-a1' })
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    for (let i = 0; i < RESTART_WAIT_WARN_TURNS; i++) {
      if (i) q1.emit(init)
      q1.emit(result)
    }
    await vi.waitFor(() => expect(logs(ctx).some((m) => m.includes(`has waited ${RESTART_WAIT_WARN_TURNS} turns for the session to restart (reports are still running)`))).toBe(true))
    expect(logs(ctx).filter((m) => m.includes('turns for the session to restart')).length).toBe(1)
    expect(sdk.queries).toHaveLength(1)
  }, 10_000)
})

const host = (s: ClaudeSession, c: ConfigChange) => s.hostConfigChanged(c)

describe('Claude hostConfigChanged (fake query)', () => {
  it('idle, restart needed: restarts at once, but the notice waits for the user\'s next message (no turn of its own)', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    q1.emit(result)
    servers.push(notes())
    sdk.status = [{ name: 'notes', status: 'connected', tools: [{ name: 'read' }] }]
    expect(await host(session, { mcp: { upserted: ['notes'], removed: [] } })).toEqual({ availability: 'after-idle', tools: { notes: ['read'] } })
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    expect(q2.options.agents.engineer.tools).toContain('mcp__notes')
    await vi.waitFor(() => expect(rows(ctx).some((b) => b.detail?.includes('The MCP server notes is attached now.'))).toBe(true))
    await sleep(200)
    expect(q2.inputs).toHaveLength(0)
    await session.send('next step please')
    await vi.waitFor(() => expect(q2.inputs).toHaveLength(1))
    const sent = texts(q2)
    expect(sent).toContain(HOST_CHANGE_LEAD)
    expect(sent).toContain('Its tools: mcp__notes__read.')
    expect(sent).toContain('Roles that may use it: Engineer (engineer).')
    expect(sent).toContain('next step please')
    expect(sent.match(/The user changed this project/g)).toHaveLength(1)
  }, 15_000)

  it('mid-turn, no restart needed: delivered in line at once', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    const before = q1.inputs.length
    servers[0] = { ...gh, roles: [] }
    expect(await host(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 1))
    const text = texts(q1)
    expect(text).toContain(HOST_CHANGE_LEAD)
    expect(text).toContain('The MCP server github is attached now.')
    expect(text).toContain('No role in the org chart is granted it, so no agent can call it in this run.')
  })

  it('idle, no restart needed: no turn; the notice comes with the next message to the orchestrator', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { ctx, session, q1 } = await running(servers)
    q1.emit(result)
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    const before = q1.inputs.length
    servers.splice(0, 1)
    expect(await host(session, { mcp: { upserted: [], removed: ['github'] } })).toEqual({ availability: 'now' })
    await sleep(100)
    expect(q1.inputs.length).toBe(before)
    expect(rows(ctx).some((b) => b.detail?.includes('The MCP server github was removed or turned off'))).toBe(true)
    // A harness message (here the delegation nudge path) carries it.
    await session.nudge('Harness: keep going.')
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 1))
    const last = String((q1.inputs.at(-1)!.message as { content: unknown }).content)
    expect(last).toContain(HOST_CHANGE_LEAD)
    expect(last).toContain('Harness: keep going.')
    await session.send('thanks')
    expect(texts(q1).match(/The user changed this project/g)).toHaveLength(1)
  })

  it('held by an interrupt: kept for the user\'s next message', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    await session.interrupt()
    q1.emit({ ...result, subtype: 'error_during_execution' })
    await sleep(50)
    const before = q1.inputs.length
    servers[0] = { ...gh, enabled: false }
    expect(await host(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    await sleep(100)
    expect(q1.inputs.length).toBe(before)
    await session.send('go on')
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 1))
    expect(String((q1.inputs.at(-1)!.message as { content: unknown }).content)).toContain(HOST_CHANGE_LEAD)
  })

  it('coalesced with this run\'s own approved change: one restart notice, delivered (the orchestrator was promised it)', async () => {
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    servers.push(mcpSpec({ id: 'mcp-docs', name: 'docs', roles: ['engineer'], secretEnv: [] }))
    expect((await host(session, { mcp: { upserted: ['docs'], removed: [] } })).availability).toBe('after-idle')
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    await vi.waitFor(() => expect(texts(q2)).toContain('This notice also covers changes approved in this run.'))
    expect(texts(q2)).toContain('The MCP server notes is attached now.')
    expect(texts(q2)).toContain('The MCP server docs is attached now.')
    expect(q2.inputs).toHaveLength(1)
  }, 15_000)

  it('rejects for a setup-like or ending session; never widens beyond the live grants', async () => {
    const setup = await running([], { run: runSummary({ kind: 'setup' }) })
    await expect(host(setup.session, { skills: true })).rejects.toThrow('Setup-like runs')
    const servers: McpServerSpec[] = []
    const { session } = await running(servers)
    await session.stop()
    await expect(host(session, { skills: true })).rejects.toThrow('ending')
  })
})
