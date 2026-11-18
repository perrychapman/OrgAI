import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, McpServerSpec, Role } from '@shared/types'

// Org changes in the same run on the Claude adapter. Only `query` is faked (a scripted stand-in for the CLI), as in
// claudeConfigChange.test.ts; ctx.roles is changed in place by the real applyRosterChange, as RunManager does.
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

import { ClaudeSession, MCP_RESTART_DELAY_MS, configChangeNotice, rosterNoticeText } from './claude'
import type { ConfigChange, ConfigChangeResult } from './harnessTools'
import { applyRosterChange } from './runRoster'
import { fakeCtx, mcpSpec, orgChart, project, role, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type Roster = { added: string[]; changed: string[]; removed: string[] }
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }
type Hook = (i: unknown, id: string, o: unknown) => Promise<HookOut>

const dirs: string[] = []
const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  sdk.status = []
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

/** A team work run whose ctx.retiredRoles() and in-place roster change behave as RunManager's (runRoster.ts). */
function start(over: Partial<RuntimeContext> = {}, servers: McpServerSpec[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-roster-'))
  dirs.push(dir)
  const retired: Role[] = []
  const ctx = fakeCtx({
    project: project({ path: dir, maxSubagentDepth: undefined }),
    autoContinue: false,
    retiredRoles: () => retired,
    mcpServers: () => servers,
    resolvedMcpServers: async () => servers.map((spec) => ({ spec, env: {}, headers: {} })),
    ...over
  })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  /** Approve an org chart: RunManager's in-place apply, then the tool's configChanged call. */
  /** RunManager's in-place apply and, in the same tick, rosterApplied (as RunManager calls it). */
  const apply = (next: Role[]): Roster => {
    const applied = applyRosterChange({ running: ctx.roles, saved: next, proposed: next })
    retired.push(...applied.retired)
    const { added, changed, removed } = applied.change
    const roles = { added, changed, removed }
    session.rosterApplied(roles)
    return roles
  }
  const approve = async (next: Role[]): Promise<ConfigChangeResult> => {
    const applied = applyRosterChange({ running: ctx.roles, saved: next, proposed: next })
    retired.push(...applied.retired)
    const { added, changed, removed } = applied.change
    return change(session, { roles: { added, changed, removed } })
  }
  return { ctx, session, retired, approve, apply }
}

const change = (s: ClaudeSession, c: ConfigChange) => (s as unknown as { configChanged(x: ConfigChange): Promise<ConfigChangeResult> }).configChanged(c)
const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', claude_code_version: 'test', tools: [], mcp_servers: [] }
const result = { type: 'result', subtype: 'success', total_cost_usd: 0, modelUsage: {}, result: 'ok', is_error: false, usage: {} }
const restartWait = { timeout: MCP_RESTART_DELAY_MS + 3000 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (q: Fake) => q.inputs.map((m) => String((m.message as { content: unknown }).content)).join('\n')
const hooksOf = (q: Fake, name: string): Hook => q.options.hooks[name][0].hooks[0]
const base = { session_id: 'sess-1', transcript_path: '', cwd: '/repo' }
/** A native spawn by the root (no agent_id) or by `caller`. */
const spawn = (q: Fake, slug: string, caller?: { id: string; type: string }): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: slug, prompt: 'x', description: 'd' }, tool_use_id: `tu-${Math.random()}`, ...(caller ? { agent_id: caller.id, agent_type: caller.type } : {}) },
    'x',
    {}
  )
const toolCall = (q: Fake, tool: string, caller?: { id: string; type: string }): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: '/repo/a.ts' }, tool_use_id: `tu-${Math.random()}`, ...(caller ? { agent_id: caller.id, agent_type: caller.type } : {}) },
    'x',
    {}
  )
const decision = (o: HookOut) => o.hookSpecificOutput?.permissionDecision
const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? ''
const lastAgent = (ctx: { events: unknown[] }, id: string): AgentInstance | undefined =>
  (ctx.events as { type: string; agent?: AgentInstance }[]).filter((e) => e.type === 'agent.upsert' && e.agent?.id === id).at(-1)?.agent

