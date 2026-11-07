import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, Role } from '@shared/types'

// Multi-provider org charts (bridged reports) on the Claude adapter. Only `query` is faked (a scripted stand-in for the
// CLI, as in claudeConfigChange.test.ts); the in-process harness server is the real SDK module.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    setMcpCalls: Record<string, unknown>[] = []
    private out: Msg[] = []
    private waiters: ((r: IteratorResult<Msg>) => void)[] = []
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
// buildRolePrompt is the real one, wrapped so tests can read the flags the adapter passes.
vi.mock('./prompts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./prompts')>()
  return { ...orig, buildRolePrompt: vi.fn(orig.buildRolePrompt) }
})

import { ClaudeSession, MCP_RESTART_DELAY_MS, buildAgents, bridgedSpawnDenial } from './claude'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { harnessToolsFor } from './harnessTools'
import { buildRolePrompt } from './prompts'
import { fakeCtx, mcpSpec, project, role } from './testHelpers'
import { ROOT_AGENT_ID, type BridgeSpawnInput, type BridgedRole, type RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

/** Lead (root) -> engineer (a lead itself) + reviewer + analyst (bridged, on OpenAI). The engineer may spawn the analyst. */
function chart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev', 'r-ext'] }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read', 'Edit'], reportsTo: 'r-lead', canSpawn: true, spawnable: ['r-ext'] }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', tools: ['Read'], reportsTo: 'r-lead' }),
    role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: 'r-lead', model: 'gpt-5' })
  ]
}
const BRIDGED: BridgedRole = { roleId: 'r-ext', slug: 'analyst', name: 'Analyst', connection: 'openai', connectionName: 'OpenAI', adapter: 'codex' }

const dirs: string[] = []
const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  sdk.status = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

function fakeBridge(text = 'Analysis done.') {
  const spawn = vi.fn(async (input: BridgeSpawnInput) => {
    input.onStarted?.({ agentId: 'b1', handle: 'analyst-1' })
    return { agentId: 'b1', handle: 'analyst-1', text, ok: true }
  })
  return { roles: () => [BRIDGED], spawn }
}

function start(over: Partial<RuntimeContext> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-bridge-')))
  dirs.push(dir)
  const roles = over.roles ?? chart()
  const ctx = fakeCtx({ project: project({ path: dir, roles, isolateWriters: false }), roles, autoContinue: false, ...over })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  return { ctx, session }
}
async function firstQuery(): Promise<Fake> {
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  return sdk.queries[0]!
}
const preToolUse = (q: Fake) => q.options.hooks.PreToolUse[0].hooks[0] as (i: unknown, id: string, o: unknown) => Promise<HookOut>
const hookCall = (tool: string, tool_input: Record<string, unknown>, tool_use_id: string, agent?: { id: string; type: string }) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's',
  transcript_path: '',
  cwd: '/repo',
  tool_name: tool,
  tool_input,
  tool_use_id,
  ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {})
})
const delegate = (q: Fake) => {
  const handler = q.options.mcpServers.orgai.instance._registeredTools.delegate_agent
  return (args: Record<string, unknown>, id?: string) => handler.handler(args, id ? { _meta: { 'claudecode/toolUseId': id } } : {}) as Promise<{ content: { text: string }[] }>
}
const orgaiTools = (tools: string[]) => tools.filter((t) => t.startsWith('mcp__orgai__')).map((t) => t.slice('mcp__orgai__'.length))
const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', claude_code_version: 'test', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: {}, result: 'ok', is_error: false, usage: {} }

