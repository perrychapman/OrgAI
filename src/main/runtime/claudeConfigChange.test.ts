import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec } from '@shared/types'

// Only `query` is faked (a scripted stand-in for the CLI), as in claude.test.ts.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    setMcpCalls: Record<string, unknown>[] = []
    inputClosed = false
    private out: Msg[] = []
    private waiters: { resolve: (r: IteratorResult<Msg>) => void; reject: (e: Error) => void }[] = []
    private done = false
    private failure?: Error
    constructor(
      readonly prompt: AsyncIterable<Msg>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly options: Record<string, any>
    ) {
      void (async () => {
        for await (const m of prompt) this.inputs.push(m)
        this.inputClosed = true
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
    fail(e: Error): void {
      this.failure = e
      for (const w of this.waiters.splice(0)) w.reject(e)
    }
    get ended(): boolean {
      return this.done
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

import { ClaudeSession, MCP_RESTART_DELAY_MS, configChangeNotice, grantSnapshot, grantsGained, mcpDefinitionKey } from './claude'
import { livePluginNames, pluginStale } from './claudeSkills'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { fakeCtx, mcpSpec, project } from './testHelpers'
import type { RunSkill, RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

const dirs: string[] = []
function tmp(prefix = 'orgai-cfg-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function skill(name: string, roleIds: string[]): RunSkill {
  const dir = join(tmp('orgai-cfg-skill-'), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nUse ${name}.`)
  return { id: `id-${name}`, name, description: `${name} desc`, dir, files: [{ path: 'SKILL.md', bytes: 1 }], roleIds }
}

const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  sdk.status = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function start(servers: McpServerSpec[], over: Partial<RuntimeContext> = {}) {
  const ctx = fakeCtx({
    project: project({ path: tmp() }),
    autoContinue: false,
    mcpServers: () => servers,
    resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })),
    ...over
  })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  return { ctx, session }
}
const change = (s: ClaudeSession, c: ConfigChange) => (s as unknown as { configChanged(x: ConfigChange): Promise<ConfigChangeResult> }).configChanged(c)
const attach = (s: ClaudeSession, spec: McpServerSpec) => (s as unknown as { addMcpServer(x: McpServerSpec): Promise<unknown> }).addMcpServer(spec)
const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', claude_code_version: 'test', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: {}, result: 'ok', is_error: false, usage: {} }
const restartWait = { timeout: MCP_RESTART_DELAY_MS + 3000 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (q: Fake) => q.inputs.map((m) => String((m.message as { content: unknown }).content)).join('\n')
const preToolUse = (q: Fake) => q.options.hooks.PreToolUse[0].hooks[0] as (i: unknown, id: string, o: unknown) => Promise<HookOut>
const call = (tool: string, input: Record<string, unknown> = {}, agent?: { id: string; type: string }) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-1',
  transcript_path: '',
  cwd: '/repo',
  tool_name: tool,
  tool_input: input,
  tool_use_id: `tu-${Math.random()}`,
  ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {})
})
const decide = async (q: Fake, tool: string, input: Record<string, unknown> = {}, agent?: { id: string; type: string }) =>
  (await preToolUse(q)(call(tool, input, agent), 'x', {})).hookSpecificOutput?.permissionDecision
const eng = { id: 'a1', type: 'engineer' }

async function running(servers: McpServerSpec[], over: Partial<RuntimeContext> = {}) {
  const run = start(servers, over)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  const q1 = sdk.queries[0]!
  q1.emit(init)
  await vi.waitFor(() => expect(q1.inputs.length).toBeGreaterThan(0))
  return { ...run, q1 }
}

describe('ClaudeSession configChanged: MCP (fake query)', () => {
  it('a new server: setMcpServers with the live list at once, after-idle with its tools, then a restart with widened definitions and a notice', async () => {
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    servers.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['engineer'], secretEnv: [] }))
    sdk.status = [{ name: 'notes', status: 'connected', tools: [{ name: 'read' }] }]
    expect(await change(session, { mcp: { upserted: ['notes'], removed: [] } })).toEqual({ availability: 'after-idle', tools: { notes: ['read'] } })
    expect(Object.keys(q1.setMcpCalls[0]!).sort()).toEqual(['notes', 'orgai'])
    expect(sdk.queries).toHaveLength(1)
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    expect(q2.options.resume).toBe('sess-1')
    expect(q2.options.agents.engineer.tools).toContain('mcp__notes')
    expect(q2.options.agents.reviewer.tools).not.toContain('mcp__notes')
    await vi.waitFor(() => expect(texts(q2)).toContain('The MCP server notes is attached now. Its tools: mcp__notes__read.'))
    expect(texts(q2)).toContain('Roles that may use it: Engineer (engineer).')
  }, 10_000)

  it('a removed server leaves every attach record: not in setMcpServers, the restart, its definitions or the notice', async () => {
    const servers: McpServerSpec[] = []
    const { session, q1 } = await running(servers)
    const pg = mcpSpec({ id: 'mcp-pg', name: 'pg', roles: ['engineer'], secretEnv: [] })
    servers.push(pg)
    sdk.status = [{ name: 'pg', status: 'connected', tools: [{ name: 'query' }] }]
    await attach(session, pg)
    servers.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['engineer'], secretEnv: [] }))
    sdk.status = [...sdk.status, { name: 'notes', status: 'connected', tools: [{ name: 'read' }] }]
    expect((await change(session, { mcp: { upserted: ['notes'], removed: [] } })).availability).toBe('after-idle')
    // The user removes pg before the restart: a pure removal is in effect at once (the gate denies it).
    servers.splice(servers.indexOf(pg), 1)
    expect(await change(session, { mcp: { upserted: [], removed: ['pg'] } })).toEqual({ availability: 'now' })
    expect(Object.keys(q1.setMcpCalls.at(-1)!)).not.toContain('pg')
    expect(await decide(q1, 'mcp__pg__query', {}, eng)).toBe('deny')
    expect((session as unknown as { attachedMcp: Set<string> }).attachedMcp.has('pg')).toBe(false)
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    expect(Object.keys(q2.options.mcpServers)).not.toContain('pg')
    expect(Object.keys(q2.options.mcpServers)).toContain('notes')
    expect(q2.options.agents.engineer.tools).not.toContain('mcp__pg')
    await vi.waitFor(() => expect(texts(q2)).toContain('The MCP server notes is attached now.'))
    expect(texts(q2)).not.toContain('The MCP server pg is attached now.')
    expect(texts(q2)).toContain('The MCP server pg was removed or turned off: its tools are no longer available.')
  }, 10_000)

  it('an ungrant or a disable needs no restart: now, and the MCP gate denies at the next call', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    expect(await decide(q1, 'mcp__github__list', {}, eng)).not.toBe('deny')
    servers[0] = { ...gh, roles: ['lead'] }
    // Moving it to the root is a gain for the root (its whitelist did not name the server): a restart is due.
    const regrant = await change(session, { mcp: { upserted: ['github'], removed: [] } })
    expect(regrant.availability).toBe('after-idle')
    servers[0] = { ...gh, roles: [] }
    expect(await change(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    const denied = (await preToolUse(q1)(call('mcp__github__list', {}, eng), 'x', {})).hookSpecificOutput
    expect(denied?.permissionDecision).toBe('deny')
    expect(denied?.permissionDecisionReason).toContain('does not grant the MCP server "github"')
    servers[0] = { ...gh, enabled: false }
    expect(await change(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    expect((await preToolUse(q1)(call('mcp__github__list'), 'x', {})).hookSpecificOutput?.permissionDecisionReason).toContain('turned off')
    // Nothing a restart would add any more: the pending regrant is dropped and no restart happens.
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 300)
    expect(sdk.queries).toHaveLength(1)
  }, 10_000)

  it('a re-granted server reaches the root after a restart, and the notice names it with its roles', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, q1 } = await running(servers)
    expect(q1.options.agents.lead.tools).not.toContain('mcp__github')
    servers[0] = { ...gh, roles: ['engineer', 'lead'] }
    sdk.status = [{ name: 'github', status: 'connected', tools: [{ name: 'list' }] }]
    expect((await change(session, { mcp: { upserted: ['github'], removed: [] } })).availability).toBe('after-idle')
    // A regrant of an unchanged definition does not count as an agent install.
    expect((session as unknown as { attachedMcp: Set<string> }).attachedMcp.has('github')).toBe(false)
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    expect(q2.options.agents.lead.tools).toContain('mcp__github')
    await vi.waitFor(() => expect(texts(q2)).toContain('The MCP server github is attached now.'))
    expect(texts(q2)).toContain('Roles that may use it: Lead (lead), Engineer (engineer).')
  }, 10_000)
})

describe('ClaudeSession configChanged: skills (fake query)', () => {
  const pluginPath = (q: Fake): string => q.options.plugins?.[0]?.path

  it('a new skill rebuilds the plugin at the restart; the old dir is removed only after the new query sent init', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let skills = [alpha]
    const { session, q1 } = await running([], { skills: () => skills })
    const oldPath = pluginPath(q1)
    expect(existsSync(oldPath)).toBe(true)
    skills = [alpha, skill('beta', ['r-lead'])]
    expect(await change(session, { skills: true })).toEqual({ availability: 'after-idle' })
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    const newPath = pluginPath(q2)
    expect(newPath).not.toBe(oldPath)
    expect((q2.options.skills as string[]).some((s) => s.endsWith(':beta'))).toBe(true)
    expect(existsSync(join(newPath, 'skills', 'beta', 'SKILL.md'))).toBe(true)
    expect(existsSync(oldPath)).toBe(true)
    await vi.waitFor(() => expect(texts(q2)).toContain('Skills in this session now:'))
    expect(texts(q2)).toMatch(/orgai-[0-9a-f]{8}:beta for Lead \(lead\)/)
    q2.emit(init)
    await vi.waitFor(() => expect(existsSync(oldPath)).toBe(false))
    expect(existsSync(newPath)).toBe(true)
    // The gate now follows the new plugin's names.
    const qualified = (q2.options.skills as string[]).find((s) => s.endsWith(':beta'))!
    expect(await decide(q2, 'Skill', { skill: qualified })).not.toBe('deny')
  }, 10_000)

  it('a failed restart falls back to the old plugin (kept) and tells the orchestrator the skill changes wait', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let skills = [alpha]
    const { ctx, session, q1 } = await running([], { skills: () => skills })
    const oldPath = pluginPath(q1)
    skills = [alpha, skill('beta', ['r-lead'])]
    await change(session, { skills: true })
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const newPath = pluginPath(sdk.queries[1]!)
    sdk.queries[1]!.fail(new Error('spawn failed'))
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(3))
    // First failure: the same rebuilt plugin again.
    expect(pluginPath(sdk.queries[2]!)).toBe(newPath)
    sdk.queries[2]!.fail(new Error('spawn failed'))
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(4))
    const q4 = sdk.queries[3]!
    expect(pluginPath(q4)).toBe(oldPath)
    expect(existsSync(oldPath)).toBe(true)
    await vi.waitFor(() => expect(texts(q4)).toContain('The skill changes approved this run could not be applied to this session'))
    q4.emit(init)
    await vi.waitFor(() => expect(existsSync(newPath)).toBe(false))
    expect(existsSync(oldPath)).toBe(true)
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(false)
  }, 15_000)

  it('the pause after failed config restarts says so', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let skills = [alpha]
    const { ctx, session, q1 } = await running([], { skills: () => skills })
    skills = [alpha, skill('beta', ['r-lead'])]
    await change(session, { skills: true })
    q1.emit(result)
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(sdk.queries).toHaveLength(i + 1), restartWait)
      sdk.queries[i]!.fail(new Error('spawn failed'))
    }
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'paused')).toBe(true))
    expect(ctx.events.find((e) => e.type === 'run.status' && e.status === 'paused')).toMatchObject({ pauseReason: 'The session could not be resumed after a configuration change.' })
  }, 15_000)

  it('an ungrant or a removal takes effect at the next Skill call without a restart', async () => {
    const alpha = skill('alpha', ['r-lead', 'r-eng'])
    let skills = [alpha]
    const { session, q1 } = await running([], { skills: () => skills })
    const qualified = (q1.options.skills as string[])[0]!
    expect(await decide(q1, 'Skill', { skill: qualified }, eng)).not.toBe('deny')
    skills = [{ ...alpha, roleIds: ['r-lead'] }]
    expect(await change(session, { skills: true })).toEqual({ availability: 'now' })
    expect(await decide(q1, 'Skill', { skill: qualified }, eng)).toBe('deny')
    expect(await decide(q1, 'Skill', { skill: qualified })).not.toBe('deny')
    skills = []
    expect(await change(session, { skills: true })).toEqual({ availability: 'now' })
    expect(await decide(q1, 'Skill', { skill: qualified })).toBe('deny')
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 300)
    expect(sdk.queries).toHaveLength(1)
  }, 10_000)

  it('a grant the plugin and the role\'s Skill tool already cover is now: the gate allows it at once', async () => {
    const alpha = skill('alpha', ['r-lead'])
    const beta = skill('beta', ['r-eng'])
    let skills = [alpha, beta]
    const { session, q1 } = await running([], { skills: () => skills })
    const qAlpha = (q1.options.skills as string[]).find((s) => s.endsWith(':alpha'))!
    expect(await decide(q1, 'Skill', { skill: qAlpha }, eng)).toBe('deny')
    skills = [{ ...alpha, roleIds: ['r-lead', 'r-eng'] }, beta]
    expect(await change(session, { skills: true })).toEqual({ availability: 'now' })
    expect(await decide(q1, 'Skill', { skill: qAlpha }, eng)).not.toBe('deny')
  })

  it('a skill whose files changed (update) makes the plugin stale', async () => {
    const alpha = skill('alpha', ['r-lead'])
    const { session } = await running([], { skills: () => [alpha] })
    writeFileSync(join(alpha.dir, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\nNew instructions.')
    expect(await change(session, { skills: true })).toEqual({ availability: 'after-idle' })
  })

  it('an unreadable skill list fails the Skill gate closed', async () => {
    const alpha = skill('alpha', ['r-lead'])
    let broken = false
    const { q1 } = await running([], {
      skills: () => {
        if (broken) throw new Error('store gone')
        return [alpha]
      }
    })
    const qualified = (q1.options.skills as string[])[0]!
    broken = true
    const out = (await preToolUse(q1)(call('Skill', { skill: qualified }), 'x', {})).hookSpecificOutput
    expect(out?.permissionDecision).toBe('deny')
    expect(out?.permissionDecisionReason).toContain('could not check which skills')
  })
})

describe('config change helpers', () => {
  it('grantsGained counts only additions', () => {
    const a = grantSnapshot({ lead: { description: '', prompt: '', tools: ['Read', 'mcp__gh'], mcpServers: ['gh'] } })
    const lost = grantSnapshot({ lead: { description: '', prompt: '', tools: ['Read'], mcpServers: [] } })
    const more = grantSnapshot({ lead: { description: '', prompt: '', tools: ['Read', 'mcp__gh', 'Skill'], mcpServers: ['gh'] } })
    expect(grantsGained(a, lost)).toBe(false)
    expect(grantsGained(a, a)).toBe(false)
    expect(grantsGained(a, more)).toBe(true)
    expect(grantsGained(undefined, a)).toBe(true)
  })

  it('mcpDefinitionKey ignores roles and enabled, and changes with what runs', () => {
    const s = mcpSpec({ roles: ['a'] })
    expect(mcpDefinitionKey({ ...s, roles: ['b'], enabled: false })).toBe(mcpDefinitionKey(s))
    expect(mcpDefinitionKey({ ...s, args: ['-y', 'other@1.0.0'] })).not.toBe(mcpDefinitionKey(s))
    expect(mcpDefinitionKey({ ...s, env: { A: '1' } })).not.toBe(mcpDefinitionKey(s))
  })

  it('configChangeNotice names servers, removals and skills through datum', () => {
    const text = configChangeNotice({
      servers: [{ name: 'notes', tools: ['read'], roles: [{ name: 'Lead', slug: 'lead' }] }],
      removed: ['old'],
      skills: [{ name: 'orgai-12345678:alpha', roles: [{ name: 'Lead', slug: 'lead' }] }]
    })
    expect(text).toContain('The MCP server notes is attached now. Its tools: mcp__notes__read.')
    expect(text).toContain('The MCP server old was removed or turned off: its tools are no longer available.')
    expect(text).toContain('Skills in this session now: orgai-12345678:alpha for Lead (lead).')
    expect(configChangeNotice({ servers: [], removed: [], skills: [] })).toBe('[OrgAI harness] The configuration change approved this run is in effect now. No skills are granted in this session now.')
    expect(configChangeNotice({ servers: [], removed: [], skills: null })).toContain("The project's skills changed")
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `p:s${i}`, roles: [] }))
    expect(configChangeNotice({ servers: [], removed: [], skills: many })).toContain(', and 5 more.')
  })

  it('livePluginNames carries live grants and drops removed or renamed skills; pluginStale', () => {
    const a: RunSkill = { id: 'a', name: 'alpha', description: 'd', dir: '/x', files: [], roleIds: ['r1'] }
    const plugin = { names: new Map([['p:alpha', a]]), digests: new Map([['a', 'd1']]) }
    expect(livePluginNames(plugin, [{ ...a, roleIds: ['r2'] }]).get('p:alpha')?.roleIds).toEqual(['r2'])
    expect(livePluginNames(plugin, []).size).toBe(0)
    expect(livePluginNames(plugin, [{ ...a, name: 'renamed' }]).size).toBe(0)
    const digest = (s: RunSkill) => (s.id === 'a' ? 'd1' : 'dx')
    expect(pluginStale(plugin, [a], digest)).toBe(false)
    expect(pluginStale(plugin, [{ ...a, roleIds: [] }, { ...a, id: 'b', name: 'beta', roleIds: [] }], digest)).toBe(false)
    expect(pluginStale(plugin, [a, { ...a, id: 'b', name: 'beta' }], digest)).toBe(true)
    expect(pluginStale(plugin, [a], () => 'd2')).toBe(true)
    expect(pluginStale(undefined, [a], digest)).toBe(true)
    // A skill left out of the plugin and unchanged since is not retried.
    expect(pluginStale({ ...plugin, refused: new Map([['b', 'dx']]) }, [a, { ...a, id: 'b', name: 'beta' }], digest)).toBe(false)
  })
})
