import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Project, ProviderId, ProviderModel, RunEvent, RunKind } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
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

/** `slow`: stop() waits for release() before the session ends (the window between a stop and `finished`); `sent` records every message the session got. */
function recorder(id: ProviderId, slow = false) {
  const ctxs: RuntimeContext[] = []
  const sent: string[] = []
  let end = (): void => {}
  let open = (): void => {}
  const gate = new Promise<void>((r) => (open = r))
  const adapter: RuntimeAdapter = {
    id,
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      const session: RuntimeSession = {
        send: async (text) => void sent.push(text),
        interrupt: async () => {},
        stop: async () => {
          if (slow) await gate
          end()
        },
        finished: new Promise<void>((r) => (end = r))
      }
      return session
    }
  }
  return { adapter, ctxs, sent, release: () => open() }
}

function rig(adapter: ProviderId, extra: RunManagerOptions = {}, slow = false) {
  const rec = recorder(adapter, slow)
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn(), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
  const own = events
  const m = new RunManager({ [adapter]: rec.adapter }, (e) => void own.push(e), new RunStore(join(dir, 'data')), setup, () => 100, { dataDir: join(dir, 'data'), catalog: () => CATALOG, ...extra })
  return { m, ctx: () => rec.ctxs.at(-1)!, sent: rec.sent, release: rec.release }
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

  /** The same, with a token mix the price table prices at $6 (sonnet input $3 per million): 1.2 times the cap of 5. */
  const MODEST = { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const sdkUsageOf = (ctx: RuntimeContext, tokens: typeof BIG, totalUsd: number): void => {
    // The SDK's total is already known (an earlier turn) when the agent's tokens move: before it has reported any total the
    // run is compared on the estimate (the "no total yet" tests below).
    ctx.emit({ type: 'run.cost', runId: ctx.run.id, totalCostUsd: totalUsd })
    const a = rootUsing('claude-sonnet-4-5')
    setModelTokens(a, 'claude-sonnet-4-5', tokens)
    spend(ctx, a)
  }

  it('main does not stop a Claude run before the SDK would on a moderate estimate: the SDK\'s own run total decides (estimate 1.2x the cap, SDK total under it)', async () => {
    const { m, ctx, run } = await claudeRun(5)
    // The SDK's total is 3 while the table prices the same tokens at 6: past the cap, short of the 1.5x backstop.
    sdkUsageOf(ctx(), MODEST, 3)
    const usage = m.summary(run.id)?.usage
    expect(usage?.providerCostUsd).toBe(3)
    expect(usage?.costUsd ?? 0).toBeGreaterThanOrEqual(5)
    expect(usage?.costUsd ?? 0).toBeLessThan(7.5)
    expect(m.summary(run.id)?.status).toBe('running')
    expect(m.summary(run.id)?.hold).toBeUndefined()
    // The SDK's total reaches the cap: held at once, without waiting for its error.
    sdkUsageOf(ctx(), MODEST, 5)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('backstop: an estimate of 1.5x the cap or more holds a first-party Claude run even when the SDK\'s total is still under it (15 against 3 under a cap of 5)', async () => {
    const { m, ctx, run } = await claudeRun(5)
    // 3x the cap by the price table, SDK total 3: an SDK total that far under its own tokens is not trusted. Once, with the
    // ordinary hold and line; the SDK's later error finds the run already stopped.
    sdkUsageOf(ctx(), BIG, 3)
    expect(m.summary(run.id)?.usage?.providerCostUsd).toBe(3)
    expect(m.summary(run.id)?.usage?.costUsd ?? 0).toBeGreaterThanOrEqual(15)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { limitUsd: 5 } } }))
    ctx().onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    expect(holdsOf(run.id)).toHaveLength(1)
    expect(logsOf(run.id, 'used all of its spending limit')).toHaveLength(1)
    expect(finishedOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('backstop: just under 1.5x the cap does not hold while the SDK is under the cap', async () => {
    const { m, ctx, run } = await claudeRun(5)
    // 2.4M sonnet input tokens = $7.20, 1.44x of 5.
    sdkUsageOf(ctx(), { input: 2_400_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 2)
    expect(m.summary(run.id)?.usage?.costUsd).toBeCloseTo(7.2, 5)
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(m.summary(run.id)?.status).toBe('running')
    await m.stopAll()
  })

  it('a first-party Claude run whose SDK has reported no total yet is held on main\'s own estimate once tokens were used (the adapter under-reports)', async () => {
    const { m, ctx, run } = await claudeRun(5)
    const a = rootUsing('claude-sonnet-4-5')
    setModelTokens(a, 'claude-sonnet-4-5', MODEST)
    spend(ctx(), a)
    expect(m.summary(run.id)?.usage?.providerCostUsd).toBeUndefined()
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { limitUsd: 5 } } }))
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('an SDK total of 0 with tokens used is the same: held on the estimate, not invisible', async () => {
    const { m, ctx, run } = await claudeRun(5)
    sdkUsageOf(ctx(), MODEST, 0)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    await m.stopAll()
  })

  it('a run priced from Settings (computed) with a low SDK total cannot hide behind it: the Settings price is the estimate', async () => {
    // A Settings price: 10 dollars per million input tokens, so 2M tokens cost 20 against a cap of 5 (4x), SDK total 1.
    const { m, ctx } = rig('claude', { appSettings: () => ({ modelPrices: [{ model: 'claude-sonnet-4-5', price: { inputPerToken: 0.00001, outputPerToken: 0.00005 } }] }) as never })
    const run = await m.start({ project: team('claude-sonnet-4-5', 5), prompt: 'go' })
    sdkUsageOf(ctx(), MODEST, 1)
    expect(m.summary(run.id)?.usage).toMatchObject({ costSource: 'computed', providerCostUsd: 1 })
    expect(m.summary(run.id)?.usage?.costUsd).toBeCloseTo(20, 5)
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    await m.stopAll()
  })

  it('a run with no SDK total yet and no tokens is not held (nothing to compare)', async () => {
    const { m, ctx, run } = await claudeRun(5)
    spend(ctx(), rootUsing('claude-sonnet-4-5'))
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })

  describe('an unpriced model or subagent in main\'s table does not stop a first-party run (the SDK enforces the cap)', () => {
    const unpricedAgent = () => rootUsing('claude-sonnet-4-5', undefined, [{ model: 'unexpected-unpriced-model' }])

    it('no SDK total yet: not stopped on "unknown price" in the first turn', async () => {
      const { m, ctx, run } = await claudeRun(5)
      spend(ctx(), unpricedAgent())
      expect(m.summary(run.id)?.usage).toMatchObject({ costPartial: true })
      expect(m.summary(run.id)?.usage?.providerCostUsd).toBeUndefined()
      expect(m.summary(run.id)?.status).toBe('running')
      expect(m.summary(run.id)?.hold).toBeUndefined()
      expect(logsOf(run.id, 'no known price, so its spending limit')).toHaveLength(0)
      await m.stopAll()
    })

    it('an all-unknown first agent (costSource unknown) is not stopped either', async () => {
      const { m, ctx, run } = await claudeRun(5)
      spend(ctx(), rootUsing('unexpected-unpriced-model'))
      expect(m.summary(run.id)?.usage).toMatchObject({ costSource: 'unknown' })
      expect(m.summary(run.id)?.status).toBe('running')
      expect(m.summary(run.id)?.hold).toBeUndefined()
      await m.stopAll()
    })

    it('the SDK total arrives under the cap: the run keeps going; reaching the cap holds it once', async () => {
      const { m, ctx, run } = await claudeRun(5)
      spend(ctx(), unpricedAgent())
      ctx().emit({ type: 'run.cost', runId: run.id, totalCostUsd: 2 })
      expect(m.summary(run.id)?.status).toBe('running')
      expect(m.summary(run.id)?.hold).toBeUndefined()
      ctx().emit({ type: 'run.cost', runId: run.id, totalCostUsd: 5 })
      await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { limitUsd: 5 } } }))
      ctx().onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
      expect(holdsOf(run.id)).toHaveLength(1)
      expect(logsOf(run.id, 'used all of its spending limit')).toHaveLength(1)
      await m.stopAll()
    })

    it('the priced part still backstops: 1.5x the cap on the priced estimate holds an unpriced-model run', async () => {
      const { m, ctx, run } = await claudeRun(5)
      const a = unpricedAgent()
      setModelTokens(a, 'claude-sonnet-4-5', BIG)
      spend(ctx(), a)
      await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
      expect(logsOf(run.id, 'no known price, so its spending limit')).toHaveLength(0)
      await m.stopAll()
    })

    it('a legacy run with no recorded connection resolves to the default Anthropic connection and is exempt too', async () => {
      const { m, ctx, run } = await claudeRun(5)
      ;(m as unknown as { runs: Map<string, { summary: { connection?: string } }> }).runs.get(run.id)!.summary.connection = undefined
      spend(ctx(), unpricedAgent())
      expect(m.summary(run.id)?.status).toBe('running')
      expect(m.summary(run.id)?.hold).toBeUndefined()
      await m.stopAll()
    })

    it('a per-run cap the user chose keeps the unknown-price stop (the SDK-first rule is the project cap only)', async () => {
      const { m, ctx } = rig('claude')
      const run = await m.start({ project: team('claude-sonnet-4-5', 50), prompt: 'go', userChoice: { maxBudgetUsd: 5 } })
      spend(ctx(), unpricedAgent())
      await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
      await m.stopAll()
    })
  })

  it('the total the adapter reports holds a first-party run at once (the SDK-first ordering)', async () => {
    const { m, ctx, run } = await claudeRun(5)
    const a = rootUsing('claude-sonnet-4-5')
    spend(ctx(), a)
    ctx().emit({ type: 'run.cost', runId: run.id, totalCostUsd: 6 })
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    await m.stopAll()
  })
})

