import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Role, RunEvent } from '@shared/types'

// A message for the root must not wait behind a foreground shell call (Bash / PowerShell) until its timeout: the
// adapter backgrounds exactly those calls by tool_use id through Query.backgroundTasks (SDK typings, not checked live).
// A scripted stand-in for the CLI; no tokens.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    inputs: Msg[] = []
    backgroundCalls: (string | undefined)[] = []
    backgroundAnswer: () => Promise<boolean> = async () => true
    stopped: string[] = []
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
    backgroundTasks(toolUseId?: string): Promise<boolean> {
      this.backgroundCalls.push(toolUseId)
      return this.backgroundAnswer()
    }
    async setMcpServers() {
      return { added: [], removed: [], errors: {} }
    }
    async mcpServerStatus() {
      return []
    }
    async interrupt() {}
    async stopTask(id: string) {
      this.stopped.push(id)
    }
    async supportedModels() {
      return []
    }
    async getContextUsage() {
      return { rawMaxTokens: 200_000 }
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

type Fake = InstanceType<typeof sdk.FakeQuery>

const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
})

const roles = (): Role[] => [
  role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'opus', tier: 'deep', canSpawn: true, spawnable: ['r-eng'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: 'sonnet', tier: 'everyday', reportsTo: 'r-lead' })
]

async function start() {
  const rs = roles()
  const ctx = fakeCtx({ project: project({ path: '/repo', roles: rs, isolateWriters: false }), roles: rs, run: runSummary(), autoContinue: false })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  const q = sdk.queries[0]!
  q.emit({ type: 'system', subtype: 'init', model: 'claude-opus', session_id: 's', claude_code_version: 'x', uuid: 'i-1' })
  return { ctx, session, q }
}

let seq = 0
/** An assistant message with one tool_use block, from the root (parent null) or from inside an Agent call. */
function toolUse(q: Fake, id: string, name: string, input: Record<string, unknown>, parent: string | null = null): void {
  seq += 1
  q.emit({
    type: 'assistant',
    message: { id: `m-${seq}`, role: 'assistant', model: 'claude-opus', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: parent,
    session_id: 's',
    uuid: `a-${seq}`
  })
}
function toolResult(q: Fake, id: string, parent: string | null = null): void {
  seq += 1
  q.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: parent, session_id: 's', uuid: `u-${seq}` })
}
const shown = (ctx: { events: RunEvent[] }, id: string): boolean =>
  ctx.events.some((e) => e.type === 'transcript' && (e.entry.block.kind === 'tool_use' ? e.entry.block.id === id : e.entry.block.kind === 'tool_result' && e.entry.block.toolUseId === id))
const shownResult = (ctx: { events: RunEvent[] }, id: string): boolean =>
  ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_result' && e.entry.block.toolUseId === id)
const inputText = (q: Fake): string => JSON.stringify(q.inputs)
const logs = (ctx: { events: RunEvent[] }, level: string): string[] => ctx.events.flatMap((e) => (e.type === 'log' && e.level === level ? [e.message] : []))
const flush = () => new Promise((r) => setTimeout(r, 10))

