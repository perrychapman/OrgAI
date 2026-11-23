import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BRIEF_MAX_CHARS, type AgentInstance, type Role } from '@shared/types'

// UI overhaul on Claude with a scripted stand-in for the CLI (same shapes as claudeSplit.test.ts): the spawn caps
// (Role.maxConcurrent, Project.maxAgentsPerRun) at the PreToolUse spawn hook, AgentInstance.brief at task_started and
// RuntimeSession.stopAgent through Query.stopTask. No tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    stopped: string[] = []
    /** Task ids stopTask refuses (already gone). */
    refuse = new Set<string>()
    private waiters: ((r: IteratorResult<Msg>) => void)[] = []
    private out: Msg[] = []
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
    async setMcpServers() {
      return { added: [], removed: [], errors: {} }
    }
    async mcpServerStatus() {
      return []
    }
    async interrupt() {}
    async stopTask(id: string) {
      if (this.refuse.has(id)) throw new Error(`No task found with ID: ${id}`)
      this.stopped.push(id)
    }
    close(): void {
      this.end()
    }
  }
  return { FakeQuery, queries: [] as FakeQuery[] }
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
import { ClaudeSession } from './claude'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookOut = Record<string, any>
type Hook = (i: unknown, id: string, o: unknown) => Promise<HookOut>

const sessions: ClaudeSession[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const chart = (eng: Partial<Role> = {}): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'opus', tier: 'deep', canSpawn: true, spawnable: ['r-eng', 'r-help'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'opus', tier: 'deep', effort: 'high', reportsTo: 'r-lead', canSpawn: true, spawnable: ['r-help'], ...eng }),
  role({ id: 'r-help', slug: 'helper', name: 'Helper', model: 'opus', tier: 'deep', effort: 'high', reportsTo: 'r-lead' })
]
const call = {
  engineer: (name: string) => ({ subagent_type: 'engineer', name, model: 'opus', effort: 'high', description: 'Module' }),
  helper: (name: string) => ({ subagent_type: 'helper', name, model: 'opus', effort: 'high', description: 'Module' })
}

async function start(rs: Role[], projectOver: Record<string, unknown> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-caps-')))
  dirs.push(dir)
  const ctx: RuntimeContext & { events: unknown[] } = fakeCtx({ project: project({ path: dir, roles: rs, isolateWriters: false, ...projectOver }), roles: rs, run: runSummary(), autoContinue: false })
  const before = sdk.queries.length
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(before + 1))
  return { ctx, session, q: sdk.queries[before]!, dir }
}

const hooksOf = (q: Fake, name: string): Hook => q.options.hooks[name][0].hooks[0]
const base = { session_id: 's', transcript_path: '', cwd: '/repo' }
/** An Agent call by the root (no agent_id) or by `by`. */
const spawn = (q: Fake, id: string, input: Record<string, unknown>, by?: { agentId: string; type: string }): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'Do it', ...input }, tool_use_id: id, ...(by ? { agent_id: by.agentId, agent_type: by.type } : { agent_type: 'lead' }) },
    'x',
    {}
  )
const subStop = (q: Fake, agentId: string, type: string): Promise<HookOut> =>
  hooksOf(q, 'SubagentStop')({ ...base, hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, stop_hook_active: false }, 'x', {})
const taskStarted = (q: Fake, agentId: string, tu: string, type: string, parent?: string) =>
  q.emit({ type: 'system', subtype: 'task_started', task_id: agentId, task_type: 'local_agent', tool_use_id: tu, subagent_type: type, ...(parent ? { parent_task_id: parent } : {}), description: 'work', session_id: 's', uuid: `u-${agentId}` })
const lastAgent = (ctx: { events: unknown[] }, id: string): AgentInstance | undefined =>
  (ctx.events as { type: string; agent?: AgentInstance }[]).filter((e) => e.type === 'agent.upsert' && e.agent?.id === id).at(-1)?.agent
const started = async (ctx: { events: unknown[] }, q: Fake, agentId: string, tu: string, type: string, parent?: string) => {
  taskStarted(q, agentId, tu, type, parent)
  await vi.waitFor(() => expect(lastAgent(ctx, agentId)?.spawnToolUseId).toBe(tu))
}
const denial = (out: HookOut): string | undefined => (out.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : undefined)

