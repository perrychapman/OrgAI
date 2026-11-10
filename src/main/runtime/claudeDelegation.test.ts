import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'

// Only `query` is faked (a scripted stand-in for the CLI); the in-process harness server is the real SDK module.
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
import { DelegationLedger } from './delegationLedger'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import type { DelegationCompletion, DelegationGate, RuntimeContext } from './types'
import type { AgentInstance, Role } from '@shared/types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type Hook = (i: unknown, id: string, o: unknown) => Promise<Record<string, any>>
type HookOut = Record<string, any>

const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
})

// lead -> mgr (requires wrk) and adapt (adaptive); mgr -> wrk.
const roles = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-mgr', 'r-adapt'], requiredReports: ['r-mgr'] }),
  role({ id: 'r-mgr', slug: 'mgr', name: 'Manager', canSpawn: true, spawnable: ['r-wrk'], requiredReports: ['r-wrk'], reportsTo: 'r-lead' }),
  role({ id: 'r-wrk', slug: 'wrk', name: 'Worker', reportsTo: 'r-mgr' }),
  role({ id: 'r-adapt', slug: 'adapt', name: 'Adaptive', reportsTo: 'r-lead' })
]

function gateMock(answers: DelegationCompletion[] = [{ action: 'allow' }]) {
  const queue = [...answers]
  const gate = {
    noteSpawn: vi.fn(),
    completion: vi.fn((): DelegationCompletion => (queue.length > 1 ? queue.shift()! : queue[0]!)),
    ended: vi.fn(),
    resumed: vi.fn(),
    delivered: vi.fn(),
    receiptText: vi.fn((): string | undefined => 'Harness receipt: mgr-1 ok'),
    nativeStrike: vi.fn(() => 1)
  } satisfies DelegationGate
  return gate
}

function start(over: Partial<RuntimeContext> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-deleg-')))
  const rs = roles()
  const ctx = fakeCtx({ project: project({ path: dir, roles: rs, isolateWriters: false }), roles: rs, run: runSummary(), autoContinue: false, ...over })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const integrator = (session as any).integrator as { onSubagentFinished: (id: string) => Promise<void>; holdFailed: (id: string, r: string) => Promise<void>; unhold: (id: string) => void }
  const onFinished = vi.spyOn(integrator, 'onSubagentFinished').mockResolvedValue()
  const holdFailed = vi.spyOn(integrator, 'holdFailed').mockResolvedValue()
  const unhold = vi.spyOn(integrator, 'unhold')
  return { ctx, session, onFinished, holdFailed, unhold }
}
async function firstQuery(): Promise<Fake> {
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  return sdk.queries[0]!
}
const hooksOf = (q: Fake, name: string): Hook => q.options.hooks[name][0].hooks[0]
const base = { session_id: 's', transcript_path: '', cwd: '/repo' }
const spawn = (q: Fake, role: string, id: string, caller?: { id: string; type: string }, extra: Record<string, unknown> = {}): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: role, prompt: 'x', ...extra }, tool_use_id: id, agent_type: caller?.type ?? 'lead', ...(caller ? { agent_id: caller.id } : {}) },
    'x',
    {}
  )
const stop = (q: Fake, id: string, type: string, last = 'report', active = false): Promise<HookOut> =>
  hooksOf(q, 'SubagentStop')({ ...base, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, last_assistant_message: last, stop_hook_active: active }, 'x', {})
const post = (q: Fake, id: string, response: unknown): Promise<HookOut> =>
  hooksOf(q, 'PostToolUse')({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_response: response, tool_use_id: id, agent_type: 'lead' }, 'x', {})
const taskStarted = (q: Fake, id: string, tu: string, type: string, parent?: string) =>
  q.emit({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: tu, subagent_type: type, description: 'work', ...(parent ? { parent_task_id: parent } : {}), session_id: 's', uuid: `u-${id}-${tu}` })
