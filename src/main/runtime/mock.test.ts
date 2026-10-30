import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachment, McpServerSpec, RunEvent, TranscriptBlock } from '@shared/types'
import { MockAdapter, type MockSession } from './mock'
import { ROOT_AGENT_ID, type PeerMessage, type RunSkill } from './types'
import { parseSuggestions } from '../skills/suggest'
import { peerMessageText } from './prompts'
import { authFailureMessage } from './activity'
import { fakeCtx, project, runSummary } from './testHelpers'

describe('mock listModels', () => {
  it('lists the builtin aliases plus an unknown family', async () => {
    const list = await new MockAdapter().listModels()
    expect(list?.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'mock-lyric'])
    expect(list?.every((m) => m.label && m.description)).toBe(true)
  })
})

const png: ImageAttachment ={ mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }

function userBlocks(events: RunEvent[]): Extract<TranscriptBlock, { kind: 'user' }>[] {
  const out: Extract<TranscriptBlock, { kind: 'user' }>[] = []
  for (const e of events) if (e.type === 'transcript' && e.entry.block.kind === 'user' && e.entry.agentId === ROOT_AGENT_ID) out.push(e.entry.block)
  return out
}

describe('mock adapter image attachments', () => {
  it('records images on the first prompt and on send(), and omits the key when there are none', async () => {
    const ctx = fakeCtx({ prompt: 'Look at this', images: [png] })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.send('And this', [png, png])
    await session.send('No images')
    await session.stop()
    await session.finished

    const blocks = userBlocks(ctx.events)
    expect(blocks[0]).toEqual({ kind: 'user', text: 'Look at this', images: [png] })
    expect(blocks[1]).toEqual({ kind: 'user', text: 'And this', images: [png, png] })
    expect(blocks[2]).toEqual({ kind: 'user', text: 'No images' })
    expect('images' in blocks[2]).toBe(false)
  })

  it('treats an image-only send as a turn and replies', async () => {
    const ctx = fakeCtx({ prompt: 'Start' })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.send('', [png])
    await session.send('', [png, png])
    const texts: string[] = []
    const collect = (): void => {
      texts.length = 0
      for (const e of ctx.events) {
        if (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text') texts.push(e.entry.block.text)
      }
    }
    for (let i = 0; i < 200; i++) {
      collect()
      if (texts.includes('Mock reply to: [2 images]')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    await session.stop()
    await session.finished
    expect(texts).toContain('Mock reply to: [1 image]')
    expect(texts).toContain('Mock reply to: [2 images]')
  })
})

describe('mock adapter MCP and connection recording', () => {
  const spec = (id: string, name: string, over: Partial<McpServerSpec> = {}): McpServerSpec => ({
    id,
    name,
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    source: 'user',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over
  })

  it('records per-role MCP servers, enabled plugins and the connection without secrets', async () => {
    const p = project({ mcpServers: [spec('m1', 'fs', { roles: ['lead'] }), spec('m2', 'web')] })
    const ctx = fakeCtx({
      project: p,
      mcpServers: () => p.mcpServers ?? [],
      plugins: () => [
        { id: 'a', name: 'a', path: '/p/a', enabled: true },
        { id: 'b', name: 'b', path: '/p/b', enabled: false }
      ],
      connection: { connection: 'litellm', adapter: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'secret' } }
    })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await session.stop()
    await session.finished
    expect(session.mcpServersByRole).toEqual({ lead: ['fs', 'web'], engineer: ['web'], reviewer: ['web'] })
    expect(session.plugins.map((x) => x.id)).toEqual(['a'])
    expect(session.connection).toEqual({ adapter: 'claude', connection: 'litellm' })
    expect(JSON.stringify(session.connection)).not.toContain('secret')
  })

  it('records servers attached through the addMcpServer hook', async () => {
    const ctx = fakeCtx()
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    const added = spec('m9', 'late')
    await expect(session.addMcpServer(added)).resolves.toBe('mcp__late__')
    expect(session.addedMcpServers).toEqual([added])
    await session.stop()
    await session.finished
  })

  it('runs the mcp-assist script with the assistant tools and never nudges', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }), autoContinue: true, continuationDelayMs: 1 })
    const session = (await new MockAdapter({
      script: { delayMs: 0, mcpAssist: [{ type: 'harness', name: 'ask_user', args: { question: 'Which server?', options: [{ label: 'fs' }, { label: 'web' }] } }] }
    }).start(ctx)) as MockSession
    for (let i = 0; i < 100 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 30))
    await session.stop()
    await session.finished
    expect(ctx.requestQuestion).toHaveBeenCalled()
    expect(session.harnessMessages).toEqual([])
    expect(ctx.events.some((e) => e.type === 'log' && /unknown harness tool/.test(e.message))).toBe(false)
  })
})

