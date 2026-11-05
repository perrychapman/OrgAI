import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EngagementNote, ImageAttachment, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeSource, McpServerSpec, RunEvent, TranscriptBlock } from '@shared/types'
import { ENGAGEMENT_CONTEXT_TOOL, KNOWLEDGE_RECALL_TOOL, KNOWLEDGE_TOOL } from '@shared/types'
import { RESUME_TEXT } from './runManager'
import { DEEP_TREE_TOKEN, FATIGUE_TOKEN, FOLDER_CONFIG_TOKEN, KNOWLEDGE_RECALL_TOKEN, KNOWLEDGE_TOKEN, MCP_MIDRUN_TOKEN, MOCK_KNOWLEDGE, MOCK_KNOWLEDGE_DONE, MOCK_KNOWLEDGE_NONE, MOCK_KNOWLEDGE_RECALLED, MOCK_KNOWLEDGE_RECALL_BRIEF, MOCK_KNOWLEDGE_RECALL_QUERY, UNPRICED_REPORT_ID, MOCK_REFERENCE_COPY_HINT, MOCK_REFERENCE_REPORT, REFERENCE_EDIT_TOKEN, REFERENCE_SHELL_TOKEN,MOCK_MIDRUN_REPORT, MOCK_MIDRUN_SERVER, MOCK_MIDRUN_TOOL, MockAdapter, fatigueSteps, knowledgeFactId, type MockSession } from './mock'
import { ROOT_AGENT_ID, type KnowledgeCaller, type PeerMessage, type RunSkill, type RuntimeContext } from './types'
import { parseSuggestions } from '../skills/suggest'
import { peerMessageText } from './prompts'
import { authFailureMessage } from './activity'
import { fakeCtx, project, runSummary } from './testHelpers'
import { addRules } from './permissionRules'
import { defaultRoles } from '@shared/defaults'
import type { AgentInstance } from '@shared/types'
import type { MockStep } from './mock'
import { harnessToolsFor } from './harnessTools'
import { z } from 'zod'

// harnessToolsFor is the real one, wrapped so a test can add a fake tool.
const harnessToolsActual = vi.hoisted(() => ({ harnessToolsFor: undefined as unknown as typeof import('./harnessTools').harnessToolsFor }))
vi.mock('./harnessTools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./harnessTools')>()
  harnessToolsActual.harnessToolsFor = orig.harnessToolsFor
  return { ...orig, harnessToolsFor: vi.fn(orig.harnessToolsFor) }
})

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
    await expect(session.addMcpServer(added)).resolves.toEqual({ prefix: 'mcp__late__', availability: 'now' })
    expect(session.addedMcpServers).toEqual([added])
    await session.stop()
    await session.finished
  })

  it('[mock:mcp-midrun]: the approved server is usable at once by granted roles; a role the card left out is denied', async () => {
    const servers: McpServerSpec[] = []
    const ctx = fakeCtx({
      prompt: `Use a new server ${MCP_MIDRUN_TOKEN}`,
      autoContinue: false,
      mcpServers: () => servers,
      // Like RunManager: the approved spec (roles restricted on the card to the root) joins the run's servers.
      requestMcpInstall: vi.fn(async (req: { spec: McpServerSpec }) => {
        const spec = { ...req.spec, roles: ['lead'] }
        servers.push(spec)
        return { approved: true, scope: 'run' as const, spec }
      })
    })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text.includes('was used'))).toBe(true))
    expect(session.addedMcpServers.map((s) => s.name)).toEqual([MOCK_MIDRUN_SERVER])
    expect(session.mcpServersByRole).toEqual({ lead: [MOCK_MIDRUN_SERVER], engineer: [], reviewer: [] })
    const results = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [{ agent: e.entry.agentId, ...e.entry.block }] : []))
    expect(results.find((r) => r.agent === ROOT_AGENT_ID && r.content === 'PONG')).toBeDefined()
    const denied = results.find((r) => r.agent === MOCK_MIDRUN_REPORT)
    expect(denied).toMatchObject({ isError: true })
    expect(denied?.content).toContain(`does not grant the MCP server "${MOCK_MIDRUN_SERVER}" to the Engineer role (engineer)`)
    // The root's call still went through the permission card; the denied one never reached it.
    expect(vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0].toolName)).toEqual([MOCK_MIDRUN_TOOL])
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

  it('nudges an engagement with the engagement wording (review the deliverables), a code project with verification', async () => {
    const nudgeFor = async (kind: 'engagement' | 'code'): Promise<string> => {
      const ctx = fakeCtx({ autoContinue: true, continuationDelayMs: 1, project: project({ kind }) })
      const session = (await new MockAdapter({
        script: { delayMs: 0, work: [{ type: 'plan', goal: 'G', steps: ['A', 'B'] }, { type: 'text', text: 'Step one.' }] }
      }).start(ctx)) as MockSession
      await waitFor(() => session.harnessMessages.length > 0)
      await session.stop()
      await session.finished
      return session.harnessMessages[0] ?? ''
    }
    const engagement = await nudgeFor('engagement')
    expect(engagement).toContain('review the deliverables against the brief')
    expect(engagement).not.toContain('verification')
    expect(await nudgeFor('code')).toContain("run the project's verification")
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

describe('mock adapter assistants scripts', () => {
  const quick = { folder: '/some/folder', team: 'single' as const, allowEdits: false, gitRepo: false }
  async function runToIdle(ctx: ReturnType<typeof fakeCtx>, follow?: string): Promise<MockSession> {
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    const idle = () => ctx.events.filter((e) => e.type === 'run.status' && e.status === 'idle').length
    for (let i = 0; i < 300 && idle() < 1; i++) await new Promise((r) => setTimeout(r, 10))
    if (follow) {
      await session.send(follow)
      for (let i = 0; i < 300 && idle() < 2; i++) await new Promise((r) => setTimeout(r, 10))
    }
    return session
  }
  const toolNames = (ctx: ReturnType<typeof fakeCtx>) =>
    ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_use' ? [e.entry.block.name] : []))
  const texts = (ctx: ReturnType<typeof fakeCtx>) =>
    ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
  const peek = (id: string) => ({ id, name: id, path: `/${id}`, brief: '', roles: [], connection: 'anthropic' as const })
  const stopAll = async (s: MockSession): Promise<void> => {
    await s.stop()
    await s.finished
  }

  it('quick run: list_projects once, one answer naming the count, then idle; a follow-up gets a short reply', async () => {
    const ctx = fakeCtx({ run: runSummary({ projectId: 'quick', quick }), listProjects: () => [peek('a'), peek('b')] })
    const session = await runToIdle(ctx, 'thanks')
    expect(toolNames(ctx)).toEqual(['list_projects'])
    expect(texts(ctx)).toEqual(['I can see 2 OrgAI projects. Tell me what you would like to do.', 'Mock reply to: thanks'])
    await stopAll(session)
  })

  it('single-agent work run (team single): replies to the prompt and to follow-ups, no spawn, no plan, then idle', async () => {
    const roles = [defaultRoles()[0]!].map((r) => ({ ...r, reportsTo: null, canSpawn: false, spawnable: [] }))
    const ctx = fakeCtx({ run: runSummary({ team: 'single' }), prompt: 'Summarise the brief', project: project({ roles }), roles, autoContinue: false })
    const session = await runToIdle(ctx, 'and the risks?')
    expect(texts(ctx)).toEqual(['Mock reply to: Summarise the brief', 'Mock reply to: and the risks?'])
    expect(toolNames(ctx)).toEqual([])
    expect(ctx.events.filter((e) => e.type === 'agent.upsert' && e.agent.id !== ROOT_AGENT_ID)).toEqual([])
    expect(ctx.updatePlan).not.toHaveBeenCalled()
    await stopAll(session)
  })

  it("lets a report call an 'all'-audience harness tool (engagement_context) through the grant gate", async () => {
    vi.mocked(harnessToolsFor).mockImplementation((c, h) => [
      ...harnessToolsActual.harnessToolsFor(c, h),
      { name: 'engagement_context', description: 'Engagement context', audience: 'all', inputSchema: z.object({}), call: async () => 'notes' }
    ])
    try {
      const ctx = fakeCtx({ autoContinue: false })
      const work: MockStep[] = [
        { type: 'spawn', id: 'rev', role: 'reviewer', description: 'Look' },
        { type: 'tool', agent: 'rev', name: 'mcp__orgai__engagement_context', input: {}, result: 'notes' },
        { type: 'tool', agent: 'rev', name: 'mcp__orgai__set_plan', input: {} },
        { type: 'finish', id: 'rev', result: 'done' },
        { type: 'text', text: 'All done.' }
      ]
      const session = (await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)) as MockSession
      await vi.waitFor(() => expect(texts(ctx)).toContain('All done.'))
      const results = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' && e.entry.agentId === 'rev' ? [e.entry.block] : []))
      expect(results[0]).toMatchObject({ content: 'notes' })
      expect(results[0]!.isError).toBeFalsy()
      expect(results[1]).toMatchObject({ isError: true })
      expect(results[1]!.content).toContain('not available')
      await stopAll(session)
    } finally {
      vi.mocked(harnessToolsFor).mockImplementation(harnessToolsActual.harnessToolsFor)
    }
  })

  it('quick run: singular wording for one project', async () => {
    const ctx = fakeCtx({ run: runSummary({ projectId: 'quick', quick }), listProjects: () => [peek('a')] })
    const session = await runToIdle(ctx)
    expect(texts(ctx)[0]).toBe('I can see 1 OrgAI project. Tell me what you would like to do.')
    await stopAll(session)
  })

  it('skill-assist on a project: list, propose mock-skill for the first role, final text', async () => {
    const ctx = fakeCtx({ run: runSummary({ kind: 'skill-assist' }), skillCatalog: () => ({ library: [], project: [] }) })
    const session = await runToIdle(ctx)
    expect(toolNames(ctx)).toEqual(['list_skill_library', 'propose_skills'])
    const [p] = (ctx.requestProposal as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { kind: string; payload: any })
    expect(p.kind).toBe('skills')
    expect(p.payload.items).toHaveLength(1)
    expect(p.payload.items[0]).toMatchObject({ action: 'create', scope: 'project', roles: ['lead'], draft: { name: 'mock-skill' } })
    expect(p.payload.items[0].draft.description.length).toBeGreaterThan(10)
    expect(texts(ctx).at(-1)).toBe('The skill is set up.')
    await stopAll(session)
  })

  it('skill-assist on the skills project proposes a library skill and retries on REVISE', async () => {
    const decide = vi.fn().mockResolvedValueOnce({ behavior: 'revise', feedback: 'shorter' }).mockResolvedValue({ behavior: 'approve' })
    const ctx = fakeCtx({
      run: runSummary({ kind: 'skill-assist', projectId: 'skills' }),
      project: project({ id: 'skills' }),
      skillCatalog: () => ({ library: [], project: [] }),
      requestProposal: decide
    })
    const session = await runToIdle(ctx)
    const calls = decide.mock.calls.map((c) => c[0] as { payload: any })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.payload.items[0]).toMatchObject({ scope: 'library', draft: { name: 'mock-skill' } })
    expect(calls[0]!.payload.items[0].roles).toBeUndefined()
    expect(toolNames(ctx)).toEqual(['list_skill_library', 'propose_skills', 'propose_skills'])
    await stopAll(session)
  })

  it('mcp-assist with allowBuild tools on the harness project still finishes its script', async () => {
    const roles = [{ ...project().roles[0]!, tools: ['Read', 'Edit', 'Write', 'Bash'] as ('Read' | 'Edit' | 'Write' | 'Bash')[] }]
    const ctx = fakeCtx({
      run: runSummary({ kind: 'mcp-assist', projectId: 'harness' }),
      project: project({ id: 'harness', path: join(tmpdir(), 'quick', 'build'), roles }),
      roles,
      mcpLibrary: () => []
    })
    const session = await runToIdle(ctx)
    expect(texts(ctx).at(-1)).toBe('The MCP servers are set up.')
    await stopAll(session)
  })
})