/** task_started, then wait until the adapter has processed it (stream messages and hook calls are not ordered). */
const started = async (ctx: { events: unknown[] }, q: Fake, id: string, tu: string, type: string, parent?: string) => {
  taskStarted(q, id, tu, type, parent)
  await vi.waitFor(() => expect(lastAgent(ctx, id)?.spawnToolUseId).toBe(tu))
}
const notified = (q: Fake, id: string, status = 'completed') =>
  q.emit({ type: 'system', subtype: 'task_notification', task_id: id, status, output_file: '', summary: 'sum', session_id: 's', uuid: `n-${id}-${status}` })
const lastAgent = (ctx: { events: unknown[] }, id: string): AgentInstance | undefined =>
  (ctx.events as { type: string; agent?: AgentInstance }[]).filter((e) => e.type === 'agent.upsert' && e.agent?.id === id).at(-1)?.agent

describe('Claude delegation: PreToolUse foreground rewrite', () => {
  it('forces run_in_background false for a required report and for a role with obligations, not for an adaptive one', async () => {
    start({ delegation: gateMock() })
    const q = await firstQuery()
    expect((await spawn(q, 'mgr', 'tu1')).hookSpecificOutput.updatedInput.run_in_background).toBe(false)
    // wrk is required by mgr
    expect((await spawn(q, 'wrk', 'tu2', { id: 'm1', type: 'mgr' })).hookSpecificOutput.updatedInput.run_in_background).toBe(false)
    const adaptive = await spawn(q, 'adapt', 'tu3')
    expect(adaptive.hookSpecificOutput.updatedInput.run_in_background).toBeUndefined()
  })

  it('strictDelegation makes every spawnable role of a spawner required', async () => {
    const rs = roles().map((r) => ({ ...r, requiredReports: undefined }))
    start({ delegation: gateMock(), roles: rs, project: project({ roles: rs }), run: runSummary({ overrides: { strictDelegation: true } }) })
    const q = await firstQuery()
    expect((await spawn(q, 'adapt', 'tu1')).hookSpecificOutput.updatedInput.run_in_background).toBe(false)
  })

  it('without a gate the spawn is not rewritten', async () => {
    start()
    const q = await firstQuery()
    const out = await spawn(q, 'mgr', 'tu1')
    expect(out.hookSpecificOutput.updatedInput.run_in_background).toBeUndefined()
  })
})

describe('Claude delegation: SubagentStop', () => {
  it('blocks on correct, then marks the second stop failed and holds the branch instead of integrating', async () => {
    const gate = gateMock([{ action: 'correct', text: 'Harness: spawn wrk.' }, { action: 'fail', missing: 'wrk never spawned' }])
    const { ctx, onFinished, holdFailed } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await vi.waitFor(() => expect(lastAgent(ctx, 'm1')).toBeDefined())
    const first = await stop(q, 'm1', 'mgr')
    expect(first).toEqual({ decision: 'block', reason: 'Harness: spawn wrk.' })
    expect(gate.completion).toHaveBeenCalledWith('m1', { canCorrect: true, canWait: true, reportText: 'report' })
    expect(lastAgent(ctx, 'm1')?.state).not.toBe('done')
    expect(onFinished).not.toHaveBeenCalled()
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.agentId === 'm1' && e.entry.block.kind === 'system' && e.entry.block.text === 'Harness: spawn wrk.')).toBe(true)
    const second = await stop(q, 'm1', 'mgr', 'again', true)
    expect(second).toEqual({})
    expect(lastAgent(ctx, 'm1')).toMatchObject({ state: 'done', activity: 'Skipped required reports' })
    expect(holdFailed).toHaveBeenCalledWith('m1', 'wrk never spawned')
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('blocks on wait too', async () => {
    const { ctx, onFinished } = start({ delegation: gateMock([{ action: 'wait', text: 'Harness: wait for wrk.' }]) })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    expect(await stop(q, 'm1', 'mgr')).toEqual({ decision: 'block', reason: 'Harness: wait for wrk.' })
    expect(lastAgent(ctx, 'm1')?.state).not.toBe('done')
    expect(onFinished).not.toHaveBeenCalled()
  })

  it.each([['allow'], ['none']] as const)('%s finishes the agent as today', async (action) => {
    const { ctx, onFinished, holdFailed } = start({ delegation: gateMock([{ action }]) })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    expect(await stop(q, 'm1', 'mgr')).toEqual({})
    expect(lastAgent(ctx, 'm1')).toMatchObject({ state: 'done', activity: 'Reported back' })
    expect(onFinished).toHaveBeenCalledWith('m1')
    expect(holdFailed).not.toHaveBeenCalled()
  })

  it('without a gate it finishes and integrates', async () => {
    const { ctx, onFinished } = start()
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    expect(await stop(q, 'm1', 'mgr')).toEqual({})
    expect(lastAgent(ctx, 'm1')).toMatchObject({ state: 'done', activity: 'Reported back' })
    expect(onFinished).toHaveBeenCalledWith('m1')
  })
})