describe('mock adapter harness transcript rows', () => {
  const systemEntries = (events: RunEvent[]) =>
    events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'system' ? [e.entry] : []))
  const waitFor = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  it('records a nudge as a harness row with the summary as text and the full instruction as detail', async () => {
    const ctx = fakeCtx({ autoContinue: true, continuationDelayMs: 1 })
    const session = (await new MockAdapter({ script: { delayMs: 0, work: [{ type: 'text', text: 'First part done.' }] } }).start(ctx)) as MockSession
    await waitFor(() => session.harnessMessages.length > 0)
    await session.stop()
    await session.finished
    const full = session.harnessMessages[0]
    expect(full).toBeTruthy()
    const row = systemEntries(ctx.events).find((e) => e.block.kind === 'system' && e.block.detail === full)
    expect(row?.source).toBe('harness')
    const text = (row?.block as { text: string }).text
    expect(text).not.toBe(full)
    expect(text.length).toBeLessThan(full.length)
  })

  it('marks tellUser lines as harness rows', async () => {
    const ctx = fakeCtx({ autoContinue: true, maxAutoContinues: 0, continuationDelayMs: 1 })
    const session = await new MockAdapter({
      script: { delayMs: 0, work: [{ type: 'plan', goal: 'G', steps: ['A', 'B'] }, { type: 'text', text: 'Step one.' }] }
    }).start(ctx)
    await waitFor(() => systemEntries(ctx.events).length > 0)
    await session.stop()
    await session.finished
    const rows = systemEntries(ctx.events)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((e) => e.source === 'harness')).toBe(true)
    expect(rows.some((e) => !('detail' in e.block))).toBe(true)
  })
})

describe('mock adapter default MCP-assist script', () => {
  it('produces an mcpServers proposal that passes validation', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }) })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.requestProposal).mock.calls[0][0].kind).toBe('mcpServers')
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_result' && /not acceptable/.test(String(e.entry.block.content)))).toBe(false)
  })
})

