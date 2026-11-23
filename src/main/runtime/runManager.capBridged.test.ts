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
import { project as makeProject } from './testHelpers'
import { computeRunUsage, emptyAgentUsage, setModelTokens } from './runUsage'
import { priceAgentUsage } from './pricing'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// A bridged child's spend counts against the run's caps whatever the parent's adapter is, and the child's own cap is what is
// left of the run's. Fake adapters, no tokens.

let dir: string
let events: RunEvent[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-capb-'))
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
}

/** `rootTokens`: what the session's root agent has used when it starts; `onStart` runs after it (the child's report, more spend). */
function fake(id: 'claude' | 'codex', model: string, rootTokens = { input: 1000, output: 500 }, onStart?: (ctx: RuntimeContext) => void): Fake {
  const settlement: SessionSettlement = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }
  const f: Fake = { ctxs: [], stops: 0, adapter: undefined as never }
  f.adapter = {
    id,
    complete: async () => '',
    start: async (ctx: RuntimeContext): Promise<RuntimeSession> => {
      f.ctxs.push(ctx)
      let end = (): void => {}
      const finished = new Promise<void>((r) => (end = r))
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const root = agent({ id: ROOT_AGENT_ID, roleId: ctx.roles.find((r) => r.reportsTo === null)?.id ?? null, roleSlug: 'root', name: 'Root', model })
      setModelTokens(root, model, { input: rootTokens.input, output: rootTokens.output, cacheRead: 0, cacheWrite: 0 })
      ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: root })
      onStart?.(ctx)
      return {
        send: async () => {},
        interrupt: async () => {},
        stop: async () => {
          f.stops++
          ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
          end()
        },
        finished,
        settlement: () => settlement
      }
    }
  }
  return f
}

function settingsWith() {
  const c = defaultConnections({ kind: 'subscription' })
  return { setupModel: 'opus', mcpAssistModel: 'opus', connections: { ...c, openai: { ...c.openai, enabled: true } } }
}

/** Lead (claude, anthropic) -> Engineer on the openai connection (codex, 1e-6 per input token). */
function bridgedProject(over: Partial<Project> = {}): Project {
  const base = makeProject({ path: join(dir, 'repo'), provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } }, ...over })
  return { ...base, roles: base.roles.map((r) => (r.id === 'r-eng' ? { ...r, connection: 'openai', model: 'gpt-5' } : r)) }
}

function setup(claude: Fake, codex: Fake, options: RunManagerOptions = {}) {
  const store = new RunStore(join(dir, 'data'))
  const own = events
  const service = { applyProposal: vi.fn(), complete: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => 'profile') } as unknown as SetupService
  const rootConn: RunConnection = { connection: 'anthropic', adapter: 'claude', env: {} }
  const roleConn: RunConnection = { connection: 'openai', adapter: 'codex', apiKey: 'sk-openai-secret-12345', env: {}, pricing: { 'gpt-5': { inputPerToken: 0.000001, outputPerToken: 0.000002 } } }
  return new RunManager({ claude: claude.adapter, codex: codex.adapter }, (e) => void own.push(e), store, service, () => 100, {
    appSettings: () => settingsWith(),
    resolveConnection: () => rootConn,
    resolveRoleConnection: () => roleConn,
    ...options
  })
}

const SIX_DOLLARS = { input: 6_000_000, output: 0 }

