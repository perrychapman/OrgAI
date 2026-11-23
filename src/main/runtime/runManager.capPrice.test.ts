import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, Project, ProviderId, ProviderModel, RunEvent } from '@shared/types'
import { RunManager } from './runManager'
import { setModelTokens } from './runUsage'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { project as makeProject, role, runSummary } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// M2: a daily / monthly cap cannot see a run whose model has no known price, so such a run is refused at start and a live run
// whose cost turns unknown says so once in its log.

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-capprice-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const model = (id: string): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'builtin' })
const CATALOG: ProviderModel[] = [model('claude-sonnet-4-5'), model('claude-opus-4-5'), model('mystery-model')]

function rig(extra: Partial<ConstructorParameters<typeof RunManager>[5]> = {}) {
  const started: { ctx: RuntimeContext }[] = []
  const make = (id: ProviderId): RuntimeAdapter => ({
    id,
    complete: async () => '',
    start: async (ctx) => {
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${started.length + 1}` })
      started.push({ ctx })
      const session: RuntimeSession = { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
      return session
    }
  })
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const own = events
  const m = new RunManager({ mock: make('mock'), claude: make('claude'), codex: make('codex') }, (e) => void own.push(e), store, setup, () => 100, {
    dataDir: join(dir, 'data'),
    catalog: () => CATALOG,
    ...extra
  })
  return { m, store, started }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

/** A Claude-provider team: a priced lead, and a second role with the given model. */
const claudeTeam = (engineerModel: string, over: Partial<Project> = {}): Project => ({
  ...makeProject({ id: 'p1', path: folder() }),
  provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } },
  roles: [role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'claude-sonnet-4-5' }), role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', model: engineerModel, reportsTo: 'r-lead' })],
  ...over
})

const SENTENCE = (m: string): string => `This project has a daily or monthly spending limit, but ${m} has no known price, so the limit cannot be enforced. Set a model price in Settings or remove the limit.`

describe('a daily or monthly cap needs priced models (M2)', () => {
  it('refuses a start whose role model has no known price under a daily cap, leaving no run', async () => {
    const r = rig()
    await expect(r.m.start({ project: claudeTeam('mystery-model', { maxDailyUsd: 5 }), prompt: 'go' })).rejects.toThrow(SENTENCE('mystery-model'))
    expect(r.store.list('p1')).toEqual([])
    expect(r.started).toEqual([])
  })

  it('refuses under a monthly cap, and for an unpriced chosen root model', async () => {
    const r = rig()
    await expect(r.m.start({ project: claudeTeam('mystery-model', { maxMonthlyUsd: 50 }), prompt: 'go' })).rejects.toThrow(SENTENCE('mystery-model'))
    const root = claudeTeam('claude-sonnet-4-5', { maxMonthlyUsd: 50 })
    await expect(r.m.start({ project: root, prompt: 'go', userChoice: { modelSelection: { model: 'mystery-model', connection: 'anthropic' } } })).rejects.toThrow(SENTENCE('mystery-model'))
    expect(r.store.list('p1')).toEqual([])
    expect(r.started).toEqual([])
  })

  it('starts the same unpriced model without a cap, and priced models under caps', async () => {
    const r = rig()
    await r.m.start({ project: claudeTeam('mystery-model'), prompt: 'go' })
    await r.m.start({ project: claudeTeam('claude-opus-4-5', { id: 'p2', path: folder('two'), maxDailyUsd: 5, maxMonthlyUsd: 50 }), prompt: 'go' })
    expect(r.started).toHaveLength(2)
    await r.m.stopAll()
  })

  it('does not refuse a mock run (its models are fake ids priced by the mock itself)', async () => {
    const r = rig()
    const p = makeProject({ id: 'p3', path: folder('three'), maxDailyUsd: 5 })
    await r.m.start({ project: p, prompt: 'go' })
    expect(r.started).toHaveLength(1)
    await r.m.stopAll()
  })

  it('logs one warning when a live run under a cap turns unknown-cost, and none without a cap', async () => {
    const tokens = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
    const agent = (): AgentInstance => {
      const a: AgentInstance = { id: 'root', roleId: 'r-lead', roleSlug: 'lead', name: 'Lead', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Working', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() }
      setModelTokens(a, 'mock-unpriced', tokens)
      return a
    }
    const r = rig()
    const capped = await r.m.start({ project: makeProject({ id: 'p4', path: folder('four'), maxDailyUsd: 5 }), prompt: 'go' })
    const uncapped = await r.m.start({ project: makeProject({ id: 'p5', path: folder('five') }), prompt: 'go' })
    for (const run of [capped, uncapped]) {
      const ctx = r.started.find((s) => s.ctx.run.id === run.id)!.ctx
      ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent() })
      ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent() })
    }
    const warnings = (id: string): string[] => events.flatMap((e) => (e.type === 'log' && e.runId === id && e.level === 'warn' && e.message.includes('no known price') ? [e.message] : []))
    expect(r.m.summaryOf(capped.id)!.usage).toMatchObject({ costSource: 'unknown' })
    expect(warnings(capped.id)).toHaveLength(1)
    expect(warnings(uncapped.id)).toHaveLength(0)
    await r.m.stopAll()
  })
})

describe('a live model switch under a daily or monthly cap needs a priced model (M1)', () => {
  const REASON = SENTENCE('mystery-model')

  it('refuses a live switch to an unpriced model before the adapter changes anything, and saves nothing', async () => {
    const p = claudeTeam('claude-sonnet-4-5', { maxDailyUsd: 5 })
    const r = rig({ resolveProject: () => p })
    const run = await r.m.start({ project: p, prompt: 'go' })
    const active = Reflect.get(r.m, 'runs').get(run.id)
    const change = vi.fn(async () => {})
    active.session.switchModel = change
    const before = r.m.summaryOf(run.id)!.modelSelection
    const result = await r.m.switchModel({ runId: run.id, model: 'mystery-model' })
    expect(result).toMatchObject({ applied: false, reason: REASON })
    expect(change).not.toHaveBeenCalled()
    expect(r.m.summaryOf(run.id)!.modelSelection).toEqual(before)
    expect(events.some((e) => e.type === 'run.model')).toBe(false)
    // A priced model on the same connection still switches.
    const ok = await r.m.switchModel({ runId: run.id, model: 'claude-opus-4-5' })
    expect(ok.applied).toBe(true)
    expect(change).toHaveBeenCalledOnce()
    await r.m.stopAll()
  })

  it('refuses under a monthly cap, and allows the same unpriced model when the project has no cap', async () => {
    const monthly = claudeTeam('claude-sonnet-4-5', { maxMonthlyUsd: 50 })
    const r = rig({ resolveProject: () => monthly })
    const run = await r.m.start({ project: monthly, prompt: 'go' })
    Reflect.get(r.m, 'runs').get(run.id).session.switchModel = vi.fn(async () => {})
    expect(await r.m.switchModel({ runId: run.id, model: 'mystery-model' })).toMatchObject({ applied: false, reason: REASON })
    await r.m.stopAll()

    const open = claudeTeam('claude-sonnet-4-5', { id: 'p9', path: folder('open') })
    const r2 = rig({ resolveProject: () => open })
    const run2 = await r2.m.start({ project: open, prompt: 'go' })
    Reflect.get(r2.m, 'runs').get(run2.id).session.switchModel = vi.fn(async () => {})
    expect((await r2.m.switchModel({ runId: run2.id, model: 'mystery-model' })).applied).toBe(true)
    await r2.m.stopAll()
  })

  it('refuses a selection saved for the next continuation of an ended run, so a continuation cannot start unpriced', async () => {
    const p = claudeTeam('claude-sonnet-4-5', { maxDailyUsd: 5 })
    const r = rig({ resolveProject: () => p })
    r.store.upsert(runSummary({ id: 'ended', projectId: 'p1', status: 'finished', connection: 'anthropic', modelAdapter: 'claude' }))
    const result = await r.m.switchModel({ runId: 'ended', model: 'mystery-model' })
    expect(result).toMatchObject({ applied: false, reason: REASON })
    expect(r.store.get('ended')?.modelSelection).toBeUndefined()
    expect(events.some((e) => e.type === 'run.model')).toBe(false)
    const ok = await r.m.switchModel({ runId: 'ended', model: 'claude-opus-4-5' })
    expect(ok).toMatchObject({ applied: false, reason: 'Model will be used when the run continues.' })
    expect(r.store.get('ended')?.modelSelection).toEqual({ model: 'claude-opus-4-5', connection: 'anthropic' })
  })
})