async function running(over: Partial<RuntimeContext> = {}, servers: McpServerSpec[] = []) {
  const run = start(over, servers)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  const q1 = sdk.queries[0]!
  q1.emit(init)
  await vi.waitFor(() => expect(q1.inputs.length).toBeGreaterThan(0))
  return { ...run, q1 }
}

/** The run's chart with a new report under the lead, who may now spawn it. */
function withDocs(): Role[] {
  const next = orgChart()
  next[0]!.spawnable = [...next[0]!.spawnable, 'r-docs']
  next.push(role({ id: 'r-docs', slug: 'docs', name: 'Docs writer', tools: ['Read', 'Write'], reportsTo: 'r-lead' }))
  return next
}
/**
 * The run's chart without the reviewer. `tidy` also takes it off the lead's spawnable (what a real chart does: the lead
 * is then changed too); without it the change is a pure removal.
 */
function withoutReviewer(tidy = false): Role[] {
  const next = orgChart().filter((r) => r.id !== 'r-rev')
  if (tidy) next[0]!.spawnable = ['r-eng']
  return next
}

async function restarted(q: Fake): Promise<Fake> {
  const n = sdk.queries.length
  q.emit(result)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(n + 1), restartWait)
  return sdk.queries[n]!
}

describe('Claude org changes in the same run: liveRoster', () => {
  it('a team work run declares liveRoster; single, quick and setup runs do not, and refuse a roles change', async () => {
    const { session } = await running({ run: runSummary({ team: 'single' }) })
    expect(session.liveRoster).toBe(false)
    await expect(change(session, { roles: { added: [], changed: ['r-eng'], removed: [] } })).rejects.toThrow('apply from the next run')
    expect(start().session.liveRoster).toBe(true)
    expect(start({ run: runSummary({ kind: 'setup' }) }).session.liveRoster).toBe(false)
  })
})

