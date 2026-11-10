import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Role, RunEvent, RunPlan } from '@shared/types'

// Compaction of the orchestrator's conversation on Claude, with a scripted stand-in for the CLI. Message and hook
// shapes follow scripts/smoke-compaction.mjs (SDK 0.3.318, docs/agent-notes/sdk-facts.md "Compaction"): PreCompact ->
// system status 'compacting' -> SubagentStop of a nameless fork (the summarizer) -> SessionStart (source 'compact') ->
// PostCompact -> status null with compact_result -> compact_boundary. A subagent's compaction runs the same hooks
// without agent_id and emits no system message. No tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
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
    async stopTask() {}
    async supportedModels() {
      return sdk.models
    }
    async getContextUsage() {
      return { rawMaxTokens: 200_000 }
    }
    close(): void {
      this.end()
    }
  }
  return { FakeQuery, queries: [] as FakeQuery[], models: [] as { value: string; resolvedModel?: string }[] }
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
import { ClaudeSession, modelTierReport } from './claude'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookOut = Record<string, any>
type Hook = (i: unknown, id: string, o: unknown) => Promise<HookOut>

const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
})

const roles = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'opus', tier: 'deep', canSpawn: true, spawnable: ['r-eng'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'sonnet', tier: 'everyday', reportsTo: 'r-lead' })
]

async function start(over: Partial<RuntimeContext> = {}) {
  const rs = roles()
  const ctx = fakeCtx({ project: project({ path: '/repo', roles: rs, isolateWriters: false }), roles: rs, run: runSummary(), autoContinue: false, ...over })
  const before = sdk.queries.length
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(before + 1))
  return { ctx, session, q: sdk.queries[before]! }
}

const hooksOf = (q: Fake, name: string): Hook | undefined => q.options.hooks[name]?.[0]?.hooks[0]
const base = { session_id: 's', transcript_path: '/t/s.jsonl', cwd: '/repo' }
const init = (q: Fake, n: number) => q.emit({ type: 'system', subtype: 'init', model: 'claude-opus', session_id: 's', claude_code_version: 'x', uuid: `i-${n}` })
const resultMsg = (q: Fake, n: number) =>
  q.emit({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, is_error: false, session_id: 's', uuid: `r-${n}` })
const logs = (events: RunEvent[]): string[] => events.flatMap((e) => (e.type === 'log' ? [e.message] : []))
const agentRows = (events: RunEvent[]): AgentInstance[] => events.flatMap((e) => (e.type === 'agent.upsert' ? [e.agent] : []))

/** One compaction as the CLI runs it for the root (`root` true) or for a subagent (no system messages). */
async function compaction(q: Fake, opts: { root: boolean; forkId?: string; pre?: number; post?: number }): Promise<HookOut | undefined> {
  await hooksOf(q, 'PreCompact')?.({ ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }, 'x', {})
  if (opts.root) q.emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's', uuid: 'st-1' })
  await new Promise((r) => setTimeout(r, 5))
  await hooksOf(q, 'SubagentStop')?.({ ...base, hook_event_name: 'SubagentStop', agent_id: opts.forkId ?? 'fork-1', agent_type: '', stop_hook_active: false }, 'x', {})
  const started = await hooksOf(q, 'SessionStart')?.({ ...base, hook_event_name: 'SessionStart', source: 'compact' }, 'x', {})
  await hooksOf(q, 'PostCompact')?.({ ...base, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'summary' }, 'x', {})
  if (opts.root) {
    q.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: 's', uuid: 'st-2' })
    q.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: opts.pre ?? 168_000, post_tokens: opts.post ?? 9_000 }, session_id: 's', uuid: 'cb-1' })
  }
  await new Promise((r) => setTimeout(r, 5))
  return started
}

describe('Claude: compaction of the orchestrator', () => {
  it('logs each root compaction with its sizes and tells the transcript; the summarizer fork is no report', async () => {
    const { ctx, q } = await start()
    init(q, 1)
    await compaction(q, { root: true, pre: 168_400, post: 12_100 })
    await vi.waitFor(() => expect(logs(ctx.events).some((m) => m.includes('Compaction 1 of the orchestrator'))).toBe(true))
    expect(logs(ctx.events).find((m) => m.includes('Compaction 1'))).toContain('168k to 12k tokens')
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text.includes('compacted'))).toBe(true)
    // The nameless fork never becomes an agent on the chart.
    expect(agentRows(ctx.events).some((a) => a.id === 'fork-1')).toBe(false)
    await compaction(q, { root: true, forkId: 'fork-2' })
    await vi.waitFor(() => expect(logs(ctx.events).some((m) => m.includes('Compaction 2 of the orchestrator'))).toBe(true))
    resultMsg(q, 1)
  })

  it('a subagent compaction (no system messages) is not counted as the orchestrator’s', async () => {
    const { ctx, q } = await start()
    init(q, 1)
    await compaction(q, { root: false })
    expect(logs(ctx.events).some((m) => m.includes('Compaction'))).toBe(false)
    expect(agentRows(ctx.events).some((a) => a.id === 'fork-1')).toBe(false)
  })
})


