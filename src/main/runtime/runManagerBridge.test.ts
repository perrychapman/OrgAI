import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Project, RunEvent } from '@shared/types'
import { defaultConnections } from '@shared/defaults'
import { ROOT_AGENT_ID, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type SessionSettlement } from './types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, role } from './testHelpers'
import { setModelTokens } from './runUsage'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rmb-'))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function agent(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return { roleId: null, roleSlug: 'x', name: 'x', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Working', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over }
}

interface Fake {
  adapter: RuntimeAdapter
  ctxs: RuntimeContext[]
  stops: number
  /** The adapter's sessions end when stopped. */
  settlement: SessionSettlement
  /** What the root does right after init (default: nothing). */
  onStart?: (ctx: RuntimeContext) => void
}

function fake(id: 'claude' | 'codex', model: string, onStart?: Fake['onStart']): Fake {
  const f: Fake = {
    ctxs: [],
    stops: 0,
    settlement: { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true },
    onStart,
    adapter: undefined as never
  }
  f.adapter = {
    id,
    complete: async () => '',
    start: async (ctx: RuntimeContext): Promise<RuntimeSession> => {
      f.ctxs.push(ctx)
      let end = (): void => {}
      const finished = new Promise<void>((r) => (end = r))
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const root = agent({ id: ROOT_AGENT_ID, roleId: ctx.roles.find((r) => r.reportsTo === null)?.id ?? null, roleSlug: 'root', name: 'Root', model })
      setModelTokens(root, model, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 })
      ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: root })
      f.onStart?.(ctx)
      return {
        send: async () => {},
        interrupt: async () => {},
        stop: async () => {
          f.stops++
          ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
          end()
        },
        finished,
        settlement: () => f.settlement
      }
    }
  }
  return f
}

function settingsWith(openai: boolean) {
  const c = defaultConnections({ kind: 'subscription' })
  return { setupModel: 'opus', mcpAssistModel: 'opus', connections: { ...c, openai: { ...c.openai, enabled: openai } } }
}

/** Lead (claude, anthropic) -> Engineer on the openai connection (codex) + Reviewer (native). */
function bridgedProject(over: Partial<Project> = {}): Project {
  const base = makeProject({ path: join(dir, 'repo'), provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } }, ...over })
  return {
    ...base,
    roles: base.roles.map((r) => (r.id === 'r-eng' ? { ...r, connection: 'openai', model: 'gpt-5' } : r))
  }
}

function setup(p: Project, claude: Fake, codex: Fake, options: RunManagerOptions = {}) {
  const store = new RunStore(join(dir, 'data'))
  const own = events
  const service = { applyProposal: vi.fn(() => p), complete: vi.fn(() => p), markScaffolded: vi.fn(() => p), markArchitectureUpdated: vi.fn(() => p), hiddenContext: vi.fn(() => 'profile') } as unknown as SetupService
  const rootConn: RunConnection = { connection: 'anthropic', adapter: 'claude', env: {} }
  const roleConn: RunConnection = {
    connection: 'openai',
    adapter: 'codex',
    apiKey: 'sk-openai-secret-12345',
    env: { CODEX_HOME: '/data/codex' },
    pricing: { 'gpt-5': { inputPerToken: 0.000001, outputPerToken: 0.000002 } }
  }
  const resolveRoleConnection = vi.fn(() => roleConn)
  const m = new RunManager({ claude: claude.adapter, codex: codex.adapter }, (e) => void own.push(e), store, service, () => 100, {
    appSettings: () => settingsWith(true),
    resolveConnection: () => rootConn,
    resolveRoleConnection,
    ...options
  })
  return { m, resolveRoleConnection, store }
}