describe('Claude delegation: PostToolUse receipts', () => {
  it('confirms delivery of a completed spawn by its tool_use id and returns the receipt as additionalContext', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalled())
    const out = await post(q, 'tu1', { status: 'completed', content: 'report' })
    expect(gate.delivered).toHaveBeenCalledWith('m1')
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'Harness receipt: mgr-1 ok' })
  })

  it('an async_launched result is not a delivery', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalled())
    for (const resp of [{ status: 'async_launched' }, 'Agent async_launched: id m1']) {
      expect(await post(q, 'tu1', resp)).toEqual({})
    }
    expect(gate.delivered).not.toHaveBeenCalled()
  })

  it('delivers without additionalContext when there is no receipt line', async () => {
    const gate = gateMock()
    gate.receiptText.mockReturnValue(undefined)
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'adapt')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalled())
    expect(await post(q, 'tu1', 'done')).toEqual({})
    expect(gate.delivered).toHaveBeenCalledWith('m1')
  })
})

describe('Claude delegation: task_started and task_notification', () => {
  it('reports a new agent to the gate once; a later task_started for it is a resume (unhold, thinking, no noteSpawn)', async () => {
    const gate = gateMock()
    const { ctx, unhold } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu2', 'wrk', 'm1')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalledExactlyOnceWith('w1', 'm1', 'r-wrk'))
    await stop(q, 'w1', 'wrk')
    expect(lastAgent(ctx, 'w1')?.state).toBe('done')
    taskStarted(q, 'w1', 'tu9', 'wrk', 'm1')
    await vi.waitFor(() => expect(unhold).toHaveBeenCalledWith('w1'))
    expect(gate.noteSpawn).toHaveBeenCalledTimes(1)
    expect(gate.resumed).toHaveBeenCalledExactlyOnceWith('w1')
    expect(gate.completion).toHaveBeenCalledTimes(1)
    expect(lastAgent(ctx, 'w1')?.state).toBe('thinking')
  })

  it('a notification after SubagentStop neither re-integrates nor overwrites the state, failed or not', async () => {
    const gate = gateMock([{ action: 'fail', missing: 'x' }])
    const { ctx, onFinished, holdFailed } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await stop(q, 'm1', 'mgr')
    notified(q, 'm1', 'completed')
    notified(q, 'm1', 'failed')
    await new Promise((r) => setTimeout(r, 30))
    expect(lastAgent(ctx, 'm1')).toMatchObject({ state: 'done', activity: 'Skipped required reports' })
    expect(onFinished).not.toHaveBeenCalled()
    expect(holdFailed).toHaveBeenCalledTimes(1)
    expect(gate.ended).not.toHaveBeenCalled()
  })

  it('a notification for an agent that never stopped finishes it as before; failed or killed also ends it in the ledger', async () => {
    const gate = gateMock()
    const { ctx, onFinished } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'a1', 'tu1', 'adapt')
    await started(ctx, q, 'a2', 'tu2', 'adapt')
    notified(q, 'a1', 'completed')
    notified(q, 'a2', 'failed')
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2))
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Reported back' })
    expect(lastAgent(ctx, 'a2')).toMatchObject({ state: 'error', activity: 'Task failed' })
    expect(gate.ended).toHaveBeenCalledExactlyOnceWith('a2')
  })
})

