import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { READ_DOCUMENT_TOOL } from '@shared/types'

// Only `query` is faked; the in-process harness server is the real SDK module.
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    private waiters: ((r: IteratorResult<Msg>) => void)[] = []
    private out: Msg[] = []
    private done = false
    constructor(
      prompt: AsyncIterable<Msg>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly options: Record<string, any>
    ) {
      void (async () => {
        for await (const _ of prompt) void _
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
  return { FakeQuery, queries: [] as FakeQuery[], callers: [] as unknown[] }
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

// The real read_document definition lands separately in harnessTools; until then the run offers a recording stand-in.
vi.mock('./harnessTools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./harnessTools')>()
  return {
    ...orig,
    harnessToolsFor: (...args: Parameters<typeof orig.harnessToolsFor>) => {
      const tools = orig.harnessToolsFor(...args)
      return tools.some((t) => t.name === READ_DOCUMENT_TOOL)
        ? tools
        : [...tools, { name: READ_DOCUMENT_TOOL, description: 'stub', audience: 'all' as const, inputSchema: z.object({ path: z.string() }), call: async () => 'STUB-TEXT' }]
    }
  }
})

import { HarnessCallerTracker, READ_DOCUMENT_NO_READ_DENIAL, ClaudeSession, buildHarnessServer } from './claude'
import type { HarnessTool } from './harnessTools'
import { fakeCtx, orgChart, project, role } from './testHelpers'
import { ROOT_AGENT_ID } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

/** A stand-in for the real read_document definition: it only records who called it. */
const stub = (): HarnessTool & { seen: unknown[] } => {
  const seen: unknown[] = []
  return {
    seen,
    name: READ_DOCUMENT_TOOL,
    description: 'stub',
    audience: 'all',
    inputSchema: z.object({ path: z.string() }),
    call: async (_args, caller) => {
      seen.push(caller)
      return 'STUB-TEXT'
    }
  }
}

const sessions: ClaudeSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
})

const roles = () => [...orgChart(), role({ id: 'r-scribe', slug: 'scribe', name: 'Scribe', tools: ['Grep'], reportsTo: 'r-lead' })]

function start() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-readdoc-')))
  const rs = roles()
  const ctx = fakeCtx({ project: project({ path: dir, roles: rs, isolateWriters: false }), roles: rs, autoContinue: false })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  return { ctx, dir }
}
async function firstQuery(): Promise<Fake> {
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  return sdk.queries[0]!
}
const hook = (q: Fake, input: Record<string, unknown>, id: string, agent?: { id: string; type?: string }) =>
  (q.options.hooks.PreToolUse[0].hooks[0] as (i: unknown, id: string, o: unknown) => Promise<HookOut>)(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '',
      cwd: '/repo',
      tool_name: `mcp__orgai__${READ_DOCUMENT_TOOL}`,
      tool_input: input,
      tool_use_id: id,
      ...(agent ? { agent_id: agent.id, ...(agent.type ? { agent_type: agent.type } : {}) } : {})
    },
    'x',
    {}
  )
const spawn = async (q: Fake, ctx: ReturnType<typeof start>['ctx'], taskId: string, slug: string) => {
  q.emit({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_agent', subagent_type: slug, tool_use_id: `tu-spawn-${taskId}`, description: 'work', session_id: 's', uuid: `u-${taskId}` })
  await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.id === taskId)).toBe(true))
}

describe('read_document PreToolUse gate (fake query)', () => {
  it('denies a report whose role has no Read, allows one with Read and the root, and denies an unresolved report', async () => {
    const { ctx } = start()
    const q = await firstQuery()
    await spawn(q, ctx, 'a-scribe', 'scribe')
    await spawn(q, ctx, 'a-eng', 'engineer')

    const noRead = await hook(q, { path: 'a.xlsx' }, 'tu-1', { id: 'a-scribe', type: 'scribe' })
    expect(noRead.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: READ_DOCUMENT_NO_READ_DENIAL })
    expect(READ_DOCUMENT_NO_READ_DENIAL).toBe('Your role has no Read tool, so read_document is not available to you.')

    expect((await hook(q, { path: 'a.xlsx' }, 'tu-2', { id: 'a-eng', type: 'engineer' })).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' })
    expect((await hook(q, { path: 'a.xlsx' }, 'tu-3')).hookSpecificOutput?.permissionDecision).not.toBe('deny')

    // A report neither the hook (no agent_type) nor the agent table can name a role for.
    const unresolved = await hook(q, { path: 'a.xlsx' }, 'tu-4', { id: 'ghost' })
    expect(unresolved.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: READ_DOCUMENT_NO_READ_DENIAL })
  })

  it('reports see the harness tool in their whitelist even without Read, so the hook is the gate', async () => {
    start()
    const q = await firstQuery()
    expect(q.options.agents.scribe.tools).not.toContain('Read')
    expect(q.options.agents.scribe.tools).toContain(`mcp__orgai__${READ_DOCUMENT_TOOL}`)
  })
})

describe('buildHarnessServer caller for read_document', () => {
  const call = (server: ReturnType<typeof buildHarnessServer>, id?: string) => {
    const handler = (server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance._registeredTools[READ_DOCUMENT_TOOL]!
    return handler.handler({ path: 'a.md' }, id ? { _meta: { 'claudecode/toolUseId': id } } : {})
  }
  const build = (reportsLive: boolean) => {
    const tool = stub()
    const tracker = new HarnessCallerTracker()
    const server = buildHarnessServer([tool], tracker, () => reportsLive, undefined, (id) => (id === 'a1' ? 'r-eng' : undefined), (id) => `/work/${id}`)
    return { tool, tracker, server }
  }
  const name = `mcp__orgai__${READ_DOCUMENT_TOOL}`

  it('a known report: agentId, its role and its working folder', async () => {
    const { tool, tracker, server } = build(true)
    tracker.record(name, 'tu-r', 'a1')
    await call(server, 'tu-r')
    expect(tool.seen).toEqual([{ agentId: 'a1', roleId: 'r-eng', cwd: '/work/a1' }])
  })

  it('a known root: ROOT_AGENT_ID and its folder, no roleId', async () => {
    const { tool, tracker, server } = build(true)
    tracker.record(name, 'tu-root', undefined)
    await call(server, 'tu-root')
    expect(tool.seen).toEqual([{ agentId: ROOT_AGENT_ID, cwd: `/work/${ROOT_AGENT_ID}` }])
  })

  it('an unknown caller (a first-in-first-out guess while reports are live, or no sighting) is {}', async () => {
    const { tool, tracker, server } = build(true)
    tracker.record(name, 'tu-x', undefined)
    await call(server) // no id in _meta: a queue guess, reports live
    await call(server, 'never-seen')
    expect(tool.seen).toEqual([{}, {}])
  })
})
