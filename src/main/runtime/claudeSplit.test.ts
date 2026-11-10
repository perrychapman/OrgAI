import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Role, RunPlan } from '@shared/types'

// Split execution on Claude (docs/design/split-execution.md 3.2, 3.3, 3.6) with a scripted stand-in for the CLI: the
// waiting note on a background launch, the context pack from the brief's Files: line delivered at SubagentStart, and
// background reports (not required) tracked from launch to hand-back. Message and hook shapes follow sdk-facts
// checks 12 to 14 (SDK 0.3.318). No tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    stopped: string[] = []
    interrupts = 0
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
    async interrupt() {
      this.interrupts++
    }
    async stopTask(id: string) {
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
import { ClaudeSession, SPAWN_LINK_WAIT_MS } from './claude'
import { CONTEXT_PACK_HEADING } from './contextPack'
import { WAITING_NOTE } from './waitingNote'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import type { DelegationGate, RuntimeContext } from './types'

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

/** Lead (deep) -> engineer (deep / high), helper (deep / high), reviewer (everyday, required: receipt-bearing). */
const roles = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'opus', tier: 'deep', canSpawn: true, spawnable: ['r-eng', 'r-help', 'r-rev'], requiredReports: ['r-rev'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'opus', tier: 'deep', effort: 'high', reportsTo: 'r-lead' }),
  role({ id: 'r-help', slug: 'helper', name: 'Helper', model: 'opus', tier: 'deep', effort: 'high', reportsTo: 'r-lead' }),
  role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', model: 'sonnet', tier: 'everyday', reportsTo: 'r-lead' })
]
/** Calls the hook keeps as written (no updatedInput). */
const wellFormed = {
  engineer: { subagent_type: 'engineer', name: 'eng-1', model: 'opus', effort: 'high', description: 'Module A' },
  helper: { subagent_type: 'helper', name: 'help-1', model: 'opus', effort: 'high', description: 'Module B' },
  reviewer: { subagent_type: 'reviewer', name: 'rev-1', model: 'sonnet', effort: 'medium', run_in_background: false, description: 'Review' }
}

function gateMock() {
  return {
    noteSpawn: vi.fn(),
    completion: vi.fn(() => ({ action: 'allow' as const })),
    ended: vi.fn(),
    resumed: vi.fn(),
    delivered: vi.fn(),
    receiptText: vi.fn((): string | undefined => undefined),
    nativeStrike: vi.fn(() => 1)
  } satisfies DelegationGate
}

async function start(over: Partial<RuntimeContext> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-split-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'contract.ts'), 'export interface Contract { id: string }\n')
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 2\n')
  const rs = roles()
  const ctx = fakeCtx({ project: project({ path: dir, roles: rs, isolateWriters: false }), roles: rs, run: runSummary(), autoContinue: false, ...over })
  const before = sdk.queries.length
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const integrator = (session as any).integrator as { onSubagentFinished: (id: string) => Promise<void> }
  const onFinished = vi.spyOn(integrator, 'onSubagentFinished').mockResolvedValue()
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(before + 1))
  const q = sdk.queries[before]!
  return { ctx, session, q, dir, onFinished }
}

const hooksOf = (q: Fake, name: string): Hook => q.options.hooks[name][0].hooks[0]
const base = (dir = '/repo') => ({ session_id: 's', transcript_path: '', cwd: dir })
const spawn = (q: Fake, id: string, input: Record<string, unknown>, dir?: string): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')({ ...base(dir), hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'Do it', ...input }, tool_use_id: id, agent_type: 'lead' }, 'x', {})
const subStart = (q: Fake, agentId: string, type: string): Promise<HookOut> =>
  hooksOf(q, 'SubagentStart')({ ...base(), hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type }, 'x', {})
/** The root's Agent PostToolUse; `async_launched` is the background launch result of check 12. */
const post = (q: Fake, id: string, response: unknown): Promise<HookOut> =>
  hooksOf(q, 'PostToolUse')({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_response: response, tool_use_id: id, agent_type: 'lead' }, 'x', {})
const launched = (agentId: string) => ({ isAsync: true, status: 'async_launched', agentId, resolvedModel: 'claude-opus', outputFile: '/tmp/out', canReadOutputFile: true, canContinueAgent: false })
/** The worker's SubagentHandback (check 12): PreToolUse then PostToolUse with the report in tool_input.message. */
async function handback(q: Fake, agentId: string, type: string, message: string): Promise<void> {
  const input = { ...base(), tool_name: 'SubagentHandback', tool_input: { message }, tool_use_id: `hb-${agentId}`, agent_id: agentId, agent_type: type }
  await hooksOf(q, 'PreToolUse')({ ...input, hook_event_name: 'PreToolUse' }, 'x', {})
  await hooksOf(q, 'PostToolUse')({ ...input, hook_event_name: 'PostToolUse', tool_response: { success: true, message: 'Report delivered to your caller.' } }, 'x', {})
}
/** SubagentStop of a background report: no last_assistant_message (check 12). */
const subStop = (q: Fake, agentId: string, type: string): Promise<HookOut> =>
  hooksOf(q, 'SubagentStop')({ ...base(), hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, stop_hook_active: false }, 'x', {})