describe('Claude org changes in the same run: add', () => {
  it('after-idle; the new role is refused until the restart, then defined, announced and spawnable', async () => {
    const { session, approve, q1 } = await running()
    expect(q1.options.agents.docs).toBeUndefined()
    expect(await approve(withDocs())).toEqual({ availability: 'after-idle' })
    // No definition in the running query yet: refused with a clear reason, never left to the CLI.
    const early = await spawn(q1, 'docs')
    expect(decision(early)).toBe('deny')
    expect(reason(early)).toContain('Docs writer joined this run\'s org chart; it can be delegated to once the agents are idle and the session restarts')
    // Roles the running query defines still spawn as before.
    expect(decision(await spawn(q1, 'engineer'))).not.toBe('deny')
    const q2 = await restarted(q1)
    expect(q2.options.resume).toBe('sess-1')
    expect(q2.options.agents.docs.tools).toEqual(expect.arrayContaining(['Read', 'Write']))
    expect(q2.options.agents.lead.prompt).toContain('docs')
    await vi.waitFor(() => expect(texts(q2)).toContain('The approved org chart is in place in this session now.'))
    expect(texts(q2)).toContain('Added or changed roles you can delegate to now (where the chart lets you): Docs writer (docs).')
    expect(decision(await spawn(q2, 'docs'))).not.toBe('deny')
    // The new role has no MCP server or skill grants of its own (an org change never grants).
    expect(q2.options.agents.docs.mcpServers).toBeUndefined()
    expect(q2.options.agents.docs.tools).not.toContain('Skill')
    void session
  }, 15_000)

  it('the automatic subagent depth stays as the run started when the change deepens the chart', async () => {
    const { approve, q1 } = await running()
    const depth = q1.options.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
    const next = orgChart()
    next[1]!.canSpawn = true
    next[1]!.spawnable = ['r-deep']
    next.push(role({ id: 'r-deep', slug: 'deep', name: 'Deep', reportsTo: 'r-eng' }))
    expect((await approve(next)).availability).toBe('after-idle')
    const q2 = await restarted(q1)
    expect(q2.options.agents.deep).toBeDefined()
    expect(q2.options.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe(depth)
  }, 15_000)
})

describe('Claude org changes in the same run: change', () => {
  it('a changed report is refused until the restart, then runs on its new definition', async () => {
    const { approve, q1 } = await running()
    const next = orgChart()
    next[1]!.tools = ['Read', 'Grep']
    next[1]!.prompt = 'You are the careful engineer.'
    expect(await approve(next)).toEqual({ availability: 'after-idle' })
    const early = await spawn(q1, 'engineer')
    expect(decision(early)).toBe('deny')
    expect(reason(early)).toContain('Engineer changed in this run\'s org chart')
    const q2 = await restarted(q1)
    expect(q2.options.agents.engineer.tools).toEqual(expect.arrayContaining(['Read', 'Grep']))
    expect(q2.options.agents.engineer.tools).not.toContain('Edit')
    expect(q2.options.agents.engineer.prompt).toContain('You are the careful engineer.')
    await vi.waitFor(() => expect(texts(q2)).toContain('Engineer (engineer)'))
    expect(decision(await spawn(q2, 'engineer'))).not.toBe('deny')
  }, 15_000)

  // The slug case is driven directly: RunManager now defers any card that changes a running role's slug (reason
  // `identity`), so applyRosterChange never produces it. This covers the adapter's defensive slug-history handling.
  it('a role whose slug changes: its old slug is refused at once, its new one after the restart', async () => {
    const { ctx, session, q1 } = await running()
    const role = ctx.roles.find((r) => r.id === 'r-rev')!
    role.slug = 'auditor'
    role.name = 'Auditor'
    const roles = { added: [], changed: ['r-rev'], removed: [] }
    session.rosterApplied(roles)
    expect((await change(session, { roles })).availability).toBe('after-idle')
    expect(reason(await spawn(q1, 'reviewer'))).toContain('Allowed subagent_type values: engineer, auditor.')
    expect(reason(await spawn(q1, 'auditor'))).toContain('Auditor changed in this run\'s org chart')
    const q2 = await restarted(q1)
    expect(q2.options.agents.reviewer).toBeUndefined()
    expect(decision(await spawn(q2, 'auditor'))).not.toBe('deny')
  }, 15_000)

  it('a name-only rename through applyRosterChange: after-idle, spawnable under its slug after the restart', async () => {
    const { approve, q1 } = await running()
    const next = orgChart()
    next[2]!.name = 'Auditor'
    expect((await approve(next)).availability).toBe('after-idle')
    const q2 = await restarted(q1)
    expect(decision(await spawn(q2, 'reviewer'))).not.toBe('deny')
  }, 15_000)

  it('the root: its lost tool is refused at once, and its prompt and tools come in line at the restart', async () => {
    const { approve, q1 } = await running()
    expect(q1.options.agents.lead.tools).toContain('Read')
    expect(decision(await toolCall(q1, 'Read'))).not.toBe('deny')
    const next = orgChart()
    next[0]!.tools = ['Grep']
    next[0]!.prompt = 'You lead with a light touch.'
    expect(await approve(next)).toEqual({ availability: 'after-idle' })
    const lost = await toolCall(q1, 'Read')
    expect(decision(lost)).toBe('deny')
    expect(reason(lost)).toContain('took Read off the orchestrator\'s role')
    // A tool the root still has is not refused.
    expect(decision(await toolCall(q1, 'Grep'))).not.toBe('deny')
    const q2 = await restarted(q1)
    expect(q2.options.agent).toBe('lead')
    expect(q2.options.agents.lead.tools).toContain('Grep')
    expect(q2.options.agents.lead.tools).not.toContain('Read')
    expect(q2.options.agents.lead.prompt).toContain('You lead with a light touch.')
    // The root keeps its model (live model switching owns it).
    expect(q2.options.model).toBe(q1.options.model)
    await vi.waitFor(() => expect(texts(q2)).toContain("Your own role's instructions and tools are the new chart's now."))
  }, 15_000)
})

describe('Claude org changes in the same run: remove', () => {
  it('now; a removed role is refused before and after the restart, which drops its definition', async () => {
    const { approve, q1 } = await running()
    expect(await approve(withoutReviewer())).toEqual({ availability: 'now' })
    const before = await spawn(q1, 'reviewer')
    expect(decision(before)).toBe('deny')
    expect(reason(before)).toContain('Reviewer was removed from the org chart in this run: no new agents of this role start')
    const q2 = await restarted(q1)
    expect(q2.options.agents.reviewer).toBeUndefined()
    await vi.waitFor(() => expect(texts(q2)).toContain('Removed from this run (no new agents of these): Reviewer.'))
    const after = await spawn(q2, 'reviewer')
    expect(decision(after)).toBe('deny')
    expect(reason(after)).toContain('Reviewer was removed from the org chart in this run')
  }, 15_000)

  it('a removal that also edits the lead\'s spawnable is after-idle (the root changed); the removed role is refused throughout', async () => {
    const { approve, q1 } = await running()
    expect(await approve(withoutReviewer(true))).toEqual({ availability: 'after-idle' })
    expect(reason(await spawn(q1, 'reviewer'))).toContain('Reviewer was removed from the org chart in this run')
    expect(decision(await spawn(q1, 'engineer'))).not.toBe('deny')
    const q2 = await restarted(q1)
    expect(q2.options.agents.reviewer).toBeUndefined()
    expect(reason(await spawn(q2, 'reviewer'))).toContain('Reviewer was removed from the org chart in this run')
  }, 15_000)

  it('a running report of a removed role keeps its name and tools and finishes normally; the restart waits for it', async () => {
    const { ctx, approve, q1 } = await running()
    q1.emit({ type: 'system', subtype: 'task_started', task_id: 'rv1', tool_use_id: 'tu-rv', subagent_type: 'reviewer', description: 'review', session_id: 's', uuid: 'u-rv' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'rv1')?.name).toBe('Reviewer'))
    expect((await approve(withoutReviewer())).availability).toBe('now')
    await hooksOf(q1, 'SubagentStart')({ ...base, hook_event_name: 'SubagentStart', agent_id: 'rv1', agent_type: 'reviewer' }, 'x', {})
    expect(lastAgent(ctx, 'rv1')).toMatchObject({ name: 'Reviewer', roleId: 'r-rev', roleSlug: 'reviewer' })
    // Its own calls are not refused for the removal (it finishes on its start-time definition).
    expect(decision(await toolCall(q1, 'Read', { id: 'rv1', type: 'reviewer' }))).not.toBe('deny')
    // The orchestrator's turn ends while the report runs: no restart yet.
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 300)
    expect(sdk.queries).toHaveLength(1)
    q1.emit({ type: 'system', subtype: 'task_notification', task_id: 'rv1', tool_use_id: 'tu-rv', status: 'completed', output_file: '', summary: 'done', session_id: 's', uuid: 'n-rv' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'rv1')?.state).toBe('done'))
    expect(lastAgent(ctx, 'rv1')?.name).toBe('Reviewer')
    // The hand-back turn ends: now the restart applies the chart.
    q1.emit(result)
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    expect(sdk.queries[1]!.options.agents.reviewer).toBeUndefined()
  }, 20_000)
})