// SDK 0.3.318 in permission mode 'auto': a subagent reports through the built-in SubagentHandback tool and its turn ends
// on that call, so SubagentStop carries no last_assistant_message (scripts/smoke-delegation.mjs handback).
const HANDBACK_OK = { success: true, message: 'Report delivered to your caller.' }
const handbackPre = (q: Fake, agent: { id?: string; type: string }, message: string, tu = `hb-${agent.id}`): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')(
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message }, tool_use_id: tu, agent_type: agent.type, ...(agent.id ? { agent_id: agent.id } : {}) },
    'x',
    {}
  )
const handbackPost = (q: Fake, agent: { id?: string; type: string }, message: string, response: unknown = HANDBACK_OK, tu = `hb-${agent.id}`): Promise<HookOut> =>
  hooksOf(q, 'PostToolUse')(
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_input: { message }, tool_response: response, tool_use_id: tu, agent_type: agent.type, ...(agent.id ? { agent_id: agent.id } : {}) },
    'x',
    {}
  )
const handBack = async (q: Fake, agent: { id: string; type: string }, message: string): Promise<void> => {
  await handbackPre(q, agent, message)
  await handbackPost(q, agent, message)
}
const stopNoText = (q: Fake, id: string, type: string): Promise<HookOut> =>
  hooksOf(q, 'SubagentStop')({ ...base, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, stop_hook_active: false }, 'x', {})