describe('mock adapter receive()', () => {
  const msg: PeerMessage = { fromRunId: 'run-x', fromProjectName: 'Other', fromPrompt: 'Do other things', text: 'Please sync the API' }

  it('wakes an idle root, records framed and raw text, and writes no transcript block itself', async () => {
    const ctx = fakeCtx({ prompt: 'Start' })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    for (let i = 0; i < 200 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    const before = ctx.events.length
    await session.receive(msg)
    const framed = peerMessageText(msg)
    expect(session.harnessMessages).toEqual([framed])
    expect(session.peerMessages).toEqual([msg])
    const after = ctx.events.slice(before)
    expect(after.some((e) => e.type === 'run.status' && e.status === 'running')).toBe(true)
    expect(after.some((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text === framed)).toBe(false)
    await session.stop()
    await session.finished
  })

  it('is a no-op after stop', async () => {
    const ctx = fakeCtx({ prompt: 'Start' })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await session.stop()
    await session.finished
    const before = ctx.events.length
    await session.receive(msg)
    expect(session.harnessMessages).toEqual([])
    expect(session.peerMessages).toEqual([])
    expect(ctx.events.length).toBe(before)
  })
})

describe('mock adapter MCP library steps', () => {
  const entry = { id: 'lib-1', name: 'libfs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'libfs-server@1.0.0'], source: 'registry' as const, addedAt: '' }
  async function run(ctx: ReturnType<typeof fakeCtx>): Promise<void> {
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
  }
  const proposals = (ctx: ReturnType<typeof fakeCtx>) => (ctx.requestProposal as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { kind: string; payload: any })
  const mcpProposals = (ctx: ReturnType<typeof fakeCtx>) => proposals(ctx).filter((p) => p.kind === 'mcpServers')

  it('setup skips the MCP step when the library is empty', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'setup' }), mcpLibrary: () => [] })
    await run(ctx)
    expect(mcpProposals(ctx)).toHaveLength(0)
    expect(ctx.completeSetup).toHaveBeenCalled()
  })

  it('setup proposes linking the first library entry before completing', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'setup' }), mcpLibrary: () => [entry] })
    await run(ctx)
    const [p] = mcpProposals(ctx)
    expect(p.payload.upsert[0]).toMatchObject({ libraryId: 'lib-1' })
    expect(ctx.completeSetup).toHaveBeenCalled()
  })

  it('setup still completes when the MCP proposal is revised', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'setup' }), mcpLibrary: () => [entry] })
    ;(ctx.requestProposal as ReturnType<typeof vi.fn>).mockImplementation(async (p: { kind: string }) =>
      p.kind === 'mcpServers' ? { behavior: 'revise', feedback: 'no' } : { behavior: 'approve' }
    )
    await run(ctx)
    expect(mcpProposals(ctx)).toHaveLength(1)
    expect(ctx.completeSetup).toHaveBeenCalled()
  })

  it('mcp-assist on a project proposes a non-project-only server plus a library link', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }), mcpLibrary: () => [entry] })
    await run(ctx)
    const [p] = mcpProposals(ctx)
    expect(p.payload.upsert[0]).toMatchObject({ name: 'mock-fs' })
    expect(p.payload.upsert.some((u: any) => u.libraryId === 'lib-1')).toBe(true)
  })

  it('mcp-assist on a project with an empty library proposes only the new server', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist' }), mcpLibrary: () => [] })
    await run(ctx)
    const [p] = mcpProposals(ctx)
    expect(p.payload.upsert).toHaveLength(1)
  })

  it('mcp-assist on the harness project proposes a library entry', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'mcp-assist', projectId: 'harness' }), project: project({ id: 'harness' }), mcpLibrary: () => [entry] })
    await run(ctx)
    const [p] = mcpProposals(ctx)
    expect(p.payload.scope).toBe('library')
    expect(p.payload.upsert).toHaveLength(1)
    expect(p.payload.upsert[0]).toMatchObject({ name: 'mock-fs' })
  })
})

