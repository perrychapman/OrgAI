import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Project, ProviderId, ProviderModel, RunEvent, RunKind } from '@shared/types'
import { RunManager } from './runManager'
import { setModelTokens } from './runUsage'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { ROOT_AGENT_ID, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { project as makeProject, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// Project.maxBudgetUsd alone holds a run in main, on every adapter (Codex never reads the cap; Claude's SDK stops on its own).
// Recording adapters, no tokens. The per-run cap, the conversation budget, unknown prices and the two-stops ordering are
// checked beside the rule that must keep holding.

let dir: string
let events: RunEvent[]
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-projcap-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CATALOG: ProviderModel[] = [
  { id: 'gpt-5', label: 'GPT', connection: 'openai', adapter: 'codex', family: 'openai', source: 'builtin' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet', connection: 'anthropic', adapter: 'claude', family: 'claude', source: 'builtin' },
  { id: 'unpriced-model', label: 'Unknown', connection: 'openai', adapter: 'codex', family: 'openai', source: 'builtin' }
]

function recorder(id: ProviderId) {
  const ctxs: RuntimeContext[] = []
  let end = (): void => {}
  const adapter: RuntimeAdapter = {
    id,
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const session: RuntimeSession = { send: async () => {}, interrupt: async () => {}, stop: async () => end(), finished: new Promise<void>((r) => (end = r)) }
      return session
    }
  }
  return { adapter, ctxs }
}

function rig(adapter: ProviderId) {
  const rec = recorder(adapter)
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn(), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
  const own = events
  const m = new RunManager({ [adapter]: rec.adapter }, (e) => void own.push(e), new RunStore(join(dir, 'data')), setup, () => 100, { dataDir: join(dir, 'data'), catalog: () => CATALOG })
  return { m, ctx: () => rec.ctxs.at(-1)! }
}

/** A one-role project on the given model; `cap` is Project.maxBudgetUsd. */
function team(model: string, cap: number | undefined, over: Partial<Project> = {}): Project {
  const adapter: ProviderId = CATALOG.find((m) => m.id === model)?.adapter ?? 'claude'
  const p = makeProject({ id: 'pc', path: (() => { const f = join(dir, 'work'); mkdirSync(f, { recursive: true }); return f })(), provider: { id: adapter, label: adapter, auth: { kind: 'subscription' } }, ...(cap !== undefined ? { maxBudgetUsd: cap } : {}), ...over })
  p.roles = [role({ ...p.roles[0], model, canSpawn: false, spawnable: [] })]
  return p
}

const TOKENS = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
/** The root agent with usage of one model; `providerCost` is what the provider reported for it (undefined = none). */
function rootUsing(model: string, providerCost?: number, more: { model: string; providerCost?: number; tokens?: typeof TOKENS }[] = []): AgentInstance {
  const a: AgentInstance = { id: ROOT_AGENT_ID, roleId: 'r-lead', roleSlug: 'lead', name: 'Lead', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Working', model, inputTokens: 1, outputTokens: 1, costUsd: 0, startedAt: 1 }
  setModelTokens(a, model, TOKENS, providerCost)
  for (const x of more) setModelTokens(a, x.model, x.tokens ?? TOKENS, x.providerCost)
  return a
}
const spend = (ctx: RuntimeContext, agent: AgentInstance): void => ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent })

/** The budget holds the run was given, one entry per hold: a hold re-sent with refreshed actions keeps its `since`. */
const holdsOf = (runId: string) => {
  const seen = new Map<number, Extract<RunEvent, { type: 'run.hold' }>>()
  for (const e of events) if (e.type === 'run.hold' && e.runId === runId && e.hold?.kind === 'budget' && !seen.has(e.hold.since)) seen.set(e.hold.since, e)
  return [...seen.values()]
}
const logsOf = (runId: string, text: string) => events.filter((e) => e.type === 'log' && e.runId === runId && e.message.includes(text))
const finishedOf = (runId: string) => events.filter((e) => e.type === 'run.status' && e.runId === runId && e.status === 'finished')

const KINDS: RunKind[] = ['work', 'setup', 'mcp-assist', 'skill-assist']

describe('a project budget alone holds a Codex run (all four run kinds)', () => {
  it.each(KINDS)('%s: spend that reaches the project cap holds the run on its budget, with no exec outcome', async (kind) => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 5), prompt: 'go', kind })
    spend(ctx(), rootUsing('gpt-5', 7))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'budget', budget: { scope: 'run', limitUsd: 5 } })
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    expect(events.some((e) => e.type === 'run.finalized' && e.runId === run.id)).toBe(false)
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it.each(KINDS)('%s: spend under the cap keeps running, and the run is never held', async (kind) => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 5), prompt: 'go', kind })
    spend(ctx(), rootUsing('gpt-5', 2))
    expect(m.summary(run.id)?.status).toBe('running')
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(m.summary(run.id)?.endedBy).toBeUndefined()
    // Then it reaches the cap exactly: held.
    spend(ctx(), rootUsing('gpt-5', 5))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    await m.stopAll()
  })

  it.each(KINDS)('%s: no project cap and no run cap never holds, whatever the spend', async (kind) => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', undefined), prompt: 'go', kind })
    spend(ctx(), rootUsing('gpt-5', 500))
    expect(m.summary(run.id)?.status).toBe('running')
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })

  it('a per-run cap below the project cap wins (the run holds at the run cap, not the project cap)', async () => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 10), prompt: 'go', userChoice: { maxBudgetUsd: 3 } })
    expect(m.summary(run.id)?.runBudgetUsd).toBe(3)
    spend(ctx(), rootUsing('gpt-5', 4))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'budget', budget: { scope: 'run', limitUsd: 3 } })
    await m.stopAll()
  })

  it('a per-run cap above the project cap cannot raise it (the project cap holds)', async () => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 4), prompt: 'go', userChoice: { maxBudgetUsd: 20 } })
    spend(ctx(), rootUsing('gpt-5', 4))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.hold).toMatchObject({ budget: { limitUsd: 4 } })
    await m.stopAll()
  })

  it.each(KINDS)('%s: spend that has no known price under a cap stops the run instead of passing it as zero', async (kind) => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 5), prompt: 'go', kind })
    spend(ctx(), rootUsing('unexpected-unpriced-model'))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.usage).toMatchObject({ costSource: 'unknown' })
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'budget' })
    expect(logsOf(run.id, 'no known price, so its spending limit')).toHaveLength(1)
    await m.stopAll()
  })

  it('unknown-price spend without any cap is not stopped (nothing to enforce)', async () => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', undefined), prompt: 'go' })
    spend(ctx(), rootUsing('unexpected-unpriced-model'))
    expect(m.summary(run.id)?.status).toBe('running')
    await m.stopAll()
  })

  it('a partly unpriced run under a cap stops too: the priced part is only a lower bound', async () => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 50), prompt: 'go' })
    spend(ctx(), rootUsing('gpt-5', 1, [{ model: 'unexpected-unpriced-model' }]))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.usage).toMatchObject({ costPartial: true })
    await m.stopAll()
  })

  it('a stopped run is held once: a later cost update adds no second hold, log or end', async () => {
    const { m, ctx } = rig('codex')
    const run = await m.start({ project: team('gpt-5', 5), prompt: 'go' })
    spend(ctx(), rootUsing('gpt-5', 7))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget' }))
    spend(ctx(), rootUsing('gpt-5', 9))
    ctx().emit({ type: 'run.cost', runId: run.id, totalCostUsd: 9 })
    expect(holdsOf(run.id)).toHaveLength(1)
    expect(logsOf(run.id, 'used all of its spending limit')).toHaveLength(1)
    expect(finishedOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })
})