describe('mock adapter build sessions', () => {
  it('refuses writes under <workspace>/.claude without a card and asks for other files', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orgai-mock-build-'))
    const ctx = fakeCtx({
      run: runSummary({ kind: 'mcp-assist', buildWorkspace: ws }),
      project: project({ path: ws }),
      autoContinue: false
    })
    const script = {
      delayMs: 0,
      mcpAssist: [
        { type: 'tool' as const, name: 'Write', input: { file_path: join(ws, '.claude', 'settings.local.json') }, ask: true },
        { type: 'tool' as const, name: 'Write', input: { file_path: join(ws, 'server.mjs') }, ask: true }
      ]
    }
    const session = await new MockAdapter({ script }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.requestPermission).mock.calls[0][0].input).toEqual({ file_path: join(ws, 'server.mjs') })
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_result' && e.entry.block.isError && /cannot write/.test(String(e.entry.block.content)))).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })
})

describe('mock adapter MCP gate parity (review L3, M3)', () => {
  const toolResults = (events: RunEvent[]) => events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))
  async function runTools(ctx: ReturnType<typeof fakeCtx>, work: { name: string; input?: Record<string, unknown>; ask?: boolean }[]) {
    const session = await new MockAdapter({ script: { delayMs: 0, work: work.map((w) => ({ type: 'tool' as const, result: 'ok', ...w })) } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
    return toolResults(ctx.events)
  }

  it('gates the MCP resource tools on input.server like the Claude hook', async () => {
    const servers = [
      { id: 'm1', name: 'github', transport: 'stdio' as const, command: 'npx', enabled: true, source: 'user' as const, roles: ['engineer'], addedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', name: 'docs', transport: 'stdio' as const, command: 'npx', enabled: true, source: 'user' as const, addedAt: '2026-01-01T00:00:00.000Z' }
    ]
    const ctx = fakeCtx({ autoContinue: false, mcpServers: () => servers })
    const results = await runTools(ctx, [
      { name: 'ReadMcpResourceTool', input: { server: 'github', uri: 'x://1' } },
      { name: 'ListMcpResourcesTool', input: {} },
      { name: 'ReadMcpResourceTool', input: { server: 'docs', uri: 'x://2' } }
    ])
    expect(results.map((r) => r.isError)).toEqual([true, true, false])
    expect(String(results[0]!.content)).toContain('does not grant the MCP server "github" to the Lead role (lead)')
    expect(String(results[1]!.content)).toContain('Listing the resources of every MCP server is not available')
  })

  it('never pre-approves an agent-installed server through a server-level rule; other servers keep theirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-rules-'))
    addRules(dir, ['mcp__late', 'mcp__keep'])
    const keep: McpServerSpec = { id: 'k1', name: 'keep', transport: 'stdio', command: 'npx', enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }
    const late: McpServerSpec = { id: 'l1', name: 'late', transport: 'stdio', command: 'npx', enabled: true, source: 'agent', addedAt: '2026-01-01T00:00:00.000Z' }
    let granted: string[] = []
    const ctx = fakeCtx({ autoContinue: false, project: project({ path: dir, mcpServers: [keep] }), mcpServers: () => [keep, late], allowedRules: () => granted })
    await runTools(ctx, [
      { name: 'mcp__keep__list', ask: true },
      { name: 'mcp__late__list', ask: true }
    ])
    expect(vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0].toolName)).toEqual(['mcp__late__list'])
    // An exact tool grant for this run still applies.
    granted = ['mcp__late__list']
    const again = fakeCtx({ autoContinue: false, project: project({ path: dir, mcpServers: [keep] }), mcpServers: () => [keep, late], allowedRules: () => granted })
    await runTools(again, [{ name: 'mcp__late__list', ask: true }])
    expect(again.requestPermission).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('mock adapter MCP server-level suggestions (issue #14 C)', () => {
  const spec = (name: string, source: 'user' | 'agent', id = `id-${name}`): McpServerSpec => ({ id, name, transport: 'stdio', command: 'npx', enabled: true, source, addedAt: '2026-01-01T00:00:00.000Z' })
  async function runTools(ctx: ReturnType<typeof fakeCtx>, work: { name: string; ask?: boolean }[]) {
    const session = await new MockAdapter({ script: { delayMs: 0, work: work.map((w) => ({ type: 'tool' as const, result: 'ok', ...w })) } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
  }

  it('offers mcp__<server> for a configured server, exact rules for an agent-installed one; a session grant covers the next tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-mcpsrv-'))
    const keep = spec('keep', 'user')
    const late = spec('late', 'agent')
    const ctx = fakeCtx({ autoContinue: false, project: project({ path: dir, mcpServers: [keep] }), mcpServers: () => [keep, late] })
    vi.mocked(ctx.requestPermission).mockImplementation(async () => ({ behavior: 'allow', scope: 'session' }))
    await runTools(ctx, [
      { name: 'mcp__keep__list', ask: true },
      { name: 'mcp__keep__read', ask: true },
      { name: 'mcp__late__list', ask: true },
      { name: 'mcp__late__read', ask: true }
    ])
    const cards = vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0])
    expect(cards.map((c) => c.toolName)).toEqual(['mcp__keep__list', 'mcp__late__list', 'mcp__late__read'])
    expect(cards[0]!.ruleLabels).toEqual(['All tools of keep'])
    expect(cards[0]!.suggestions).toEqual([{ type: 'addRules', rules: [{ toolName: 'mcp__keep' }], behavior: 'allow', destination: 'session' }])
    expect(cards[1]!.ruleLabels).toEqual(['mcp__late__list'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('mock adapter [mock:fatigue] (permission fatigue parity)', () => {
  // Never created on disk: the script only names these folders. tmpdir() is resolved to its real path because the
  // runners' tmpdir is an 8.3 name (Windows) or under /var -> /private/var (macOS).
  const base = join(realpathSync.native(tmpdir()), `orgai-fatigue-${process.pid}`)
  const projPath = join(base, 'proj')
  const sibling = join(base, 'sibling-notes')
  type Decide = (req: { toolName: string }) => { behavior: 'allow'; scope?: 'once' | 'session' | 'project' }
  async function play(over: Parameters<typeof fakeCtx>[0], decide: Decide, script?: { work: ReturnType<typeof fatigueSteps> }) {
    const ctx = fakeCtx({ autoContinue: false, prompt: `Run the tests ${FATIGUE_TOKEN}`, project: project({ path: projPath }), ...over })
    vi.mocked(ctx.requestPermission).mockImplementation(async (req) => decide(req))
    const session = await new MockAdapter({ script: { delayMs: 0, ...script } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
    const cards = vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0])
    return { ctx, cards }
  }
  const lastText = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : [])).at(-1)

  it('offers Bash(npm test:*) for the compound cd; a session grant makes the later cd + npm test card-free', async () => {
    const { ctx, cards } = await play({}, () => ({ behavior: 'allow', scope: 'session' }))
    expect(cards.map((c) => c.toolName)).toEqual(['Bash', 'Edit'])
    expect(cards[0]!.ruleLabels).toEqual(['Bash(npm test:*)'])
    expect(cards[1]!.ruleLabels).toEqual(['Auto-accept file edits in this project', `Edits and reads in ${sibling}`])
    expect(lastText(ctx)).toBe('Mock: the fatigue script is done.')
  })

  it('pre-approves the outside edit when its folder is allowed and the project accepts edits; auto mode does not', async () => {
    const { cards } = await play({ project: project({ path: projPath, permissionMode: 'acceptEdits' }), allowedDirectories: () => [sibling] }, () => ({ behavior: 'allow', scope: 'session' }))
    expect(cards.map((c) => c.toolName)).toEqual(['Bash'])
    const auto = await play({ project: project({ path: projPath, permissionMode: 'auto' }), allowedDirectories: () => [sibling] }, () => ({ behavior: 'allow', scope: 'session' }))
    expect(auto.cards.map((c) => c.toolName)).toEqual(['Bash', 'Edit'])
  })

  it('a session acceptEdits + folder grant pre-approves later edits there, never edits elsewhere', async () => {
    const edit = (file: string) => ({ type: 'tool' as const, name: 'Edit', input: { file_path: file }, ask: true })
    const work = [edit(join(sibling, 'a.md')), edit(join(sibling, 'b.md')), edit(join(projPath, 'src', 'x.ts')), edit(join(base, 'other', 'c.md'))]
    const { cards } = await play({}, () => ({ behavior: 'allow', scope: 'session' }), { work })
    expect(cards.map((c) => (c as { input: { file_path: string } }).input.file_path)).toEqual([join(sibling, 'a.md'), join(base, 'other', 'c.md')])
  })

  it('a project scope on the edit card persists the folder and acceptEdits through the ctx hooks', async () => {
    const allowDirectories = vi.fn((d: string[]) => d)
    const acceptEditsForProject = vi.fn(() => true)
    const { cards } = await play({ allowDirectories, acceptEditsForProject }, (req) => ({ behavior: 'allow', scope: req.toolName === 'Edit' ? 'project' : 'once' }))
    expect(allowDirectories).toHaveBeenCalledTimes(1)
    expect(allowDirectories).toHaveBeenCalledWith([sibling])
    expect(acceptEditsForProject).toHaveBeenCalledTimes(1)
    // A one-time Bash allow grants nothing: the last cd + npm test asks again.
    expect(cards.map((c) => c.toolName)).toEqual(['Bash', 'Edit', 'Bash'])
  })

  it('issue #14: the same compound command twice shows one card, then none after a session grant', async () => {
    const command = `cd ${join(projPath, 'sub')} && npm test && npm run lint`
    const step = { type: 'tool' as const, name: 'Bash', input: { command }, ask: true, suggestions: [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: `${command} *` }], behavior: 'allow' as const, destination: 'localSettings' as const }], result: 'ok' }
    const { cards } = await play({}, () => ({ behavior: 'allow', scope: 'session' }), { work: [step, step] })
    expect(cards).toHaveLength(1)
    expect(cards[0]!.ruleLabels).toEqual(['Bash(npm test:*)', 'Bash(npm run lint:*)'])
  })

  it('a project-scope grant logs Saved only for new rules and the second identical command needs no card', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-saved-')))
    const command = `cd ${join(dir, 'sub')} && npm test`
    const step = { type: 'tool' as const, name: 'Bash', input: { command }, ask: true, result: 'ok' }
    const { ctx, cards } = await play({ project: project({ path: dir }) }, () => ({ behavior: 'allow', scope: 'project' }), { work: [step, step] })
    expect(cards).toHaveLength(1)
    const logs = ctx.events.flatMap((e) => (e.type === 'log' ? [e.message] : []))
    expect(logs.filter((m) => m.startsWith('Saved permission rule'))).toEqual(['Saved permission rule for this project: Bash(npm test:*)'])
    expect(logs.some((m) => m.includes('do not cover this command'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('engagement rules: a project-scope grant goes through ctx.saveProjectRules, is read back through ctx.savedRules, and the folder stays untouched', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-engagement-')))
    addRules(dir, ['Bash(git status)'])
    let store: string[] = []
    const saveProjectRules = vi.fn((rules: string[]) => {
      const added = rules.filter((r) => !store.includes(r))
      store = [...store, ...added]
      return { rules: store, added }
    })
    const step = (command: string) => ({ type: 'tool' as const, name: 'Bash', input: { command }, ask: true, result: 'ok' })
    const { ctx, cards } = await play(
      { project: project({ path: dir, kind: 'engagement' }), savedRules: () => store, saveProjectRules },
      () => ({ behavior: 'allow', scope: 'project' }),
      { work: [step('npm test'), step('npm test'), step('git status')] }
    )
    expect(saveProjectRules).toHaveBeenCalledWith(['Bash(npm test:*)'])
    // The second npm test rides on the rule saved through the context; the folder's git status rule is not read.
    expect(cards.map((c) => (c as { input: { command: string } }).input.command)).toEqual(['npm test', 'git status'])
    expect(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).not.toContain('npm')
    expect(ctx.events.some((e) => e.type === 'log' && e.message === 'Saved permission rule for this project: Bash(npm test:*)')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('H-A parity: a command a saved Bash(npm test:*) seems to cover but the matcher refuses raises a card; plain npm test does not', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-refused-')))
    addRules(dir, ['Bash(npm test:*)'])
    const bashStep = (command: string) => ({
      type: 'tool' as const,
      name: 'Bash',
      input: { command },
      ask: true,
      suggestions: [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow' as const, destination: 'localSettings' as const }],
      result: 'ok'
    })
    const { cards } = await play({ project: project({ path: dir }) }, () => ({ behavior: 'allow', scope: 'once' }), {
      work: [bashStep('npm test'), bashStep('npm test --script-shell=calc'), bashStep('npm test $X')]
    })
    expect(cards.map((c) => (c.input as { command: string }).command)).toEqual(['npm test --script-shell=calc', 'npm test $X'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('H1 parity: a session grant of Bash(npm test:*) covers plain npm test only, never a wrapper or env form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-h1-'))
    const bashStep = (command: string) => ({
      type: 'tool' as const,
      name: 'Bash',
      input: { command },
      ask: true,
      suggestions: [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow' as const, destination: 'localSettings' as const }],
      result: 'ok'
    })
    const { cards } = await play({ project: project({ path: dir }) }, () => ({ behavior: 'allow', scope: 'session' }), {
      work: [bashStep('npm test'), bashStep('npm test'), bashStep('timeout 5 npm test --script-shell=x'), bashStep('NODE_ENV=test npm test --script-shell=x')]
    })
    expect(cards.map((c) => (c.input as { command: string }).command)).toEqual(['npm test', 'timeout 5 npm test --script-shell=x', 'NODE_ENV=test npm test --script-shell=x'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('a quick run gets no setMode suggestion and stays ask-only after "allow for session"', async () => {
    const quick = { folder: projPath, team: 'single' as const, allowEdits: true, gitRepo: false }
    const edit = (file: string) => ({
      type: 'tool' as const,
      name: 'Edit',
      input: { file_path: file },
      ask: true,
      suggestions: [
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
        { type: 'addDirectories' as const, directories: [sibling], destination: 'session' as const }
      ]
    })
    const { cards } = await play({ run: runSummary({ projectId: 'quick', quick }) }, () => ({ behavior: 'allow', scope: 'session' }), { work: [edit(join(sibling, 'a.md')), edit(join(sibling, 'b.md'))] })
    expect(cards).toHaveLength(2)
    expect(cards[0]!.ruleLabels).toEqual([`Edits and reads in ${sibling}`])
    expect(cards[0]!.suggestions?.some((s) => s.type === 'setMode')).toBe(false)
  })

  it('never offers or grants a protected folder as a session directory', async () => {
    const data = join(base, 'orgai-data')
    const edit = (file: string) => ({
      type: 'tool' as const,
      name: 'Edit',
      input: { file_path: file },
      ask: true,
      suggestions: [
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
        { type: 'addDirectories' as const, directories: [data], destination: 'session' as const }
      ]
    })
    const { cards } = await play({ protectedDirectories: () => [data] }, () => ({ behavior: 'allow', scope: 'session' }), { work: [edit(join(data, 'a.json')), edit(join(data, 'b.json'))] })
    expect(cards).toHaveLength(2)
    expect(cards[0]!.ruleLabels).toEqual(['Auto-accept file edits in this project'])
  })

  it('a quick run never calls the persist hooks, even on a project scope', async () => {
    const allowDirectories = vi.fn((d: string[]) => d)
    const acceptEditsForProject = vi.fn(() => true)
    const quick = { folder: projPath, team: 'single' as const, allowEdits: true, gitRepo: false }
    const { cards } = await play(
      { run: runSummary({ projectId: 'quick', quick }), allowDirectories, acceptEditsForProject },
      (req) => ({ behavior: 'allow', scope: req.toolName === 'Edit' ? 'project' : 'session' }),
      { work: fatigueSteps(projPath) }
    )
    expect(cards.map((c) => c.toolName)).toEqual(['Bash', 'Edit'])
    expect(allowDirectories).not.toHaveBeenCalled()
    expect(acceptEditsForProject).not.toHaveBeenCalled()
  })
})

describe('mock [mock:reference-edit]', () => {
  async function play(referenceDirectories?: () => string[]) {
    const ctx = fakeCtx({ autoContinue: false, prompt: `Review the brief ${REFERENCE_EDIT_TOKEN}`, project: project({ roles: defaultRoles(), permissionMode: 'acceptEdits' }), allowedRules: () => ['Edit'], ...(referenceDirectories ? { referenceDirectories } : {}) })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    const statuses = (): string[] => ctx.events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))
    for (let i = 0; i < 300 && !statuses().includes('idle'); i++) await new Promise((r) => setTimeout(r, 10))
    return { ctx, session, statuses }
  }

  it('a report edit under the first reference folder is denied without a card, and the run goes on to its end', async () => {
    const ref = mkdtempSync(join(tmpdir(), 'orgai-mock-ref-'))
    const { ctx, session, statuses } = await play(() => [ref])
    const msg = `${ref} is a reference folder: agents may read it, not change it`
    const results = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' && e.entry.agentId === MOCK_REFERENCE_REPORT ? [e.entry.block] : []))
    expect(results).toEqual([expect.objectContaining({ content: '# Client brief\n' }), expect.objectContaining({ content: `${msg}${MOCK_REFERENCE_COPY_HINT}`, isError: true })])
    // H2: exactly one harness row on the report, file name first, the path and the folder message as detail.
    const rows = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' && e.entry.block.text.startsWith('Refused:') ? [e.entry] : []))
    expect(rows).toEqual([expect.objectContaining({ agentId: MOCK_REFERENCE_REPORT, block: { kind: 'system', text: 'Refused: brief.md is in a reference folder (read only)', detail: `${join(ref, 'brief.md')}\n${msg}` } })])
    // Denied before the saved Edit rule, acceptEdits or a card.
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes(msg))).toBe(true)
    expect(statuses()).toContain('idle')
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'Mock: the reference-edit script is done.')).toBe(true)
    await session.stop()
    await session.finished
    expect(statuses().at(-1)).toBe('finished')
  })

  it('skips the edit with a log line when the run has no reference folder', async () => {
    const { ctx, session } = await play()
    expect(ctx.events.some((e) => e.type === 'log' && e.message.includes('no reference folder'))).toBe(true)
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_use' && e.entry.block.name === 'Edit')).toBe(false)
    await session.stop()
  })

  it('the edit gate fails closed on a missing path and leaves other edits alone', async () => {
    const ref = mkdtempSync(join(tmpdir(), 'orgai-mock-ref-'))
    const ctx = fakeCtx({ autoContinue: false, referenceDirectories: () => [ref] })
    const work = [
      { type: 'tool' as const, name: 'Write', input: {}, ask: true, result: 'written' },
      { type: 'tool' as const, name: 'Edit', input: { file_path: join(ctx.project.path, 'a.md') }, ask: true, result: 'edited' }
    ]
    const session = await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    const results = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))
    expect(results[0]).toMatchObject({ isError: true, content: expect.stringContaining('names no file path') })
    expect(results[1]).toMatchObject({ content: 'edited' })
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    await session.stop()
  })

  it('L4: an unreadable reference list refuses edit tools (warn log, no card) and leaves other tools alone', async () => {
    const ctx = fakeCtx({ autoContinue: false, referenceDirectories: () => { throw new Error('boom') } })
    const work = [
      { type: 'tool' as const, name: 'Edit', input: { file_path: join(ctx.project.path, 'a.md') }, ask: true, result: 'edited' },
      { type: 'tool' as const, name: 'Read', input: { file_path: join(ctx.project.path, 'a.md') }, result: 'read' }
    ]
    const session = await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    const results = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))
    expect(results[0]).toMatchObject({ isError: true, content: 'OrgAI could not check the reference folders, so this edit was refused. Try again shortly.' })
    expect(results[1]).toMatchObject({ content: 'read' })
    expect(ctx.requestPermission).not.toHaveBeenCalled()
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes("Could not read the run's reference folders: boom"))).toBe(true)
    await session.stop()
  })
})

