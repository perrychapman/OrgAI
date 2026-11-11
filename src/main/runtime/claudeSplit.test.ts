import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { ClaudeSession, SPAWN_LINK_WAIT_MS, STOPPED_REPORT_DENIAL, TOOL_USE_BY_TASK_MAX } from './claude'
import { CONTEXT_PACK_HEADING, CONTEXT_PACK_NOT_READ_IN_FULL, READ_TEXT_STORE_LIMITS } from './contextPack'
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

async function start(over: Partial<RuntimeContext> = {}, rs: Role[] = roles()) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-split-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'contract.ts'), 'export interface Contract { id: string }\n')
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 2\n')
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
/** A Read response as the CLI builds it (0.3.318 bundle): the raw text and its line counts; whole file unless `part`. */
const readResponse = (file: string, content: string, part?: { startLine: number; numLines: number; totalLines: number }) => {
  const lines = content.split('\n').length
  return { type: 'text', file: { filePath: file, content, numLines: part?.numLines ?? lines, startLine: part?.startLine ?? 1, totalLines: part?.totalLines ?? lines } }
}
/**
 * A successful Read (its PostToolUse: the CLI ran it) by the root, or by `agentId`; `file` relative to `cwd`. The
 * response holds `content` (default: the file's text now, the whole file) unless `response` is given.
 */
const read = (q: Fake, file: string, cwd: string, agentId?: string, response?: unknown): Promise<HookOut> =>
  hooksOf(q, 'PostToolUse')({
    ...base(cwd),
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: file },
    tool_response: response ?? readResponse(file, readFileSync(resolve(cwd, file), 'utf8')),
    tool_use_id: `read-${Math.random()}`,
    ...(agentId ? { agent_id: agentId, agent_type: 'engineer' } : { agent_type: 'lead' })
  }, 'x', {})