describe('Claude delegation: SubagentHandback reports', () => {
  it('a report that hands back and stops with no last message gets the handback as its report text and result', async () => {
    const gate = gateMock()
    const { ctx, onFinished } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await handBack(q, { id: 'w1', type: 'adapt' }, 'Handback report text')
    expect(await stopNoText(q, 'w1', 'adapt')).toEqual({})
    expect(gate.completion).toHaveBeenLastCalledWith('w1', { canCorrect: false, canWait: false, reportText: 'Handback report text' })
    expect(lastAgent(ctx, 'w1')).toMatchObject({ state: 'done', result: 'Handback report text' })
    expect(onFinished).toHaveBeenCalledWith('w1')
  })

  it('a handback followed by a short closing text uses the handback message', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await handBack(q, { id: 'w1', type: 'adapt' }, 'The full report')
    await stop(q, 'w1', 'adapt', 'Done.')
    expect(gate.completion).toHaveBeenLastCalledWith('w1', expect.objectContaining({ reportText: 'The full report' }))
    expect(lastAgent(ctx, 'w1')?.result).toBe('The full report')
  })

  it('a report that ends with plain text still uses last_assistant_message', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await stop(q, 'w1', 'adapt', 'Plain report')
    expect(gate.completion).toHaveBeenLastCalledWith('w1', { canCorrect: true, canWait: true, reportText: 'Plain report' })
    expect(lastAgent(ctx, 'w1')?.result).toBe('Plain report')
  })

  it('a handback the CLI refused (success false) is not captured; neither is one from the root', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await handbackPre(q, { id: 'w1', type: 'adapt' }, 'refused text')
    await handbackPost(q, { id: 'w1', type: 'adapt' }, 'refused text', { success: false, message: 'Nothing was sent: your report was already delivered.' })
    // The root has no handback contract: its call is left to the CLI (which refuses it) and never captured or gated.
    expect(await handbackPre(q, { type: 'lead' }, 'root text', 'hb-root')).toEqual({})
    await handbackPost(q, { type: 'lead' }, 'root text', HANDBACK_OK, 'hb-root')
    expect(gate.completion.mock.calls.map((c: unknown[]) => c[0])).toEqual(['w1'])
    await stop(q, 'w1', 'adapt', 'closing text')
    expect(lastAgent(ctx, 'w1')?.result).toBe('closing text')
    expect(lastAgent(ctx, 'root')?.result).toBeUndefined()
  })

  it("a resumed agent's second handback replaces the first", async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await handBack(q, { id: 'w1', type: 'adapt' }, 'First report')
    await stopNoText(q, 'w1', 'adapt')
    expect(lastAgent(ctx, 'w1')?.result).toBe('First report')
    taskStarted(q, 'w1', 'tu9', 'adapt')
    await vi.waitFor(() => expect(lastAgent(ctx, 'w1')?.state).toBe('thinking'))
    await handBack(q, { id: 'w1', type: 'adapt' }, 'Second report')
    await stopNoText(q, 'w1', 'adapt')
    expect(gate.completion).toHaveBeenLastCalledWith('w1', expect.objectContaining({ reportText: 'Second report' }))
    expect(lastAgent(ctx, 'w1')?.result).toBe('Second report')
  })

  it('a resumed activation that does not hand back does not reuse the earlier handback', async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await handBack(q, { id: 'w1', type: 'adapt' }, 'First report')
    await stopNoText(q, 'w1', 'adapt')
    taskStarted(q, 'w1', 'tu9', 'adapt')
    await vi.waitFor(() => expect(lastAgent(ctx, 'w1')?.state).toBe('thinking'))
    await stop(q, 'w1', 'adapt', 'Second, plain')
    expect(gate.completion).toHaveBeenLastCalledWith('w1', expect.objectContaining({ reportText: 'Second, plain' }))
  })

  it('a notification for an agent that never stopped takes the handback report, not the harness summary', async () => {
    const { ctx } = start({ delegation: gateMock() })
    const q = await firstQuery()
    await started(ctx, q, 'a1', 'tu1', 'adapt')
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', output_file: '', summary: "This agent's report was delivered to you as a message", handback: 'send', handback_report: { text: 'Background report' }, session_id: 's', uuid: 'n-a1' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('done'))
    expect(lastAgent(ctx, 'a1')?.result).toBe('Background report')
  })

  it("a withheld handback (the child never reported) does not confirm delivery to the parent's ledger", async () => {
    const gate = gateMock()
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalled())
    await post(q, 'tu1', { status: 'completed', handback: 'withheld', content: [{ type: 'text', text: 'The subagent ended without delivering a report' }] })
    expect(gate.delivered).not.toHaveBeenCalled()
  })

  it('a repeated stop of a finished activation (the CLI asking it to hand back) does not finish it twice', async () => {
    const gate = gateMock()
    const { ctx, onFinished } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'w1', 'tu1', 'adapt')
    await stop(q, 'w1', 'adapt', 'first text')
    await stop(q, 'w1', 'adapt', 'again', true)
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(gate.completion).toHaveBeenCalledTimes(1)
  })
})