describe('mock reference shell guard', () => {
  const idle = async (ctx: ReturnType<typeof fakeCtx>) => {
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
  }
  const results = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))

  it('[mock:reference-shell]: the del command asks with referenceFolder and no suggestions, without step.ask, and allow gives ok', async () => {
    const ref = mkdtempSync(join(tmpdir(), 'orgai-mock-refsh-'))
    // Unattended mode plus saved rules that would cover the command elsewhere: still a card.
    const ctx = fakeCtx({ autoContinue: false, prompt: `Tidy up ${REFERENCE_SHELL_TOKEN}`, project: project({ roles: defaultRoles(), permissionMode: 'auto' }), allowedRules: () => ['Bash(del:*)'], referenceDirectories: () => [ref] })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await idle(ctx)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    const req = vi.mocked(ctx.requestPermission).mock.calls[0]![0]
    expect(req).toMatchObject({ agentId: 'root', toolName: 'Bash', input: { command: `del "${join(ref, 'brief.md')}"` }, referenceFolder: ref })
    expect(req.suggestions).toBeUndefined()
    expect(req.ruleLabels).toBeUndefined()
    expect(results(ctx)).toEqual([expect.objectContaining({ content: 'ok', isError: false })])
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'info' && e.message.includes(`${ref} is a reference folder: agents may read it, not change it; this command names it`))).toBe(true)
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'Mock: the reference-shell script is done.')).toBe(true)
    await session.stop()
  })

  it('[mock:reference-shell]: a deny gives the deny text; without a reference folder the step is skipped with an info log', async () => {
    const ref = mkdtempSync(join(tmpdir(), 'orgai-mock-refsh-'))
    const ctx = fakeCtx({ autoContinue: false, prompt: `Tidy up ${REFERENCE_SHELL_TOKEN}`, project: project({ roles: defaultRoles() }), referenceDirectories: () => [ref] })
    vi.mocked(ctx.requestPermission).mockResolvedValue({ behavior: 'deny', message: 'Not in the client folder.' })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    await idle(ctx)
    expect(results(ctx)).toEqual([expect.objectContaining({ content: 'Not in the client folder.', isError: true })])
    await session.stop()
    const none = fakeCtx({ autoContinue: false, prompt: `Tidy up ${REFERENCE_SHELL_TOKEN}`, project: project({ roles: defaultRoles() }) })
    const s2 = await new MockAdapter({ script: { delayMs: 0 } }).start(none)
    await idle(none)
    expect(none.events.some((e) => e.type === 'log' && e.level === 'info' && e.message.includes('[mock:reference-shell]: this run has no reference folder'))).toBe(true)
    expect(none.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'tool_use')).toBe(false)
    expect(none.requestPermission).not.toHaveBeenCalled()
    await s2.stop()
  })

  it('a session grant never pre-approves a touching command; npm test from inside the folder asks; elsewhere the rule holds; Read cards name the folder', async () => {
    const ref = mkdtempSync(join(tmpdir(), 'orgai-mock-refsh-'))
    const ctx = fakeCtx({ autoContinue: false, allowedRules: () => ['Bash(npm test:*)'], referenceDirectories: () => [ref] })
    vi.mocked(ctx.requestPermission).mockResolvedValue({ behavior: 'allow', scope: 'session' })
    const work = [
      { type: 'tool' as const, name: 'Bash', input: { command: 'npm test', cwd: join(ref, 'sub') }, result: 'inside' },
      { type: 'tool' as const, name: 'Bash', input: { command: 'npm test' }, ask: true, result: 'elsewhere' },
      { type: 'tool' as const, name: 'Read', input: { file_path: join(ref, 'brief.md') }, ask: true, result: 'read' },
      { type: 'tool' as const, name: 'Bash', input: { command: 'npm test', cwd: join(ref, 'sub') }, result: 'inside again' }
    ]
    const session = await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)
    await idle(ctx)
    const cards = vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0])
    // inside (forced, no step.ask), Read (card with the folder), inside again (a session allow kept nothing); elsewhere matched its rule.
    expect(cards.map((c) => [c.toolName, c.referenceFolder])).toEqual([['Bash', ref], ['Read', ref], ['Bash', ref]])
    for (const c of cards) expect(c.suggestions).toBeUndefined()
    expect(results(ctx).map((r) => r.content)).toEqual(['inside', 'elsewhere', 'read', 'inside again'])
    await session.stop()
  })

  it('an unreadable list makes a shell step ask (no folder named), even without step.ask', async () => {
    let boom = false
    const ctx = fakeCtx({ autoContinue: false, allowedRules: () => ['Bash(npm test:*)'], referenceDirectories: () => { if (boom) throw new Error('boom'); return [] } })
    boom = true
    const session = await new MockAdapter({ script: { delayMs: 0, work: [{ type: 'tool' as const, name: 'Bash', input: { command: 'npm test' }, result: 'ran' }] } }).start(ctx)
    await idle(ctx)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.requestPermission).mock.calls[0]![0].referenceFolder).toBeUndefined()
    await session.stop()
  })

  it('L1: a list that throws on the second read asks with no suggestions, keeps no grant, and never rejects', async () => {
    // Every second read throws: the step's reference check reads fine, matchOptionsFor's read throws.
    let reads = 0
    const ctx = fakeCtx({
      autoContinue: false,
      allowedRules: () => ['Bash(npm test:*)', 'Read'],
      referenceDirectories: () => {
        if (++reads % 2 === 0) throw new Error('boom')
        return []
      }
    })
    vi.mocked(ctx.requestPermission).mockResolvedValue({ behavior: 'allow', scope: 'session' })
    const work = [
      { type: 'tool' as const, name: 'Bash', input: { command: 'npm test' }, ask: true, result: 'first' },
      { type: 'tool' as const, name: 'Bash', input: { command: 'npm test' }, ask: true, result: 'second' },
      { type: 'tool' as const, name: 'Read', input: { file_path: join(tmpdir(), 'elsewhere', 'a.md') }, ask: true, result: 'read' }
    ]
    const session = await new MockAdapter({ script: { delayMs: 0, work } }).start(ctx)
    await idle(ctx)
    const cards = vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0])
    // Neither the saved rules nor a session grant allowed anything: three cards, none with suggestions or a folder.
    expect(cards.map((c) => c.toolName)).toEqual(['Bash', 'Bash', 'Read'])
    for (const c of cards) {
      expect(c.suggestions).toBeUndefined()
      expect(c.referenceFolder).toBeUndefined()
    }
    expect(results(ctx).map((r) => r.content)).toEqual(['first', 'second', 'read'])
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes("Could not read the run's folders for Bash"))).toBe(true)
    await session.stop()
  })
})