/** Any tool call's PreToolUse by `agentId`. */
const pre = (q: Fake, agentId: string, tool: string, input: Record<string, unknown>, type = 'engineer'): Promise<HookOut> =>
  hooksOf(q, 'PreToolUse')({ ...base(), hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `${tool}-${Math.random()}`, agent_id: agentId, agent_type: type }, 'x', {})
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
    // Only files the lead itself read with Read are inlined.
    await read(q, join(dir, 'src', 'contract.ts'), dir)
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
    expect(out).toContain(`missing.ts (${CONTEXT_PACK_NOT_READ_IN_FULL})`)
    // Delivered once: a resumed start of the same agent gets nothing.
    expect(await subStart(q, 'a1', 'engineer')).toEqual({})
    void ctx
  })

  it('parallel spawns of one role: each start gets its own pack, whatever the order of starts and links', async () => {
    const { q, dir } = await start()
    await read(q, 'src/contract.ts', dir)
    await read(q, 'src/other.ts', dir)
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
    await read(q, join(dir, 'src', 'contract.ts'), dir)
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

describe('Claude: the pack holds only what the lead read, from the folders the harness knows (second security pass)', () => {
  it('E: a file the lead did not read (a Read the CLI denied never reaches PostToolUse), or that another agent read, is not inlined', async () => {
    const { ctx, q, dir } = await start()
    // The CLI's own rules (e.g. Read(./.env) in .claude/settings.json) deny the lead's Read: no PostToolUse, nothing recorded.
    writeFileSync(join(dir, '.env'), 'TOKEN=s3cret\n')
    await read(q, 'src/contract.ts', dir)
    // A report's Read counts for that report only.
    await read(q, join(dir, 'src', 'other.ts'), dir, 'a-other')
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts, .env, src/other.ts', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    const block = (await subStart(q, 'a1', 'engineer')).hookSpecificOutput.additionalContext as string
    expect(block).toContain('File: src/contract.ts')
    expect(block).not.toContain('s3cret')
    expect(block).not.toContain('other.ts')
    const out = (await post(q, 't1', launched('a1'))).hookSpecificOutput.additionalContext as string
    expect(out).toContain(`.env (${CONTEXT_PACK_NOT_READ_IN_FULL})`)
    expect(out).toContain(`src/other.ts (${CONTEXT_PACK_NOT_READ_IN_FULL})`)
  })

  it('E: a read through a link is found by its real path too; a failed or non-text Read records nothing', async () => {
    const { ctx, q, dir } = await start()
    symlinkSync(join(dir, 'src', 'contract.ts'), join(dir, 'alias.ts'))
    await read(q, 'alias.ts', dir)
    await read(q, 'src/other.ts', dir, undefined, { is_error: true })
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts, src/other.ts', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    const block = (await subStart(q, 'a1', 'engineer')).hookSpecificOutput.additionalContext as string
    expect(block).toContain('File: src/contract.ts\n```\nexport interface Contract')
    expect(block).not.toContain('File: src/other.ts')
  })

  it('2: a partial Read (a range, a token-cap page) is not inlined', async () => {
    const { ctx, q, dir } = await start()
    writeFileSync(join(dir, 'long.ts'), 'a\nb\nc\nd\n')
    await read(q, 'long.ts', dir, undefined, readResponse('long.ts', 'b\nc', { startLine: 2, numLines: 2, totalLines: 5 }))
    await read(q, 'src/contract.ts', dir, undefined, { ...readResponse('src/contract.ts', 'export interface'), file: { ...readResponse('src/contract.ts', 'export interface').file, truncatedByTokenCap: true } })
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: long.ts, src/contract.ts', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    expect(await subStart(q, 'a1', 'engineer')).toEqual({})
    const out = (await post(q, 't1', launched('a1'))).hookSpecificOutput.additionalContext as string
    expect(out).toContain(`long.ts (${CONTEXT_PACK_NOT_READ_IN_FULL})`)
    expect(out).toContain(`src/contract.ts (${CONTEXT_PACK_NOT_READ_IN_FULL})`)
  })

  it('2: a file changed on disk after the lead\'s Read inlines what the lead saw; no file system read at spawn', async () => {
    const { ctx, q, dir } = await start()
    await read(q, 'src/contract.ts', dir)
    writeFileSync(join(dir, 'src', 'contract.ts'), 'REPLACED after the read\n')
    // Even gone from disk.
    await read(q, 'src/other.ts', dir)
    unlinkSync(join(dir, 'src', 'other.ts'))
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: src/contract.ts, src/other.ts', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    const block = (await subStart(q, 'a1', 'engineer')).hookSpecificOutput.additionalContext as string
    expect(block).toContain('export interface Contract { id: string }')
    expect(block).toContain('export const other = 2')
    expect(block).not.toContain('REPLACED')
  })

  it('2: a link flipped between the Read and its PostToolUse cannot inline a file whose content the Read did not return', async () => {
    const { ctx, q, dir } = await start()
    writeFileSync(join(dir, 'notes.md'), 'plain notes\n')
    writeFileSync(join(dir, '.env'), 'TOKEN=s3cret\n')
    symlinkSync(join(dir, 'notes.md'), join(dir, 'link.md'))
    // The CLI read link.md -> notes.md (its deny rule for .env checked against that); the link then flips to .env.
    const seen = readResponse('link.md', readFileSync(join(dir, 'link.md'), 'utf8'))
    unlinkSync(join(dir, 'link.md'))
    symlinkSync(join(dir, '.env'), join(dir, 'link.md'))
    await read(q, 'link.md', dir, undefined, seen)
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: link.md, .env', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    const block = (await subStart(q, 'a1', 'engineer')).hookSpecificOutput.additionalContext as string
    expect(block).not.toContain('s3cret')
    expect(block).toContain('File: link.md\n```\nplain notes')
  })

  it('2: memory bounds: entries per agent (oldest dropped); a report\'s reads are dropped when it ends', async () => {
    const { ctx, session, q, dir } = await start()
    for (let i = 0; i <= READ_TEXT_STORE_LIMITS.entries; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `file ${i}`)
      await read(q, `f${i}.txt`, dir)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (session as any).readTexts as { size: (a: string) => { entries: number }; get: (a: string, k: string) => unknown }
    expect(store.size('root').entries).toBe(READ_TEXT_STORE_LIMITS.entries)
    expect(store.get('root', join(dir, 'f0.txt'))).toBeUndefined()
    expect(store.get('root', join(dir, `f${READ_TEXT_STORE_LIMITS.entries}.txt`))).toBeDefined()
    // A report's own reads, gone once it ends.
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: false }, dir)
    await started(ctx, q, 'a1', 't1', 'engineer')
    await read(q, 'src/contract.ts', dir, 'a1')
    expect(store.size('a1').entries).toBe(1)
    await subStop(q, 'a1', 'engineer')
    expect(store.size('a1').entries).toBe(0)
  })

  it('F: a target role without the Read tool gets no pack', async () => {
    const rs = roles().map((r): Role => (r.slug === 'helper' ? { ...r, tools: ['Bash'] } : r))
    const { ctx, q, dir } = await start({}, rs)
    await read(q, 'src/contract.ts', dir)
    await spawn(q, 't1', { ...wellFormed.helper, prompt: 'B\nFiles: src/contract.ts', run_in_background: true }, dir)
    await started(ctx, q, 'a1', 't1', 'helper')
    expect(await subStart(q, 'a1', 'helper')).toEqual({})
    expect((await post(q, 't1', launched('a1'))).hookSpecificOutput.additionalContext).toContain('src/contract.ts (Helper has no Read tool)')
  })

  it('G: the hook\'s cwd resolves relative paths but is never a root', async () => {
    const { ctx, q, dir } = await start()
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-split-out-')))
    dirs.push(elsewhere)
    writeFileSync(join(elsewhere, 'notes.txt'), 'outside the run')
    // The lead read it (a Read it was allowed), and the hook reports its cwd there: still outside the run's folders.
    await read(q, 'notes.txt', elsewhere)
    await spawn(q, 't1', { ...wellFormed.engineer, prompt: 'A\nFiles: notes.txt', run_in_background: true }, elsewhere)
    await started(ctx, q, 'a1', 't1', 'engineer')
    void (await subStart(q, 'a1', 'engineer'))
    const out = (await post(q, 't1', launched('a1'))).hookSpecificOutput.additionalContext as string
    expect(out).toContain('notes.txt (outside the folders the report may read)')
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

  it('I1/I2: a stopped report may not keep acting: every tool call is denied, its hand-back too, until a SendMessage resume', async () => {
    const { ctx, session, q } = await start({ delegation: gateMock() })
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await post(q, 't1', launched('a1'))
    expect(await pre(q, 'a1', 'Bash', { command: 'ls' })).toEqual({})
    await session.interrupt()
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }], ['Read', { file_path: 'x' }], ['SubagentHandback', { message: 'late' }]] as const) {
      expect((await pre(q, 'a1', tool, input)).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED_REPORT_DENIAL })
    }
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Interrupted' })
    // A SendMessage resume (task_started for the known agent) makes it live again.
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', tool_use_id: 'sm-1', parent_task_id: undefined, subagent_type: 'engineer', description: 'more', session_id: 's', uuid: 'u-a1-resume' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('thinking'))
    expect(await pre(q, 'a1', 'Bash', { command: 'ls' })).toEqual({})
  })

  it('I3: a report stopped before its task_started arrived stays stopped when the late task_started comes', async () => {
    const gate = gateMock()
    const { ctx, session, q } = await start({ delegation: gate })
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    // The launch result names the agent before its task_started was handled.
    await post(q, 't1', launched('a1'))
    expect(session.settlement().quiescent).toBe(false)
    await session.interrupt()
    expect(q.stopped).toEqual(['a1'])
    expect(session.settlement().quiescent).toBe(true)
    // Its SubagentStart and task_started arrive late: recorded settled, never a live report.
    expect(await subStart(q, 'a1', 'engineer')).toEqual({})
    taskStarted(q, 'a1', 't1', 'engineer')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalledWith('a1', 'root', 'r-eng'))
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Interrupted' })
    expect(gate.ended).toHaveBeenCalledWith('a1')
    expect(session.settlement().quiescent).toBe(true)
    expect((await pre(q, 'a1', 'Bash', { command: 'ls' })).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(await subStop(q, 'a1', 'engineer')).toEqual({})
    expect(lastAgent(ctx, 'a1')?.activity).toBe('Interrupted')
    // The staffing book has it ended, not running.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).staffingBook.agents.get('a1')?.state).toBe('ended')
  })

  it('I3: a report the SubagentStart drew but whose task_started had not arrived is settled, and the late task_started keeps it so', async () => {
    const gate = gateMock()
    const { ctx, session, q } = await start({ delegation: gate })
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await subStart(q, 'a1', 'engineer')
    await post(q, 't1', launched('a1'))
    await session.interrupt()
    taskStarted(q, 'a1', 't1', 'engineer')
    await vi.waitFor(() => expect(gate.noteSpawn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', activity: 'Interrupted' })
    expect(gate.ended.mock.calls.filter(([id]) => id === 'a1').length).toBeGreaterThanOrEqual(1)
    // The ledger's last word on it is ended, after the noteSpawn.
    expect(gate.ended.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(gate.noteSpawn.mock.invocationCallOrder[0]!)
  })

  it('I4: a resumed report whose notification carries the SendMessage tool_use_id keeps its report text', async () => {
    const { ctx, q } = await start()
    await spawn(q, 't1', { ...wellFormed.engineer, run_in_background: true })
    await started(ctx, q, 'a1', 't1', 'engineer')
    await post(q, 't1', launched('a1'))
    await subStop(q, 'a1', 'engineer')
    notified(q, 'a1', 't1', 'First report.')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.result).toBe('First report.'))
    // The root messages it (a resume); the resume's task_started names the original Agent call.
    await hooksOf(q, 'PreToolUse')({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'eng-1', message: 'Also do B' }, tool_use_id: 'sm-1', agent_type: 'lead' }, 'x', {})
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', tool_use_id: 't1', subagent_type: 'engineer', description: 'more', session_id: 's', uuid: 'u-a1-resume' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('thinking'))
    // Its end is notified under the SendMessage call: still its report.
    notified(q, 'a1', 'sm-1', 'Second report.')
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')).toMatchObject({ state: 'done', result: 'Second report.' }))
    // A notification under an unrelated call (its own background Bash) is still not its end.
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', tool_use_id: 't1', subagent_type: 'engineer', description: 'again', session_id: 's', uuid: 'u-a1-resume2' })
    await vi.waitFor(() => expect(lastAgent(ctx, 'a1')?.state).toBe('thinking'))
    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'bash-call', status: 'completed', output_file: '', summary: 'sleep', session_id: 's', uuid: 'nb3' })
    await new Promise((r) => setTimeout(r, 20))
    expect(lastAgent(ctx, 'a1')?.state).toBe('thinking')
  })

  it('I5: the task_started links are bounded', async () => {
    const { session } = await start()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    for (let i = 0; i < TOOL_USE_BY_TASK_MAX + 50; i++) s.linkTask(`a${i}`, `t${i}`)
    expect(s.toolUseByTask.size).toBe(TOOL_USE_BY_TASK_MAX)
    expect(s.toolUseByTask.has('a0')).toBe(false)
    expect(s.toolUseByTask.get(`a${TOOL_USE_BY_TASK_MAX + 49}`)).toBe(`t${TOOL_USE_BY_TASK_MAX + 49}`)
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
