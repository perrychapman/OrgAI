import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '@shared/types'

// Only `query` is faked (the same scripted stand-in as claude.test.ts, reduced to what the hooks need).
const sdk = vi.hoisted(() => {
  type Msg = Record<string, unknown>
  class FakeQuery {
    private waiters: ((r: IteratorResult<Msg>) => void)[] = []
    private done = false
    constructor(
      readonly prompt: AsyncIterable<Msg>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly options: Record<string, any>
    ) {
      void (async () => {
        for await (const _ of prompt) void _
        this.end()
      })()
    }
    end(): void {
      this.done = true
      for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
    }
    [Symbol.asyncIterator](): AsyncIterator<Msg> {
      return {
        next: () => (this.done ? Promise.resolve({ value: undefined as never, done: true }) : new Promise((resolve) => this.waiters.push(resolve)))
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
import { SELF_CONTROL_DENIAL_MESSAGE, SELF_CONTROL_REFUSAL_TEXT, SELF_CONTROL_UNCHECKED_MESSAGE, controlProtectedPaths } from './selfControlGate'
import { fakeCtx, project } from './testHelpers'
import type { RuntimeContext } from './types'

type Fake = InstanceType<typeof sdk.FakeQuery>
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

const sessions: ClaudeSession[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop()
  sdk.queries.length = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function start(mode: PermissionMode, over: Partial<RuntimeContext> = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-claude-self-')))
  dirs.push(base)
  const repo = join(base, 'repo')
  const data = join(base, 'data')
  mkdirSync(repo)
  mkdirSync(join(data, 'run'), { recursive: true })
  const ctx = fakeCtx({ project: project({ path: repo, permissionMode: mode }), autoContinue: false, controlProtectedPaths: () => controlProtectedPaths(data), ...over })
  const session = new ClaudeSession(ctx)
  sessions.push(session)
  return { ctx, data, repo }
}

async function firstQuery(): Promise<Fake> {
  await vi.waitFor(() => expect(sdk.queries).toHaveLength(1))
  return sdk.queries[0]!
}

const hook = (q: Fake, tool: string, input: Record<string, unknown>, cwd: string): Promise<HookOut> =>
  (q.options.hooks.PreToolUse[0].hooks[0] as (i: unknown, id: string, o: unknown) => Promise<HookOut>)(
    { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd, tool_name: tool, tool_input: input, tool_use_id: `tu-${Math.random()}` },
    'x',
    {}
  )

const refusalRows = (ctx: { events: { type: string }[] }) =>
  ctx.events.filter((e) => e.type === 'transcript' && (e as unknown as { entry: { block: { text?: string }; source?: string } }).entry.block.text === SELF_CONTROL_REFUSAL_TEXT && (e as unknown as { entry: { source?: string } }).entry.source === 'harness')

describe('ClaudeSession self-control gate (fake query)', () => {
  for (const [label, mode, rules] of [
    ['bypassPermissions', 'bypassPermissions', []],
    ['acceptEdits', 'acceptEdits', []],
    ['a saved Bash(*) allow rule', 'default', ['Bash(*)', 'Bash', 'Read']]
  ] as const) {
    it(`PreToolUse denies orgai and control files under ${label}, writes the harness row, and still allows normal calls`, async () => {
      const { ctx, data, repo } = start(mode, { allowedRules: () => [...rules] })
      const q = await firstQuery()
      const cli = await hook(q, 'Bash', { command: 'orgai status' }, repo)
      expect(cli.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(cli.hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      const read = await hook(q, 'Read', { file_path: join(data, 'run', 'daemon.json') }, repo)
      expect(read.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(read.hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(refusalRows(ctx)).toHaveLength(2)
      const logs = ctx.events.filter((e) => e.type === 'log' && (e as { message?: string }).message?.includes('OrgAI control files or the orgai command'))
      expect(logs).toHaveLength(2)
      // An ordinary command is not touched by the gate (the hook may allow it or leave it to the CLI; never this deny).
      const normal = await hook(q, 'Bash', { command: 'npm test' }, repo)
      expect(normal.hookSpecificOutput?.permissionDecisionReason).not.toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(normal.hookSpecificOutput?.permissionDecision).not.toBe('deny')
      expect(refusalRows(ctx)).toHaveLength(2)
    })
  }

  it('a saved Bash rule allows npm test through the hook while orgai stays denied', async () => {
    const { repo } = start('default', { allowedRules: () => ['Bash(npm test:*)'] })
    const q = await firstQuery()
    expect((await hook(q, 'Bash', { command: 'npm test' }, repo)).hookSpecificOutput?.permissionDecision).toBe('allow')
    expect((await hook(q, 'Bash', { command: 'npm test && orgai daemon stop' }, repo)).hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('canUseTool denies as a backstop with the same message', async () => {
    const { ctx, data } = start('default')
    const q = await firstQuery()
    const canUseTool = q.options.canUseTool as (t: string, i: Record<string, unknown>, o: Record<string, unknown>) => Promise<Record<string, unknown>>
    const signal = new AbortController().signal
    expect(await canUseTool('Bash', { command: 'npx orgai inbox' }, { signal })).toEqual({ behavior: 'deny', message: SELF_CONTROL_DENIAL_MESSAGE })
    expect(await canUseTool('Edit', { file_path: join(data, 'secrets.json'), old_string: 'a', new_string: 'b' }, { signal })).toEqual({ behavior: 'deny', message: SELF_CONTROL_DENIAL_MESSAGE })
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(refusalRows(ctx)).toHaveLength(2)
  })

  it('an empty protected list denies shell commands unchecked under bypassPermissions, leaves file tools, logs once (review M2)', async () => {
    const { ctx, data, repo } = start('bypassPermissions', { controlProtectedPaths: () => [] })
    const q = await firstQuery()
    expect((await hook(q, 'Read', { file_path: join(data, 'run', 'daemon.json') }, repo)).hookSpecificOutput?.permissionDecisionReason).not.toBe(SELF_CONTROL_DENIAL_MESSAGE)
    await hook(q, 'Read', { file_path: join(data, 'run', 'x') }, repo)
    expect((await hook(q, 'Bash', { command: 'orgai status' }, repo)).hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    const shell = await hook(q, 'Bash', { command: `cat ${join(data, 'run', 'daemon.secret')}` }, repo)
    expect(shell.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(shell.hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect((await hook(q, 'Bash', { command: 'ls' }, repo)).hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
    expect(ctx.events.filter((e) => e.type === 'log' && (e as { message?: string }).message?.includes('control paths are unavailable'))).toHaveLength(1)
  })

  it('an unreadable protected list is caught: shell commands are denied unchecked, file tools are not (review M2)', async () => {
    const { data, repo } = start('bypassPermissions', {
      controlProtectedPaths: () => {
        throw new Error('boom')
      }
    })
    const q = await firstQuery()
    expect((await hook(q, 'Read', { file_path: join(data, 'run', 'daemon.json') }, repo)).hookSpecificOutput?.permissionDecisionReason).not.toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect((await hook(q, 'Bash', { command: `cat ${join(data, 'run', 'daemon.secret')}` }, repo)).hookSpecificOutput?.permissionDecisionReason).toBe(SELF_CONTROL_UNCHECKED_MESSAGE)
  })
})
