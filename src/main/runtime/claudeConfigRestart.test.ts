import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    private waiters: { resolve: (r: IteratorResult<Msg>) => void; reject: (e: Error) => void }[] = []
    private done = false
    private failure?: Error
    /** Manual mode (state.manualRead at construction): the CLI reads its input only when the test calls read(). */
    private reader?: AsyncIterator<Msg>
    constructor(
      prompt: AsyncIterable<Msg>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly options: Record<string, any>
    ) {
      if (state.manualRead) {
        this.reader = prompt[Symbol.asyncIterator]()
        return
      }
      void (async () => {
        for await (const m of prompt) this.inputs.push(m)
        this.inputClosed = true
        // state.lingerAfterInput: the CLI keeps emitting after its input closed until the test ends it (sdk-facts check 12).
        if (!state.lingerAfterInput) this.end()
      })()
    }
    inputClosed = false
    /** Manual mode: read the next input message (resolves once one is pushed). */
    async read(): Promise<Msg | undefined> {
      const r = await this.reader!.next()
      if (r.done) return undefined
      this.inputs.push(r.value)
      return r.value
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
    /** The CLI process dies (a restarted query that fails before its init). */
    fail(e: Error): void {
      this.failure = e
      for (const w of this.waiters.splice(0)) w.reject(e)
    }
    [Symbol.asyncIterator](): AsyncIterator<Msg> {
      return {
        next: () => {
          if (this.failure) return Promise.reject(this.failure)
          if (this.out.length) return Promise.resolve({ value: this.out.shift()!, done: false })
          if (this.done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
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
  const state = { FakeQuery, queries: [] as FakeQuery[], status: [] as { name: string; status: string; tools?: { name: string }[] }[], manualRead: false, lingerAfterInput: false }
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

import { BACKGROUND_HANDBACK_WAIT_MS, ClaudeSession, HOST_CHANGE_LEAD, MCP_NOTICE_TOOL_CAP, MCP_RESTART_DELAY_MS, RESTART_WAIT_WARN_TURNS, configChangeNotice } from './claude'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { fakeCtx, mcpSpec, project, role, runSummary } from './testHelpers'
import type { RunSkill, RuntimeContext } from './types'

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
  sdk.manualRead = false
  sdk.lingerAfterInput = false
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

  it('mid-turn, no restart needed: nothing goes to the input; the notice rides on the next message, once (eager reader)', async () => {
    // The fake CLI here reads every pushed message at once, as the SDK's Query.streamInput does (sdk.mjs): a notice
    // pushed mid-turn would be in the CLI's hands, and a turn that ends before reading it would start one of its own.
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { ctx, session, q1 } = await running(servers)
    const before = q1.inputs.length
    servers[0] = { ...gh, roles: [] }
    expect(await host(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    await sleep(100)
    // Regression (review H1, third round): it was pushed to the input mid-turn.
    expect(q1.inputs.length).toBe(before)
    expect(rows(ctx).some((b) => b.detail?.includes(HOST_CHANGE_LEAD))).toBe(true)
    // The turn ends without another tool round: still nothing for the CLI to start a turn with.
    q1.emit(result)
    await sleep(100)
    expect(q1.inputs.length).toBe(before)
    await session.send('next step')
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 1))
    const sent = String((q1.inputs.at(-1)!.message as { content: unknown }).content)
    expect(sent).toContain(HOST_CHANGE_LEAD)
    expect(sent).toContain('next step')
    // Regression (review L3): an ungrant said "The MCP server github is attached now."
    expect(sent).not.toContain('The MCP server github is attached now.')
    expect(sent).toContain('The MCP server github was already attached; which roles may use it changed.')
    expect(sent).toContain('No role in the org chart is granted it, so no agent can call it in this run.')
    // Exactly once: a later harness message does not repeat it.
    await session.nudge('Harness: keep going.')
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 2))
    expect(texts(q1).match(/The user changed this project/g)).toHaveLength(1)
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

  it('rejects for a setup-like or ending session', async () => {
    const setup = await running([], { run: runSummary({ kind: 'setup' }) })
    await expect(host(setup.session, { skills: true })).rejects.toThrow('Setup-like runs')
    const servers: McpServerSpec[] = []
    const { session } = await running(servers)
    await session.stop()
    await expect(host(session, { skills: true })).rejects.toThrow('ending')
  })

  it('never widens beyond the live grants: an ungrant the user saves is refused at the next call, with no restart', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    const eng = { agent_id: 'a1', agent_type: 'engineer' }
    const gate = async (tool: string) =>
      ((await hooksOf(q1, 'PreToolUse')({ ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: `tu-${Math.random()}`, ...eng }, 'x', {})) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
      }).hookSpecificOutput
    expect((await gate('mcp__github__list'))?.permissionDecision).not.toBe('deny')
    servers[0] = { ...gh, roles: [] }
    expect(await host(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    const denied = await gate('mcp__github__list')
    expect(denied?.permissionDecision).toBe('deny')
    expect(denied?.permissionDecisionReason).toContain('does not grant the MCP server "github"')
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 400)
    expect(sdk.queries).toHaveLength(1)
  }, 10_000)

  it('a second host change while a restart is being built is not lost, and neither starts a turn', async () => {
    const servers: McpServerSpec[] = []
    let hold: Promise<void> | undefined
    let resolvedCalls = 0
    const { session, q1 } = await running(servers, {
      resolvedMcpServers: async () => {
        resolvedCalls += 1
        if (hold) await hold
        return servers.map((spec) => ({ spec, env: {}, headers: {} }))
      }
    })
    q1.emit(result)
    await sleep(50)
    const before = q1.inputs.length
    servers.push(notes())
    expect((await host(session, { mcp: { upserted: ['notes'], removed: [] } })).availability).toBe('after-idle')
    // The restart at idle is being built (buildOptions waits on the resolved server list) when the second change lands.
    let release!: () => void
    hold = new Promise<void>((r) => (release = r))
    const calls = resolvedCalls
    await vi.waitFor(() => expect(resolvedCalls).toBeGreaterThan(calls), restartWait)
    servers.push(mcpSpec({ id: 'mcp-docs', name: 'docs', roles: ['engineer'], secretEnv: [] }))
    const second = host(session, { mcp: { upserted: ['docs'], removed: [] } })
    release()
    hold = undefined
    expect((await second).availability).toBe('after-idle')
    await vi.waitFor(() => expect(sdk.queries.length).toBeGreaterThanOrEqual(2), restartWait)
    const s = session as unknown as { restartDue(): boolean }
    // Either the restart already took the second change (the build reads the live list) or it is still due for the next one.
    const latest = sdk.queries.at(-1)!
    expect(latest.options.agents.engineer.tools).toContain('mcp__notes')
    expect(latest.options.agents.engineer.tools.includes('mcp__docs') || s.restartDue()).toBe(true)
    await sleep(MCP_RESTART_DELAY_MS + 400)
    // No turn of its own: nothing reached any query's input.
    expect(q1.inputs.length).toBe(before)
    for (const q of sdk.queries.slice(1)) expect(q.inputs).toHaveLength(0)
  }, 20_000)
})

const skillDirs: string[] = []
afterEach(() => {
  for (const d of skillDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})
function skill(name: string, roleIds: string[]): RunSkill {
  const root = mkdtempSync(join(tmpdir(), 'orgai-cfg-skill-'))
  skillDirs.push(root)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nUse ${name}.`)
  return { id: `id-${name}`, name, description: `${name} desc`, dir, files: [{ path: 'SKILL.md', bytes: 1 }], roleIds }
}

describe('Claude hostConfigChanged: a change the user saves never starts a turn (review fixes)', () => {
  it('H1: a restart for the user\'s change alone that cannot start pauses for the user, never auto-resumed', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let skills = [alpha]
    const { ctx, session, q1 } = await running([], { skills: () => skills })
    q1.emit(result)
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    skills = [alpha, skill('beta', ['r-lead'])]
    expect((await host(session, { skills: true })).availability).toBe('after-idle')
    // Restart at once (idle); every restarted query dies before its init.
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(sdk.queries).toHaveLength(i + 1), restartWait)
      sdk.queries[i]!.fail(new Error('spawn failed'))
    }
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(true))
    const paused = ctx.events.find((e) => e.type === 'run.status' && e.status === 'paused') as { autoResume?: boolean; pausedUntil?: number; pauseReason?: string }
    // Regression: autoResume was true with pausedUntil 5 minutes ahead, so RunManager continued the run (RESUME_TEXT).
    expect(paused.autoResume).toBe(false)
    expect(paused.pausedUntil).toBeUndefined()
    expect(paused.pauseReason).toBe('The session could not be resumed after the change you made in OrgAI. Your change could not be applied to this session; the run waits for your next message.')
    // L3: the fallback's notice names the user's change, not one "approved this run".
    const detail = rows(ctx).map((b) => b.detail ?? '').find((d) => d.includes('could not be applied to this session')) ?? ''
    expect(detail).toContain('The skill changes the user made in OrgAI could not be applied to this session')
    expect(detail).not.toContain('approved this run')
    // Nothing reached any query's input: the notices waited for the user.
    for (const q of sdk.queries.slice(1)) expect(q.inputs).toHaveLength(0)
  }, 20_000)

  it('H1 counterpart: a restart that also carries the run\'s own change keeps the automatic resume', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let skills = [alpha]
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers, { skills: () => skills })
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    skills = [alpha, skill('beta', ['r-lead'])]
    await host(session, { skills: true })
    q1.emit(result)
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(sdk.queries).toHaveLength(i + 1), restartWait)
      sdk.queries[i]!.fail(new Error('spawn failed'))
    }
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(true))
    const paused = ctx.events.find((e) => e.type === 'run.status' && e.status === 'paused') as { autoResume?: boolean; pausedUntil?: number }
    expect(paused.autoResume).toBe(true)
    expect(paused.pausedUntil).toBeGreaterThan(Date.now())
  }, 20_000)

  const unread = (s: ClaudeSession) => (s as unknown as { input: { peek(): unknown[] } }).input.peek()
  const contentOf = (m: Record<string, unknown> | undefined) => String((m?.message as { content: unknown } | undefined)?.content)

  it('M1: a host change mid-turn, then an interrupt: nothing reaches the CLI until the user\'s next message, which carries it once', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    const before = q1.inputs.length
    servers[0] = { ...gh, roles: [] }
    await host(session, { mcp: { upserted: ['github'], removed: [] } })
    await session.interrupt()
    q1.emit({ ...result, subtype: 'error_during_execution' })
    await sleep(100)
    expect(q1.inputs.length).toBe(before)
    await session.send('go on')
    await vi.waitFor(() => expect(q1.inputs.length).toBe(before + 1))
    const sent = String((q1.inputs.at(-1)!.message as { content: unknown }).content)
    expect(sent).toContain(HOST_CHANGE_LEAD)
    expect(sent).toContain('go on')
    expect(texts(q1).match(/The user changed this project/g)).toHaveLength(1)
  })

  it('M (third round): a hand-back turn run on the closing query leaves the root idle, and a later restart still happens', async () => {
    sdk.lingerAfterInput = true
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    q1.emit(result)
    await sleep(50)
    servers.push(notes())
    await host(session, { mcp: { upserted: ['notes'], removed: [] } })
    await vi.waitFor(() => expect(q1.inputClosed).toBe(true), restartWait)
    // The CLI runs a hand-back turn on the closing query: the root works, and its result is skipped (nextQuery).
    q1.emit({ type: 'assistant', message: { id: 'm-hb', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Reading the report.' }] }, parent_tool_use_id: null, session_id: 's', uuid: 'a-hb' })
    await sleep(50)
    q1.emit(result)
    await sleep(50)
    q1.end()
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2))
    const s = session as unknown as { restartState(): { rootIdle: boolean }; rootBusy(): boolean }
    // Regression: the root stayed 'thinking' for ever, so rootIdle was false and no restart could happen again.
    expect(s.restartState().rootIdle).toBe(true)
    expect(s.rootBusy()).toBe(false)
    servers.push(mcpSpec({ id: 'mcp-docs', name: 'docs', roles: ['engineer'], secretEnv: [] }))
    expect((await host(session, { mcp: { upserted: ['docs'], removed: [] } })).availability).toBe('after-idle')
    const q2 = sdk.queries[1]!
    await vi.waitFor(() => expect(q2.inputClosed).toBe(true), restartWait)
    q2.end()
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(3), restartWait)
    expect(sdk.queries[2]!.options.agents.engineer.tools).toContain('mcp__docs')
  }, 20_000)

  it('L (third round): a restarted query that dies before its init takes its waiting notice back; retry and fallback each say it once', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    q1.emit(result)
    await sleep(50)
    servers.push(notes())
    await host(session, { mcp: { upserted: ['notes'], removed: [] } })
    const inEffect = (b: { text?: string }) => !!b.text?.startsWith('Configuration change in effect')
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    await vi.waitFor(() => expect(rows(ctx).filter(inEffect)).toHaveLength(1))
    sdk.queries[1]!.fail(new Error('spawn failed'))
    // The retry announces again.
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(3), restartWait)
    await vi.waitFor(() => expect(rows(ctx).filter(inEffect)).toHaveLength(2))
    const q3 = sdk.queries[2]!
    await session.send('one')
    await vi.waitFor(() => expect(q3.inputs).toHaveLength(1))
    // Regression: the dead query's notice was still waiting, so the message carried "attached now" twice.
    expect(texts(q3).match(/The MCP server notes is attached now\./g)).toHaveLength(1)
    // q3 dies before its init too, after reading the message: the fallback replays it without the notice.
    q3.fail(new Error('spawn failed'))
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(4), restartWait)
    const q4 = sdk.queries[3]!
    await vi.waitFor(() => expect(q4.inputs).toHaveLength(1))
    expect(texts(q4)).toContain('one')
    expect(texts(q4)).not.toContain('attached now')
    await session.send('two')
    await vi.waitFor(() => expect(q4.inputs).toHaveLength(2))
    // The fallback's notice comes once, and no "in effect" for the change it could not apply.
    expect(texts(q4)).not.toContain('attached now')
    expect(texts(q4).match(/could not be attached to this session/g)).toHaveLength(1)
  }, 20_000)

  it('L (third round): a notice moved out at an interrupt before a restarted query\'s init is not replayed when that query dies', async () => {
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    q1.emit(result)
    await sleep(50)
    // Restarted queries read their input only when the test says so.
    sdk.manualRead = true
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    // The restart's own notice and a harness message wait unread for the new query (before its init).
    await vi.waitFor(() => expect(unread(session)).toHaveLength(1))
    await session.nudge('Harness: check the plan.')
    expect(unread(session)).toHaveLength(2)
    await session.interrupt()
    expect(unread(session)).toHaveLength(0)
    sdk.queries[1]!.fail(new Error('spawn failed'))
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(3), restartWait)
    const q3 = sdk.queries[2]!
    await sleep(100)
    expect(unread(session)).toHaveLength(0)
    await session.send('go on')
    const sent = contentOf(await q3.read())
    // Regression: both were replayed into the retry and moved to the held notices a second time.
    expect(sent.match(/Harness: check the plan\./g)).toHaveLength(1)
    expect(sent.match(/The MCP server notes is attached now\./g)).toHaveLength(1)
    expect(sent).toContain('go on')
  }, 20_000)

  it('M2: the trailing init and empty result of a query closed for a restart are no turn', async () => {
    sdk.lingerAfterInput = true
    const turnEnds = vi.fn()
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers, { onRootTurnEnded: turnEnds })
    q1.emit(result)
    await vi.waitFor(() => expect(turnEnds).toHaveBeenCalledTimes(1))
    servers.push(notes())
    await host(session, { mcp: { upserted: ['notes'], removed: [] } })
    // The restart at idle closes q1's input; the CLI then emits one more init and an empty result (sdk-facts check 12).
    await vi.waitFor(() => expect(q1.inputClosed).toBe(true), restartWait)
    q1.emit(init)
    q1.emit({ ...result, result: '' })
    await sleep(50)
    q1.end()
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2))
    await sleep(MCP_RESTART_DELAY_MS + 200)
    // Regression: the trailing result was reported as a root turn end (and handed to the continuation driver).
    expect(turnEnds).toHaveBeenCalledTimes(1)
    expect((session as unknown as { turnInFlight: boolean }).turnInFlight).toBe(false)
  }, 15_000)

  it('M2: a query closed for a restart and killed between its trailing init and result leaves no turn in flight', async () => {
    sdk.lingerAfterInput = true
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    q1.emit(result)
    await sleep(50)
    servers.push(notes())
    await host(session, { mcp: { upserted: ['notes'], removed: [] } })
    await vi.waitFor(() => expect(q1.inputClosed).toBe(true), restartWait)
    q1.emit(init)
    await sleep(50)
    // The close timer kills it before its result.
    q1.end()
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2))
    // Regression: turnInFlight stayed true for ever (rootBusy always true, every later restart blocked).
    expect((session as unknown as { turnInFlight: boolean }).turnInFlight).toBe(false)
    expect((session as unknown as { rootBusy(): boolean }).rootBusy()).toBe(false)
  }, 15_000)

  it('L1: a background report that stops while the orchestrator is idle holds the restart before its notification arrives', async () => {
    const servers: McpServerSpec[] = []
    const { ctx, session, q1 } = await running(servers)
    await backgroundReport(ctx, q1, 'a1', 't1')
    servers.push(notes())
    await change(session, { mcp: { upserted: ['notes'], removed: [] } })
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 400)
    expect(sdk.queries).toHaveLength(1)
    // SubagentStop only: its task_notification (and the CLI's hand-back turn) come later than the restart check.
    await hooksOf(q1, 'SubagentStop')({ ...base, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'engineer', stop_hook_active: false }, 'x', {})
    await sleep(MCP_RESTART_DELAY_MS + 600)
    // Regression: the check reportSettled scheduled found nothing running and closed the input before the hand-back.
    expect(sdk.queries).toHaveLength(1)
  }, 15_000)
})

describe('configChangeNotice caps (review L4)', () => {
  it('caps the removed servers, the roles per server and the roles per skill', () => {
    const many = Array.from({ length: MCP_NOTICE_TOOL_CAP + 3 }, (_, i) => ({ name: `Role ${i}`, slug: `role-${i}` }))
    const text = configChangeNotice({
      servers: [{ name: 'gh', tools: [], roles: many }],
      removed: Array.from({ length: MCP_NOTICE_TOOL_CAP + 2 }, (_, i) => `srv${i}`),
      skills: [{ name: 'alpha', roles: many }]
    })
    expect(text).toContain(`Role ${MCP_NOTICE_TOOL_CAP - 1} (role-${MCP_NOTICE_TOOL_CAP - 1}), and 3 more.`)
    expect(text).not.toContain(`Role ${MCP_NOTICE_TOOL_CAP} (`)
    expect(text).toContain(`srv${MCP_NOTICE_TOOL_CAP - 1}, and 2 more were removed or turned off`)
    expect(text).not.toContain(`srv${MCP_NOTICE_TOOL_CAP},`)
    expect(text).toContain(`alpha for Role 0 (role-0)`)
    expect((text.match(/, and 3 more/g) ?? []).length).toBe(2)
  })
})