describe('mock adapter auth failure', () => {
  const message = authFailureMessage('litellm')
  const connection = { connection: 'litellm' as const, adapter: 'claude' as const, env: {} }
  function check(ctx: ReturnType<typeof fakeCtx>): void {
    const status = ctx.events.filter((e) => e.type === 'run.status').map((e) => (e as { status: string }).status)
    expect(status).toContain('error')
    expect(status).not.toContain('finished')
    const err = ctx.events.find((e) => e.type === 'run.status' && e.status === 'error')
    expect(err).toMatchObject({ error: message })
    const row = ctx.events.find((e) => e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' && e.entry.block.text === message)
    expect(row).toBeTruthy()
    const root = [...ctx.events].reverse().find((e) => e.type === 'agent.upsert' && e.agent.id === ROOT_AGENT_ID)
    expect(root).toMatchObject({ agent: { state: 'error' } })
  }
  it('fails the run from the first prompt', async () => {
    const ctx = fakeCtx({ prompt: 'hello [mock:auth-fail]', connection })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.finished
    check(ctx)
  })
  it('fails the run from a later user message', async () => {
    const ctx = fakeCtx({ prompt: 'hello', connection })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await session.send('now [mock:auth-fail]')
    await session.finished
    check(ctx)
  })
  it('makes complete() throw the readable message', async () => {
    await expect(new MockAdapter().complete({ system: 's', prompt: '[mock:auth-fail]', kind: 'title', connection })).rejects.toThrow(message)
  })
})

describe('mock adapter usage reporting', () => {
  type Agent = Extract<RunEvent, { type: 'agent.upsert' }>['agent']
  async function agentsOf(prompt: string): Promise<{ ctx: ReturnType<typeof fakeCtx>; last: Map<string, Agent> }> {
    const ctx = fakeCtx({ prompt })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.cost')).toBe(true), { timeout: 5000 })
    const last = new Map<string, Agent>()
    for (const e of ctx.events) if (e.type === 'agent.upsert') last.set(e.agent.id, e.agent)
    await session.stop()
    await session.finished
    return { ctx, last }
  }
  const lastCost = (ctx: ReturnType<typeof fakeCtx>): number => ([...ctx.events].reverse().find((e) => e.type === 'run.cost') as { totalCostUsd: number }).totalCostUsd

  it('reports per-model tokens with cache, turns, tool calls and a retry; provider cost by default', async () => {
    const { ctx, last } = await agentsOf('do it')
    const root = last.get(ROOT_AGENT_ID)!
    expect(root.usage?.models[0]).toMatchObject({ model: 'claude-opus-4-5' })
    expect(root.usage?.models[0]?.providerCostUsd).toBeGreaterThan(0)
    expect(root.usage?.tokens.cacheRead).toBeGreaterThan(0)
    expect(root.usage?.tokens.cacheWrite).toBeGreaterThan(0)
    expect(root.usage?.turns).toBeGreaterThan(0)
    expect(root.usage?.toolCalls).toBeGreaterThan(0)
    expect(root.usage?.retries).toBe(1)
    expect(last.get('mock-report-1')?.usage?.models[0]).toMatchObject({ model: 'claude-sonnet-4-5' })
    const providerTotal = [...last.values()].reduce((s, a) => s + (a.usage?.models.reduce((x, m) => x + (m.providerCostUsd ?? 0), 0) ?? 0), 0)
    expect(lastCost(ctx)).toBeCloseTo(providerTotal, 10)
  })

  it('has a report that spent tokens and produced nothing, on an unpriced model', async () => {
    const { last } = await agentsOf('do it')
    const silent = last.get('mock-report-2')!
    expect(silent.state).toBe('done')
    expect(silent.result).toBeFalsy()
    expect(silent.usage?.tokens.output).toBeGreaterThan(0)
    expect(silent.usage?.models[0]).toMatchObject({ model: 'mock-unpriced' })
    expect(silent.usage?.models[0]?.providerCostUsd).toBeUndefined()
  })

  it('[mock:no-price] leaves every agent unpriced with no provider cost', async () => {
    const { last, ctx } = await agentsOf('do it [mock:no-price]')
    for (const a of last.values()) expect(a.usage?.models.every((m) => m.model === 'mock-unpriced' && m.providerCostUsd === undefined)).toBe(true)
    expect(lastCost(ctx)).toBe(0)
  })

  it('[mock:computed-cost] reports a priced model without provider cost', async () => {
    const { last } = await agentsOf('do it [mock:computed-cost]')
    for (const a of last.values()) expect(a.usage?.models.every((m) => m.model === 'claude-sonnet-4-5' && m.providerCostUsd === undefined)).toBe(true)
  })
})

describe('mock adapter complete', () => {
  const adapter = new MockAdapter({ script: { delayMs: 0 } })
  const sys = 's'
  it('derives a title from the first four words inside <message>', async () => {
    const prompt = 'Instructions\n<message>\nfix the "login" bug, now please\n</message>'
    expect(await adapter.complete({ system: sys, prompt, kind: 'title' })).toBe('Fix the login bug')
  })
  it('uses the whole prompt without markers and returns empty for nothing', async () => {
    expect(await adapter.complete({ system: sys, prompt: "don't panic", kind: 'title' })).toBe("Don't panic")
    expect(await adapter.complete({ system: sys, prompt: '!!! ???', kind: 'title' })).toBe('')
  })
  it('fails on the failure marker', async () => {
    await expect(adapter.complete({ system: sys, prompt: '<message>[mock:title-fail]</message>', kind: 'title' })).rejects.toThrow('Mock title failure')
  })
  it('rejects when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(adapter.complete({ system: sys, prompt: 'x', kind: 'title', signal: ac.signal })).rejects.toThrow('cancelled')
  })
  it('rejects when the signal aborts during the slow wait', async () => {
    const ac = new AbortController()
    const p = adapter.complete({ system: sys, prompt: '<message>[mock:title-slow]</message>', kind: 'title', signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow('Completion cancelled')
  })
  it('completes the slow title when never aborted', async () => {
    const ac = new AbortController()
    expect(await adapter.complete({ system: sys, prompt: '<message>[mock:title-slow] hi</message>', kind: 'title', signal: ac.signal })).toMatch(/hi/)
  })
  it('still answers drafts with parseable JSON roles', async () => {
    for (const kind of [undefined, 'draft' as const]) {
      const out = JSON.parse(await adapter.complete({ system: sys, prompt: 'x', kind }))
      expect(Array.isArray(out.roles)).toBe(true)
    }
  })
})

describe('mock adapter skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-skill-'))
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: pdf-fill\ndescription: Fill forms\n---\nDo the steps.')
  const skill = (roleIds: string[]): RunSkill => ({ id: 'sk1', name: 'pdf-fill', description: 'Fill forms', dir, files: [{ path: 'SKILL.md' }] as RunSkill['files'], roleIds })
  const play = async (ctx: ReturnType<typeof fakeCtx>, script: object = {}) => {
    const session = await new MockAdapter({ script: { delayMs: 0, ...script } }).start(ctx)
    for (let i = 0; i < 200 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
  }
  const rootOnly = { work: [{ type: 'text', text: 'Working.' }] }
  const toolUses = (ctx: ReturnType<typeof fakeCtx>, agentId: string): string[] =>
    ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === agentId && e.entry.block.kind === 'tool_use' ? [e.entry.block.name] : []))

  it('loads the first granted skill for the root and emits skill.used with transcript blocks', async () => {
    const ctx = fakeCtx({ skills: () => [skill(['r-lead'])] })
    await play(ctx)
    const used = ctx.events.filter((e) => e.type === 'skill.used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ agentId: ROOT_AGENT_ID, skillId: 'sk1', name: 'pdf-fill' })
    expect(toolUses(ctx, ROOT_AGENT_ID)).toContain('load_skill')
    const result = ctx.events.find((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_result' && /Do the steps/.test(e.entry.block.content))
    expect(result).toBeTruthy()
  })

  it('does not load for a role without a grant, and a spawned granted agent loads for itself', async () => {
    const none = fakeCtx({ skills: () => [skill(['r-eng'])] })
    await play(none, rootOnly)
    expect(none.events.some((e) => e.type === 'skill.used')).toBe(false)
    expect(toolUses(none, ROOT_AGENT_ID)).not.toContain('load_skill')
    expect(toolUses(none, ROOT_AGENT_ID)).not.toContain('list_skills')

    const spawned = fakeCtx({ skills: () => [skill(['r-eng'])] })
    await play(spawned, { work: [{ type: 'spawn', id: 'a1', role: 'engineer', description: 'Do it' }] })
    expect(spawned.events.filter((e) => e.type === 'skill.used')).toMatchObject([{ agentId: 'a1' }])
    expect(toolUses(spawned, 'a1')).toEqual(['load_skill'])
  })

  it('[mock:skill] without a grant calls list_skills', async () => {
    const ctx = fakeCtx({ prompt: 'go [mock:skill]', skills: () => [skill(['r-eng'])] })
    await play(ctx, rootOnly)
    expect(toolUses(ctx, ROOT_AGENT_ID)).toContain('list_skills')
    expect(ctx.events.some((e) => e.type === 'skill.used')).toBe(false)
  })

  it("complete kind 'skills' returns suggestions parseSuggestions accepts and reports usage", async () => {
    const onUsage = vi.fn()
    const text = await new MockAdapter().complete({ system: 's', prompt: 'p', kind: 'skills', onUsage } as never)
    const list = parseSuggestions(text, [])
    expect(list).toHaveLength(1)
    expect(list[0]!.draft.name).toBe('mock-suggested-skill')
    expect(onUsage).toHaveBeenCalledWith({ tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, model: 'mock' })
    rmSync(dir, { recursive: true, force: true })
  })
})