const taskStarted = (q: Fake, agentId: string, tu: string, type: string) =>
  q.emit({ type: 'system', subtype: 'task_started', task_id: agentId, task_type: 'local_agent', tool_use_id: tu, subagent_type: type, description: 'work', session_id: 's', uuid: `u-${agentId}` })
/** The report's task_notification: tool_use_id = its Agent call, handback 'send' and handback_report (check 12). */
const notified = (q: Fake, agentId: string, tu: string, text: string, status = 'completed') =>
  q.emit({ type: 'system', subtype: 'task_notification', task_id: agentId, tool_use_id: tu, status, output_file: '', summary: 'Harness note', handback: 'send', handback_report: { text }, session_id: 's', uuid: `n-${agentId}` })
const init = (q: Fake, n: number) => q.emit({ type: 'system', subtype: 'init', model: 'claude-opus', session_id: 's', claude_code_version: 'x', uuid: `i-${n}` })
const resultMsg = (q: Fake, n: number) =>
  q.emit({ type: 'result', subtype: 'success', result: 'still running', total_cost_usd: 0, modelUsage: {}, usage: {}, is_error: false, session_id: 's', uuid: `r-${n}` })
const lastAgent = (ctx: { events: unknown[] }, id: string): AgentInstance | undefined =>
  (ctx.events as { type: string; agent?: AgentInstance }[]).filter((e) => e.type === 'agent.upsert' && e.agent?.id === id).at(-1)?.agent
const started = async (ctx: { events: unknown[] }, q: Fake, agentId: string, tu: string, type: string) => {
  taskStarted(q, agentId, tu, type)
  await vi.waitFor(() => expect(lastAgent(ctx, agentId)?.spawnToolUseId).toBe(tu))
}
const plan = (steps: RunPlan['steps']): RunPlan => ({ goal: 'Ship', steps, status: 'active', autoContinues: 0, updatedAt: 0 })
const twoModules = () =>
  plan([
    { id: 'p1', title: 'Module A', status: 'pending', staff: { role: 'engineer' } },
    { id: 'p2', title: 'Module B', status: 'pending' }
  ])

describe('Claude: the waiting note (split-execution 3.6) on a background launch', () => {
  it('once, when the root launches its only report in the background and a plan step is ready; not on a foreground spawn', async () => {
    const { ctx, q } = await start()
    await ctx.updatePlan(twoModules())
    // Foreground (the report already back): waiting is over, no note.
    expect(await spawn(q, 't0', { ...wellFormed.helper, name: 'help-0', run_in_background: false })).toEqual({})
    await started(ctx, q, 'a0', 't0', 'helper')
    await subStop(q, 'a0', 'helper')
    expect(await post(q, 't0', { status: 'completed', content: [{ type: 'text', text: 'done' }] })).toEqual({})
    // Background: the note rides on the launch result.
    expect(await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })).toEqual({})
    await started(ctx, q, 'a1', 't1', 'engineer')
    const out = await post(q, 't1', launched('a1'))
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: WAITING_NOTE })
    // At most once per run.
    await subStop(q, 'a1', 'engineer')
    expect(await spawn(q, 't2', { ...wellFormed.engineer, name: 'eng-2', run_in_background: true })).toEqual({})
    await started(ctx, q, 'a2', 't2', 'engineer')
    expect(await post(q, 't2', launched('a2'))).toEqual({})
  })

  it('not with two reports running, not for a required report, not without a ready step', async () => {
    const a = await start()
    await a.ctx.updatePlan(twoModules())
    await spawn(a.q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(a.ctx, a.q, 'a1', 't1', 'engineer')
    await spawn(a.q, 't2', { ...wellFormed.helper, run_in_background: true })
    await started(a.ctx, a.q, 'a2', 't2', 'helper')
    expect(await post(a.q, 't2', launched('a2'))).toEqual({})
    await a.session.stop()

    const b = await start()
    await b.ctx.updatePlan(twoModules())
    expect(await post(b.q, 'none', launched('x'))).toEqual({})
    const c = await start()
    await c.ctx.updatePlan(plan([{ id: 'p1', title: 'Module A', status: 'pending', staff: { role: 'engineer' } }, { id: 'p2', title: 'Verify', status: 'pending', after: ['p1'] }]))
    await spawn(c.q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(c.ctx, c.q, 'a1', 't1', 'engineer')
    // p1 is the report's own step; p2 waits on it: nothing ready for the lead.
    expect(await post(c.q, 't1', launched('a1'))).toEqual({})
  })
})