describe('Claude: spawn caps (Role.maxConcurrent, Project.maxAgentsPerRun)', () => {
  it('a role cap refuses the N+1th live spawn of the role, counting an approved spawn that has not started, and allows again once one ended', async () => {
    const { ctx, q } = await start(chart({ maxConcurrent: 2 }))
    expect(denial(await spawn(q, 't1', call.engineer('eng-1')))).toBeUndefined()
    // t1 has no agent yet (parallel calls in one message): it already counts.
    expect(denial(await spawn(q, 't2', call.engineer('eng-2')))).toBeUndefined()
    const refused = denial(await spawn(q, 't3', call.engineer('eng-3')))
    expect(refused).toContain('Concurrent limit for engineer reached (2 running at once)')
    // Another role is not affected by the engineer's cap.
    expect(denial(await spawn(q, 't4', call.helper('help-1')))).toBeUndefined()
    await started(ctx, q, 'a1', 't1', 'engineer')
    await started(ctx, q, 'a2', 't2', 'engineer')
    expect(denial(await spawn(q, 't5', call.engineer('eng-5')))).toContain('Concurrent limit for engineer')
    // One engineer ends: a slot is free.
    await subStop(q, 'a1', 'engineer')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('done'))
    expect(denial(await spawn(q, 't6', call.engineer('eng-6')))).toBeUndefined()
    expect(denial(await spawn(q, 't7', call.engineer('eng-7')))).toContain('Concurrent limit for engineer')
  })

  it('a refused spawn leaves no trace: it frees nothing and counts nothing', async () => {
    const { ctx, q } = await start(chart({ maxConcurrent: 1 }))
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect(denial(await spawn(q, 't2', call.engineer('eng-2')))).toBeDefined()
    expect(denial(await spawn(q, 't3', call.engineer('eng-3')))).toBeDefined()
    await subStop(q, 'a1', 'engineer')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('done'))
    expect(denial(await spawn(q, 't4', call.engineer('eng-4')))).toBeUndefined()
  })

  it('the run total refuses the N+1th agent even after earlier ones ended; the root never counts', async () => {
    const { ctx, q } = await start(chart(), { maxAgentsPerRun: 2 })
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    await subStop(q, 'a1', 'engineer')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('done'))
    await spawn(q, 't2', call.helper('help-1'))
    await started(ctx, q, 'a2', 't2', 'helper')
    await subStop(q, 'a2', 'helper')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a2')?.state).toBe('done'))
    const refused = denial(await spawn(q, 't3', call.helper('help-2')))
    expect(refused).toContain('Agent limit reached (this run may start 2 agents in total and 2 have started)')
  })

  it('both caps are read live: raising or lowering them mid-run applies to the next spawn', async () => {
    const { ctx, q } = await start(chart({ maxConcurrent: 1 }), { maxAgentsPerRun: 1 })
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect(denial(await spawn(q, 't2', call.helper('help-1')))).toContain('Agent limit reached')
    // The project cap is raised: the helper starts; the engineer's role cap (taken from ctx.roles) still holds.
    ctx.project = { ...ctx.project, maxAgentsPerRun: 5 }
    expect(denial(await spawn(q, 't3', call.helper('help-1')))).toBeUndefined()
    expect(denial(await spawn(q, 't4', call.engineer('eng-2')))).toContain('Concurrent limit for engineer')
    // The role's cap is raised in place (an org change rewrites ctx.roles).
    ctx.roles.find((r) => r.id === 'r-eng')!.maxConcurrent = 2
    expect(denial(await spawn(q, 't5', call.engineer('eng-2')))).toBeUndefined()
    // And lowered below what runs: nothing new starts.
    ctx.project = { ...ctx.project, maxAgentsPerRun: 2 }
    expect(denial(await spawn(q, 't6', call.helper('help-2')))).toContain('Agent limit reached')
  })

  it('no caps set: nothing changes (an unchanged call is left alone)', async () => {
    const { q } = await start(chart())
    for (let i = 0; i < 4; i++) expect(await spawn(q, `t${i}`, call.engineer(`eng-${i}`))).toEqual({})
  })

  it('counts the run\'s bridged agents (ctx.spawnCapAgents, read live) toward the total and a role cap', async () => {
    const { ctx, q } = await start(chart({ maxConcurrent: 2 }), { maxAgentsPerRun: 3 })
    // Two agents a bridged child started, in the run's record but not in this session: 2 of 3 are used.
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = [
      { id: 'ag_b', state: 'thinking', roleId: 'r-oa' },
      { id: 'ag_b:h1', state: 'thinking', roleId: 'r-eng' }
    ]
    ctx.spawnCapAgents = () => bridged
    // The engineer cap counts the bridged engineer too: one more engineer is the second, a third would be refused.
    expect(denial(await spawn(q, 't1', call.engineer('eng-1')))).toBeUndefined()
    // Three agents now exist (2 bridged + 1 native): the fourth is refused whatever its role.
    expect(denial(await spawn(q, 't2', call.helper('help-1')))).toContain('Agent limit reached (this run may start 3 agents in total and 3 have started)')
    // The accessor is read at every spawn, not once: when the bridged list shrinks (a removed agent) the next spawn passes.
    bridged.pop()
    expect(denial(await spawn(q, 't3', call.helper('help-1')))).toBeUndefined()
  })

  it('a role cap counts a live bridged agent of the role, and a finished one frees the slot', async () => {
    const { ctx, q } = await start(chart({ maxConcurrent: 1 }))
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = [{ id: 'ag_b:e1', state: 'thinking', roleId: 'r-eng' }]
    ctx.spawnCapAgents = () => bridged
    expect(denial(await spawn(q, 't1', call.engineer('eng-1')))).toContain('Concurrent limit for engineer reached (1 running at once)')
    bridged[0]!.state = 'done'
    expect(denial(await spawn(q, 't2', call.engineer('eng-1')))).toBeUndefined()
  })

  it('a report spawning under a cap is refused by the same gate', async () => {
    const { ctx, q } = await start(chart(), { maxAgentsPerRun: 1 })
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    const out = await spawn(q, 't2', call.helper('help-1'), { agentId: 'a1', type: 'engineer' })
    expect(denial(out)).toContain('Agent limit reached')
  })
})