describe('mock [mock:deep-tree]', () => {
  it('plays root -> mock-lead -> two reports on the default chart, every report finishes', async () => {
    const ctx = fakeCtx({ autoContinue: false, prompt: `Split the work ${DEEP_TREE_TOKEN}`, project: project({ roles: defaultRoles() }) })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    const statuses = (): string[] => ctx.events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))
    for (let i = 0; i < 300 && !statuses().includes('idle'); i++) await new Promise((r) => setTimeout(r, 10))
    const latest = (): Map<string, AgentInstance> => {
      const m = new Map<string, AgentInstance>()
      for (const e of ctx.events) if (e.type === 'agent.upsert') m.set(e.agent.id, e.agent)
      return m
    }
    const before = latest()
    for (const id of ['mock-lead', 'mock-lead-report-1', 'mock-lead-report-2']) {
      expect(before.get(id)?.state).toBe('done')
      expect(before.get(id)?.endedAt).toBeTypeOf('number')
    }
    await session.stop()
    await session.finished
    const agents = latest()
    expect([...agents.keys()].sort()).toEqual([ROOT_AGENT_ID, 'mock-lead', 'mock-lead-report-1', 'mock-lead-report-2'].sort())
    expect(agents.get(ROOT_AGENT_ID)?.parentId).toBeNull()
    expect(agents.get('mock-lead')).toMatchObject({ parentId: ROOT_AGENT_ID, handle: 'mock-lead', roleSlug: 'implementer' })
    for (const id of ['mock-lead-report-1', 'mock-lead-report-2']) {
      expect(agents.get(id)).toMatchObject({ parentId: 'mock-lead', handle: id, roleSlug: 'implementer' })
    }
    for (const a of agents.values()) {
      expect(a.state).toBe('done')
      expect(a.endedAt).toBeTypeOf('number')
    }
    expect(statuses().at(-1)).toBe('finished')
    // The lead got both reports' results; the root got the lead's.
    const spawnIds = new Set([...agents.values()].map((a) => a.spawnToolUseId).filter(Boolean))
    const results = ctx.events.flatMap((e) =>
      e.type === 'transcript' && e.entry.block.kind === 'tool_result' && spawnIds.has(e.entry.block.toolUseId) ? [[e.entry.agentId, e.entry.block.content]] : []
    )
    expect(results).toEqual([
      ['mock-lead', 'First half done.'],
      ['mock-lead', 'Second half done.'],
      [ROOT_AGENT_ID, 'Both halves done by mock-lead-report-1 and mock-lead-report-2.']
    ])
  })
})