describe('Claude: the models a session resolves (run start)', () => {
  const list = [
    { value: 'default', resolvedModel: 'claude-opus-4-5' },
    { value: 'opus', resolvedModel: 'claude-opus-4-5' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5' }
  ]

  it('names each alias\u2019s model and warns for a variable that forces an older model and a role pinned to one', () => {
    const r = modelTierReport({
      list,
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-5' },
      roles: [{ name: 'Lead', model: 'opus' }, { name: 'Writer', model: 'claude-sonnet-4-6' }],
      catalog: ['opus', 'claude-opus-5-5'],
      rootModel: 'claude-opus-4-5'
    })
    expect(r.line).toBe('Models this session resolves: orchestrator claude-opus-4-5; opus -> claude-opus-4-5 (ANTHROPIC_DEFAULT_OPUS_MODEL), sonnet -> claude-sonnet-5-5, haiku -> claude-haiku-5-5.')
    expect(r.warnings).toEqual([
      "The opus alias runs on claude-opus-4-5, older than claude-opus-5-5 (set by the connection's tier mapping); older models can have a much smaller context window and compact sooner.",
      'Writer is pinned to claude-sonnet-4-6, older than claude-sonnet-5-5; older models can have a much smaller context window and compact sooner.'
    ])
  })

  it('no warning when every alias is native and current', () => {
    expect(modelTierReport({ list: list.map((m) => (m.value === 'opus' || m.value === 'default' ? { ...m, resolvedModel: 'claude-opus-5-5' } : m)), roles: [{ name: 'Lead', model: 'opus' }] }).warnings).toEqual([])
  })

  it('the session logs the line once, at its first init', async () => {
    sdk.models = list.map((m) => (m.value === 'opus' || m.value === 'default' ? { ...m, resolvedModel: 'claude-opus-5-5' } : m))
    const { ctx, q } = await start()
    init(q, 1)
    init(q, 2)
    await vi.waitFor(() => expect(logs(ctx.events).filter((m) => m.startsWith('Models this session resolves'))).toHaveLength(1))
    expect(logs(ctx.events).find((m) => m.startsWith('Models this session resolves'))).toContain('opus -> claude-opus-5-5')
  })
})

const plan = (): RunPlan => ({
  goal: 'Ship',
  steps: [
    { id: 'p1', title: 'Read', status: 'done' },
    { id: 'p2', title: 'Change', status: 'in_progress' }
  ],
  status: 'active',
  autoContinues: 0,
  updatedAt: 0
})

describe('Claude: after a compaction of the orchestrator', () => {
  it('emits agent.compacted with the sizes', async () => {
    const { ctx, q } = await start()
    init(q, 1)
    await compaction(q, { root: true, pre: 168_400, post: 12_100 })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.compacted')).toBe(true))
    expect(ctx.events.find((e) => e.type === 'agent.compacted')).toMatchObject({ agentId: 'root', trigger: 'auto', tokensBefore: 168_400, tokensAfter: 12_100 })
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === 'The conversation was compacted (1st time, 168k to 12k tokens).')).toBe(true)
  })

  it('re-attaches the plan once per root compaction through SessionStart; never for a subagent compaction', async () => {
    const { ctx, q } = await start()
    init(q, 1)
    await ctx.updatePlan(plan())
    const out = await compaction(q, { root: true })
    expect(out?.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    expect(out?.hookSpecificOutput?.additionalContext).toContain('- p2 [in progress] Change')
    // A second SessionStart for the same compaction adds nothing.
    expect(await hooksOf(q, 'SessionStart')!({ ...base, hook_event_name: 'SessionStart', source: 'compact' }, 'x', {})).toEqual({})
    // A subagent's compaction: no 'compacting' on the stream, so nothing goes to it.
    expect(await compaction(q, { root: false, forkId: 'fork-9' })).toEqual({})
    // Other sources never get it.
    expect(await hooksOf(q, 'SessionStart')!({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, 'x', {})).toEqual({})
    // The next root compaction gets it again.
    expect((await compaction(q, { root: true, forkId: 'fork-3' }))?.hookSpecificOutput?.additionalContext).toContain('Plan (active, 1 of 2 steps done)')
  })

  it('three compactions without a finished step stop the automatic continues with one warning naming the model and window', async () => {
    const { ctx, q } = await start({ autoContinue: true })
    init(q, 1)
    q.emit({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'Reading.' }], usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: 's', uuid: 'a1' })
    await ctx.updatePlan(plan())
    for (const id of ['f1', 'f2', 'f3']) await compaction(q, { root: true, forkId: id })
    await vi.waitFor(() => expect(logs(ctx.events).some((m) => m.includes('compacted its context 3 times'))).toBe(true))
    const warn = ctx.events.find((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('compacted its context'))
    expect(warn && warn.type === 'log' ? warn.message : '').toContain('(claude-opus-4-5, 200k-token context)')
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text.startsWith('Automatic continues stopped:'))).toBe(true)
  })
})