describe('Claude: the SDK stop and main\'s project-cap stop make one hold', () => {
  const claudeRun = async (cap: number) => {
    const r = rig('claude')
    const run = await r.m.start({ project: team('claude-sonnet-4-5', cap), prompt: 'go' })
    return { ...r, run }
  }

  /** What the SDK reports for a Claude run: the root's tokens (priced by the table, 5M sonnet input is far over any cap here) and its run total. */
  const BIG = { input: 5_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const sdkUsage = (ctx: RuntimeContext, totalUsd: number): void => {
    const a = rootUsing('claude-sonnet-4-5')
    setModelTokens(a, 'claude-sonnet-4-5', BIG)
    spend(ctx, a)
    ctx.emit({ type: 'run.cost', runId: ctx.run.id, totalCostUsd: totalUsd })
  }

  it('main first, then the SDK\'s error_max_budget_usd for the same run: one hold, one end, one line', async () => {
    const { m, ctx, run } = await claudeRun(5)
    sdkUsage(ctx(), 5)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    ctx().onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    ctx().emit({ type: 'run.status', runId: run.id, status: 'idle' })
    expect(holdsOf(run.id)).toHaveLength(1)
    expect(logsOf(run.id, 'used all of its spending limit')).toHaveLength(1)
    expect(finishedOf(run.id)).toHaveLength(1)
    expect(m.summary(run.id)?.endedBy).toBe('budget')
    await m.stopAll()
  })

  it('the SDK first, then a cost update past the cap: still one hold, one end, one line', async () => {
    const { m, ctx, run } = await claudeRun(5)
    ctx().onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    sdkUsage(ctx(), 6)
    expect(holdsOf(run.id)).toHaveLength(1)
    expect(logsOf(run.id, 'used all of its spending limit')).toHaveLength(1)
    expect(finishedOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('main does not stop a Claude run before the SDK would: the SDK\'s own run total decides, not a higher computed one', async () => {
    const { m, ctx, run } = await claudeRun(5)
    // The SDK's total is 3 while the table prices the same tokens far higher.
    sdkUsage(ctx(), 3)
    const usage = m.summary(run.id)?.usage
    expect(usage?.providerCostUsd).toBe(3)
    expect(usage?.costUsd ?? 0).toBeGreaterThanOrEqual(5)
    expect(m.summary(run.id)?.status).toBe('running')
    expect(m.summary(run.id)?.hold).toBeUndefined()
    // The SDK's total reaches the cap: held at once, without waiting for its error.
    sdkUsage(ctx(), 5)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('a Claude run with no run total yet is not held on main\'s own estimate; the total the adapter reports (a proxy\'s priced total too) holds it', async () => {
    const { m, ctx, run } = await claudeRun(5)
    const a = rootUsing('claude-sonnet-4-5')
    setModelTokens(a, 'claude-sonnet-4-5', BIG)
    spend(ctx(), a)
    expect(m.summary(run.id)?.usage?.providerCostUsd).toBeUndefined()
    expect(m.summary(run.id)?.usage?.costUsd ?? 0).toBeGreaterThanOrEqual(5)
    expect(m.summary(run.id)?.hold).toBeUndefined()
    ctx().emit({ type: 'run.cost', runId: run.id, totalCostUsd: 6 })
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    await m.stopAll()
  })
})

describe('rules that must keep holding', () => {
  it('a conversation budget is a total cap and the project-cap fallback does not add a second stop (checkExecBudget alone)', async () => {
    const { m, ctx } = rig('codex')
    const p = team('gpt-5', 10)
    // A continuation on a conversation budget: main enforces it through checkExecBudget with the chain's spend, once.
    const store = (m as unknown as { store: RunStore }).store
    store.upsert({ id: 'prev', projectId: p.id, kind: 'work', prompt: 'x', status: 'error', startedAt: 1, totalCostUsd: 3, connection: 'anthropic', modelSelection: { model: 'gpt-5', connection: 'openai' } } as never)
    const run = await m.continueRun(p, 'prev', 'Recover')
    expect(m.summary(run.id)?.conversationBudgetUsd).toBe(10)
    // 3 spent before, 4 now: 7 of 10, no stop. The project cap of 10 alone would not stop it either way.
    spend(ctx(), rootUsing('gpt-5', 4))
    expect(m.summary(run.id)?.status).toBe('running')
    spend(ctx(), rootUsing('gpt-5', 7))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(holdsOf(run.id)).toHaveLength(1)
    expect(holdsOf(run.id)[0]!.hold).toMatchObject({ budget: { scope: 'conversation', limitUsd: 10 } })
    await m.stopAll()
  })
})