describe('Claude org changes in the same run: coalescing', () => {
  it('a roles change and a pending MCP change share one restart and one notice', async () => {
    const servers: McpServerSpec[] = []
    const { session, approve, q1 } = await running({}, servers)
    servers.push(mcpSpec({ id: 'mcp-notes', name: 'notes', roles: ['engineer'], secretEnv: [] }))
    sdk.status = [{ name: 'notes', status: 'connected', tools: [{ name: 'read' }] }]
    expect((await change(session, { mcp: { upserted: ['notes'], removed: [] } })).availability).toBe('after-idle')
    expect((await approve(withDocs())).availability).toBe('after-idle')
    const q2 = await restarted(q1)
    expect(q2.options.agents.engineer.tools).toContain('mcp__notes')
    expect(q2.options.agents.docs).toBeDefined()
    await vi.waitFor(() => expect(texts(q2)).toContain('The approved org chart is in place in this session now.'))
    expect(texts(q2)).toContain('The MCP server notes is attached now.')
    await sleep(MCP_RESTART_DELAY_MS + 300)
    expect(sdk.queries).toHaveLength(2)
  }, 15_000)

  it('a later "nothing to restart for" MCP change does not drop a pending roles restart', async () => {
    const gh = mcpSpec({ name: 'github', roles: ['engineer'], secretEnv: [] })
    const servers = [gh]
    const { session, approve, q1 } = await running({}, servers)
    expect((await approve(withoutReviewer())).availability).toBe('now')
    servers[0] = { ...gh, roles: [] }
    expect(await change(session, { mcp: { upserted: ['github'], removed: [] } })).toEqual({ availability: 'now' })
    const q2 = await restarted(q1)
    expect(q2.options.agents.reviewer).toBeUndefined()
  }, 15_000)

  it('a change approved while the restart is being built is not lost: refused on that query, applied by the next', async () => {
    let hold: Promise<void> | undefined
    let release = (): void => {}
    let builds = 0
    const { approve, q1 } = await running({
      resolvedMcpServers: async () => {
        builds += 1
        if (hold) await hold
        return []
      }
    })
    expect((await approve(withDocs())).availability).toBe('after-idle')
    hold = new Promise<void>((r) => (release = r))
    const seen = builds
    q1.emit(result)
    await vi.waitFor(() => expect(builds).toBeGreaterThan(seen), restartWait)
    // Approved while the options are built: the next query does not count as holding it.
    const next = withDocs()
    next[0]!.spawnable = [...next[0]!.spawnable, 'r-qa']
    next.push(role({ id: 'r-qa', slug: 'qa', name: 'QA', reportsTo: 'r-lead' }))
    expect((await approve(next)).availability).toBe('after-idle')
    hold = undefined
    release()
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(2), restartWait)
    const q2 = sdk.queries[1]!
    q2.emit(init)
    expect(decision(await spawn(q2, 'docs'))).not.toBe('deny')
    expect(reason(await spawn(q2, 'qa'))).toContain('QA joined this run\'s org chart')
    // Still due: the next idle point restarts again and QA is in.
    const q3 = await restarted(q2)
    expect(q3.options.agents.qa).toBeDefined()
    expect(decision(await spawn(q3, 'qa'))).not.toBe('deny')
  }, 20_000)
})