describe('Claude: AgentInstance.brief', () => {
  it('is the spawn prompt, set when the agent is first created, absent on the root, cut to AGENT_BRIEF_MAX_CHARS', async () => {
    const { ctx, q } = await start(chart())
    await spawn(q, 't1', { ...call.engineer('eng-1'), prompt: 'Build the parser.\nFiles: a.ts' })
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect(lastAgent(ctx, 'a1')?.brief).toBe('Build the parser.\nFiles: a.ts')
    // The very first upsert of the agent already carries it.
    const first = (ctx.events as { type: string; agent?: AgentInstance }[]).find((e) => e.type === 'agent.upsert' && e.agent?.id === 'a1')!.agent!
    expect(first.brief).toBe('Build the parser.\nFiles: a.ts')
    const long = 'x'.repeat(AGENT_BRIEF_MAX_CHARS + 500)
    await spawn(q, 't2', { ...call.helper('help-1'), prompt: long })
    await started(ctx, q, 'a2', 't2', 'helper')
    expect(lastAgent(ctx, 'a2')?.brief).toHaveLength(AGENT_BRIEF_MAX_CHARS)
    expect(lastAgent(ctx, 'root')?.brief).toBeUndefined()
    // A resume (task_started for the same agent under another call) keeps the first brief.
    await spawn(q, 't3', { ...call.engineer('eng-1'), prompt: 'Something else' })
    taskStarted(q, 'a1', 't3', 'engineer')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastAgent(ctx, 'a1')?.brief).toBe('Build the parser.\nFiles: a.ts')
  })

  it('no brief when the call has no prompt text', async () => {
    const { ctx, q } = await start(chart())
    await spawn(q, 't1', { ...call.engineer('eng-1'), prompt: '   ' })
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect(lastAgent(ctx, 'a1')?.brief).toBeUndefined()
  })
})

describe('Claude: stopAgent', () => {
  it('never the root, false for an unknown agent', async () => {
    const { session, q } = await start(chart())
    expect(await session.stopAgent('root')).toBe(false)
    expect(await session.stopAgent('nope')).toBe(false)
    expect(q.stopped).toEqual([])
  })

  it('stops one running report with stopTask, ends it as other stopped reports end, and a second stop is false', async () => {
    const { ctx, session, q } = await start(chart())
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    await spawn(q, 't2', call.helper('help-1'))
    await started(ctx, q, 'a2', 't2', 'helper')
    expect(await session.stopAgent('a1')).toBe(true)
    expect(q.stopped).toEqual(['a1'])
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    expect(lastAgent(ctx, 'a1')?.endedAt).toBeTypeOf('number')
    // The other report and the root are untouched.
    expect(lastAgent(ctx, 'a2')?.state).not.toBe('done')
    expect(lastAgent(ctx, 'root')?.state).not.toBe('done')
    expect(await session.stopAgent('a1')).toBe(false)
    expect(q.stopped).toEqual(['a1'])
  })

  it('stops the reports under it too, deepest first', async () => {
    const { ctx, session, q } = await start(chart())
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    await spawn(q, 't2', call.helper('help-1'), { agentId: 'a1', type: 'engineer' })
    await started(ctx, q, 'a2', 't2', 'helper', 'a1')
    expect(lastAgent(ctx, 'a2')?.parentId).toBe('a1')
    expect(await session.stopAgent('a1')).toBe(true)
    expect(q.stopped).toEqual(['a2', 'a1'])
    expect(lastAgent(ctx, 'a1')?.state).toBe('done')
    expect(lastAgent(ctx, 'a2')).toMatchObject({ state: 'done', activity: 'Stopped by you' })
  })

  it('false when the CLI refuses the stop (the task is already gone); nothing is settled', async () => {
    const { ctx, session, q } = await start(chart())
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    q.refuse.add('a1')
    expect(await session.stopAgent('a1')).toBe(false)
    expect(lastAgent(ctx, 'a1')?.state).not.toBe('done')
  })

  it('a report that has already ended cannot be stopped', async () => {
    const { ctx, session, q } = await start(chart())
    await spawn(q, 't1', call.engineer('eng-1'))
    await started(ctx, q, 'a1', 't1', 'engineer')
    await subStop(q, 'a1', 'engineer')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('done'))
    expect(await session.stopAgent('a1')).toBe(false)
    expect(q.stopped).toEqual([])
  })
})