describe('Claude delegation: SubagentHandback gate (PreToolUse)', () => {
  it('denies a handback while required reports are missing, with the correction text, and does not capture it', async () => {
    const gate = gateMock([{ action: 'correct', text: 'Harness: spawn wrk.' }, { action: 'allow' }])
    const { ctx, onFinished } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    const out = await handbackPre(q, { id: 'm1', type: 'mgr' }, 'premature report')
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Harness: spawn wrk.' })
    expect(gate.completion).toHaveBeenCalledWith('m1', { canCorrect: true, canWait: true, reportText: 'premature report', provisional: true })
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.agentId === 'm1' && e.entry.block.kind === 'system' && e.entry.block.text === 'Harness: spawn wrk.')).toBe(true)
    expect(lastAgent(ctx, 'm1')?.state).not.toBe('done')
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('denies on wait too', async () => {
    const { ctx } = start({ delegation: gateMock([{ action: 'wait', text: 'Harness: wait for wrk.' }]) })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    expect((await handbackPre(q, { id: 'm1', type: 'mgr' }, 'r')).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Harness: wait for wrk.' })
  })

  it.each([['allow'], ['fail'], ['none']] as const)('a provisional %s leaves the handback to the normal flow; SubagentStop records the verdict', async (action) => {
    const gate = gateMock([{ action }])
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    expect((await handbackPre(q, { id: 'm1', type: 'mgr' }, 'report')).hookSpecificOutput?.permissionDecision).toBeUndefined()
    await handbackPost(q, { id: 'm1', type: 'mgr' }, 'report')
    expect(await stopNoText(q, 'm1', 'mgr')).toEqual({})
    expect(gate.completion).toHaveBeenLastCalledWith('m1', { canCorrect: false, canWait: false, reportText: 'report' })
    expect(lastAgent(ctx, 'm1')?.state).toBe('done')
  })

  it('SubagentStop never blocks an agent whose report was already handed back', async () => {
    const gate = gateMock([{ action: 'allow' }, { action: 'correct', text: 'too late' }])
    const { ctx } = start({ delegation: gate })
    const q = await firstQuery()
    await started(ctx, q, 'm1', 'tu1', 'mgr')
    await handBack(q, { id: 'm1', type: 'mgr' }, 'report')
    expect(await stopNoText(q, 'm1', 'mgr')).toEqual({})
    expect(gate.completion).toHaveBeenLastCalledWith('m1', expect.objectContaining({ canCorrect: false, canWait: false }))
  })
})

describe('Claude delegation: SubagentHandback with the real ledger', () => {
  it('required implementer and reviewer reports that hand back give valid receipts; the root completes without a correction', async () => {
    const rs: Role[] = [
      role({ id: 'r-orch', slug: 'orchestrator', name: 'Orchestrator', canSpawn: true, spawnable: ['r-impl', 'r-rev'], requiredReports: ['r-impl', 'r-rev'] }),
      role({ id: 'r-impl', slug: 'implementer', name: 'Implementer', reportsTo: 'r-orch' }),
      role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', reportsTo: 'r-orch' })
    ]
    const ledger = new DelegationLedger({ obligations: { 'r-orch': ['r-impl', 'r-rev'] }, strict: false })
    ledger.noteRoot('root', 'r-orch')
    const { ctx } = start({ delegation: ledger, roles: rs, project: project({ roles: rs, isolateWriters: false }) })
    const q = await firstQuery()
    for (const [id, tu, type] of [['i1', 'tu1', 'implementer'], ['v1', 'tu2', 'reviewer']] as const) {
      await started(ctx, q, id, tu, type)
      await handBack(q, { id, type }, `${type} report`)
      expect(await stopNoText(q, id, type)).toEqual({})
      await post(q, tu, { status: 'completed', handback: 'send', content: [{ type: 'text', text: 'delivered as a message' }] })
      expect(lastAgent(ctx, id)?.result).toBe(`${type} report`)
    }
    const receipts = ledger.snapshot().receipts
    expect(receipts.map((r) => [r.childId, r.delivered, r.reportChars > 0])).toEqual([
      ['i1', true, true],
      ['v1', true, true]
    ])
    expect(ledger.completion('root', { canCorrect: true, canWait: true, reportText: 'done', provisional: true })).toMatchObject({ action: 'allow' })
    expect(ledger.completion('root', { canCorrect: false, canWait: false, reportText: '' })).toMatchObject({ action: 'allow' })
    expect(ledger.rootVerdict()).not.toBe('failed')
    expect(ledger.summary().agents.root?.missing ?? []).toEqual([])
  })
})

describe('Claude delegation: nudge', () => {
  it('sends the text to the root as a harness message that is not an auto-continue', async () => {
    const { session } = start({ delegation: gateMock() })
    const q = await firstQuery()
    await session.nudge!('Harness: delegate now.')
    await vi.waitFor(() => expect(q.inputs.some((m) => (m.message as { content: string }).content === 'Harness: delegate now.')).toBe(true))
    expect(session.settlement?.().nudgeTurn1Sent).toBe(false)
  })
})