describe('Claude bridged reports: agent definitions and prompts', () => {
  it('a bridged role gets no AgentDefinition; the others do, and every prompt gets the bridged marks', () => {
    const ctx = fakeCtx({ project: project({ roles: chart() }), roles: chart(), bridge: fakeBridge() })
    vi.mocked(buildRolePrompt).mockClear()
    const agents = buildAgents(ctx, harnessToolsFor(ctx), false)
    expect(Object.keys(agents).sort()).toEqual(['engineer', 'lead', 'reviewer'])
    const flags = vi.mocked(buildRolePrompt).mock.calls.map((c) => c[3]!)
    expect(flags).toHaveLength(3)
    for (const f of flags) expect(f).toMatchObject({ bridgedRoles: [BRIDGED], bridgeVia: 'delegate_agent' })
    for (const f of flags) expect('bridged' in f).toBe(false)
    // The lead's prompt marks the analyst "delegate with delegate_agent".
    expect(agents.lead!.prompt).toContain('- analyst (runs on OpenAI: delegate with delegate_agent, not the Agent tool)')
  })

  it('without ctx.bridge nothing changes: every role has a definition and no bridged flags', () => {
    const ctx = fakeCtx({ project: project({ roles: chart() }), roles: chart() })
    vi.mocked(buildRolePrompt).mockClear()
    const agents = buildAgents(ctx, harnessToolsFor(ctx), false)
    expect(Object.keys(agents).sort()).toEqual(['analyst', 'engineer', 'lead', 'reviewer'])
    for (const c of vi.mocked(buildRolePrompt).mock.calls) expect('bridgedRoles' in c[3]!).toBe(false)
    expect(orgaiTools(agents.lead!.tools!)).not.toContain('delegate_agent')
  })

  it('delegate_agent is whitelisted for the root and every canSpawn role, never for a plain report', async () => {
    start({ bridge: fakeBridge() })
    const q = await firstQuery()
    expect(q.options.agents.analyst).toBeUndefined()
    expect(orgaiTools(q.options.agents.lead.tools)).toContain('delegate_agent')
    expect(orgaiTools(q.options.agents.engineer.tools)).toContain('delegate_agent')
    expect(orgaiTools(q.options.agents.reviewer.tools)).not.toContain('delegate_agent')
  })

  it('a restarted query (MCP attach at idle) still builds no definition for the bridged role', async () => {
    const servers: McpServerSpec[] = []
    const { session } = start({ bridge: fakeBridge(), mcpServers: () => servers, resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })) })
    const q1 = await firstQuery()
    q1.emit(init)
    await vi.waitFor(() => expect(q1.inputs.length).toBeGreaterThan(0))
    servers.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['engineer'], secretEnv: [] }))
    sdk.status = [{ name: 'notes', status: 'connected', tools: [{ name: 'read' }] }]
    const change = (session as unknown as { configChanged(x: ConfigChange): Promise<ConfigChangeResult> }).configChanged({ mcp: { upserted: ['notes'], removed: [] } })
    expect((await change).availability).toBe('after-idle')
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), { timeout: MCP_RESTART_DELAY_MS + 3000 })
    const q2 = sdk.queries[1]!
    expect(q2.options.agents.engineer.tools).toContain('mcp__notes')
    expect(q2.options.agents.analyst).toBeUndefined()
    expect(orgaiTools(q2.options.agents.lead.tools)).toContain('delegate_agent')
  }, 10_000)
})

describe('Claude bridged reports: the spawn gate', () => {
  it('denies an Agent / Task spawn of a bridged role, naming the connection and delegate_agent', async () => {
    start({ bridge: fakeBridge() })
    const q = await firstQuery()
    const reason = 'Analyst runs on OpenAI: call delegate_agent instead'
    for (const tool of ['Agent', 'Task']) {
      const root = await preToolUse(q)(hookCall(tool, { subagent_type: 'analyst', prompt: 'x', description: 'd' }, `tu-${tool}`), 'x', {})
      expect(root.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: reason })
    }
    const lead = await preToolUse(q)(hookCall('Agent', { subagent_type: 'analyst', prompt: 'x' }, 'tu-eng', { id: 'a1', type: 'engineer' }), 'x', {})
    expect(lead.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: reason })
    expect(bridgedSpawnDenial(fakeCtx({ bridge: fakeBridge() }), 'engineer')).toBeUndefined()
  })

  it('a native spawn of a non-bridged role still passes, and a refusal lists only native slugs', async () => {
    start({ bridge: fakeBridge() })
    const q = await firstQuery()
    const ok = await preToolUse(q)(hookCall('Agent', { subagent_type: 'reviewer', prompt: 'x', name: 'reviewer-1' }, 'tu-ok'), 'x', {})
    expect(ok.hookSpecificOutput?.permissionDecision).toBeUndefined()
    const bad = await preToolUse(q)(hookCall('Agent', { subagent_type: 'nobody', prompt: 'x' }, 'tu-bad'), 'x', {})
    expect(bad.hookSpecificOutput?.permissionDecisionReason).toBe('The org chart does not let lead spawn "nobody". Allowed subagent_type values: engineer, reviewer.')
  })
})