describe('Claude: a message for the root does not wait behind a foreground shell call', () => {
  it('a user send during a root Bash call backgrounds that call by its tool_use id and still queues the message', async () => {
    const { ctx, session, q } = await start()
    toolUse(q, 'tu-sh', 'Bash', { command: 'sleep 600', timeout: 600000 })
    await vi.waitFor(() => expect(shown(ctx, 'tu-sh')).toBe(true))
    await session.send('Are you there?')
    expect(q.backgroundCalls).toEqual(['tu-sh'])
    await vi.waitFor(() => expect(inputText(q)).toContain('Are you there?'))
    await flush()
    // Already moved: a second message asks nothing more.
    await session.send('Again')
    expect(q.backgroundCalls).toEqual(['tu-sh'])
  })

  it('PowerShell counts as a shell; a run_in_background call, a finished call and no call ask nothing', async () => {
    const { ctx, session, q } = await start()
    await session.send('Nothing running')
    expect(q.backgroundCalls).toEqual([])
    toolUse(q, 'tu-bg', 'Bash', { command: 'npm run dev', run_in_background: true })
    toolUse(q, 'tu-done', 'Bash', { command: 'ls' })
    toolResult(q, 'tu-done')
    await vi.waitFor(() => expect(shownResult(ctx, 'tu-done')).toBe(true))
    await session.send('Still nothing')
    expect(q.backgroundCalls).toEqual([])
    toolUse(q, 'tu-ps', 'PowerShell', { command: 'Start-Sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-ps')).toBe(true))
    await session.send('Now')
    expect(q.backgroundCalls).toEqual(['tu-ps'])
  })

  it('a foreground subagent spawn and a subagent’s own shell call are never backgrounded; no call is made without an id', async () => {
    const { ctx, session, q } = await start()
    toolUse(q, 'tu-agent', 'Agent', { subagent_type: 'engineer', description: 'Build', prompt: 'Build it' })
    toolUse(q, 'tu-sub-sh', 'Bash', { command: 'sleep 600' }, 'tu-agent')
    await vi.waitFor(() => expect(shown(ctx, 'tu-sub-sh')).toBe(true))
    await session.send('Hello')
    await session.nudge('Harness: reminder')
    await flush()
    expect(q.backgroundCalls).toEqual([])
    await vi.waitFor(() => expect(inputText(q)).toContain('Hello'))
  })

  it('a rejecting backgroundTasks does not fail the send: the message is queued, a warning is logged, the call is not asked again', async () => {
    const { ctx, session, q } = await start()
    q.backgroundAnswer = () => Promise.reject(new Error('background tasks are disabled'))
    toolUse(q, 'tu-sh', 'Bash', { command: 'sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-sh')).toBe(true))
    await expect(session.send('Hi')).resolves.toBeUndefined()
    await vi.waitFor(() => expect(inputText(q)).toContain('Hi'))
    await vi.waitFor(() => expect(logs(ctx, 'warn').some((m) => m.includes('background tasks are disabled'))).toBe(true))
    await session.send('Hi again')
    expect(q.backgroundCalls).toEqual(['tu-sh'])
  })

  it('a backgroundTasks that throws synchronously does not fail the send either', async () => {
    const { ctx, session, q } = await start()
    q.backgroundAnswer = () => {
      throw new Error('boom')
    }
    toolUse(q, 'tu-sh', 'Bash', { command: 'sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-sh')).toBe(true))
    await expect(session.send('Hi')).resolves.toBeUndefined()
    await vi.waitFor(() => expect(logs(ctx, 'warn').some((m) => m.includes('boom'))).toBe(true))
    await vi.waitFor(() => expect(inputText(q)).toContain('Hi'))
  })

  it('a peer message and a harness notice background the root shell call the same way', async () => {
    const { ctx, session, q } = await start()
    toolUse(q, 'tu-1', 'Bash', { command: 'sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-1')).toBe(true))
    await session.receive({ fromRunId: 'run-2', fromProjectName: 'Other', fromPrompt: 'Other work', text: 'Peer says hi' })
    expect(q.backgroundCalls).toEqual(['tu-1'])
    await vi.waitFor(() => expect(inputText(q)).toContain('Peer says hi'))
    toolResult(q, 'tu-1')
    toolUse(q, 'tu-2', 'Bash', { command: 'sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-2')).toBe(true))
    await session.nudge('Harness: a report is back')
    expect(q.backgroundCalls).toEqual(['tu-1', 'tu-2'])
    await vi.waitFor(() => expect(inputText(q)).toContain('a report is back'))
  })

  it('false while the call still runs (no task yet) warns, and the call is asked again at its task_started', async () => {
    const { ctx, session, q } = await start()
    let answer = false
    q.backgroundAnswer = async () => answer
    toolUse(q, 'tu-sh', 'Bash', { command: 'sleep 600' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-sh')).toBe(true))
    await session.send('Hi')
    await vi.waitFor(() => expect(logs(ctx, 'warn').some((m) => m.includes('could not be moved to the background yet'))).toBe(true))
    answer = true
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu-sh', task_type: 'local_bash', is_backgrounded: false, description: 'sleep', session_id: 's', uuid: 't1' })
    await vi.waitFor(() => expect(q.backgroundCalls).toEqual(['tu-sh', 'tu-sh']))
  })

  it('the backgrounded shell stays a background task until its notification, and an interrupt stops it', async () => {
    const { ctx, session, q } = await start()
    toolUse(q, 'tu-sh', 'Bash', { command: 'sleep 600' })
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu-sh', task_type: 'local_bash', is_backgrounded: false, description: 'sleep', session_id: 's', uuid: 't1' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-sh')).toBe(true))
    await session.send('Hi')
    await flush()
    // The placeholder result the CLI returns for the moved call, then the turn goes on and ends.
    toolResult(q, 'tu-sh')
    q.emit({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true }, session_id: 's', uuid: 't2' })
    q.emit({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, is_error: false, session_id: 's', uuid: 'r-1' })
    await vi.waitFor(() => expect(shownResult(ctx, 'tu-sh')).toBe(true))
    await flush()
    expect(session.settlement().quiescent).toBe(false)
    await session.interrupt()
    expect(q.stopped).toContain('b1')
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'tu-sh', status: 'stopped', output_file: '', summary: '', session_id: 's', uuid: 'n1' })
    await vi.waitFor(() => expect(session.settlement().quiescent).toBe(true))
  })

  it('an interrupt leaves a shell the agent started in the background itself alone', async () => {
    const { ctx, session, q } = await start()
    toolUse(q, 'tu-bg', 'Bash', { command: 'npm run dev', run_in_background: true })
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 'tu-bg', task_type: 'local_bash', is_backgrounded: true, description: 'dev', session_id: 's', uuid: 't1' })
    await vi.waitFor(() => expect(shown(ctx, 'tu-bg')).toBe(true))
    await flush()
    await session.interrupt()
    expect(q.stopped).not.toContain('b2')
  })
})
