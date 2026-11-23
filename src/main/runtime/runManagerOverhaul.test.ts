import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentInstance, Project, ProjectSpend, RunEvent, RunPlan, RunSummary } from '@shared/types'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { RESUME_TEXT, RunManager, SKIP_REVIEW_TEXT, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, role, runSummary } from './testHelpers'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/** projectSpend is another module's job (and has its own tests): these tests set what it answers. */
const spendState = vi.hoisted(() => ({ day: 0, month: 0, dayUntil: 0, monthUntil: 0 }))
vi.mock('./projectSpend', () => ({
  projectSpend: (p: Pick<Project, 'id' | 'maxDailyUsd' | 'maxMonthlyUsd'>, _runs: readonly RunSummary[], now: number): ProjectSpend => ({
    projectId: p.id,
    day: { spentUsd: spendState.day, runs: 1, unknownRuns: 0, from: now - 1000, until: spendState.dayUntil },
    month: { spentUsd: spendState.month, runs: 1, unknownRuns: 0, from: now - 1000, until: spendState.monthUntil },
    ...(p.maxDailyUsd !== undefined ? { maxDailyUsd: p.maxDailyUsd } : {}),
    ...(p.maxMonthlyUsd !== undefined ? { maxMonthlyUsd: p.maxMonthlyUsd } : {}),
    monthProjectionUsd: null,
    generatedAt: now
  })
}))