describe('a bridged child\'s spend counts against the project cap of a Claude run (M2)', () => {
  it('a child that spends past the cap while the root\'s SDK total is low holds and ends the run, and the child is stopped', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    // The child is a few cents at first; the test makes it spend $6 below.
    const codex = fake('codex', 'gpt-5')
    const p = bridgedProject({ maxBudgetUsd: 5 })
    const m = setup(claude, codex)
    const run = await m.start({ project: p, prompt: 'go' })
    await tick()
    const parent = claude.ctxs[0]!
    parent.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    const spawned = parent.bridge!.spawn({ role: 'engineer', brief: 'build it', description: 'Building' })
    await tick()
    expect(m.summary(run.id)?.hold).toBeUndefined()
    // The child's own agent now has $6 of usage (priced by its own connection).
    const child = codex.ctxs[0]!
    const root = agent({ id: ROOT_AGENT_ID, roleSlug: 'engineer', name: 'Engineer', model: 'gpt-5' })
    setModelTokens(root, 'gpt-5', { input: SIX_DOLLARS.input, output: 0, cacheRead: 0, cacheWrite: 0 })
    child.emit({ type: 'agent.upsert', runId: run.id, agent: root })
    // The root's SDK total alone is 1: before this fix the run went on.
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { limitUsd: 5 } } }))
    expect(m.summary(run.id)?.hold?.budget?.spentUsd).toBeGreaterThanOrEqual(6)
    expect(codex.stops).toBeGreaterThanOrEqual(1)
    await expect(spawned).resolves.toMatchObject({ ok: false })
    const holds = new Set(events.filter((e) => e.type === 'run.hold' && e.runId === run.id && e.hold?.kind === 'budget').map((e) => (e as Extract<RunEvent, { type: 'run.hold' }>).hold!.since))
    expect(holds.size).toBe(1)
  })

  it('a child under the cap does not stop the run', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const m = setup(claude, codex)
    const run = await m.start({ project: bridgedProject({ maxBudgetUsd: 5 }), prompt: 'go' })
    await tick()
    const parent = claude.ctxs[0]!
    parent.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    void parent.bridge!.spawn({ role: 'engineer', brief: 'build it', description: 'Building' })
    await tick()
    const root = agent({ id: ROOT_AGENT_ID, roleSlug: 'engineer', name: 'Engineer', model: 'gpt-5' })
    setModelTokens(root, 'gpt-5', { input: 3_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })
    codex.ctxs[0]!.emit({ type: 'agent.upsert', runId: run.id, agent: root })
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(m.summary(run.id)?.endedBy).toBeUndefined()
    await m.stop(run.id)
  })

  it('the child\'s own session cap is the run\'s limit less what the rest of the run has spent, not a full copy of the project cap', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const m = setup(claude, codex)
    const run = await m.start({ project: bridgedProject({ maxBudgetUsd: 5 }), prompt: 'go' })
    await tick()
    const parent = claude.ctxs[0]!
    parent.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 2 })
    void parent.bridge!.spawn({ role: 'engineer', brief: 'build it', description: 'Building' })
    await tick()
    const child = codex.ctxs[0]!
    // 5 less the root's 2 (the child's own few cents are added back).
    expect(child.project.maxBudgetUsd).toBeCloseTo(3, 6)
    parent.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 3 })
    expect(child.project.maxBudgetUsd).toBeCloseTo(2, 6)
    await m.stop(run.id)
  })

  it('a per-run cap the user chose is what the child is measured against, when it is lower than the project\'s', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const m = setup(claude, codex)
    const run = await m.start({ project: bridgedProject({ maxBudgetUsd: 50 }), prompt: 'go', userChoice: { maxBudgetUsd: 4 } })
    await tick()
    const parent = claude.ctxs[0]!
    void parent.bridge!.spawn({ role: 'engineer', brief: 'build it', description: 'Building' })
    await tick()
    expect(codex.ctxs[0]!.project.maxBudgetUsd).toBeLessThanOrEqual(4)
    expect(codex.ctxs[0]!.project.maxBudgetUsd).toBeGreaterThan(3.9)
    await m.stop(run.id)
  })

  it('a run without a cap hands its child none', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const m = setup(claude, codex)
    const run = await m.start({ project: bridgedProject(), prompt: 'go' })
    await tick()
    void claude.ctxs[0]!.bridge!.spawn({ role: 'engineer', brief: 'x', description: 'x' })
    await tick()
    expect(codex.ctxs[0]!.project.maxBudgetUsd).toBeUndefined()
    await m.stop(run.id)
  })

  it('a child whose spend has no known price under a cap stops the run (the unknown-price rule)', async () => {
    const claude = fake('claude', 'claude-sonnet-4-5')
    const codex = fake('codex', 'gpt-5')
    const m = setup(claude, codex)
    const run = await m.start({ project: bridgedProject({ maxBudgetUsd: 5 }), prompt: 'go' })
    await tick()
    const parent = claude.ctxs[0]!
    parent.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    void parent.bridge!.spawn({ role: 'engineer', brief: 'build it', description: 'Building' })
    await tick()
    const root = agent({ id: ROOT_AGENT_ID, roleSlug: 'engineer', name: 'Engineer', model: 'mystery-model-9' })
    setModelTokens(root, 'mystery-model-9', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })
    codex.ctxs[0]!.emit({ type: 'agent.upsert', runId: run.id, agent: root })
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    expect(events.some((e) => e.type === 'log' && e.runId === run.id && e.message.includes('no known price'))).toBe(true)
  })
})