describe('Claude bridged reports: delegate_agent through the harness server', () => {
  it('the hook allows it with the node in "tool" state; the root call reaches bridge.spawn with no parent (the root)', async () => {
    const bridge = fakeBridge()
    const { ctx } = start({ bridge })
    const q = await firstQuery()
    const out = await preToolUse(q)(hookCall('mcp__orgai__delegate_agent', { role: 'analyst', brief: 'Look.' }, 'tu-d1'), 'x', {})
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow')
    const rootUpserts = ctx.events.flatMap((e) => (e.type === 'agent.upsert' && e.agent.id === ROOT_AGENT_ID ? [e.agent] : []))
    expect(rootUpserts.at(-1)).toMatchObject({ state: 'tool', activity: 'Delegating to analyst on another connection…' })
    const res = await delegate(q)({ role: 'analyst', brief: 'Look.' }, 'tu-d1')
    expect(bridge.spawn).toHaveBeenCalledTimes(1)
    const input = bridge.spawn.mock.calls[0]![0]
    expect(input).toMatchObject({ role: 'r-ext', brief: 'Look.' })
    expect(input.parentAgentId).toBeUndefined()
    expect(input.parentRoleId).toBeUndefined()
    expect(res.content[0]!.text).toContain('Bridged report analyst-1 (Analyst) finished.')
    expect(res.content[0]!.text).toContain('Analysis done.')
  })

  it('a report lead\'s call passes its agent id and role id', async () => {
    const bridge = fakeBridge()
    const { ctx } = start({ bridge })
    const q = await firstQuery()
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', subagent_type: 'engineer', tool_use_id: 'tu-spawn', description: 'work', session_id: 's', uuid: 'u1' })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.id === 'a1' && e.agent.roleId === 'r-eng')).toBe(true))
    await preToolUse(q)(hookCall('mcp__orgai__delegate_agent', { role: 'analyst', brief: 'Check.' }, 'tu-d2', { id: 'a1', type: 'engineer' }), 'x', {})
    await delegate(q)({ role: 'analyst', brief: 'Check.' }, 'tu-d2')
    expect(bridge.spawn.mock.calls[0]![0]).toMatchObject({ role: 'r-ext', brief: 'Check.', parentAgentId: 'a1', parentRoleId: 'r-eng' })
  })
})

describe('Claude bridged child session (ctx.bridgedChild)', () => {
  const childRoles = (): Role[] => [role({ id: 'r-ext', slug: 'analyst', name: 'Analyst', tools: ['Read'], reportsTo: null })]
  const child = { agentId: 'b1', parentAgentId: ROOT_AGENT_ID, roleId: 'r-ext' }

  it('its root gets the report prompt and no root-audience harness tools', async () => {
    vi.mocked(buildRolePrompt).mockClear()
    start({ roles: childRoles(), bridgedChild: child })
    const q = await firstQuery()
    const flags = vi.mocked(buildRolePrompt).mock.calls.map((c) => c[3]!)
    expect(flags.at(-1)).toMatchObject({ bridged: true })
    expect('bridgedRoles' in flags.at(-1)!).toBe(false)
    const tools = orgaiTools(q.options.agents.analyst.tools)
    for (const t of ['set_plan', 'update_plan', 'complete_plan', 'ask_user', 'propose_org_change', 'message_run', 'delegate_agent']) expect(tools).not.toContain(t)
    expect(q.options.agents.analyst.prompt).toContain('You were delegated this work by another agent of the team')
  })

  it('never nudges: a finished turn leaves the input as it was', async () => {
    start({ roles: childRoles(), bridgedChild: child, continuationDelayMs: 0 })
    const q = await firstQuery()
    q.emit(init)
    await vi.waitFor(() => expect(q.inputs.length).toBe(1))
    q.emit(result)
    await new Promise((r) => setTimeout(r, 150))
    expect(q.inputs).toHaveLength(1)
  })
})