describe('Claude through a proxy: the cap compares the best known cost, not only the adapter\'s total', () => {
  it('a proxy connection with a low reported total and a higher estimate holds on the estimate', async () => {
    const rec = recorder('claude')
    const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn(), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
    const m = new RunManager({ claude: rec.adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, {
      dataDir: join(dir, 'data'),
      catalog: () => CATALOG,
      resolveConnection: () => ({ connection: 'proxy-1', adapter: 'claude', env: {} })
    })
    const run = await m.start({ project: team('claude-sonnet-4-5', 5), prompt: 'go' })
    expect(m.summary(run.id)?.connection).toBe('proxy-1')
    const ctx = rec.ctxs.at(-1)!
    const a = rootUsing('claude-sonnet-4-5')
    setModelTokens(a, 'claude-sonnet-4-5', { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })
    spend(ctx, a)
    ctx.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    // 6 by the table, 1 reported, 1.2x the cap: a proxy has no SDK-first rule, so the estimate counts.
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })

  it('the same unpriced subagent model through a proxy is still stopped on "unknown price"', async () => {
    const rec = recorder('claude')
    const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn(), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
    const m = new RunManager({ claude: rec.adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, {
      dataDir: join(dir, 'data'),
      catalog: () => CATALOG,
      resolveConnection: () => ({ connection: 'proxy-1', adapter: 'claude', env: {} })
    })
    const run = await m.start({ project: team('claude-sonnet-4-5', 5), prompt: 'go' })
    spend(rec.ctxs.at(-1)!, rootUsing('claude-sonnet-4-5', undefined, [{ model: 'unexpected-unpriced-model' }]))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget' } }))
    expect(logsOf(run.id, 'no known price, so its spending limit')).toHaveLength(1)
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

describe('L5: a desktop conversation-budget run that meets an unpriced model holds on it', () => {
  it('sets the unpriced budget hold (known part of the chain spend, switchModel only) and ends the run with no exec outcome', async () => {
    const { m, ctx } = rig('codex')
    const p = team('gpt-5', 10)
    const store = (m as unknown as { store: RunStore }).store
    store.upsert({ id: 'prev', projectId: p.id, kind: 'work', prompt: 'x', status: 'error', startedAt: 1, totalCostUsd: 3, connection: 'anthropic', modelSelection: { model: 'gpt-5', connection: 'openai' } } as never)
    const run = await m.continueRun(p, 'prev', 'Recover')
    expect(m.summary(run.id)?.conversationBudgetUsd).toBe(10)
    spend(ctx(), rootUsing('gpt-5', 0.5, [{ model: 'unexpected-unpriced-model' }]))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    const hold = m.summary(run.id)?.hold
    expect(hold).toMatchObject({ kind: 'budget', budget: { scope: 'conversation', limitUsd: 10, unpriced: true }, actions: ['switchModel'] })
    expect(hold?.budget?.spentUsd).toBeCloseTo(3.5, 6)
    expect(hold?.reason).toContain("this conversation's spending limit ($10.00)")
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    expect(events.some((e) => e.type === 'run.finalized' && e.runId === run.id)).toBe(false)
    expect(holdsOf(run.id)).toHaveLength(1)
    await m.stopAll()
  })
})

// An unpriced model under a cap stops the run (the documented rule); the hold must say that, not "used all of" the limit, and a
// message to the ended run must be refused in words instead of a bare "Run is not active".
describe('a run stopped on an unknown price says so, and a message to it is refused clearly', () => {
  const UNPRICED_REASON = "The run stopped because part of it used a model with no known price, so its cost cannot be counted against this run's spending limit ($2.50). Set a price for that model in Settings, or remove the limit."
  const startedWithSession = async (m: RunManager, ctx: () => RuntimeContext, cap: number | undefined) => {
    const run = await m.start({ project: team('gpt-5', cap), prompt: 'go' })
    ctx().emit({ type: 'run.status', runId: run.id, status: 'running', sessionId: 'sess-1' })
    return run
  }

  it('cap $2.50, $0.007 of known spend plus an unpriced report: held at once, with the unknown-price reason and the known cost', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 0.007, [{ model: 'unexpected-unpriced-model' }]))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    const hold = m.summary(run.id)?.hold
    expect(hold).toMatchObject({ kind: 'budget', reason: UNPRICED_REASON, budget: { scope: 'run', limitUsd: 2.5, unpriced: true } })
    expect(hold?.budget?.spentUsd).toBeCloseTo(0.007, 6)
    // Raising the limit cannot help an unpriced stop: only the model switch is offered.
    expect(hold?.actions).toEqual(['switchModel'])
    expect(m.holdOf(run.id)?.actions).toEqual(['switchModel'])
    expect(holdsOf(run.id)).toHaveLength(1)
    // The stored copy carries the flag too (a reload keeps the wording and the card's title).
    expect(new RunStore(join(dir, 'data')).get(run.id)?.hold?.budget?.unpriced).toBe(true)
    await m.stopAll()
  })

  it('priced spend under the same cap never holds (no early trip on priced usage)', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 0.007))
    spend(ctx(), rootUsing('gpt-5', 2.49))
    expect(m.summary(run.id)).toMatchObject({ status: 'running' })
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })

  it('priced spend that does reach the cap keeps the "used all of" reason and carries no unpriced flag', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 2.6))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(m.summary(run.id)?.hold?.reason).toBe("The run stopped because it used all of this run's spending limit ($2.50).")
    const budget = m.summary(run.id)?.hold?.budget
    expect(budget).toEqual({ scope: 'run', limitUsd: 2.5, spentUsd: expect.any(Number) })
    expect(budget?.spentUsd).toBeCloseTo(2.6, 6)
    expect(m.summary(run.id)?.hold?.actions).toEqual(['addBudget', 'switchModel'])
    await m.stopAll()
  })

  it('send to the stopped run is refused with the hold reason and what to do, not "Run is not active"', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 0.007, [{ model: 'unexpected-unpriced-model' }]))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    // Adding budget would not help an unpriced stop, so the text points at the price and the model instead.
    await expect(m.send(run.id, 'Thanks, and one more thing')).rejects.toThrow(`${UNPRICED_REASON} The run has ended, so it cannot take a message. Set a price for that model in Settings, or switch the model, then continue it from the run page.`)
    await m.stopAll()
  })

  it('a priced budget stop still offers add budget in the refusal text', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 2.6))
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    await expect(m.send(run.id, 'more')).rejects.toThrow("The run stopped because it used all of this run's spending limit ($2.50). The run has ended, so it cannot take a message. Add budget or continue it from the run page.")
    await m.stopAll()
  })

  it('M1: a send between the unpriced stop and the end of the session is refused and never reaches the session', async () => {
    const { m, ctx, sent, release } = rig('codex', {}, true)
    const run = await startedWithSession(m, ctx, 2.5)
    spend(ctx(), rootUsing('gpt-5', 0.007, [{ model: 'unexpected-unpriced-model' }]))
    // The stop began (the hold is set) but the session has not ended: the run is not "finished" yet.
    await vi.waitFor(() => expect(m.summary(run.id)?.hold?.kind).toBe('budget'))
    expect(finishedOf(run.id)).toHaveLength(0)
    await expect(m.send(run.id, 'one more thing')).rejects.toThrow(`${UNPRICED_REASON} The run has ended, so it cannot take a message. Set a price for that model in Settings, or switch the model, then continue it from the run page.`)
    expect(sent).toEqual([])
    release()
    await vi.waitFor(() => expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' }))
    expect(sent).toEqual([])
    await m.stopAll()
  })

  it('M1: a send to a priced budget stop that is still ending is refused the same way, and a healthy run still takes a message', async () => {
    const { m, ctx, sent, release } = rig('codex', {}, true)
    const run = await startedWithSession(m, ctx, 2.5)
    await m.send(run.id, 'first')
    expect(sent).toEqual(['first'])
    spend(ctx(), rootUsing('gpt-5', 2.6))
    await vi.waitFor(() => expect(m.summary(run.id)?.hold?.kind).toBe('budget'))
    // Still ending: a continuation is not accepted yet, so the text does not offer to add budget.
    await expect(m.send(run.id, 'second')).rejects.toThrow("The run stopped because it used all of this run's spending limit ($2.50). The run has ended, so it cannot take a message. Continue it from the run page.")
    expect(sent).toEqual(['first'])
    release()
    await m.stopAll()
  })

  it('M1: a send after the user ended the session (End session, before it finishes) is refused', async () => {
    const { m, ctx, sent, release } = rig('codex', {}, true)
    const run = await startedWithSession(m, ctx, undefined)
    const stopping = m.stop(run.id)
    await expect(m.send(run.id, 'late')).rejects.toThrow('This run has ended, so it cannot take a message. Continue it from the run page.')
    expect(sent).toEqual([])
    release()
    await stopping
    await m.stopAll()
  })

  it('M2: addBudget on a stored unpriced hold is refused in main, whatever actions the stored hold lists', async () => {
    const { m } = rig('codex')
    const store = (m as unknown as { store: RunStore }).store
    store.upsert({ id: 'unp', projectId: 'pc', kind: 'work', prompt: 'x', status: 'finished', startedAt: 1, sessionId: 's1', endedBy: 'budget', hold: { kind: 'budget', since: 1, reason: 'r', budget: { scope: 'run', limitUsd: 2.5, spentUsd: 0.007, unpriced: true }, actions: ['addBudget', 'switchModel'] } } as never)
    store.upsert({ id: 'priced', projectId: 'pc', kind: 'work', prompt: 'x', status: 'finished', startedAt: 1, sessionId: 's1', endedBy: 'budget', hold: { kind: 'budget', since: 1, reason: 'r', budget: { scope: 'run', limitUsd: 2.5, spentUsd: 2.6 }, actions: ['addBudget', 'switchModel'] } } as never)
    expect(m.holdOf('unp')?.actions).toEqual(['switchModel'])
    expect(m.holdOf('priced')?.actions).toEqual(['addBudget', 'switchModel'])
    await expect(m.addBudget({ runId: 'unp', addUsd: 2 })).rejects.toThrow('This run stopped because part of it has no known price, so adding to its limit would not help. Set a price for that model in Settings, or switch the model, then continue it from the run page.')
  })

  it('L1: a send to a run that is still starting says so; a run that is finalizing without a session says it ended', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const adapter: RuntimeAdapter = {
      id: 'codex',
      complete: async () => '',
      start: async (ctx) => {
        await gate
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
        return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      }
    }
    const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn(), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
    const m = new RunManager({ codex: adapter }, (e) => void events.push(e), new RunStore(join(dir, 'data')), setup, () => 100, { dataDir: join(dir, 'data'), catalog: () => CATALOG })
    const starting = m.start({ project: team('gpt-5', undefined), prompt: 'go' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'run.status' && e.status === 'starting')).toBe(true))
    const runId = events.find((e) => e.type === 'run.status' && e.status === 'starting')!.runId
    await expect(m.send(runId, 'hi')).rejects.toThrow('This run is still starting. Send your message again in a moment.')
    // Before the adapter is called (no start in flight yet, status still 'starting') it is still starting; finalizing with no
    // session and no start in flight, it is ending.
    const active = (m as unknown as { runs: Map<string, { opening?: Promise<unknown>; finalizing?: Promise<void> }> }).runs.get(runId)!
    const opening = active.opening
    active.opening = undefined
    await expect(m.send(runId, 'hi')).rejects.toThrow('This run is still starting. Send your message again in a moment.')
    active.finalizing = Promise.resolve()
    await expect(m.send(runId, 'hi')).rejects.toThrow('This run has ended, so it cannot take a message. Continue it from the run page.')
    active.finalizing = undefined
    active.opening = opening
    release()
    await starting
    await m.stopAll()
  })

  it('L1: a pre-launch budget refusal that ends the run is not told it is "still starting"', async () => {
    const { m } = rig('codex')
    // The chain's model has no known price: the conversation budget cannot be enforced, so the run ends before its adapter starts.
    const p = team('unpriced-model', 10)
    const store = (m as unknown as { store: RunStore }).store
    store.upsert({ id: 'prev', projectId: p.id, kind: 'work', prompt: 'x', status: 'error', startedAt: 1, totalCostUsd: 1, connection: 'anthropic', modelSelection: { model: 'unpriced-model', connection: 'openai' } } as never)
    const attempts: Promise<string>[] = []
    const push = events.push.bind(events)
    events.push = (...items: RunEvent[]): number => {
      for (const e of items) if (e.type === 'run.status' && e.status === 'finished' && attempts.length === 0) attempts.push(m.send(e.runId, 'hi').then(() => 'sent', (err: Error) => err.message))
      return push(...items)
    }
    const run = await m.continueRun(p, 'prev', 'Recover')
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'budget' })
    expect(await Promise.all(attempts)).toEqual(['This run has ended, so it cannot take a message. Continue it from the run page.'])
    await m.stopAll()
  })

  describe('L2: the refusal tail follows the hold kind, and a paused run is not told it "has ended"', () => {
    const put = (m: RunManager, id: string, status: 'paused' | 'finished' | 'error', hold: Record<string, unknown>, sessionId: string | undefined = 's1'): void => {
      const store = (m as unknown as { store: RunStore }).store
      store.upsert({ id, projectId: 'pc', kind: 'work', prompt: 'x', status, startedAt: 1, ...(sessionId ? { sessionId } : {}), hold: { since: 1, ...hold } } as never)
    }
    const USAGE = "The provider's usage limit was reached, so the run is paused until it resets."
    const DAILY = 'The daily spending limit is reached.'

    it('a usage-limit pause: resume it', async () => {
      const { m } = rig('codex')
      put(m, 'u', 'paused', { kind: 'usage-limit', reason: USAGE, actions: ['resume', 'switchModel'] })
      await expect(m.send('u', 'hi')).rejects.toThrow(`${USAGE} It cannot take a message while it is paused. Resume it from the run page.`)
    })

    it('a spending-limit pause: resume it', async () => {
      const { m } = rig('codex')
      put(m, 's', 'paused', { kind: 'spend-limit', reason: DAILY, budget: { scope: 'day', limitUsd: 5, spentUsd: 5, resetsAt: 9 }, actions: ['resume', 'switchModel'] })
      await expect(m.send('s', 'hi')).rejects.toThrow(`${DAILY} It cannot take a message while it is paused. Resume it from the run page.`)
    })

    it('a paused run with nothing to resume from is pointed at the run page without a promise to resume', async () => {
      const { m } = rig('codex')
      put(m, 'n', 'paused', { kind: 'usage-limit', reason: USAGE, actions: ['switchModel'] }, '')
      await expect(m.send('n', 'hi')).rejects.toThrow(`${USAGE} It cannot take a message while it is paused. Continue it from the run page.`)
    })

    it('a spending limit that stopped the run (not paused), a provider error and a plan hold: the run ended, continue it', async () => {
      const { m } = rig('codex')
      put(m, 'e1', 'finished', { kind: 'spend-limit', reason: DAILY, budget: { scope: 'day', limitUsd: 5, spentUsd: 5 }, actions: ['retry', 'switchModel'] })
      put(m, 'e2', 'error', { kind: 'provider', reason: 'The provider could not be reached or answered with an error. Retry, or choose another model.', actions: ['retry', 'switchModel'] })
      await expect(m.send('e1', 'hi')).rejects.toThrow(`${DAILY} The run has ended, so it cannot take a message. Continue it from the run page.`)
      await expect(m.send('e2', 'hi')).rejects.toThrow('Retry, or choose another model. The run has ended, so it cannot take a message. Continue it from the run page.')
    })
  })

  it('send to an ended run with no hold says it ended; an unknown run keeps the old text', async () => {
    const { m, ctx } = rig('codex')
    const run = await startedWithSession(m, ctx, undefined)
    await m.stop(run.id)
    ctx().emit({ type: 'run.status', runId: run.id, status: 'finished' })
    await vi.waitFor(() => expect(m.summary(run.id)?.status).toBe('finished'))
    await expect(m.send(run.id, 'hello')).rejects.toThrow('This run has ended, so it cannot take a message. Continue it from the run page.')
    await expect(m.send('no-such-run', 'hello')).rejects.toThrow('Run is not active')
    await m.stopAll()
  })
})