describe('the daily and monthly spend includes a bridged child, also when the run shares one connection (RunUsage)', () => {
  const ctx = { connection: 'proxy-1', overrides: [], catalog: [], aliases: {} } as never
  const priced = (id: string, model: string, usd: number, parentId: string | null): AgentInstance => {
    const a = agent({ id, model, parentId })
    const u = emptyAgentUsage()
    a.usage = u
    setModelTokens(a, model, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, usd)
    a.usage = priceAgentUsage(a.usage!, ctx)
    return a
  }
  const inputs = { nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: 100 }
  const summary = { id: 'r1', projectId: 'p', kind: 'work', prompt: 'x', status: 'running', startedAt: 1, totalCostUsd: 0, connection: 'proxy-1' } as never

  it('the adapter total covers only the root session: with a bridged agent on the same connection the cost is the agents\' sum, child included', () => {
    const root = priced(ROOT_AGENT_ID, 'claude-x', 3, null)
    const child = priced('ag_child', 'gpt-x', 6, ROOT_AGENT_ID)
    child.connection = 'proxy-1'
    root.connection = 'proxy-1'
    const without = computeRunUsage(summary, [root, child], { ...inputs, providerTotalUsd: 3 })
    // The old reading: the provider total (3) stood for the whole run and the child's 6 vanished.
    expect(without.costUsd).toBe(3)
    const bridged = computeRunUsage(summary, [root, child], { ...inputs, providerTotalUsd: 3, bridgedAgentIds: new Set(['ag_child']) })
    expect(bridged.costUsd).toBe(9)
    expect(bridged.providerCostUsd).toBeUndefined()
  })

  it('the root\'s cost is the larger of the adapter\'s total and its own agents\' sum, so a root with no per-agent cost is not counted as 0', () => {
    const root = agent({ id: ROOT_AGENT_ID, model: 'claude-x' })
    root.connection = 'proxy-1'
    const child = priced('ag_child', 'gpt-x', 6, ROOT_AGENT_ID)
    child.connection = 'proxy-1'
    // The root's agents carry no cost at all (none): the provider's total of 3 is the root's cost, and the child's 6 is added.
    const out = computeRunUsage(summary, [root, child], { ...inputs, providerTotalUsd: 3, bridgedAgentIds: new Set(['ag_child']) })
    expect(out.costUsd).toBe(9)
    expect(out.providerCostUsd).toBeUndefined()
    expect(out.costPartial).toBeUndefined()
  })

  it('the native sum wins when it is larger than the adapter\'s total, and an unpriced child makes the figure partial', () => {
    const root = priced(ROOT_AGENT_ID, 'claude-x', 5, null)
    root.connection = 'proxy-1'
    const child = agent({ id: 'ag_child', model: 'mystery-model-9', parentId: ROOT_AGENT_ID })
    setModelTokens(child, 'mystery-model-9', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })
    child.usage = priceAgentUsage(child.usage!, ctx)
    child.connection = 'proxy-1'
    const out = computeRunUsage(summary, [root, child], { ...inputs, providerTotalUsd: 2, bridgedAgentIds: new Set(['ag_child']) })
    expect(out.costUsd).toBe(5)
    expect(out.costPartial).toBe(true)
  })

  it('a run with no bridged agent keeps the provider total as before', () => {
    const root = priced(ROOT_AGENT_ID, 'claude-x', 3, null)
    const out = computeRunUsage(summary, [root], { ...inputs, providerTotalUsd: 3, bridgedAgentIds: new Set(['ag_other']) })
    expect(out.costUsd).toBe(3)
    expect(out.providerCostUsd).toBe(3)
  })
})