describe('mock [mock:knowledge]', () => {
  type Knowledge = NonNullable<RuntimeContext['knowledge']>
  type Notes = NonNullable<RuntimeContext['engagementNotes']>
  const source: KnowledgeSource = { by: 'agent', at: 1 }

  /**
   * An in-memory RuntimeContext.knowledge: upserts create nodes (facts get `kf_` ids unless `keepFacts` is false),
   * links create edges, retire only records; `calls` lists every write in order with its caller.
   */
  function fakeKnowledge(keepFacts = true) {
    const graph: KnowledgeGraph = { version: 1, nodes: [], edges: [] }
    const calls: { fn: 'upsertNode' | 'link' | 'retire'; input: unknown; caller: KnowledgeCaller }[] = []
    let seq = 0
    const kg: Knowledge & { calls: typeof calls } = {
      calls,
      graph: () => graph,
      upsertNode: (input, caller) => {
        calls.push({ fn: 'upsertNode', input, caller })
        const node: KnowledgeNode = {
          id: `kn_${++seq}`,
          kind: input.kind,
          name: input.name,
          ...(input.aliases ? { aliases: input.aliases } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          facts: keepFacts ? (input.facts ?? []).map((text) => ({ id: `kf_${++seq}`, text, source })) : [],
          source,
          createdAt: 1,
          updatedAt: 1
        }
        graph.nodes.push(node)
        return { node, created: true }
      },
      link: (input, caller) => {
        calls.push({ fn: 'link', input, caller })
        const edge: KnowledgeEdge = { id: `ke_${++seq}`, from: input.from, to: input.to, relation: input.relation, ...(input.note !== undefined ? { note: input.note } : {}), source, createdAt: 1 }
        graph.edges.push(edge)
        return { edge, created: true }
      },
      retire: (input, caller) => {
        calls.push({ fn: 'retire', input, caller })
        return { item: 'fact', id: input.factId ?? '', label: 'fact', alreadyRetired: false }
      }
    }
    return kg
  }

  function fakeNotes() {
    const save = vi.fn((input: { noteId?: string; title: string; text: string }, _caller: KnowledgeCaller): EngagementNote => ({ id: 'n1', title: input.title, excerpt: input.text.split('\n')[0]!, createdAt: 1, updatedAt: 1, chars: input.text.length }))
    const notes: Notes & { save: typeof save } = { list: () => [], read: () => null, save }
    return notes
  }

  async function play(over: Parameters<typeof fakeCtx>[0] = {}) {
    const ctx = fakeCtx({ autoContinue: false, prompt: `Record the kickoff ${KNOWLEDGE_TOKEN}`, project: project({ kind: 'engagement' }), ...over })
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    const statuses = (): string[] => ctx.events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))
    for (let i = 0; i < 300 && !statuses().includes('idle'); i++) await new Promise((r) => setTimeout(r, 10))
    expect(statuses()).toContain('idle')
    await session.stop()
    await session.finished
    expect(statuses().at(-1)).toBe('finished')
    return ctx
  }
  const rootCalls = (ctx: ReturnType<typeof fakeCtx>) =>
    ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'tool_use' ? [{ name: e.entry.block.name, input: e.entry.block.input }] : []))
  const knowledgeCalls = (ctx: ReturnType<typeof fakeCtx>) => rootCalls(ctx).filter((c) => c.name === KNOWLEDGE_TOOL || c.name === ENGAGEMENT_CONTEXT_TOOL)
  const rootTexts = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
  const rootResults = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'tool_result' ? [e.entry.block] : []))
  const caller = { agentId: ROOT_AGENT_ID, roleId: 'r-lead' }

  it('makes the knowledge and note calls in order through the real harness tools, then plays the default script', async () => {
    const kg = fakeKnowledge()
    const notes = fakeNotes()
    const ctx = await play({ knowledge: kg, engagementNotes: notes })
    const byName = (name: string) => kg.graph().nodes.find((n) => n.name === name)!
    const acme = byName(MOCK_KNOWLEDGE.client)
    const jane = byName(MOCK_KNOWLEDGE.sponsor)
    const decision = byName(MOCK_KNOWLEDGE.decision)
    const factId = acme.facts.find((f) => f.text === MOCK_KNOWLEDGE.retiredFact)!.id
    expect(factId).toMatch(/^kf_/)
    const kgCall = (input: Record<string, unknown>) => ({ name: KNOWLEDGE_TOOL, input })
    expect(knowledgeCalls(ctx)).toEqual([
      kgCall({ action: 'vocabulary' }),
      kgCall({ action: 'upsert_node', kind: 'organisation', name: 'Acme Corp', aliases: ['Acme'], summary: 'The client. Mid-size manufacturer moving its billing off a legacy system.', facts: ['Headquartered in Leeds', 'Fiscal year ends in March'] }),
      kgCall({ action: 'upsert_node', kind: 'person', name: 'Jane Doe', aliases: ['J. Doe'], summary: 'Chief Financial Officer at Acme Corp and the engagement sponsor.', facts: ['Role: CFO', 'Prefers written summaries before meetings'] }),
      kgCall({ action: 'link', from: 'Jane Doe', to: 'Acme Corp', relation: 'works-at' }),
      kgCall({ action: 'upsert_node', kind: 'decision', name: 'Migrate billing to Stripe', facts: ['Agreed at the kickoff call'] }),
      kgCall({ action: 'link', from: 'Migrate billing to Stripe', to: 'Jane Doe', relation: 'decided-by', note: 'Sponsor sign-off' }),
      kgCall({ action: 'upsert_node', kind: 'risk', name: 'Legacy export format undocumented', facts: ['No one at Acme owns the export spec'] }),
      { name: ENGAGEMENT_CONTEXT_TOOL, input: { action: 'save', title: 'Kickoff call summary', text: 'Kickoff call with Jane Doe (CFO).\n\nAgreed to migrate billing to Stripe before the March year end. Open risk: the legacy export format is undocumented.' } },
      kgCall({ action: 'search', query: 'Acme' }),
      kgCall({ action: 'get', name: 'Acme Corp' }),
      kgCall({ action: 'retire', factId, reason: 'Corrected: fiscal year ends in April' })
    ])
    // The writes reached the context with the root as caller, names resolved to ids for the links.
    expect(kg.calls.map((c) => c.fn)).toEqual(['upsertNode', 'upsertNode', 'link', 'upsertNode', 'link', 'upsertNode', 'retire'])
    expect(kg.calls.every((c) => c.caller.agentId === caller.agentId && c.caller.roleId === caller.roleId)).toBe(true)
    expect(kg.calls[2]!.input).toEqual({ from: jane.id, to: acme.id, relation: 'works-at' })
    expect(kg.calls[4]!.input).toEqual({ from: decision.id, to: jane.id, relation: 'decided-by', note: 'Sponsor sign-off' })
    expect(kg.calls[6]!.input).toEqual({ factId, reason: 'Corrected: fiscal year ends in April' })
    expect(notes.save).toHaveBeenCalledTimes(1)
    expect(notes.save.mock.calls[0]![0]).toEqual({ title: 'Kickoff call summary', text: expect.stringContaining('Kickoff call with Jane Doe (CFO).') })
    expect(notes.save.mock.calls[0]![1]).toEqual(caller)
    // No call failed and no refusal came back; the search found the client.
    expect(rootResults(ctx).every((r) => !r.isError && !r.content.startsWith('REFUSED'))).toBe(true)
    expect(rootResults(ctx).find((r) => r.content.includes('entities matching Acme') || r.content.includes('entity matching Acme'))?.content).toContain('Acme Corp')
    // The done sentence, then the default script (its planning line and its last line).
    const texts = rootTexts(ctx)
    const done = texts.indexOf(MOCK_KNOWLEDGE_DONE)
    expect(done).toBeGreaterThanOrEqual(0)
    expect(texts.indexOf('Planning the work: I will read the project, delegate the change and review the result.')).toBeGreaterThan(done)
    expect(texts.at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')
    expect(texts).not.toContain(MOCK_KNOWLEDGE_NONE)
  })

  it('skips the retire (never fails) when the fact cannot be read back', async () => {
    const kg = fakeKnowledge(false)
    const ctx = await play({ knowledge: kg, engagementNotes: fakeNotes() })
    const actions = knowledgeCalls(ctx).map((c) => (c.input as { action?: string }).action)
    expect(actions).toContain('get')
    expect(actions).not.toContain('retire')
    expect(kg.calls.map((c) => c.fn)).not.toContain('retire')
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'info' && e.message.includes('retire step is skipped'))).toBe(true)
    expect(rootTexts(ctx)).toContain(MOCK_KNOWLEDGE_DONE)
  })

  it('says no knowledge graph is available on a code project (or without ctx.knowledge) and plays the default script', async () => {
    const code = await play({ project: project() })
    expect(rootTexts(code)[0]).toBe(MOCK_KNOWLEDGE_NONE)
    expect(knowledgeCalls(code)).toEqual([])
    expect(code.events.some((e) => e.type === 'log' && e.message.includes('no knowledge graph'))).toBe(true)
    expect(rootTexts(code).at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')

    const noGraph = await play({ engagementNotes: fakeNotes() })
    expect(rootTexts(noGraph)[0]).toBe(MOCK_KNOWLEDGE_NONE)
    expect(knowledgeCalls(noGraph)).toEqual([])
  })

  it('the default script without the marker makes no knowledge or note call', async () => {
    const kg = fakeKnowledge()
    const notes = fakeNotes()
    const ctx = await play({ prompt: 'Record the kickoff', knowledge: kg, engagementNotes: notes })
    expect(knowledgeCalls(ctx)).toEqual([])
    expect(kg.calls).toEqual([])
    expect(notes.save).not.toHaveBeenCalled()
    expect(rootTexts(ctx)).not.toContain(MOCK_KNOWLEDGE_DONE)
    expect(rootTexts(ctx)).not.toContain(MOCK_KNOWLEDGE_NONE)
  })

  describe('[mock:knowledge-recall] and the knowledge context', () => {
    const BLOCK = 'KNOWN-ITEMS-BLOCK'
    const known = () => vi.fn<NonNullable<RuntimeContext['knowledgeContext']>>((t) => (t.includes('Jane Doe') || t.includes('Acme') ? BLOCK : null))
    async function live(over: Parameters<typeof fakeCtx>[0] = {}) {
      const ctx = fakeCtx({ autoContinue: false, project: project({ kind: 'engagement' }), ...over })
      const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
      const statuses = (): string[] => ctx.events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))
      await vi.waitFor(() => expect(statuses()).toContain('idle'), { timeout: 3000 })
      return { ctx, session }
    }
    const userEntries = (ctx: ReturnType<typeof fakeCtx>, agentId: string) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === agentId && e.entry.block.kind === 'user' ? [e.entry.block.text] : []))

    it('seeds the graph, recalls twice through the harness tool, says so, then spawns its report with a brief naming Jane Doe', async () => {
      const knowledgeRecall = vi.fn<NonNullable<RuntimeContext['knowledgeRecall']>>(() => 'FENCED')
      const knowledgeContext = known()
      const kg = fakeKnowledge()
      const { ctx, session } = await live({ prompt: `Check the billing ${KNOWLEDGE_RECALL_TOKEN}`, knowledge: kg, engagementNotes: fakeNotes(), knowledgeRecall, knowledgeContext })
      // The seeding ran first.
      expect(kg.calls.map((c) => c.fn)).toContain('upsertNode')
      expect(rootTexts(ctx)).toContain(MOCK_KNOWLEDGE_DONE)
      expect(knowledgeRecall.mock.calls).toEqual([
        [{ query: MOCK_KNOWLEDGE_RECALL_QUERY }, { agentId: ROOT_AGENT_ID, roleId: 'r-lead' }],
        [{ query: MOCK_KNOWLEDGE_RECALL_QUERY }, { agentId: ROOT_AGENT_ID, roleId: 'r-lead' }]
      ])
      const texts = rootTexts(ctx)
      expect(texts.indexOf(MOCK_KNOWLEDGE_RECALLED)).toBeGreaterThan(texts.indexOf(MOCK_KNOWLEDGE_DONE))
      expect(rootCalls(ctx).filter((c) => c.name === KNOWLEDGE_RECALL_TOOL)).toHaveLength(2)
      // The spawn: purpose 'spawn' with the child's id; the block goes to the child, never into its transcript entry.
      expect(knowledgeContext).toHaveBeenCalledWith(MOCK_KNOWLEDGE_RECALL_BRIEF, { agentId: 'mock-report-1', purpose: 'spawn' })
      expect(session.deliveredMessages.find((m) => m.agentId === 'mock-report-1')?.text).toContain(BLOCK)
      expect(userEntries(ctx, 'mock-report-1')).toEqual([MOCK_KNOWLEDGE_RECALL_BRIEF])
      expect(rootCalls(ctx).find((c) => c.name === 'Agent')?.input).toMatchObject({ prompt: MOCK_KNOWLEDGE_RECALL_BRIEF })
      expect(JSON.stringify(ctx.events)).not.toContain(BLOCK)
      // The second report's brief names nobody: no block.
      expect(session.deliveredMessages.find((m) => m.agentId === 'mock-report-2')?.text).toBe('Look for related tests')
      await session.stop()
      await session.finished
    })

    it('says no knowledge graph is available on a code project and plays the default script', async () => {
      const { ctx, session } = await live({ prompt: `Check ${KNOWLEDGE_RECALL_TOKEN}`, project: project() })
      expect(rootTexts(ctx)[0]).toBe(MOCK_KNOWLEDGE_NONE)
      expect(rootCalls(ctx).filter((c) => c.name === KNOWLEDGE_RECALL_TOOL)).toEqual([])
      expect(rootTexts(ctx)).not.toContain(MOCK_KNOWLEDGE_RECALLED)
      expect(rootTexts(ctx).at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')
      await session.stop()
      await session.finished
    })

    it('[mock:knowledge] alone never recalls', async () => {
      const knowledgeRecall = vi.fn(() => 'FENCED')
      const { session } = await live({ prompt: `x ${KNOWLEDGE_TOKEN}`, knowledge: fakeKnowledge(), engagementNotes: fakeNotes(), knowledgeRecall })
      expect(knowledgeRecall).not.toHaveBeenCalled()
      await session.stop()
      await session.finished
    })

    it('user messages go through purpose message with the root named; the reply and the transcript hold only what was typed', async () => {
      const knowledgeContext = known()
      const { ctx, session } = await live({ prompt: 'Tell me about Acme', knowledgeContext })
      expect(knowledgeContext).toHaveBeenCalledWith('Tell me about Acme', { agentId: ROOT_AGENT_ID, purpose: 'message' })
      expect(session.deliveredMessages[0]!.text).toContain(BLOCK)
      await session.send('And Acme now?')
      await vi.waitFor(() => expect(rootTexts(ctx).some((t) => t.includes('And Acme now?'))).toBe(true))
      expect(knowledgeContext).toHaveBeenLastCalledWith('And Acme now?', { agentId: ROOT_AGENT_ID, purpose: 'message' })
      expect(session.deliveredMessages.at(-1)!.text).toContain(BLOCK)
      expect(userEntries(ctx, ROOT_AGENT_ID)).toEqual(['Tell me about Acme', 'And Acme now?'])
      expect(JSON.stringify(ctx.events)).not.toContain(BLOCK)
      await session.stop()
      await session.finished
    })

    it('nudges, peer messages, RESUME_TEXT and images-only messages get none, and a throw breaks nothing', async () => {
      const knowledgeContext = vi.fn<NonNullable<RuntimeContext['knowledgeContext']>>(() => {
        throw new Error('graph gone')
      })
      const { ctx, session } = await live({ prompt: RESUME_TEXT, knowledgeContext })
      // The default spawns' briefs are the only calls so far; they threw and the script still finished.
      expect(knowledgeContext.mock.calls.every(([, o]) => o.purpose === 'spawn')).toBe(true)
      expect(ctx.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('graph gone'))).toBe(true)
      knowledgeContext.mockClear()
      await session.receive({ fromRunId: 'r2', fromProjectName: 'Other', fromPrompt: 'x', text: 'Acme is on fire' })
      ;(session as unknown as { deliverHarness(t: string, a: string): void }).deliverHarness('Harness: continue with Acme', 'Thinking…')
      await session.send('', [{ mediaType: 'image/png', data: 'AA==', name: 'a.png' } as never])
      expect(knowledgeContext).not.toHaveBeenCalled()
      await expect(session.send('And Acme?')).resolves.toBeUndefined()
      expect(knowledgeContext).toHaveBeenCalledTimes(1)
      expect(session.deliveredMessages.at(-1)!.text).toBe('And Acme?')
      await session.stop()
      await session.finished
    })

    it('reads the standing brief for the root and every spawned agent', async () => {
      const knowledgeBrief = vi.fn(() => 'INDEX')
      const { session } = await live({ prompt: 'x', knowledgeBrief })
      expect(session.promptKnowledgeBriefs.map((b) => b.agentId)).toEqual([ROOT_AGENT_ID, 'mock-report-1', UNPRICED_REPORT_ID])
      expect(session.promptKnowledgeBriefs.every((b) => b.brief === 'INDEX')).toBe(true)
      await session.stop()
      await session.finished
    })
  })

  it('knowledgeFactId reads a live fact id from a get result and ignores retired, missing or foreign lines', () => {
    const result = ['Entity Acme Corp (data).', '<<<', 'kn_1 | organisation | Acme Corp', 'summary: x', 'facts:', '  kf_a1 | Headquartered in Leeds', '  kf_b2 | Fiscal year ends in March | retired', '  kf_c3 | Fiscal year ends in March', 'relations:', '  ke_9 | this -> works-at -> person Jane', '>>>'].join('\n')
    expect(knowledgeFactId(result, 'Fiscal year ends in March')).toBe('kf_c3')
    expect(knowledgeFactId(result, 'Headquartered in Leeds')).toBe('kf_a1')
    expect(knowledgeFactId(result, 'Not there')).toBeUndefined()
    expect(knowledgeFactId('No entity with id or name Acme Corp.', 'Headquartered in Leeds')).toBeUndefined()
    expect(knowledgeFactId('REFUSED: get needs a nodeId or a name.', 'Headquartered in Leeds')).toBeUndefined()
  })
})