describe('Claude org changes in the same run: rosterApplied (M1)', () => {
  /** Docs added, the engineer and the root changed (the root loses Read). */
  function addAndChange(): Role[] {
    const next = withDocs()
    next[0]!.tools = ['Grep']
    next[1]!.prompt = 'You are the careful engineer.'
    return next
  }

  it('rosterApplied alone: the added role, the changed role and the root\'s lost tool are refused at once', async () => {
    const { apply, q1 } = await running()
    expect(decision(await spawn(q1, 'engineer'))).not.toBe('deny')
    expect(decision(await toolCall(q1, 'Read'))).not.toBe('deny')
    expect(apply(addAndChange())).toEqual({ added: ['r-docs'], changed: expect.arrayContaining(['r-lead', 'r-eng']), removed: [] })
    // No configChanged yet: the gate already follows the live roster.
    expect(reason(await spawn(q1, 'docs'))).toContain('Docs writer joined this run\'s org chart')
    expect(reason(await spawn(q1, 'engineer'))).toContain('Engineer changed in this run\'s org chart')
    expect(reason(await toolCall(q1, 'Read'))).toContain('took Read off the orchestrator\'s role')
    expect(decision(await spawn(q1, 'reviewer'))).not.toBe('deny')
  })

  it('a configChanged that throws after rosterApplied leaves those roles refused for the session', async () => {
    let broken = false
    const { session, apply, q1 } = await running({
      mcpServers: () => {
        if (broken) throw new Error('config unreadable')
        return []
      }
    })
    broken = true
    // rosterApplied never throws, even when the live MCP list cannot be read (the root's lost tool is still refused).
    const roles = apply(addAndChange())
    await expect(change(session, { roles })).rejects.toThrow('config unreadable')
    expect(reason(await spawn(q1, 'docs'))).toContain('Docs writer joined')
    expect(reason(await spawn(q1, 'engineer'))).toContain('Engineer changed')
    expect(reason(await toolCall(q1, 'Read'))).toContain('took Read off')
    // No restart was scheduled, and the refusals hold after the turn ends.
    q1.emit(result)
    await sleep(MCP_RESTART_DELAY_MS + 300)
    expect(sdk.queries).toHaveLength(1)
    expect(decision(await spawn(q1, 'docs'))).toBe('deny')
    expect(decision(await spawn(q1, 'engineer'))).toBe('deny')
  }, 15_000)

  it('the normal sequence (rosterApplied, then configChanged) restarts at idle and then allows the roles', async () => {
    const { session, apply, q1 } = await running()
    const roles = apply(addAndChange())
    expect(await change(session, { roles })).toEqual({ availability: 'after-idle' })
    expect(decision(await spawn(q1, 'docs'))).toBe('deny')
    const q2 = await restarted(q1)
    expect(q2.options.agents.docs).toBeDefined()
    expect(q2.options.agents.engineer.prompt).toContain('You are the careful engineer.')
    expect(q2.options.agents.lead.tools).not.toContain('Read')
    q2.emit(init)
    expect(decision(await spawn(q2, 'docs'))).not.toBe('deny')
    expect(decision(await spawn(q2, 'engineer'))).not.toBe('deny')
    await vi.waitFor(() => expect(texts(q2)).toContain('The approved org chart is in place in this session now.'))
  }, 15_000)
})

