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

describe('Claude delegation: nudge', () => {
  it('sends the text to the root as a harness message that is not an auto-continue', async () => {
    const { session } = start({ delegation: gateMock() })
    const q = await firstQuery()
    await session.nudge!('Harness: delegate now.')
    await vi.waitFor(() => expect(q.inputs.some((m) => (m.message as { content: string }).content === 'Harness: delegate now.')).toBe(true))
    expect(session.settlement?.().nudgeTurn1Sent).toBe(false)
  })
})