describe('mock adapter [mock:folder-config] (folder config trust parity)', () => {
  function folder() {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-mock-folder-config-')))
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm test:*)"]}}\n')
    return dir
  }
  async function play(over: Parameters<typeof fakeCtx>[0]) {
    const dir = folder()
    const ctx = fakeCtx({ autoContinue: false, prompt: `Run the tests ${FOLDER_CONFIG_TOKEN}`, project: project({ path: dir }), ...over })
    vi.mocked(ctx.requestPermission).mockImplementation(async () => ({ behavior: 'allow', scope: 'once' }))
    const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
    for (let i = 0; i < 300 && !ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle'); i++) await new Promise((r) => setTimeout(r, 10))
    await session.stop()
    await session.finished
    const texts = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
    return { ctx, texts, cards: vi.mocked(ctx.requestPermission).mock.calls.map((c) => c[0]) }
  }

  it('loads the folder rule when nothing gates: no card for npm test', async () => {
    const { texts, cards } = await play({})
    expect(texts).toContain('Folder config loaded.')
    expect(cards).toEqual([])
  })

  it('loads it when folderConfigLoads is true, ignores it when false: npm test then asks', async () => {
    const yes = await play({ folderConfigLoads: () => true })
    expect(yes.texts).toContain('Folder config loaded.')
    expect(yes.cards).toEqual([])
    const no = await play({ folderConfigLoads: () => false })
    expect(no.texts).toContain('Folder config ignored.')
    expect(no.texts).not.toContain('Folder config loaded.')
    expect(no.cards.map((c) => c.toolName)).toEqual(['Bash'])
  })

  it('reads the gate once for the turn', async () => {
    const loads = vi.fn(() => true)
    await play({ folderConfigLoads: loads })
    expect(loads).toHaveBeenCalledTimes(1)
  })
})