describe('RunManager bridged reports', () => {
  it('runs a bridged role in a child session: agents carry their connection, priced per connection', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5', (ctx) => {
      ctx.emit({ type: 'transcript', runId: ctx.run.id, entry: { id: 't1', agentId: ROOT_AGENT_ID, at: 1, block: { kind: 'text', text: 'Patch reviewed: looks fine.' } } })
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'idle' })
    })
    const p = bridgedProject()
    const { m, resolveRoleConnection } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    expect(resolveRoleConnection).toHaveBeenCalledWith(expect.objectContaining({ id: p.id }), { connection: 'openai', adapter: 'codex' })
    const parentCtx = claude.ctxs[0]!
    expect(parentCtx.bridge!.roles()).toEqual([{ roleId: 'r-eng', slug: 'engineer', name: 'Engineer', connection: 'openai', connectionName: 'OpenAI', adapter: 'codex' }])
    expect(parentCtx.agentConnection!('r-eng')).toBe('openai')
    expect(parentCtx.agentConnection!('r-rev')).toBe('anthropic')

    const res = await parentCtx.bridge!.spawn({ role: 'engineer', brief: 'Review the patch', description: 'Reviewing' })
    expect(res).toMatchObject({ ok: true, text: 'Patch reviewed: looks fine.', handle: 'engineer-1' })
    // The child ran on the codex adapter with the role connection only.
    expect(codex.ctxs).toHaveLength(1)
    expect(codex.ctxs[0]!.connection).toMatchObject({ connection: 'openai', adapter: 'codex' })
    expect(codex.ctxs[0]!.bridge).toBeUndefined()
    expect(codex.stops).toBe(1)

    const record = m.get(run.id)!
    const childAgent = Object.values(record.agents).find((a) => a.id === res.agentId)!
    expect(childAgent).toMatchObject({ connection: 'openai', roleId: 'r-eng', handle: 'engineer-1', parentId: ROOT_AGENT_ID })
    expect(record.agents[ROOT_AGENT_ID]!.connection).toBe('anthropic')
    // Priced by its own connection's record: 1000 * 1e-6 + 500 * 2e-6.
    expect(childAgent.usage?.costUsd).toBeCloseTo(0.002, 9)
    expect(childAgent.costUsd).toBeCloseTo(0.002, 9)
    const usage = m.summary(run.id)!.usage!
    expect(usage.connections).toBeDefined()
    expect(usage.connections!.openai).toEqual({ costUsd: expect.closeTo(0.002, 9), agents: 1 })
    expect(usage.connections!.anthropic!.agents).toBe(1)
    // No secret anywhere in what was broadcast or stored.
    const all = JSON.stringify(events) + JSON.stringify(m.get(run.id))
    expect(all).not.toContain('sk-openai-secret-12345')
    await m.stop(run.id)
  })

  it('leaves RunUsage.connections unset when every agent ran on the run connection', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    expect(m.summary(run.id)!.usage!.connections).toBeUndefined()
    await m.stop(run.id)
  })

  it('refuses the run before it exists when a role’s connection is not set up', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m, resolveRoleConnection } = setup(p, claude, codex, { appSettings: () => settingsWith(false) })
    await expect(m.start({ project: p, prompt: 'go' })).rejects.toThrow('Role Engineer runs on OpenAI, which is not set up.')
    expect(claude.ctxs).toHaveLength(0)
    expect(resolveRoleConnection).not.toHaveBeenCalled()
    expect(m.liveRunCount()).toBe(0)
  })

  it('refuses when the role connection cannot be built, and without the option on a real adapter', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const a = setup(p, claude, codex, { resolveRoleConnection: () => { throw new Error('OPENAI_API_KEY is not set in OrgAI\'s environment.') } })
    await expect(a.m.start({ project: p, prompt: 'go' })).rejects.toThrow("Role Engineer runs on OpenAI: OPENAI_API_KEY is not set in OrgAI's environment.")
    const b = setup(p, claude, codex, { resolveRoleConnection: undefined })
    await expect(b.m.start({ project: p, prompt: 'go' })).rejects.toThrow('This project has roles on other connections, which this build cannot run.')
    // A missing adapter for the bridged pair refuses too.
    const store = new RunStore(join(dir, 'data2'))
    const c = new RunManager({ claude: claude.adapter }, (e) => void events.push(e), store, { markScaffolded: vi.fn(), hiddenContext: vi.fn() } as unknown as SetupService, () => 100, {
      appSettings: () => settingsWith(true),
      resolveConnection: () => ({ connection: 'anthropic', adapter: 'claude' }) as RunConnection,
      resolveRoleConnection: () => ({ connection: 'openai', adapter: 'codex' })
    })
    await expect(c.start({ project: p, prompt: 'go' })).rejects.toThrow('no runtime adapter for provider "codex"')
    expect(claude.ctxs).toHaveLength(0)
  })

  it('never bridges single, setup or chart-without-bridged-roles runs', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m, resolveRoleConnection } = setup(p, claude, codex, {
      connectionModels: () => [{ connection: 'anthropic', name: 'Anthropic', tierModels: { deep: 'opus' }, models: ['opus'] }]
    })
    const single = await m.start({ project: p, prompt: 'ask', team: 'single' })
    await tick()
    expect(claude.ctxs[0]!.bridge).toBeUndefined()
    await m.stop(single.id)
    const setupRun = await m.start({ project: p, prompt: 'design', kind: 'setup' })
    await tick()
    const sctx = claude.ctxs[1]!
    expect(sctx.bridge).toBeUndefined()
    expect(sctx.connectionModels!()).toEqual([{ connection: 'anthropic', name: 'Anthropic', tierModels: { deep: 'opus' }, models: ['opus'] }])
    // A work run does not get the setup-only hook.
    await m.stop(setupRun.id)
    const work = await m.start({ project: p, prompt: 'go' })
    await tick()
    expect(claude.ctxs[2]!.connectionModels).toBeUndefined()
    expect(resolveRoleConnection).toHaveBeenCalledTimes(1)
    await m.stop(work.id)
    // A native-only chart has no bridge at all.
    const native = makeProject({ path: join(dir, 'repo'), provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } } })
    const r = await m.start({ project: native, prompt: 'go' })
    await tick()
    expect(claude.ctxs[3]!.bridge).toBeUndefined()
    await m.stop(r.id)
  })

  it('stops a running child with the run and resolves its spawn "Stopped"', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    const spawn = claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'long task' })
    await tick()
    expect(codex.ctxs).toHaveLength(1)
    await m.stop(run.id)
    expect(await spawn).toMatchObject({ ok: false, text: 'Stopped: the run was stopped' })
    expect(codex.stops).toBe(1)
    expect(claude.stops).toBe(1)
  })

  it('stops children on interrupt and on quit', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    const spawn = claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'task' })
    await tick()
    await m.interrupt(run.id)
    expect(await spawn).toMatchObject({ ok: false, text: 'Stopped: the user interrupted the run' })
    const again = claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'task two' })
    await tick()
    await m.stopAll({ reason: 'quit' })
    expect(await again).toMatchObject({ ok: false, text: 'Stopped: OrgAI is closing' })
    expect(codex.stops).toBe(2)
  })

  it('counts a working child as work while the root is idle, and a cut run settles its agents', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5', (ctx) => ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'idle' }))
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject()
    const { m } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    expect(m.summary(run.id)!.status).toBe('idle')
    expect(m.workingRunCount()).toBe(0)
    expect(m.busyRunCount()).toBe(0)
    const spawn = claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'task' })
    await tick()
    expect(m.workingRunCount()).toBe(1)
    expect(m.busyRunCount()).toBe(1)
    await m.stop(run.id)
    await spawn
    await tick()
    expect(m.workingRunCount()).toBe(0)
    const record = m.get(run.id)!
    expect(Object.values(record.agents).every((a) => a.state === 'done' || a.state === 'error')).toBe(true)
  })

  it('a child’s card goes through the parent with the remapped agent id', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5', (ctx) => {
      void ctx.requestPermission({ agentId: ROOT_AGENT_ID, toolName: 'Bash', input: { command: 'npm test' }, title: 'Run npm test' } as never)
    })
    const p = bridgedProject()
    const { m } = setup(p, claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    const spawn = claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'task' })
    await tick(5)
    const cards = m.pendingCards(run.id)
    expect(cards.permissions).toHaveLength(1)
    const childId = Object.values(m.get(run.id)!.agents).find((a) => a.id !== ROOT_AGENT_ID)!.id
    expect(cards.permissions[0]!.agentId).toBe(childId)
    await m.stop(run.id)
    await spawn
  })
})
