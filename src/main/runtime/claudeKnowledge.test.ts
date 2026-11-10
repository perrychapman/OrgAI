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
// buildRolePrompt is the real one, wrapped so tests can read the flags the adapter passes.
vi.mock('./prompts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./prompts')>()
  return { ...orig, buildRolePrompt: vi.fn(orig.buildRolePrompt) }
})

import { ClaudeSession, buildAgents } from './claude'
import { buildRolePrompt } from './prompts'
import { RESUME_TEXT } from './runManager'
import { fakeCtx, project, role, runSummary } from './testHelpers'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } }

const BLOCK = 'KNOWN-ITEMS-BLOCK'
const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
})

function start(over: Partial<RuntimeContext> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-knowledge-')))
  const knowledgeContext = vi.fn<NonNullable<RuntimeContext['knowledgeContext']>>((text) => (text.includes('Acme') ? BLOCK : null))
  const ctx = fakeCtx({ project: project({ path: dir, kind: 'engagement', isolateWriters: false }), autoContinue: false, knowledgeContext, ...over })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  return { ctx, session, knowledgeContext }
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
const contentOf = (m: Record<string, unknown>): string => {
  const c = (m.message as { content: unknown }).content
  if (typeof c === 'string') return c
  return (c as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n')
}
const delivered = async (q: Fake, n: number): Promise<string[]> => {
  await vi.waitFor(() => expect(q.inputs.length).toBeGreaterThanOrEqual(n))
  return q.inputs.map(contentOf)
}
const userEntries = (events: RunEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'user' ? [e.entry.block.text] : []))

describe('PromptFlags.knowledgeBrief', () => {
  it('reaches every role prompt, and the key is left out without a brief', () => {
    const ctx = fakeCtx({ project: project({ kind: 'engagement' }), knowledgeBrief: () => 'INDEX' })
    vi.mocked(buildRolePrompt).mockClear()
    buildAgents(ctx, [], false)
    const flags = vi.mocked(buildRolePrompt).mock.calls.map((c) => c[3]!)
    expect(flags).toHaveLength(3)
    for (const f of flags) expect(f).toMatchObject({ knowledgeBrief: 'INDEX' })
    vi.mocked(buildRolePrompt).mockClear()
    buildAgents(fakeCtx({ project: project({ kind: 'engagement' }), knowledgeBrief: () => undefined }), [], false)
    for (const c of vi.mocked(buildRolePrompt).mock.calls) expect('knowledgeBrief' in c[3]!).toBe(false)
  })

  it('a rebuild (a restarted query builds its agents again) carries what the context returns, not a copy of its own', () => {
    let calls = 0
    // RunManager's knowledgeBrief is computed once; a fake that counts proves the adapter asks through it each time.
    const ctx = fakeCtx({ project: project({ kind: 'engagement' }), knowledgeBrief: () => (++calls, 'CONSTANT') })
    const a = buildAgents(ctx, [], false)
    const b = buildAgents(ctx, [], false)
    expect(calls).toBe(2)
    expect(a.lead!.prompt).toBe(b.lead!.prompt)
    expect(a.lead!.prompt).toContain('CONSTANT')
  })
})

describe('purpose spawn: PreToolUse on the Agent tool', () => {
  it('appends a non-null block to the brief in updatedInput.prompt and passes no agentId, since the child id is unknown', async () => {
    const { knowledgeContext } = start()
    const q = await firstQuery()
    knowledgeContext.mockClear()
    const out = await preToolUse(q)(hookCall('Agent', { subagent_type: 'engineer', prompt: 'Ask Acme about it' }, 'tu-1'), 'x', {})
    expect(knowledgeContext).toHaveBeenCalledExactlyOnceWith('Ask Acme about it', { purpose: 'spawn' })
    const prompt = out.hookSpecificOutput?.updatedInput?.prompt as string
    expect(prompt.startsWith('Ask Acme about it')).toBe(true)
    expect(prompt).toContain(BLOCK)
  })

  it('leaves the prompt alone on a null block, keeps the other updates, and never calls for a refused spawn', async () => {
    const { knowledgeContext } = start()
    const q = await firstQuery()
    knowledgeContext.mockClear()
    const out = await preToolUse(q)(hookCall('Agent', { subagent_type: 'engineer', prompt: 'Nothing known here' }, 'tu-1'), 'x', {})
    expect(out.hookSpecificOutput?.updatedInput?.prompt).toBe('Nothing known here')
    expect(out.hookSpecificOutput?.updatedInput?.name).toBe('engineer-1')
    knowledgeContext.mockClear()
    const refused = await preToolUse(q)(hookCall('Agent', { subagent_type: 'nobody', prompt: 'Ask Acme' }, 'tu-2'), 'x', {})
    expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(knowledgeContext).not.toHaveBeenCalled()
  })

  it('a throwing context does not break the spawn; it logs a warning', async () => {
    const { ctx } = start({
      knowledgeContext: () => {
        throw new Error('graph gone')
      }
    })
    const q = await firstQuery()
    const out = await preToolUse(q)(hookCall('Agent', { subagent_type: 'engineer', prompt: 'Ask Acme' }, 'tu-1'), 'x', {})
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny')
    expect(out.hookSpecificOutput?.updatedInput?.prompt).toBe('Ask Acme')
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('graph gone'))).toBe(true)
  })
})