describe('Claude org changes in the same run: a retired role\'s agents (M2)', () => {
  it('a running agent of a removed role is judged on its retired copy, not on a later role that reuses its slug', async () => {
    const { ctx, session, approve, q1 } = await running()
    q1.emit({ type: 'system', subtype: 'task_started', task_id: 'rv1', tool_use_id: 'tu-rv', subagent_type: 'reviewer', description: 'review', session_id: 's', uuid: 'u-rv' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'rv1')?.roleId).toBe('r-rev'))
    expect((await approve(withoutReviewer(true))).availability).toBe('after-idle')
    // A new role with the old slug that may spawn the engineer (RunManager defers this; driven directly here).
    ctx.roles.push(role({ id: 'r-rev2', slug: 'reviewer', name: 'Reviewer two', canSpawn: true, spawnable: ['r-eng'], reportsTo: 'r-lead' }))
    session.rosterApplied({ added: ['r-rev2'], changed: [], removed: [] })
    const out = await spawn(q1, 'engineer', { id: 'rv1', type: 'reviewer' })
    expect(decision(out)).toBe('deny')
    expect(reason(out)).toContain('does not let reviewer spawn subagents')
  })
})

describe('Claude org changes in the same run: notice text', () => {
  it('rosterNoticeText names roles through datum and caps the list', () => {
    expect(rosterNoticeText({ roles: [{ name: 'Docs', slug: 'docs' }], root: true, removed: ['Reviewer'] })).toBe(
      "The approved org chart is in place in this session now. Added or changed roles you can delegate to now (where the chart lets you): Docs (docs). Your own role's instructions and tools are the new chart's now. Removed from this run (no new agents of these): Reviewer."
    )
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `R${i}`, slug: `r${i}` }))
    expect(rosterNoticeText({ roles: many, root: false, removed: [] })).toContain(', and 5 more.')
    expect(configChangeNotice({ servers: [], removed: [], roster: { roles: [], root: false, removed: ['Old'] } })).toBe(
      '[OrgAI harness] The configuration change approved this run is in effect now. The approved org chart is in place in this session now. Removed from this run (no new agents of these): Old.'
    )
  })
})