describe('Claude: context pack from the brief (split-execution 3.2)', () => {
  it('reads the Files: line without rewriting the call, delivers the block at SubagentStart and tells the lead at launch', async () => {
    const { ctx, q, dir } = await start()
    const brief = 'Build module A against the contract.\nFiles: src/contract.ts, /etc/hosts, missing.ts'
    // The call is well-formed: the line stays in the brief and the hook returns {} (no classifier request).
    expect(await spawn(q, 't1', { ...wellFormed.engineer, prompt: brief, run_in_background: true }, dir)).toEqual({})
    // SubagentStart before its task_started (they arrive unordered): the hook waits for the link.
    const startOut = subStart(q, 'a1', 'engineer')
    taskStarted(q, 'a1', 't1', 'engineer')
    const block = (await startOut).hookSpecificOutput
    expect(block.hookEventName).toBe('SubagentStart')
    expect(block.additionalContext).toBe(`${CONTEXT_PACK_HEADING}\n\nFile: src/contract.ts\n\`\`\`\nexport interface Contract { id: string }\n\`\`\``)
    const out = (await post(q, 't1', launched('a1'))).hookSpecificOutput.additionalContext as string
    expect(out).toContain('Inlined 1 file into its brief: src/contract.ts.')
    expect(out).toContain('/etc/hosts (outside the folders the report may read)')
    expect(out).toContain('missing.ts (not found)')
    // Delivered once: a resumed start of the same agent gets nothing.
    expect(await subStart(q, 'a1', 'engineer')).toEqual({})
    void ctx
  })

  it('parallel spawns of one role: each start gets its own pack, whatever the order of starts and links', async () => {
    const { q, dir } = await start()
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts', run_in_background: true }, dir)
    await spawn(q, 't2', { ...wellFormed.engineer, name: 'eng-2', prompt: 'B\nFiles: src/other.ts', run_in_background: true }, dir)
    const s1 = subStart(q, 'a1', 'engineer')
    const s2 = subStart(q, 'a2', 'engineer')
    taskStarted(q, 'a2', 't2', 'engineer')
    taskStarted(q, 'a1', 't1', 'engineer')
    expect((await s1).hookSpecificOutput.additionalContext).toContain('File: src/contract.ts')
    expect((await s1).hookSpecificOutput.additionalContext).not.toContain('other.ts')
    expect((await s2).hookSpecificOutput.additionalContext).toContain('File: src/other.ts')
    expect((await s2).hookSpecificOutput.additionalContext).not.toContain('contract.ts')
  })

  it('a foreground spawn hears about its pack with the report; a start that cannot be linked is reported as not inlined', async () => {
    const { ctx, q, dir } = await start()
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts', run_in_background: false }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect((await subStart(q, 'a1', 'engineer')).hookSpecificOutput.additionalContext).toContain('File: src/contract.ts')
    await subStop(q, 'a1', 'engineer')
    expect((await post(q, 't1', { status: 'completed', content: 'done' })).hookSpecificOutput.additionalContext).toBe('Inlined 1 file into its brief: src/contract.ts.')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await spawn(q, 't2', { ...wellFormed.engineer, name: 'eng-2', prompt: 'B\nFiles: src/contract.ts', run_in_background: true }, dir)
      const lost = subStart(q, 'a9', 'engineer')
      await vi.advanceTimersByTimeAsync(SPAWN_LINK_WAIT_MS + 10)
      expect(await lost).toEqual({})
      const out = post(q, 't2', launched('a2'))
      await vi.advanceTimersByTimeAsync(SPAWN_LINK_WAIT_MS + 600)
      expect((await out).hookSpecificOutput.additionalContext).toBe(
        "Not inlined (the report can read them itself where allowed): src/contract.ts (it could not be attached to the report's start)."
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a trust-restricted run inlines nothing and says why; a brief without the line changes nothing', async () => {
    const r = await start({ run: runSummary({ buildWorkspace: '/elsewhere' }) })
    await spawn(r.q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts' }, r.dir)
    await started(r.ctx, r.q, 'a1', 't1', 'engineer')
    expect(await subStart(r.q, 'a1', 'engineer')).toEqual({})
    expect((await post(r.q, 't1', launched('a1'))).hookSpecificOutput.additionalContext).toContain("src/contract.ts (this run's folder is not trusted")
    const p = await start()
    await spawn(p.q, 't1', { ...wellFormed.engineer, prompt: 'Files are in src/.' }, p.dir)
    await started(p.ctx, p.q, 'a1', 't1', 'engineer')
    expect(await subStart(p.q, 'a1', 'engineer')).toEqual({})
  })
})

describe('Claude: background reports that are not required (split-execution 3.3)', () => {
  it('a model-written run_in_background: true is kept; a required report is still forced to the foreground', async () => {
    const { q } = await start({ delegation: gateMock() })
    expect(await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })).toEqual({})
    const required = await spawn(q, 't2', { ...wellFormed.reviewer, run_in_background: true })
    expect(required.hookSpecificOutput.updatedInput.run_in_background).toBe(false)
  })

  it('launch to hand-back: root idle while it runs, no nudge, the session busy until the CLI resumes the orchestrator; report text, ledger, staffing, integration', async () => {
    const gate = gateMock()
    const { ctx, session, q, onFinished } = await start({ delegation: gate, autoContinue: true, continuationDelayMs: 0 })
    await ctx.updatePlan(twoModules())
    init(q, 1)
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await subStart(q, 'a1', 'engineer')
    await post(q, 't1', launched('a1'))
    // The root's turn ends while the report works (Stop hook, then result).
    await hooksOf(q, 'Stop')({ ...base(), hook_event_name: 'Stop' }, 'x', {})
    resultMsg(q, 1)
    await vi.waitFor(() => expect(lastAgent(ctx, 'root')?.activity).toBe('Waiting on reports…'))
    await vi.waitFor(() => expect(session.settlement().continuationSettled).toBe(true))
    expect(session.settlement()).toMatchObject({ rootIdle: true, quiescent: false })
    // No continue nudge while the report is live (only the first message reached the CLI).
    expect(q.inputs).toHaveLength(1)
    await vi.waitFor(() => expect(ctx.getStaffing()?.assignments).toHaveLength(1))
    expect(ctx.getStaffing()!.assignments[0]).toMatchObject({ agentId: 'a1', stepId: 'p1' })

    // A worker's own background Bash notifies under its Bash call: not the report's end.
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'bash-7', tool_use_id: 'bash-call', status: 'completed', output_file: '', summary: 'sleep', session_id: 's', uuid: 'nb' })
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'bash-call', status: 'completed', output_file: '', summary: 'sleep', session_id: 's', uuid: 'nb2' })
    await new Promise((r) => setTimeout(r, 20))
    expect(lastAgent(ctx, 'a1')?.state).not.toBe('done')

    await handback(q, 'a1', 'engineer', 'Module A done; tests pass.')
    expect(await subStop(q, 'a1', 'engineer')).toEqual({})
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', result: 'Module A done; tests pass.', activity: 'Reported back' })
    expect(gate.completion).toHaveBeenCalledWith('a1', { canCorrect: false, canWait: false, reportText: 'Module A done; tests pass.' })
    expect(onFinished).toHaveBeenCalledWith('a1')
    notified(q, 'a1', 't1', 'Module A done; tests pass.')
    await vi.waitFor(() => expect(gate.delivered).toHaveBeenCalledWith('a1'))
    // Until the CLI resumes the orchestrator with the report, the session is not quiescent.
    expect(session.settlement().quiescent).toBe(false)
    init(q, 2)
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(true))
  })

  it('a background report that ends without a captured handback keeps the notification\'s report text', async () => {
    const { ctx, q } = await start()
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await post(q, 't1', launched('a1'))
    await subStop(q, 'a1', 'engineer')
    notified(q, 'a1', 't1', 'Report from the notification.')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.result).toBe('Report from the notification.'))
  })

  it('an interrupt settles live background reports like interrupted Codex threads and asks the CLI to stop them', async () => {
    const gate = gateMock()
    const { ctx, session, q, onFinished } = await start({ delegation: gate })
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await post(q, 't1', launched('a1'))
    expect(session.settlement().quiescent).toBe(false)
    await session.interrupt()
    expect(q.interrupts).toBe(1)
    expect(q.stopped).toEqual(['a1'])
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Interrupted' })
    expect(gate.ended).toHaveBeenCalledWith('a1')
    expect(session.settlement().quiescent).toBe(true)
    // A late stop or notification from the CLI changes nothing: no verdict, no integration, no delivery.
    await handback(q, 'a1', 'engineer', 'late')
    expect(await subStop(q, 'a1', 'engineer')).toEqual({})
    notified(q, 'a1', 't1', 'late', 'stopped')
    await new Promise((r) => setTimeout(r, 20))
    expect(gate.completion).not.toHaveBeenCalled()
    expect(gate.delivered).not.toHaveBeenCalled()
    expect(onFinished).not.toHaveBeenCalled()
    expect(lastAgent(ctx, 'a1')?.activity).toBe('Interrupted')
  })

  it('the session end settles a live background report', async () => {
    const gate = gateMock()
    const { ctx, session, q } = await start({ delegation: gate })
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await post(q, 't1', launched('a1'))
    await session.stop()
    await session.finished
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Stopped: the session ended' })
    expect(gate.ended).toHaveBeenCalledWith('a1')
  })
})