let dir: string
let events: RunEvent[]
const sink = (): ((e: RunEvent) => void) => {
  const own = events
  return (e) => void own.push(e)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rmo-'))
  events = []
  Object.assign(spendState, { day: 0, month: 0, dayUntil: Date.now() + 3_600_000, monthUntil: Date.now() + 20 * 86_400_000 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface FakeSession extends RuntimeSession {
  send: Mock<RuntimeSession['send']>
  stop: Mock<RuntimeSession['stop']>
}

interface RigOptions {
  /** The session answers stopAgent (true / false / a throw). Absent = the session has no stopAgent. */
  stopAgent?: (id: string) => boolean | Promise<boolean>
  /** adapter.start rejects with this. */
  startError?: string
}

function setupService(p: Project): SetupService {
  return {
    applyProposal: vi.fn(() => p),
    complete: vi.fn(() => p),
    markScaffolded: vi.fn(() => p),
    markArchitectureUpdated: vi.fn(() => p),
    hiddenContext: vi.fn(() => 'profile'),
    prepare: vi.fn(async (x: Project) => x)
  } as unknown as SetupService
}

function rig(p: Project, options: RunManagerOptions = {}, rigOptions: RigOptions = {}) {
  const store = new RunStore(join(dir, 'data'))
  const ctxs: RuntimeContext[] = []
  const sessions = new Map<string, FakeSession>()
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      if (rigOptions.startError) throw new Error(rigOptions.startError)
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctx.run.id}` })
      let end!: () => void
      const finished = new Promise<void>((r) => (end = r))
      const session: FakeSession = {
        send: vi.fn(async () => {}),
        interrupt: async () => {},
        stop: vi.fn(async () => {
          ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
          end()
        }),
        finished,
        ...(rigOptions.stopAgent ? { stopAgent: async (id: string) => rigOptions.stopAgent!(id) } : {})
      }
      sessions.set(ctx.run.id, session)
      return session
    }
  }
  const m = new RunManager({ mock: adapter }, sink(), store, setupService(p), () => 100, options)
  return { m, store, ctxs, sessions, ctxOf: (id: string): RuntimeContext => ctxs.find((c) => c.run.id === id)! }
}

const agentOf = (over: Partial<AgentInstance> & { id: string }): AgentInstance => ({
  roleId: 'r-eng',
  roleSlug: 'engineer',
  name: 'Engineer',
  parentId: 'root',
  spawnToolUseId: null,
  state: 'thinking',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...over
})

const tick = (ctx: RuntimeContext, agent: Partial<AgentInstance> & { id: string } = { id: 'root', parentId: null, roleId: 'r-lead', roleSlug: 'lead', name: 'Lead' }): void =>
  ctx.emit({ type: 'agent.upsert', runId: ctx.run.id, agent: agentOf(agent) })

const holdEvents = (runId: string): { hold: unknown }[] => events.filter((e): e is Extract<RunEvent, { type: 'run.hold' }> => e.type === 'run.hold' && e.runId === runId)
const logs = (runId: string, level?: string): string[] => events.flatMap((e) => (e.type === 'log' && e.runId === runId && (!level || e.level === level) ? [e.message] : []))
const proj = (over: Partial<Project> = {}): Project => makeProject({ path: join(dir, 'repo'), ...over })
/** Wait for the run to reach `status`. */
const reach = (m: RunManager, runId: string, status: RunSummary['status']): Promise<void> => vi.waitFor(() => expect(m.summary(runId)?.status).toBe(status))

describe('daily and monthly caps before a run starts', () => {
  it('refuses a start at the daily cap in a plain sentence and leaves no run', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store, ctxs } = rig(p)
    spendState.day = 5
    await expect(m.start({ project: p, prompt: 'go' })).rejects.toThrow('This project reached its daily spending limit of $5.00')
    expect(store.list(p.id)).toEqual([])
    expect(m.liveRuns()).toEqual([])
    expect(ctxs).toHaveLength(0)
  })

  it('refuses at the monthly cap, and starts below both caps', async () => {
    const p = proj({ maxDailyUsd: 5, maxMonthlyUsd: 30 })
    const { m } = rig(p)
    spendState.day = 4.99
    spendState.month = 30.01
    await expect(m.start({ project: p, prompt: 'go' })).rejects.toThrow('monthly spending limit of $30.00')
    spendState.month = 29
    const run = await m.start({ project: p, prompt: 'go' })
    expect(m.summary(run.id)?.status).toBeDefined()
    await m.stopAll()
  })

  it('applies to setup runs too, and not to a project without caps', async () => {
    const capped = proj({ maxDailyUsd: 5 })
    const { m } = rig(capped)
    spendState.day = 9
    await expect(m.start({ project: capped, prompt: 'profile it', kind: 'setup' })).rejects.toThrow('daily spending limit')
    const free = proj({ id: 'p2' })
    const run = await rig(free).m.start({ project: free, prompt: 'go' })
    expect(run.id).toBeTruthy()
  })

  it('reads the project live: a cap raised after the project was handed over lets the run start', async () => {
    const stale = proj({ maxDailyUsd: 5 })
    const raised = { ...stale, maxDailyUsd: 50 }
    const { m } = rig(stale, { resolveProject: () => raised })
    spendState.day = 10
    const run = await m.start({ project: stale, prompt: 'go' })
    expect(run.id).toBeTruthy()
    await m.stopAll()
  })

  it('refuses a continuation at the cap and keeps a paused predecessor paused', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store } = rig(p)
    store.upsert(runSummary({ id: 'old', projectId: p.id, status: 'paused', sessionId: 's-old', pausedUntil: 5, autoResume: false }))
    spendState.day = 5
    await expect(m.continueRun(p, 'old', 'again')).rejects.toThrow('daily spending limit')
    expect(m.summary('old')).toMatchObject({ status: 'paused' })
    expect(m.liveRuns()).toEqual([])
  })

  it('refuses the automatic resume of a usage-limit pause at the cap and stops promising it', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store } = rig(p, { resolveProject: () => p })
    store.upsert(runSummary({ id: 'limited', projectId: p.id, status: 'paused', sessionId: 's-l', pausedUntil: Date.now(), autoResume: true }))
    spendState.day = 6
    ;(m as unknown as { scheduleResume(id: string, at: number): void }).scheduleResume('limited', Date.now())
    await vi.waitFor(() => expect(logs('limited', 'error').join(' ')).toContain('Could not resume the paused run: This project reached its daily spending limit'))
    expect(m.summary('limited')).toMatchObject({ status: 'paused', autoResume: false })
    expect(m.liveRuns()).toEqual([])
  })

  it('refuses Resume now at the cap, then allows it once the period has reset', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store } = rig(p, { resolveProject: () => p })
    store.upsert(runSummary({ id: 'paused-1', projectId: p.id, status: 'paused', sessionId: 's-p', pausedUntil: 1, autoResume: false }))
    spendState.day = 5
    await expect(m.resumeNow('paused-1', { desktop: true })).rejects.toThrow('daily spending limit')
    spendState.day = 0
    const next = await m.resumeNow('paused-1', { desktop: true })
    expect(next.resumedFrom).toBe('paused-1')
    await m.stopAll()
  })
})

describe('daily and monthly caps while a run is live', () => {
  it('pauses by default: paused until the reset, no auto-resume, a spend-limit hold with the figures', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    tick(ctx)
    expect(m.summary(run.id)?.status).not.toBe('paused')
    spendState.day = 5.2
    tick(ctx)
    await reach(m, run.id, 'paused')
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'paused', autoResume: false, pausedUntil: spendState.dayUntil })
    expect(s.pauseReason).toContain('daily spending limit of $5.00')
    expect(s.hold).toMatchObject({ kind: 'spend-limit', budget: { scope: 'day', limitUsd: 5, spentUsd: 5.2, resetsAt: spendState.dayUntil } })
    expect(s.endedBy).toBeUndefined()
    // no auto-resume timer was armed, and none arrives
    expect(m.hasAutoResume(run.id)).toBe(false)
    expect(m.activeResumeTimerCount()).toBe(0)
    expect(holdEvents(run.id).at(-1)?.hold).toMatchObject({ kind: 'spend-limit' })
    expect(logs(run.id, 'warn').some((l) => l.includes('paused until the day resets'))).toBe(true)
    // the broadcast status says paused, without an auto-resume
    expect(events.some((e) => e.type === 'run.status' && e.runId === run.id && e.status === 'paused' && e.autoResume === false)).toBe(true)
  })

  it("stops when the project says 'stop': finished like a budget end, with the hold", async () => {
    const p = proj({ maxMonthlyUsd: 20, onSpendLimit: 'stop' })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    spendState.month = 20
    tick(ctxOf(run.id))
    await reach(m, run.id, 'finished')
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'finished', endedBy: 'budget' })
    expect(s.pausedUntil).toBeUndefined()
    expect(s.hold).toMatchObject({ kind: 'spend-limit', budget: { scope: 'month', limitUsd: 20 } })
    expect(s.hold?.reason).toContain('was stopped')
  })

  it('checks on run.cost too, and only once', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, ctxOf, sessions } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    spendState.day = 6
    ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: 2 })
    await reach(m, run.id, 'paused')
    expect(sessions.get(run.id)!.stop).toHaveBeenCalledTimes(1)
    expect(logs(run.id, 'warn').filter((l) => l.includes('spending limit')).length).toBe(1)
  })

  it('reads the project at each check: a cap lowered mid-run applies, and a cap removed lets the run go on', async () => {
    const p = proj({})
    let live: Project = p
    const { m, ctxOf } = rig(p, { resolveProject: () => live })
    const run = await m.start({ project: p, prompt: 'go' })
    spendState.day = 7
    tick(ctxOf(run.id))
    expect(m.summary(run.id)?.status).not.toBe('paused')
    live = { ...p, maxDailyUsd: 6 }
    tick(ctxOf(run.id))
    await reach(m, run.id, 'paused')
  })

  it('a paused spend-limit run cannot be resumed while the cap holds, and hold actions follow', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, ctxOf } = rig(p, { resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go' })
    spendState.day = 5
    tick(ctxOf(run.id))
    await reach(m, run.id, 'paused')
    expect(m.holdOf(run.id)?.actions).toEqual(['switchModel'])
    await expect(m.resumeNow(run.id, { desktop: true })).rejects.toThrow('daily spending limit')
    // the day rolls over
    spendState.day = 0
    expect(m.holdOf(run.id)?.actions).toEqual(['resume', 'switchModel'])
    const next = await m.resumeNow(run.id, { desktop: true })
    expect(next.resumedFrom).toBe(run.id)
    // the hold ended with the continuation
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(holdEvents(run.id).at(-1)?.hold).toBeNull()
    await m.stopAll()
  })

  it('a headless exec run at a cap always stops (nobody can wait for the reset)', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', overrides: { execMode: true } })
    spendState.day = 5
    tick(ctxOf(run.id))
    await vi.waitFor(() => expect(m.summary(run.id)?.status).toBe('finished'))
    expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', execOutcome: 'budget-exceeded' })
    expect(m.summary(run.id)?.hold).toBeUndefined()
  })

  it('a headless exec start is refused at a cap like any other', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store } = rig(p)
    spendState.day = 5
    await expect(m.start({ project: p, prompt: 'go', overrides: { execMode: true } })).rejects.toThrow('daily spending limit')
    expect(store.list(p.id)).toEqual([])
  })

  it('a Chat run has no project caps', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m } = rig(p)
    spendState.day = 99
    expect((m as unknown as { liveCapProject(id: string, quickLike: boolean, p?: Project): Project | undefined }).liveCapProject(p.id, true, p)).toBeUndefined()
  })
})

describe('spend warnings', () => {
  it('warns once per scope at the configured percent, with a log line, and never again', async () => {
    const p = proj({ maxDailyUsd: 10, maxMonthlyUsd: 100 })
    const { m, ctxOf } = rig(p, { appSettings: () => ({ spendWarnPercent: 80 }) as never })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    spendState.day = 7
    tick(ctx)
    expect(events.filter((e) => e.type === 'run.spendWarning')).toEqual([])
    spendState.day = 8
    tick(ctx)
    tick(ctx)
    ctx.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 1 })
    spendState.day = 9.5
    spendState.month = 85
    tick(ctx)
    tick(ctx)
    const warnings = events.filter((e): e is Extract<RunEvent, { type: 'run.spendWarning' }> => e.type === 'run.spendWarning')
    expect(warnings.map((w) => w.warning.scope)).toEqual(['day', 'month'])
    expect(warnings[0].warning).toMatchObject({ scope: 'day', limitUsd: 10, spentUsd: 8, percent: 80 })
    expect(warnings[1].warning).toMatchObject({ scope: 'month', limitUsd: 100, spentUsd: 85 })
    expect(logs(run.id, 'warn').filter((l) => l.startsWith('You have used 80%')).length).toBe(2)
    await m.stopAll()
  })

  it('warns about the run and the conversation scope too', async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, ctxOf } = rig(p, { appSettings: () => ({ spendWarnPercent: 50 }) as never })
    const run = await m.start({ project: p, prompt: 'go', userChoice: { maxBudgetUsd: 4 } })
    const ctx = ctxOf(run.id)
    ctx.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 2 })
    ctx.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 2.5 })
    const w = events.filter((e): e is Extract<RunEvent, { type: 'run.spendWarning' }> => e.type === 'run.spendWarning')
    expect(w.map((x) => x.warning.scope)).toEqual(['run'])
    expect(w[0].warning.limitUsd).toBe(4)
    await m.stopAll()

    const conv = rig(proj({ id: 'pc', maxBudgetUsd: 10 }), { appSettings: () => ({ spendWarnPercent: 50 }) as never })
    const cp = proj({ id: 'pc', maxBudgetUsd: 10 })
    const run2 = await conv.m.start({ project: cp, prompt: 'go', conversationBudgetUsd: 8 })
    conv.ctxOf(run2.id).emit({ type: 'run.cost', runId: run2.id, totalCostUsd: 4.5 })
    const cw = events.filter((e): e is Extract<RunEvent, { type: 'run.spendWarning' }> => e.type === 'run.spendWarning' && e.runId === run2.id)
    expect(cw.map((x) => x.warning.scope)).toEqual(['conversation'])
    expect(cw[0].warning.limitUsd).toBe(8)
    await conv.m.stopAll()
  })

  it('stays silent when the setting is off, null or out of range', async () => {
    for (const value of [undefined, null, 0, 20, 100]) {
      events = []
      const p = proj({ id: `p-${String(value)}`, maxDailyUsd: 10 })
      const { m, ctxOf } = rig(p, { appSettings: () => ({ spendWarnPercent: value }) as never })
      const run = await m.start({ project: p, prompt: 'go' })
      spendState.day = 9.9
      tick(ctxOf(run.id))
      expect(events.some((e) => e.type === 'run.spendWarning')).toBe(false)
      spendState.day = 0
      await m.stopAll()
    }
  })

  it('a second run warns again (once per run and scope)', async () => {
    const p = proj({ maxDailyUsd: 10 })
    const { m, ctxOf } = rig(p, { appSettings: () => ({ spendWarnPercent: 80 }) as never })
    spendState.day = 9
    const a = await m.start({ project: p, prompt: 'one' })
    tick(ctxOf(a.id))
    const b = await m.start({ project: p, prompt: 'two' })
    tick(ctxOf(b.id))
    const runs = events.filter((e) => e.type === 'run.spendWarning').map((e) => e.runId)
    expect(runs.sort()).toEqual([a.id, b.id].sort())
    await m.stopAll()
  })
})

describe("the run's own cap (StartRunInput.maxBudgetUsd)", () => {
  it('narrows the project cap, is recorded and reaches the adapter', async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { maxBudgetUsd: 3 } })
    expect(m.summary(run.id)?.runBudgetUsd).toBe(3)
    expect(ctxOf(run.id).project.maxBudgetUsd).toBe(3)
    await m.stopAll()
  })

  it('never widens it: above the project cap the project cap stays, and with no project cap the choice is the cap', async () => {
    const capped = proj({ maxBudgetUsd: 2 })
    const a = rig(capped)
    const wide = await a.m.start({ project: capped, prompt: 'go', userChoice: { maxBudgetUsd: 50 } })
    expect(a.m.summary(wide.id)?.runBudgetUsd).toBe(2)
    expect(a.ctxOf(wide.id).project.maxBudgetUsd).toBe(2)
    await a.m.stopAll()
    const free = proj({ id: 'free' })
    const b = rig(free)
    const own = await b.m.start({ project: free, prompt: 'go', userChoice: { maxBudgetUsd: 7 } })
    expect(b.ctxOf(own.id).project.maxBudgetUsd).toBe(7)
    await b.m.stopAll()
  })

  it.each([0, -1, NaN, Infinity, '5', null, 2_000_000])('refuses %s before a run exists', async (bad) => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, store, ctxs } = rig(p)
    await expect(m.start({ project: p, prompt: 'go', userChoice: { maxBudgetUsd: bad as number } })).rejects.toThrow('Choose a spending limit above $0.')
    expect(store.list(p.id)).toEqual([])
    expect(ctxs).toHaveLength(0)
  })

  it('refuses it on a headless exec run and on setup runs', async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m } = rig(p)
    await expect(m.start({ project: p, prompt: 'go', overrides: { execMode: true }, userChoice: { maxBudgetUsd: 3 } })).rejects.toThrow('headless run keeps')
    await expect(m.start({ project: p, prompt: 'go', kind: 'setup', userChoice: { maxBudgetUsd: 3 } })).rejects.toThrow('applies to work runs')
  })

  it('ends the run itself at the cap (main enforces it even when the provider does not) and holds on the budget', async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { maxBudgetUsd: 3 } })
    ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: 3.2 })
    await reach(m, run.id, 'finished')
    const s = m.summary(run.id)!
    expect(s.endedBy).toBe('budget')
    expect(s.hold).toMatchObject({ kind: 'budget', budget: { scope: 'run', limitUsd: 3 }, actions: ['addBudget', 'switchModel'] })
    expect(s.hold?.budget?.spentUsd).toBeGreaterThanOrEqual(3)
  })

  it('a continuation carries the cap, narrowed again by the project cap as it is now', async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { maxBudgetUsd: 6 } })
    await m.stop(run.id)
    await reach(m, run.id, 'finished')
    const lowered = { ...p, maxBudgetUsd: 4 }
    const next = await m.continueRun(lowered, run.id, 'more')
    expect(m.summary(next.id)?.runBudgetUsd).toBe(4)
    expect(ctxOf(next.id).project.maxBudgetUsd).toBe(4)
    await m.stopAll()
  })
})

describe('budget holds', () => {
  it("the provider's budget error on a desktop run ends it and holds on its cap", async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    ctx.emit({ type: 'run.cost', runId: run.id, totalCostUsd: 5.01 })
    ctx.onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    ctx.emit({ type: 'run.status', runId: run.id, status: 'idle' })
    await reach(m, run.id, 'finished')
    expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { scope: 'run', limitUsd: 5 } } })
    expect(holdEvents(run.id).map((h) => (h.hold as { kind: string } | null)?.kind)).toContain('budget')
  })

  it('a conversation budget (model handoff) holds on the conversation', async () => {
    // as continueRun hands it over: the project cap is what is left of the conversation cap
    const p = proj({ maxBudgetUsd: 4 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', conversationBudgetUsd: 4 })
    ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: 4 })
    await reach(m, run.id, 'finished')
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'budget', budget: { scope: 'conversation', limitUsd: 4 } })
  })

  it('a headless exec run keeps its own end and gets no hold', async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', overrides: { execMode: true, maxBudgetUsd: 1 } })
    ctxOf(run.id).onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    await vi.waitFor(() => expect(m.summary(run.id)?.status).toBe('finished'))
    expect(m.summary(run.id)?.execOutcome).toBe('budget-exceeded')
    expect(m.summary(run.id)?.hold).toBeUndefined()
  })

  it('actions drop addBudget once a daily cap is reached', async () => {
    const p = proj({ maxBudgetUsd: 5, maxDailyUsd: 50 })
    const { m, ctxOf } = rig(p, { resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go' })
    ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: 5 })
    ctxOf(run.id).onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    await reach(m, run.id, 'finished')
    expect(m.holdOf(run.id)?.actions).toEqual(['addBudget', 'switchModel'])
    spendState.day = 50
    expect(m.holdOf(run.id)?.actions).toEqual(['switchModel'])
  })
})

/** A run that ended on its own cap, ready for addBudget. */
async function budgetHeld(p: Project, over: { conversationBudgetUsd?: number; options?: RunManagerOptions } = {}) {
  const r = rig(p, { resolveProject: () => p, ...over.options })
  const run = await r.m.start({ project: p, prompt: 'go', ...(over.conversationBudgetUsd !== undefined ? { conversationBudgetUsd: over.conversationBudgetUsd } : {}) })
  const cap = over.conversationBudgetUsd ?? p.maxBudgetUsd ?? 1
  r.ctxOf(run.id).emit({ type: 'run.cost', runId: run.id, totalCostUsd: cap })
  r.ctxOf(run.id).onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
  await reach(r.m, run.id, 'finished')
  return { ...r, run }
}

describe('addBudget', () => {
  it('continues the run with the amount as its own cap, logs it, and ends the hold', async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, ctxOf, run } = await budgetHeld(p)
    const next = await m.addBudget({ runId: run.id, addUsd: 2 })
    expect(next.resumedFrom).toBe(run.id)
    expect(m.summary(next.id)?.runBudgetUsd).toBe(2)
    expect(ctxOf(next.id).project.maxBudgetUsd).toBe(2)
    expect(ctxOf(next.id).prompt).toBe(RESUME_TEXT.trim())
    expect(logs(next.id)).toContain("You added $2.00 to this run's budget.")
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(holdEvents(run.id).at(-1)?.hold).toBeNull()
    await m.stopAll()
  })

  it("carries the user's text as the continuation's message", async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, ctxOf, run } = await budgetHeld(p)
    const next = await m.addBudget({ runId: run.id, addUsd: 1, text: 'Finish the tests' })
    expect(ctxOf(next.id).prompt).toBe('Finish the tests')
    await m.stopAll()
  })

  it("refuses above the project's per-run cap and starts nothing", async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, store, run } = await budgetHeld(p)
    const before = store.list(p.id).length
    await expect(m.addBudget({ runId: run.id, addUsd: 6 })).rejects.toThrow("Raise the project's limit in Settings to go higher")
    expect(store.list(p.id)).toHaveLength(before)
    expect(m.summary(run.id)?.hold?.kind).toBe('budget')
  })

  it('refuses above what is left of the daily cap and of the monthly cap', async () => {
    const p = proj({ maxBudgetUsd: 50, maxDailyUsd: 10, maxMonthlyUsd: 100 })
    const { m, run } = await budgetHeld(p)
    spendState.day = 8
    await expect(m.addBudget({ runId: run.id, addUsd: 3 })).rejects.toThrow("Only $2.00 is left of this project's daily spending limit")
    spendState.day = 1
    spendState.month = 98
    await expect(m.addBudget({ runId: run.id, addUsd: 3 })).rejects.toThrow('monthly')
    spendState.month = 0
    const next = await m.addBudget({ runId: run.id, addUsd: 3 })
    expect(next.resumedFrom).toBe(run.id)
    await m.stopAll()
  })

  it('refuses when a cap is already reached', async () => {
    const p = proj({ maxBudgetUsd: 50, maxDailyUsd: 10 })
    const { m, run } = await budgetHeld(p)
    spendState.day = 10
    await expect(m.addBudget({ runId: run.id, addUsd: 1 })).rejects.toThrow('reached its daily spending limit')
  })

  it.each([0, -3, NaN, Infinity, 'x', undefined, 1001])('refuses the amount %s', async (bad) => {
    const p = proj({ maxBudgetUsd: 5000 })
    const { m, run } = await budgetHeld(p)
    await expect(m.addBudget({ runId: run.id, addUsd: bad as number })).rejects.toThrow(/Choose an amount above \$0|at most/)
  })

  it('refuses a run that is not held on its budget, a live run and an unknown run', async () => {
    const p = proj({ maxBudgetUsd: 5 })
    const { m, store, ctxOf } = rig(p)
    store.upsert(runSummary({ id: 'plain', projectId: p.id, status: 'finished', sessionId: 's-plain' }))
    await expect(m.addBudget({ runId: 'plain', addUsd: 1 })).rejects.toThrow('did not stop on its spending limit')
    store.upsert(runSummary({ id: 'wrong-hold', projectId: p.id, status: 'error', sessionId: 's-w', hold: { kind: 'provider', since: 1, reason: 'x', actions: ['retry'] } }))
    await expect(m.addBudget({ runId: 'wrong-hold', addUsd: 1 })).rejects.toThrow('did not stop on its spending limit')
    await expect(m.addBudget({ runId: 'ghost', addUsd: 1 })).rejects.toThrow('Run not found')
    const live = await m.start({ project: p, prompt: 'go' })
    await expect(m.addBudget({ runId: live.id, addUsd: 1 })).rejects.toThrow('still working')
    await m.stopAll()
  })

  it("raises a conversation budget for the chain by the amount, still inside the project's cap", async () => {
    const p = proj({ maxBudgetUsd: 10 })
    const { m, ctxOf, run } = await budgetHeld(p, { conversationBudgetUsd: 4 })
    const next = await m.addBudget({ runId: run.id, addUsd: 3 })
    expect(m.summary(next.id)?.conversationBudgetUsd).toBe(7)
    expect(ctxOf(next.id).project.maxBudgetUsd).toBe(3)
    await m.stopAll()
  })

  it('refuses a conversation raise the project cap leaves nothing for', async () => {
    const p = proj({ maxBudgetUsd: 4 })
    const { m, store, run } = await budgetHeld(p, { conversationBudgetUsd: 4 })
    const before = store.list(p.id).length
    await expect(m.addBudget({ runId: run.id, addUsd: 2 })).rejects.toThrow("Raise the project's limit in Settings to go higher")
    expect(store.list(p.id)).toHaveLength(before)
  })
})

describe('retryRun', () => {
  it('continues an ended run with the resume text, or with the text given', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p, { resolveProject: () => p })
    const first = await m.start({ project: p, prompt: 'go' })
    ctxOf(first.id).emit({ type: 'run.status', runId: first.id, status: 'error', error: 'boom' })
    await reach(m, first.id, 'error')
    const retry = await m.retryRun({ runId: first.id })
    expect(ctxOf(retry.id).prompt).toBe(RESUME_TEXT.trim())
    expect(retry.resumedFrom).toBe(first.id)
    await m.stop(retry.id)
    await reach(m, retry.id, 'finished')
    const again = await m.retryRun({ runId: retry.id, text: 'Try the other approach' })
    expect(ctxOf(again.id).prompt).toBe('Try the other approach')
    await m.stopAll()
  })

  it('refuses a live run, an unknown run, and a cap reached', async () => {
    const p = proj({ maxDailyUsd: 5 })
    const { m, store } = rig(p, { resolveProject: () => p })
    const live = await m.start({ project: p, prompt: 'go' })
    await expect(m.retryRun({ runId: live.id })).rejects.toThrow('still active')
    await expect(m.retryRun({ runId: 'nope' })).rejects.toThrow('Run not found')
    store.upsert(runSummary({ id: 'ended', projectId: p.id, status: 'error', sessionId: 's-e' }))
    spendState.day = 5
    await expect(m.retryRun({ runId: 'ended' })).rejects.toThrow('daily spending limit')
    await m.stopAll()
  })
})

describe('roles left out of a run (StartRunInput.excludeRoleIds)', () => {
  /** Lead -> engineer -> tester, reviewer. The lead must get a report from the reviewer. */
  const team = (): Project =>
    proj({
      roles: [
        role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev'], requiredReports: ['r-rev'] }),
        role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', canSpawn: true, spawnable: ['r-test'], reportsTo: 'r-lead' }),
        role({ id: 'r-test', slug: 'tester', name: 'Tester', reportsTo: 'r-eng' }),
        role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', reportsTo: 'r-lead' })
      ]
    })

  it('removes the role and everyone below it from the run and from the spawn lists, and records the choice', async () => {
    const p = team()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: ['r-eng'] } })
    const ctx = ctxOf(run.id)
    expect(ctx.roles.map((r) => r.id)).toEqual(['r-lead', 'r-rev'])
    expect(ctx.roles[0].spawnable).toEqual(['r-rev'])
    expect(ctx.project.roles.map((r) => r.id)).toEqual(['r-lead', 'r-rev'])
    expect(m.summary(run.id)?.excludedRoleIds).toEqual(['r-eng'])
    // the stored project is untouched
    expect(p.roles).toHaveLength(4)
    await m.stopAll()
  })

  it('shows an obligation that pointed at a left-out role as a delegation preflight warning', async () => {
    const p = team()
    const { m } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: ['r-rev'] } })
    expect(logs(run.id, 'warn')).toContain('Required delegation: Lead must delegate to Reviewer, which is left out of this run, so that report will not be made.')
    await m.stopAll()
  })

  it('refuses the root, an unknown id and the single assistant before a run exists', async () => {
    const p = team()
    const { m, store, ctxs } = rig(p)
    await expect(m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: ['r-lead'] } })).rejects.toThrow('cannot be left out')
    await expect(m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: ['nope'] } })).rejects.toThrow('not on this team any more')
    await expect(m.start({ project: p, prompt: 'go', team: 'single', userChoice: { excludeRoleIds: ['r-eng'] } })).rejects.toThrow('single assistant')
    await expect(m.start({ project: p, prompt: 'go', kind: 'setup', userChoice: { excludeRoleIds: ['r-eng'] } })).rejects.toThrow('work run on a project')
    await expect(m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: 'r-eng' as unknown as string[] } })).rejects.toThrow('Choose which roles')
    expect(store.list(p.id)).toEqual([])
    expect(ctxs).toHaveLength(0)
  })

  it('an empty list changes nothing', async () => {
    const p = team()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: [] } })
    expect(ctxOf(run.id).roles).toHaveLength(4)
    expect(m.summary(run.id)?.excludedRoleIds).toBeUndefined()
    await m.stopAll()
  })

  it('continuations carry the choice (and drop ids that are gone)', async () => {
    const p = team()
    const { m, ctxOf } = rig(p, { resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go', userChoice: { excludeRoleIds: ['r-eng'] } })
    await m.stop(run.id)
    await reach(m, run.id, 'finished')
    const next = await m.continueRun(p, run.id, 'more')
    expect(ctxOf(next.id).roles.map((r) => r.id)).toEqual(['r-lead', 'r-rev'])
    expect(m.summary(next.id)?.excludedRoleIds).toEqual(['r-eng'])
    await m.stop(next.id)
    await reach(m, next.id, 'finished')
    const without = { ...p, roles: p.roles.filter((r) => r.id !== 'r-eng' && r.id !== 'r-test') }
    const last = await m.continueRun(without, next.id, 'again')
    expect(m.summary(last.id)?.excludedRoleIds).toBeUndefined()
    await m.stopAll()
  })
})

describe('holds follow the run', () => {
  const blocked = (over: Partial<RunPlan> = {}): RunPlan => ({
    goal: 'g',
    steps: [{ id: 'p1', title: 'Build', status: 'blocked', owner: 'engineer' }],
    status: 'blocked',
    blockedReason: 'Which database?',
    autoContinues: 0,
    updatedAt: 1,
    ...over
  })

  it('a blocked plan holds the live run, and sending a message lifts it', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    ctx.emit({ type: 'run.status', runId: run.id, status: 'idle' })
    await ctx.updatePlan(blocked())
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'plan-blocked', plan: { blockedReason: 'Which database?', blockedStepIds: ['p1'] }, actions: ['end'] })
    expect(holdEvents(run.id).at(-1)?.hold).toMatchObject({ kind: 'plan-blocked' })
    await m.send(run.id, 'Use Postgres')
    expect(m.summary(run.id)?.hold).toBeUndefined()
    expect(holdEvents(run.id).at(-1)?.hold).toBeNull()
    await m.stopAll()
  })

  it('names the failed agent the plan is blocked on, and the plan going active again lifts the hold', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    tick(ctx, { id: 'a1', state: 'error', name: 'Engineer', costUsd: 0.4 })
    ctx.emit({ type: 'run.status', runId: run.id, status: 'idle' })
    await ctx.updatePlan(blocked())
    expect(m.summary(run.id)?.hold).toMatchObject({ kind: 'agent-failed', failed: { agentId: 'a1', name: 'Engineer' } })
    await ctx.updatePlan(blocked({ status: 'active', steps: [{ id: 'p1', title: 'Build', status: 'in_progress' }] }))
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })

  it("ending a blocked run as the user clears its hold; a blocked run that ends on its own keeps it with retry", async () => {
    const p = proj()
    const a = rig(p)
    const r1 = await a.m.start({ project: p, prompt: 'go' })
    await a.ctxOf(r1.id).updatePlan(blocked())
    await a.m.stop(r1.id)
    await reach(a.m, r1.id, 'finished')
    expect(a.m.summary(r1.id)?.hold).toBeUndefined()

    const r2 = await a.m.start({ project: p, prompt: 'go again' })
    await a.ctxOf(r2.id).updatePlan(blocked())
    a.ctxOf(r2.id).emit({ type: 'run.status', runId: r2.id, status: 'finished' })
    expect(a.m.summary(r2.id)?.hold).toMatchObject({ kind: 'plan-blocked', actions: ['retry', 'switchModel'] })
    expect(a.m.holdOf(r2.id)?.actions).toEqual(['retry', 'switchModel'])
  })

  it('a provider error ends in a provider hold written by OrgAI, never the provider text', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    ctxOf(run.id).emit({ type: 'run.status', runId: run.id, status: 'error', error: '529 overloaded sk-ant-SECRET-1234' })
    const hold = m.summary(run.id)!.hold!
    expect(hold).toMatchObject({ kind: 'provider', actions: ['retry', 'switchModel'], provider: { connection: expect.any(String) } })
    expect(JSON.stringify(hold)).not.toContain('SECRET')
    expect(JSON.stringify(hold)).not.toContain('overloaded')
    expect(holdEvents(run.id).at(-1)?.hold).toMatchObject({ kind: 'provider' })
  })

  it('an authentication failure says to sign in again', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    ctxOf(run.id).onRootTurnEnded?.({ turnGen: 1, ok: false, errorSubtype: 'error_during_execution', isAuthError: true })
    ctxOf(run.id).emit({ type: 'run.status', runId: run.id, status: 'error', error: '401' })
    expect(m.summary(run.id)?.hold?.reason).toContain('Sign in again')
  })

  it('a session that could not open is a provider failure; a local failure before it is not', async () => {
    const p = proj()
    const failing = rig(p, {}, { startError: 'no binary' })
    const run = await failing.m.start({ project: p, prompt: 'go' })
    expect(failing.m.summary(run.id)).toMatchObject({ status: 'error', hold: { kind: 'provider' } })
    // a folder that is gone is not the provider's fault
    const local = rig(p)
    const run2 = await local.m.start({ project: p, prompt: 'go' })
    await local.m.stop(run2.id)
    expect(local.m.summary(run2.id)?.hold).toBeUndefined()
  })

  it('a usage-limit pause keeps its behaviour and carries a usage-limit hold', async () => {
    const p = proj()
    const { m, ctxOf, sessions } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    ctx.rateLimited?.({ until: Date.now() + 60_000, window: 'five_hour' })
    ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'paused', autoResume: true })
    expect(s.hold).toMatchObject({ kind: 'usage-limit', actions: ['resume', 'switchModel'] })
    expect(m.hasAutoResume(run.id)).toBe(true)
    await m.stopAll()
  })

  it('a continuation ends the hold of the run it continues, on its stored copy too', async () => {
    const p = proj()
    const { m, ctxOf, store } = rig(p, { resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go' })
    ctxOf(run.id).emit({ type: 'run.status', runId: run.id, status: 'error', error: 'x' })
    await reach(m, run.id, 'error')
    expect(store.get(run.id)?.hold?.kind).toBe('provider')
    const next = await m.retryRun({ runId: run.id })
    expect(store.get(run.id)?.hold).toBeUndefined()
    expect(next.hold).toBeUndefined()
    await m.stopAll()
  })

  it('an adapter cannot set or clear a hold or send a spending warning', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const before = events.length
    ctxOf(run.id).emit({ type: 'run.hold', runId: run.id, hold: { kind: 'budget', since: 1, reason: 'forged', actions: ['addBudget'] } })
    ctxOf(run.id).emit({ type: 'run.spendWarning', runId: run.id, warning: { scope: 'day', limitUsd: 1, spentUsd: 1, percent: 99, at: 1 } })
    expect(events.slice(before)).toEqual([])
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })
})

describe('decision cards', () => {
  it('a permission card carries when it was raised; an adapter-sent priorAllows and requestedAt never stand', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const t0 = Date.now()
    void ctxOf(run.id).requestPermission({ agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, priorAllows: 41, requestedAt: 1 } as never)
    const req = events.find((e): e is Extract<RunEvent, { type: 'permission.request' }> => e.type === 'permission.request')!
    expect(req.request.requestedAt).toBeGreaterThanOrEqual(t0)
    expect(req.request.requestedAt).toBeLessThanOrEqual(Date.now())
    expect('priorAllows' in req.request).toBe(false)
    await m.stopAll()
  })

  it('a merge card says what main knows: the review comes from the ledger, never from what the adapter sent', async () => {
    const p = proj({
      roles: [
        role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng'] }),
        role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', canSpawn: true, spawnable: ['r-rev'], requiredReports: ['r-rev'], reportsTo: 'r-lead' }),
        role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', reportsTo: 'r-eng' })
      ]
    })
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    const gate = ctx.delegation!
    gate.noteSpawn('eng-1', 'root', 'r-eng')
    const ask = (checks?: unknown): void => {
      void ctx.requestMergeReview({ agentId: 'eng-1', agentName: 'Engineer', branch: 'b', path: '/x', changedFiles: [], stat: '', patch: '', ...(checks ? { checks } : {}) } as never)
    }
    const lastReview = (): Extract<RunEvent, { type: 'merge.request' }>['review'] => (events.filter((e) => e.type === 'merge.request').at(-1) as Extract<RunEvent, { type: 'merge.request' }>).review

    // no review yet; the adapter's own claim of one is ignored
    ask({ tests: 'passed', review: 'reported' })
    expect(lastReview().checks).toEqual({ tests: 'passed', review: 'none' })

    // the reviewer reports to the engineer and the receipt is delivered
    gate.noteSpawn('rev-1', 'eng-1', 'r-rev')
    gate.completion('rev-1', { canCorrect: true, canWait: false, reportText: 'Looks good: one nit.' })
    gate.delivered('rev-1')
    ask({ tests: 'failed', testDetail: 'npm test: 2 failed' })
    expect(lastReview().checks).toEqual({ tests: 'failed', testDetail: 'npm test: 2 failed', review: 'reported' })

    // anything else about the tests reads unknown
    ask({ tests: 'maybe' })
    expect(lastReview().checks).toMatchObject({ tests: 'unknown', review: 'reported' })
    ask()
    expect(lastReview().checks).toEqual({ tests: 'unknown', review: 'reported' })
    await m.stopAll()
  })

  it('the review is unknown on a run with no ledger (the single assistant)', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go', team: 'single' })
    void ctxOf(run.id).requestMergeReview({ agentId: 'x', agentName: 'X', branch: 'b', path: '/x', changedFiles: [], stat: '', patch: '' })
    const review = (events.find((e) => e.type === 'merge.request') as Extract<RunEvent, { type: 'merge.request' }>).review
    expect(review.checks).toEqual({ tests: 'unknown', review: 'unknown' })
    await m.stopAll()
  })
})

describe('skipReview, messageAgent and stopAgent', () => {
  it('skipReview sends the fixed sentence and the note through send(), logs the choice and changes no gate', async () => {
    const p = proj()
    const { m, ctxOf, sessions } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxOf(run.id)
    void ctx.requestMergeReview({ agentId: 'x', agentName: 'X', branch: 'b', path: '/x', changedFiles: [], stat: '', patch: '' })
    const ledger = JSON.stringify((m as unknown as { runs: Map<string, { ledger: { snapshot(): unknown } }> }).runs.get(run.id)!.ledger.snapshot())
    await m.skipReview({ runId: run.id, note: 'Tests cover it.' })
    expect(sessions.get(run.id)!.send).toHaveBeenCalledWith(`${SKIP_REVIEW_TEXT}\n\nNote from the user: Tests cover it.`, undefined)
    await m.skipReview({ runId: run.id })
    expect(sessions.get(run.id)!.send).toHaveBeenLastCalledWith(SKIP_REVIEW_TEXT, undefined)
    expect(logs(run.id, 'info').filter((l) => l === 'You chose to skip review.')).toHaveLength(2)
    // the ledger is untouched and the merge card still asks
    expect(JSON.stringify((m as unknown as { runs: Map<string, { ledger: { snapshot(): unknown } }> }).runs.get(run.id)!.ledger.snapshot())).toBe(ledger)
    expect(m.pendingCards(run.id).mergeReviews).toHaveLength(1)
    await m.stopAll()
  })

  it('skipReview refuses an ended run, an unknown run, and a run that cannot take the message', async () => {
    const p = proj()
    const { m, store, sessions } = rig(p)
    store.upsert(runSummary({ id: 'done', projectId: p.id, status: 'finished' }))
    await expect(m.skipReview({ runId: 'done' })).rejects.toThrow('no review to skip')
    await expect(m.skipReview({ runId: 'ghost' })).rejects.toThrow('no review to skip')
    const run = await m.start({ project: p, prompt: 'go' })
    sessions.get(run.id)!.send.mockRejectedValueOnce(new Error('session closed'))
    await expect(m.skipReview({ runId: run.id })).rejects.toThrow('session closed')
    expect(logs(run.id).includes('You chose to skip review.')).toBe(false)
    await m.stopAll()
  })

  it('messageAgent addresses the agent through the orchestrator by name and handle', async () => {
    const p = proj()
    const { m, ctxOf, sessions } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    tick(ctxOf(run.id), { id: 'a1', name: 'Engineer', handle: 'engineer-2' })
    tick(ctxOf(run.id), { id: 'a2', name: 'Tester' })
    await m.messageAgent({ runId: run.id, agentId: 'a1', text: 'Use the v2 API' })
    expect(sessions.get(run.id)!.send).toHaveBeenLastCalledWith('Message from the user for Engineer (engineer-2): Use the v2 API', undefined)
    await m.messageAgent({ runId: run.id, agentId: 'a2', text: 'Hello' })
    expect(sessions.get(run.id)!.send).toHaveBeenLastCalledWith('Message from the user for Tester (a2): Hello', undefined)
    await m.messageAgent({ runId: run.id, agentId: 'root', text: 'Plain to the root' })
    expect(sessions.get(run.id)!.send).toHaveBeenLastCalledWith('Plain to the root', undefined)
    await m.stopAll()
  })

  it('messageAgent refuses an unknown agent, an empty or too long text, and a run that is not working', async () => {
    const p = proj()
    const { m, store } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    await expect(m.messageAgent({ runId: run.id, agentId: 'nobody', text: 'hi' })).rejects.toThrow('not in this run')
    await expect(m.messageAgent({ runId: run.id, agentId: 'root', text: '   ' })).rejects.toThrow('Nothing to send')
    await expect(m.messageAgent({ runId: run.id, agentId: 'root', text: 'x'.repeat(8001) })).rejects.toThrow('too long')
    store.upsert(runSummary({ id: 'done', projectId: p.id, status: 'finished' }))
    await expect(m.messageAgent({ runId: 'done', agentId: 'a1', text: 'hi' })).rejects.toThrow('not working')
    await m.stopAll()
  })

  it('stopAgent: unknown run and agent, the root, and a session without it are answered, not thrown', async () => {
    const p = proj()
    const { m, ctxOf } = rig(p)
    const run = await m.start({ project: p, prompt: 'go' })
    tick(ctxOf(run.id), { id: 'a1' })
    expect(await m.stopAgent({ runId: 'ghost', agentId: 'a1' })).toEqual({ stopped: false, reason: 'That run is not working.' })
    expect(await m.stopAgent({ runId: run.id, agentId: 'zzz' })).toEqual({ stopped: false, reason: 'That agent is not in this run.' })
    tick(ctxOf(run.id))
    expect(await m.stopAgent({ runId: run.id, agentId: 'root' })).toMatchObject({ stopped: false, reason: expect.stringContaining('End the session') })
    expect(await m.stopAgent({ runId: run.id, agentId: 'a1' })).toEqual({ stopped: false, reason: 'This provider cannot stop one agent; interrupt the run instead.' })
    await m.stopAll()
  })

  it('stopAgent calls the adapter and reports what it said, a throw included', async () => {
    const p = proj()
    const calls: string[] = []
    const answers = [true, false, 'throw'] as const
    let i = 0
    const { m, ctxOf } = rig(p, {}, {
      stopAgent: async (id) => {
        calls.push(id)
        const a = answers[i++]
        if (a === 'throw') throw new Error('provider says no')
        return a
      }
    })
    const run = await m.start({ project: p, prompt: 'go' })
    tick(ctxOf(run.id), { id: 'a1' })
    expect(await m.stopAgent({ runId: run.id, agentId: 'a1' })).toEqual({ stopped: true })
    expect(await m.stopAgent({ runId: run.id, agentId: 'a1' })).toMatchObject({ stopped: false, reason: expect.stringContaining('already finished') })
    expect(await m.stopAgent({ runId: run.id, agentId: 'a1' })).toEqual({ stopped: false, reason: 'The provider could not stop that agent.' })
    expect(calls).toEqual(['a1', 'a1', 'a1'])
    await m.stopAll()
  })
})