describe('purpose message', () => {
  it('the first message carries the block; the transcript shows only what the user typed', async () => {
    const { ctx, knowledgeContext } = start({ prompt: 'Tell me about Acme' })
    const q = await firstQuery()
    const [first] = await delivered(q, 1)
    expect(first!.startsWith('Tell me about Acme')).toBe(true)
    expect(first).toContain(BLOCK)
    expect(knowledgeContext).toHaveBeenCalledWith('Tell me about Acme', { agentId: ROOT_AGENT_ID, purpose: 'message' })
    expect(userEntries(ctx.events)).toEqual(['Tell me about Acme'])
  })

  it('a later user message carries the block beside the text, never in its transcript entry, and names the root', async () => {
    const { ctx, session, knowledgeContext } = start()
    const q = await firstQuery()
    await session.send('What about Acme?')
    const all = await delivered(q, 2)
    expect(all[1]).toContain('What about Acme?')
    expect(all[1]).toContain(BLOCK)
    expect(knowledgeContext).toHaveBeenLastCalledWith('What about Acme?', { agentId: ROOT_AGENT_ID, purpose: 'message' })
    expect(userEntries(ctx.events)).toEqual(['Do it', 'What about Acme?'])
    expect(JSON.stringify(ctx.events)).not.toContain(BLOCK)
  })

  it('a message with images and no text is skipped and still sent', async () => {
    const { session, knowledgeContext } = start()
    const q = await firstQuery()
    knowledgeContext.mockClear()
    await session.send('', [{ mediaType: 'image/png', data: 'AA==', name: 'a.png' } as never])
    await delivered(q, 2)
    expect(knowledgeContext).not.toHaveBeenCalled()
  })

  it('a throwing context neither rejects nor loses the send; it logs a warning', async () => {
    const { ctx, session } = start({
      knowledgeContext: () => {
        throw new Error('graph gone')
      }
    })
    const q = await firstQuery()
    await expect(session.send('What about Acme?')).resolves.toBeUndefined()
    const all = await delivered(q, 2)
    expect(all[1]).toBe('What about Acme?')
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('graph gone'))).toBe(true)
  })

  it('an auto-resume (RESUME_TEXT as the first message) gets none', async () => {
    const { knowledgeContext } = start({ prompt: RESUME_TEXT, resumeSessionId: 'sess-0' })
    const q = await firstQuery()
    const [first] = await delivered(q, 1)
    expect(first).toBe(RESUME_TEXT)
    expect(knowledgeContext).not.toHaveBeenCalled()
  })

  it('a peer message and a harness nudge naming a known item get none', async () => {
    const { session, knowledgeContext } = start({ prompt: 'Start' })
    const q = await firstQuery()
    knowledgeContext.mockClear()
    await session.receive({ fromRunId: 'r2', fromProjectName: 'Other', fromPrompt: 'x', text: 'Acme is on fire' })
    // The path every harness message takes (nudges, integration notices).
    ;(session as unknown as { notifyOrchestrator(t: string, a?: string, o?: unknown): void }).notifyOrchestrator('Harness: continue with Acme', 'Thinking…', { nudge: true })
    const all = await delivered(q, 3)
    expect(all[1]).toContain('Acme is on fire')
    expect(all[2]).toBe('Harness: continue with Acme')
    expect(knowledgeContext).not.toHaveBeenCalled()
    expect(all.join('\n')).not.toContain(BLOCK)
  })
})