describe('mock text step partials', () => {
  /** The root's agent.partial texts and text transcript entries, in emit order. */
  const textEvents = (events: RunEvent[]): string[] =>
    events.flatMap((e) => {
      if (e.type === 'agent.partial' && e.agentId === ROOT_AGENT_ID) return [`partial:${e.text}`]
      if (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text') return [`text:${e.entry.block.text}`]
      return []
    })
  const idle = (events: RunEvent[]): boolean => events.some((e) => e.type === 'run.status' && e.status === 'idle')

  const run = async (steps: MockStep[], delayMs = 0): Promise<RunEvent[]> => {
    const ctx = fakeCtx()
    const session = await new MockAdapter({ script: { delayMs, work: steps } }).start(ctx)
    await vi.waitFor(() => expect(idle(ctx.events)).toBe(true), { timeout: 3000 })
    await session.stop()
    await session.finished
    return ctx.events
  }

  it('emits each cumulative partial in order, then the transcript entry and the clear', async () => {
    const osc = '\x1b]52;c;SGVsbG8=\x07'
    const text = `Hi ${osc} done`
    const events = await run([{ type: 'text', text, partials: ['Hi \x1b]5', 'Hi \x1b]52;c;SGVs', `Hi ${osc}`] }], 5)
    expect(textEvents(events)).toEqual(['partial:Hi \x1b]5', 'partial:Hi \x1b]52;c;SGVs', `partial:Hi ${osc}`, `text:${text}`, 'partial:'])
  })

  it('keeps the single half-text partial without partials', async () => {
    const events = await run([{ type: 'text', text: 'abcdef' }])
    expect(textEvents(events)).toEqual(['partial:abc', 'text:abcdef', 'partial:'])
  })

  it('an interrupt during the partial waits cuts them short: no transcript entry, the clear still comes', async () => {
    const ctx = fakeCtx()
    const steps: MockStep[] = [
      { type: 'text', text: 'abc', partials: ['a', 'ab', 'abc'] },
      { type: 'text', text: 'after' }
    ]
    const session = await new MockAdapter({ script: { delayMs: 300, work: steps } }).start(ctx)
    await vi.waitFor(() => expect(textEvents(ctx.events)).toContain('partial:a'), { timeout: 3000 })
    await session.interrupt()
    await vi.waitFor(() => expect(idle(ctx.events)).toBe(true), { timeout: 3000 })
    await session.stop()
    await session.finished
    expect(textEvents(ctx.events)).toEqual(['partial:a', 'partial:'])
  })
})