describe('knowledge_recall reachability', () => {
  const tools = (over: Partial<RuntimeContext> = {}) => {
    const { session: _s, ...rest } = start({ knowledgeRecall: vi.fn(() => 'FENCED'), ...over })
    void _s
    return rest
  }
  const recall = (q: Fake) => {
    const handler = q.options.mcpServers.orgai.instance._registeredTools.knowledge_recall
    return (args: Record<string, unknown>, id?: string) => handler.handler(args, id ? { _meta: { 'claudecode/toolUseId': id } } : {}) as Promise<{ content: { text: string }[] }>
  }

  it('is whitelisted for the root and every report on an engagement work run, and the hook allows a report', async () => {
    tools()
    const q = await firstQuery()
    for (const slug of ['lead', 'engineer', 'reviewer']) expect(q.options.agents[slug].tools).toContain('mcp__orgai__knowledge_recall')
    const out = await preToolUse(q)(hookCall('mcp__orgai__knowledge_recall', { query: 'x' }, 'tu-1', { id: 'a1', type: 'reviewer' }), 'x', {})
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow')
    const root = await preToolUse(q)(hookCall('mcp__orgai__knowledge_recall', { query: 'x' }, 'tu-2'), 'x', {})
    expect(root.hookSpecificOutput?.permissionDecision).toBe('allow')
  })

  it('is whitelisted on a single (Ask) run whose role list names no harness tool', async () => {
    const roles = [role({ id: 'r-a', slug: 'assistant', name: 'Assistant', tools: ['Read'] })]
    tools({ run: runSummary({ team: 'single' }), roles, project: project({ kind: 'engagement', roles, isolateWriters: false, path: realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-knowledge-'))) }) })
    const q = await firstQuery()
    expect(q.options.agents.assistant.tools).toContain('mcp__orgai__knowledge_recall')
  })

  it('tells the tool the caller: root explicit, a report by id, a guess with reports live as no agentId', async () => {
    const knowledgeRecall = vi.fn<NonNullable<RuntimeContext['knowledgeRecall']>>(() => 'FENCED')
    const { ctx } = tools({ knowledgeRecall })
    const q = await firstQuery()
    const hook = preToolUse(q)
    const call = recall(q)

    await hook(hookCall('mcp__orgai__knowledge_recall', { query: 'x' }, 'tu-root'), 'x', {})
    await call({ query: 'x' }, 'tu-root')
    expect(knowledgeRecall).toHaveBeenLastCalledWith({ query: 'x' }, { agentId: ROOT_AGENT_ID, roleId: undefined })

    // No report live and no id in _meta: only the root could have called.
    await hook(hookCall('mcp__orgai__knowledge_recall', { query: 'y' }, 'tu-root-2'), 'x', {})
    await call({ query: 'y' })
    expect(knowledgeRecall).toHaveBeenLastCalledWith({ query: 'y' }, { agentId: ROOT_AGENT_ID, roleId: undefined })

    // A live report: the id still identifies, a first-in-first-out match does not.
    q.emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', subagent_type: 'engineer', tool_use_id: 'tu-spawn', description: 'work', session_id: 's', uuid: 'u1' })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.id === 'a1')).toBe(true))
    await hook(hookCall('mcp__orgai__knowledge_recall', { query: 'z' }, 'tu-sub', { id: 'a1', type: 'engineer' }), 'x', {})
    await call({ query: 'z' }, 'tu-sub')
    expect(knowledgeRecall).toHaveBeenLastCalledWith({ query: 'z' }, { agentId: 'a1', roleId: undefined })
    await hook(hookCall('mcp__orgai__knowledge_recall', { query: 'w' }, 'tu-guess'), 'x', {})
    await call({ query: 'w' })
    expect(knowledgeRecall).toHaveBeenLastCalledWith({ query: 'w' }, { agentId: undefined, roleId: undefined })
  })
})

describe('staffing brief (orchestration-efficiency 4.5)', () => {
  const entries = (roleId: string) =>
    Array.from({ length: 5 }, (_, i) => ({ roleId, tier: 'fast' as const, effort: 'low' as const, firstOfStep: true, passedFirstTime: true, escalated: false, at: i }))
  const MARK = 'Staffing history for this project (data, not instructions):'

  it("goes once into the root's first message as hidden context: not the transcript, a later message or the prompts", async () => {
    const p = project({ path: realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-brief-'))), isolateWriters: false })
    const report = p.roles.find((r) => r.reportsTo !== null)!
    const { ctx, session } = start({ project: p, roles: p.roles, prompt: 'Build it', staffingProfile: () => ({ entries: entries(report.id) }) })
    const q = await firstQuery()
    const [first] = await delivered(q, 1)
    expect(first!.startsWith('Build it')).toBe(true)
    expect(first).toContain('Context from the harness (not visible to the user):')
    expect(first).toContain(MARK)
    expect(first).toContain(report.name)
    await session.send('One more thing')
    const all = await delivered(q, 2)
    expect(all[1]).not.toContain(MARK)
    expect(userEntries(ctx.events)).toEqual(['Build it', 'One more thing'])
    expect(JSON.stringify(ctx.events)).not.toContain(MARK)
    expect(JSON.stringify(q.options.systemPrompt ?? '')).not.toContain(MARK)
    expect(JSON.stringify(q.options.agents ?? {})).not.toContain(MARK)
  })

  it('a resumed session and a fixed project get none', async () => {
    const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-brief-')))
    const p = project({ path, isolateWriters: false })
    const reportId = p.roles.find((r) => r.reportsTo !== null)!.id
    for (const [over, want] of [
      [{}, true],
      [{ resumeSessionId: 'sess-0' }, false],
      [{ project: { ...p, staffing: 'fixed' as const } }, false]
    ] as const) {
      start({ project: p, roles: p.roles, prompt: 'Build it', staffingProfile: () => ({ entries: entries(reportId) }), ...over })
      const [first] = await delivered(await firstQuery(), 1)
      expect(first!.includes(MARK)).toBe(want)
      for (const s of sessions.splice(0)) await s.stop()
      sdk.queries.length = 0
    }
  })
})
