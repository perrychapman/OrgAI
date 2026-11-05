import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, RunEvent, RunOverrides, RunPlan, RunSummary } from '@shared/types'
import { DEFAULT_EXEC_STALL_TIMEOUT_MS, EXEC_FINALIZE_STOP_TIMEOUT_MS } from '@shared/types'
import { RunManager, continuedOverrides, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { CompletionInput, RootTurnEnd, RuntimeAdapter, RuntimeContext, SessionSettlement } from './types'
import { project as makeProject, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-exec-')))
  events = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** A scriptable session: the test drives turn ends, settlement and the end of the session. */
interface Fake {
  ctx: RuntimeContext
  settle: SessionSettlement
  /** stop() makes the session end (finished resolves) unless false. */
  stopEnds: boolean
  stopCalls: number
  /** The status stop() reports before finished resolves. */
  stopStatus: 'finished' | 'error'
  end: () => void
  turnGen: number
}

function rig(options: RunManagerOptions & { title?: (input: CompletionInput) => Promise<string>; startDelay?: Promise<void> } = {}) {
  const fakes: Fake[] = []
  const start = vi.fn(async (ctx: RuntimeContext) => {
    if (options.startDelay) await options.startDelay
    let end!: () => void
    const finished = new Promise<void>((resolve) => (end = resolve))
    const fake: Fake = {
      ctx,
      settle: { rootTurnGen: 0, rootIdle: false, continuationSettled: false, nudgeTurn1Sent: false, quiescent: true },
      stopEnds: true,
      stopCalls: 0,
      stopStatus: 'finished',
      end,
      turnGen: 0
    }
    fakes.push(fake)
    ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${fakes.length}` })
    return {
      send: async () => {},
      interrupt: async () => {},
      stop: async () => {
        fake.stopCalls++
        if (!fake.stopEnds) return
        ctx.emit({ type: 'run.status', runId: ctx.run.id, status: fake.stopStatus, ...(fake.stopStatus === 'error' ? { error: 'aborted' } : {}) })
        end()
      },
      finished,
      settlement: () => ({ ...fake.settle })
    }
  })
  const adapter: RuntimeAdapter = { id: 'mock', complete: options.title ?? (async () => ''), start }
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, fakes, store, start }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}
const proj = (over: Parameters<typeof makeProject>[0] = {}) => makeProject({ id: 'p1', path: folder(), runMessaging: true, ...over })

/** A root turn ends: the hook first, then the adapter's idle (cli-spec 6.2(2)). */
function endTurn(f: Fake, over: Partial<RootTurnEnd> = {}, settle: Partial<SessionSettlement> = {}): void {
  f.turnGen++
  f.settle = { ...f.settle, rootTurnGen: f.turnGen, rootIdle: true, continuationSettled: true, ...settle }
  f.ctx.onRootTurnEnded?.({ turnGen: f.turnGen, ok: true, ...over })
  f.ctx.emit({ type: 'run.status', runId: f.ctx.run.id, status: 'idle' })
}

const finalized = () => events.filter((e): e is Extract<RunEvent, { type: 'run.finalized' }> => e.type === 'run.finalized')
const exec = (over: RunOverrides = {}): RunOverrides => ({ execMode: true, ...over })
const flush = async (ms = 200): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const agent = (over: Partial<AgentInstance> & { id: string }): AgentInstance => ({
  roleId: null,
  roleSlug: 'engineer',
  name: 'Engineer',
  parentId: 'root',
  spawnToolUseId: null,
  state: 'thinking',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 0,
  ...over
})

describe('exec settlement', () => {
  it('a single-agent run settles completed-unplanned after turn 1', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', team: 'single', overrides: exec() })
    expect(run.overrides?.execChainId).toBe(run.id)
    endTurn(fakes[0])
    await flush()
    expect(finalized()).toHaveLength(1)
    expect(finalized()[0]).toMatchObject({ runId: run.id, execChainId: run.id, outcome: 'completed-unplanned' })
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'finished', execOutcome: 'completed-unplanned' })
    expect(s.endedBy).toBeUndefined()
    expect(fakes[0].stopCalls).toBe(1)
  })

  it('autoContinue false settles after turn 1', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ autoContinue: false }) })
    expect(fakes[0].ctx.autoContinue).toBe(false)
    endTurn(fakes[0])
    await flush()
    expect(m.summary(run.id)?.execOutcome).toBe('completed-unplanned')
  })

  it('a team run without a plan waits for the turn-1 nudge', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    endTurn(fakes[0])
    await flush(3000)
    expect(finalized()).toHaveLength(0)
    // The nudge went out and its follow-up turn finished with no plan.
    endTurn(fakes[0], {}, { nudgeTurn1Sent: true })
    await flush()
    expect(m.summary(run.id)?.execOutcome).toBe('completed-unplanned')
  })

  it('a pending continuation never settles until it flips', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ autoContinue: false }) })
    endTurn(fakes[0], {}, { continuationSettled: false })
    await flush(5000)
    expect(finalized()).toHaveLength(0)
    fakes[0].settle.continuationSettled = true
    // No event: the poll picks it up.
    await flush(1500)
    expect(m.summary(run.id)?.execOutcome).toBe('completed-unplanned')
  })

  it('plan outcomes: done, blocked, active', async () => {
    const plan = (status: RunPlan['status']): RunPlan => ({ goal: 'g', steps: [], status, autoContinues: 0, updatedAt: 0 })
    for (const [status, outcome, endedBy] of [
      ['done', 'completed', undefined],
      ['blocked', 'blocked', 'policy'],
      ['active', 'incomplete-plan', 'policy']
    ] as const) {
      events = []
      const { m, fakes } = rig()
      const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
      await fakes[0].ctx.updatePlan?.(plan(status))
      endTurn(fakes[0])
      await flush()
      expect(m.summary(run.id)).toMatchObject({ execOutcome: outcome, status: 'finished' })
      expect(m.summary(run.id)?.endedBy).toBe(endedBy)
    }
  })

  it('a working report and limitHold block settlement', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ autoContinue: false }) })
    const f = fakes[0]
    f.ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent({ id: 'a1', state: 'tool' }) })
    f.ctx.rateLimited?.({ window: 'five_hour' })
    endTurn(f)
    await flush(3000)
    expect(finalized()).toHaveLength(0)
    f.ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent({ id: 'a1', state: 'done' }) })
    await flush(3000)
    // Still held by the usage limit.
    expect(finalized()).toHaveLength(0)
    await m.send(run.id, 'carry on')
    endTurn(f)
    await flush()
    expect(m.summary(run.id)?.execOutcome).toBe('completed-unplanned')
  })

  it('failed turns: failed, auth-error and error_max_budget_usd', async () => {
    for (const [over, outcome, status, endedBy] of [
      [{ ok: false, errorSubtype: 'error_max_turns' }, 'failed', 'error', undefined],
      [{ ok: false, isAuthError: true }, 'auth-error', 'error', undefined],
      [{ ok: false, errorSubtype: 'error_max_budget_usd' }, 'budget-exceeded', 'finished', 'budget']
    ] as const) {
      events = []
      const { m, fakes } = rig()
      const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
      endTurn(fakes[0], over)
      await flush()
      expect(m.summary(run.id)).toMatchObject({ execOutcome: outcome, status })
      expect(m.summary(run.id)?.endedBy).toBe(endedBy)
      expect(finalized()).toHaveLength(1)
    }
  })

  it('an adapter error status without finalization finalizes failed, or auth-error', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'error', error: 'boom' })
    await flush()
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'failed', status: 'error' })
    events = []
    const r2 = rig()
    const run2 = await r2.m.start({ project: proj(), prompt: 'go', overrides: exec() })
    r2.fakes[0].ctx.emit({ type: 'run.status', runId: run2.id, status: 'error', error: 'Invalid API key · Please run /login' })
    await flush()
    expect(r2.m.summary(run2.id)?.execOutcome).toBe('auth-error')
  })

  it('the stall watchdog ends a run that stays unsettled', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ autoContinue: false, execStallTimeoutMs: 10_000 }) })
    endTurn(fakes[0], {}, { quiescent: false })
    await flush(9_000)
    expect(finalized()).toHaveLength(0)
    await flush(2_000)
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'stalled', status: 'finished', endedBy: 'policy' })
  })

  it('the stall watchdog defaults to DEFAULT_EXEC_STALL_TIMEOUT_MS and waits while the root is busy', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    fakes[0].settle.rootIdle = false
    await flush(DEFAULT_EXEC_STALL_TIMEOUT_MS + 1000)
    expect(finalized()).toHaveLength(0)
    fakes[0].settle.rootIdle = true
    await flush(DEFAULT_EXEC_STALL_TIMEOUT_MS + 1000)
    expect(m.summary(run.id)?.execOutcome).toBe('stalled')
  })

  it('a non-exec run never settles or finalizes', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', team: 'single' })
    endTurn(fakes[0])
    await flush(DEFAULT_EXEC_STALL_TIMEOUT_MS + 1000)
    expect(finalized()).toHaveLength(0)
    expect(m.summary(run.id)?.status).toBe('idle')
    await m.stopAll()
  })
})

describe('exec rate limits', () => {
  it('a pause without waitForReset finalizes rate-limited with no resume timer, also with a past reset', async () => {
    for (const until of [Date.now() + 60_000, Date.now() - 1000]) {
      events = []
      const { m, fakes } = rig()
      const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
      fakes[0].ctx.rateLimited?.({ until, window: 'five_hour' })
      fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
      fakes[0].end()
      expect(m.hasAutoResume(run.id)).toBe(false)
      await flush()
      const s = m.summary(run.id)!
      expect(s).toMatchObject({ status: 'paused', execOutcome: 'rate-limited', autoResume: false })
      expect(s.endedBy).toBeUndefined()
      expect(m.hasAutoResume(run.id)).toBe(false)
      expect(finalized()).toHaveLength(1)
      await flush(120_000)
      expect(m.liveRunCount()).toBe(0)
    }
  })

  it('with waitForReset the timer is armed and the resume keeps the exec fields', async () => {
    const p = proj()
    const { m, fakes } = rig({ resolveProject: () => p })
    const policy = { permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold' } as const
    const run = await m.start({ project: p, prompt: 'go', overrides: exec({ waitForReset: true, decisionPolicy: policy }) })
    fakes[0].ctx.rateLimited?.({ until: Date.now() + 10_000 })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
    fakes[0].end()
    await flush()
    expect(m.hasAutoResume(run.id)).toBe(true)
    expect(finalized()).toHaveLength(0)
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    await flush(11_000)
    expect(fakes).toHaveLength(2)
    const next = fakes[1].ctx.run
    expect(next.resumedFrom).toBe(run.id)
    expect(next.overrides).toMatchObject({ execMode: true, execChainId: run.id, waitForReset: true, decisionPolicy: policy })
  })

  it("the automatic resume keeps a 'configure' caller's widening overrides; without the grant they stay clamped", async () => {
    for (const allowWidening of [true, false]) {
      const p = proj({ permissionMode: 'default' })
      const { m, fakes } = rig({ resolveProject: () => p })
      const run = await m.start({ project: p, prompt: 'go', overrides: exec({ waitForReset: true, permissionMode: 'bypassPermissions' }), ...(allowWidening ? { allowWidening } : {}) })
      expect(fakes[0].ctx.project.permissionMode).toBe(allowWidening ? 'bypassPermissions' : 'default')
      fakes[0].ctx.rateLimited?.({ until: Date.now() + 10_000 })
      fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
      fakes[0].end()
      await flush(11_200)
      expect(fakes).toHaveLength(2)
      expect(fakes[1].ctx.project.permissionMode, `allowWidening ${allowWidening}`).toBe(allowWidening ? 'bypassPermissions' : 'default')
    }
  })
})

describe('exec pauses: stop, cancel and manual resume (review fixes)', () => {
  /** Start an exec run and pause it on a usage limit; the session ends (teardown), so only its summary is left. */
  async function pausedRun(over: RunOverrides = {}, startOpts: { allowWidening?: boolean } = {}, projOver: Parameters<typeof proj>[0] = {}) {
    const p = proj(projOver)
    const r = rig({ resolveProject: () => p })
    const run = await r.m.start({ project: p, prompt: 'go', overrides: exec(over), ...startOpts })
    r.fakes[0].ctx.rateLimited?.({ until: Date.now() + 10_000 })
    r.fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
    r.fakes[0].end()
    await flush()
    return { ...r, p, run }
  }

  it('stopping a paused waitForReset run finalizes it interrupted and cancels the auto-resume', async () => {
    const { m, fakes, run } = await pausedRun({ waitForReset: true })
    expect(m.liveRunCount()).toBe(0)
    expect(m.hasAutoResume(run.id)).toBe(true)
    await m.stop(run.id)
    expect(m.hasAutoResume(run.id)).toBe(false)
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', execOutcome: 'interrupted', endedBy: 'user', autoResume: false })
    expect(finalized().map((e) => e.outcome)).toEqual(['interrupted'])
    expect(events.some((e) => e.type === 'run.status' && e.runId === run.id && e.status === 'finished' && e.endedBy === 'user')).toBe(true)
    await flush(20_000)
    expect(fakes).toHaveLength(1)
  })

  it('stopping a paused desktop run cancels its auto-resume and ends it as stopped by the user', async () => {
    const p = proj()
    const { m, fakes } = rig({ resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go' })
    fakes[0].ctx.rateLimited?.({ until: Date.now() + 10_000 })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'finished' })
    fakes[0].end()
    await flush()
    expect(m.hasAutoResume(run.id)).toBe(true)
    await m.stop(run.id)
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', endedBy: 'user', autoResume: false })
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    expect(finalized()).toHaveLength(0)
    await flush(20_000)
    expect(fakes).toHaveLength(1)
  })

  it('stopping a live paused waitForReset run (session still open) finishes it interrupted', async () => {
    const p = proj()
    const { m, fakes } = rig({ resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go', overrides: exec({ waitForReset: true }) })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'paused', pausedUntil: Date.now() + 10_000, autoResume: true })
    expect(m.hasAutoResume(run.id)).toBe(true)
    await m.stop(run.id)
    expect(m.hasAutoResume(run.id)).toBe(false)
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', execOutcome: 'interrupted', endedBy: 'user', autoResume: false })
    expect(finalized()).toHaveLength(1)
    await flush(20_000)
    expect(fakes).toHaveLength(1)
  })

  it('Cancel auto-resume on a waitForReset run finalizes it rate-limited', async () => {
    const { m, run } = await pausedRun({ waitForReset: true })
    m.cancelAutoResume(run.id)
    expect(m.summary(run.id)).toMatchObject({ status: 'paused', execOutcome: 'rate-limited', autoResume: false })
    expect(finalized().map((e) => e.outcome)).toEqual(['rate-limited'])
    m.cancelAutoResume(run.id)
    expect(finalized()).toHaveLength(1)
  })

  it('a waitForReset pause the adapter marks autoResume false finalizes rate-limited', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ waitForReset: true }) })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'paused', pausedUntil: Date.now() + 10_000, autoResume: false })
    await flush()
    expect(m.hasAutoResume(run.id)).toBe(false)
    expect(m.summary(run.id)).toMatchObject({ status: 'paused', execOutcome: 'rate-limited', autoResume: false })
    expect(finalized()).toHaveLength(1)
  })

  it('a failed automatic resume finalizes the waitForReset run rate-limited', async () => {
    const { m, run } = await pausedRun({ waitForReset: true })
    // The project is gone by the reset: resumeUnleased throws before continueRun.
    ;(m as unknown as { options: RunManagerOptions }).options.resolveProject = () => undefined
    await flush(11_000)
    expect(m.summary(run.id)).toMatchObject({ status: 'paused', execOutcome: 'rate-limited', autoResume: false })
    expect(finalized().map((e) => e.outcome)).toEqual(['rate-limited'])
  })

  it('a manual Resume now of a finalized rate-limited exec run continues as a desktop run', async () => {
    const { m, fakes, run } = await pausedRun({ decisionPolicy: { permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'fail', proposal: 'decline', merge: 'hold' } })
    expect(m.summary(run.id)?.execOutcome).toBe('rate-limited')
    await m.resumeNow(run.id)
    expect(fakes).toHaveLength(2)
    expect(fakes[1].ctx.run.overrides?.execMode).toBeUndefined()
    expect(fakes[1].ctx.run.overrides?.decisionPolicy).toBeUndefined()
    await m.stopAll()
  })

  it("a manual Resume now never re-applies a 'configure' caller's widening; only the timer does", async () => {
    const { m, fakes, run } = await pausedRun({ waitForReset: true, permissionMode: 'bypassPermissions' }, { allowWidening: true }, { permissionMode: 'default' })
    expect(fakes[0].ctx.project.permissionMode).toBe('bypassPermissions')
    await m.resumeNow(run.id)
    expect(fakes).toHaveLength(2)
    // Still the in-flight exec chain (its follower waits), but clamped to the project's mode.
    expect(fakes[1].ctx.run.overrides?.execMode).toBe(true)
    expect(fakes[1].ctx.project.permissionMode).toBe('default')
    await m.stopAll()
  })

  it('widening is not kept for a run without waitForReset, nor after Cancel auto-resume', async () => {
    const a = await pausedRun({ permissionMode: 'bypassPermissions' }, { allowWidening: true }, { permissionMode: 'default' })
    expect((a.m as unknown as { widenedRuns: Set<string> }).widenedRuns.size).toBe(0)
    const b = await pausedRun({ waitForReset: true, permissionMode: 'bypassPermissions' }, { allowWidening: true }, { permissionMode: 'default' })
    const widened = (b.m as unknown as { widenedRuns: Set<string> }).widenedRuns
    expect(widened.has(b.run.id)).toBe(true)
    b.m.cancelAutoResume(b.run.id)
    expect(widened.size).toBe(0)
  })

  it('resume --exec merges a partial decisionPolicy over the chain policy per field', () => {
    const prev: RunOverrides = { execMode: true, execChainId: 'c', decisionPolicy: { permission: 'wait', rules: 'deny', mcpInstall: 'deny', question: 'fail', proposal: 'decline', merge: 'hold', waitTimeoutMs: 3_600_000 } }
    const next = continuedOverrides(prev, { exec: true, overrides: { decisionPolicy: { question: 'conservative' } as RunOverrides['decisionPolicy'] } })
    expect(next?.decisionPolicy).toEqual({ permission: 'wait', rules: 'deny', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold', waitTimeoutMs: 3_600_000 })
    // Without a carried policy the missing choices take the defaults.
    const fresh = continuedOverrides(undefined, { overrides: { decisionPolicy: { question: 'conservative' } as RunOverrides['decisionPolicy'] } })
    expect(fresh?.decisionPolicy).toEqual({ permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold' })
  })
})

describe('exec finalizer and teardown order', () => {
  it('a finalized run stays live until its final status is written (the title join)', async () => {
    let resolveTitle!: (t: string) => void
    const { m, fakes } = rig({ title: () => new Promise<string>((r) => (resolveTitle = r)) })
    const run = await m.start({ project: proj(), prompt: 'go', team: 'single', overrides: exec() })
    endTurn(fakes[0])
    await flush(100)
    // The session ended (stop), but the finalizer waits for the title: the run still counts as live.
    expect(fakes[0].stopCalls).toBe(1)
    expect(m.liveRunCount()).toBe(1)
    expect(finalized()).toHaveLength(0)
    resolveTitle('A title')
    await flush(100)
    expect(finalized()).toHaveLength(1)
    expect(m.summary(run.id)?.status).toBe('finished')
    expect(m.liveRunCount()).toBe(0)
  })
})

describe('exec budget', () => {
  it('maxBudgetUsd 0 finalizes before adapter.start', async () => {
    const { m, start } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ maxBudgetUsd: 0 }) })
    expect(start).not.toHaveBeenCalled()
    expect(run).toMatchObject({ execOutcome: 'budget-exceeded', endedBy: 'budget', status: 'finished' })
    expect(finalized()).toHaveLength(1)
    expect(m.liveRunCount()).toBe(0)
  })

  it('passes what is left of the chain budget as ctx.budgetUsd', async () => {
    const { m, fakes, store } = rig()
    store.upsert({ id: 'run-old', projectId: 'p1', kind: 'work', prompt: 'x', status: 'finished', startedAt: 0, totalCostUsd: 0.4, overrides: { execMode: true, execChainId: 'chain-1' } } as RunSummary)
    await m.start({ project: proj(), prompt: 'go', overrides: exec({ execChainId: 'chain-1', maxBudgetUsd: 1 }) })
    expect(fakes[0].ctx.budgetUsd).toBeCloseTo(0.6)
    await m.stopAll()
  })

  it('a spent chain finalizes before launch', async () => {
    const { m, start, store } = rig()
    store.upsert({ id: 'run-old', projectId: 'p1', kind: 'work', prompt: 'x', status: 'finished', startedAt: 0, totalCostUsd: 2, overrides: { execMode: true, execChainId: 'chain-1' } } as RunSummary)
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ execChainId: 'chain-1', maxBudgetUsd: 1 }) })
    expect(start).not.toHaveBeenCalled()
    expect(run.execOutcome).toBe('budget-exceeded')
  })

  it('a budget crossed on an agent.upsert finalizes at once', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ maxBudgetUsd: 0.5 }) })
    const usage = { models: [{ model: 'claude-sonnet-5-5', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, providerCostUsd: 0.6 }], turns: 1, toolCalls: 0, retries: 0 }
    fakes[0].ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent({ id: 'root', parentId: null, model: 'claude-sonnet-5-5', usage: usage as unknown as AgentInstance['usage'] }) })
    // Synchronous: claimed before any timer runs.
    expect(m.summary(run.id)?.execOutcome).toBeUndefined()
    await flush(0)
    expect(m.summary(run.id)).toMatchObject({ execOutcome: 'budget-exceeded', endedBy: 'budget' })
  })

  it('an unpriced role model with a budget is refused unless allowUnpricedBudget', async () => {
    const roles = [role({ id: 'r1', slug: 'lead', model: 'totally-unknown-model' })]
    const { m, start } = rig()
    const run = await m.start({ project: proj({ roles }), prompt: 'go', overrides: exec({ maxBudgetUsd: 5 }) })
    expect(start).not.toHaveBeenCalled()
    expect(run.execOutcome).toBe('budget-exceeded')
    const r2 = rig()
    await r2.m.start({ project: proj({ roles }), prompt: 'go', overrides: exec({ maxBudgetUsd: 5, allowUnpricedBudget: true }) })
    expect(r2.start).toHaveBeenCalledTimes(1)
    await r2.m.stopAll()
  })

  it('no budget means no price check', async () => {
    const roles = [role({ id: 'r1', slug: 'lead', model: 'totally-unknown-model' })]
    const { m, start, fakes } = rig()
    await m.start({ project: proj({ roles }), prompt: 'go', overrides: exec() })
    expect(start).toHaveBeenCalledTimes(1)
    expect(fakes[0].ctx.budgetUsd).toBeUndefined()
    await m.stopAll()
  })

  it('an agent whose usage has no price ends a budgeted run', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec({ maxBudgetUsd: 5 }) })
    const usage = { models: [{ model: 'nobody-knows', tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }], turns: 1, toolCalls: 0, retries: 0 }
    fakes[0].ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent({ id: 'a1', usage: usage as unknown as AgentInstance['usage'] }) })
    await flush(0)
    expect(m.summary(run.id)?.execOutcome).toBe('budget-exceeded')
  })
})

describe('the finalizer', () => {
  it('late adapter events do not change the outcome; run.finalized goes out once; double finalize shares a promise', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    fakes[0].stopStatus = 'error'
    const first = m.finalizeExecRun(run.id, 'needs-decision', { endedBy: 'policy' })
    const second = m.finalizeExecRun(run.id, 'failed')
    expect(second).toBe(first)
    await flush()
    await first
    // The abort's 'error' status was dropped.
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', execOutcome: 'needs-decision', endedBy: 'policy' })
    fakes[0].ctx.emit({ type: 'run.status', runId: run.id, status: 'error', error: 'late' })
    fakes[0].ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agent({ id: 'a9', state: 'thinking' }) })
    // The record flush timer saves the late (settled) agent.
    await flush(2000)
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'finished', execOutcome: 'needs-decision', endedBy: 'policy' })
    expect(finalized()).toHaveLength(1)
    expect(m.get(run.id)?.agents.a9.state).not.toBe('thinking')
    // Persisted.
    expect(m.list('p1').find((r) => r.id === run.id)?.execOutcome).toBe('needs-decision')
  })

  it('awaits session.finished and gives up after EXEC_FINALIZE_STOP_TIMEOUT_MS', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    fakes[0].stopEnds = false
    let done = false
    void m.finalizeExecRun(run.id, 'stalled', { endedBy: 'policy' }).then(() => (done = true))
    await flush(EXEC_FINALIZE_STOP_TIMEOUT_MS - 100)
    expect(done).toBe(false)
    expect(finalized()).toHaveLength(0)
    await flush(200)
    expect(done).toBe(true)
    expect(finalized()).toHaveLength(1)
    expect(m.liveRunCount()).toBe(0)
  })

  it('joins an in-flight title', async () => {
    const title = vi.fn(
      (input: CompletionInput) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('Fix the build'), 1000)
          input.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        })
    )
    const { m, fakes } = rig({ title })
    const run = await m.start({ project: proj(), prompt: 'please fix the build', team: 'single', overrides: exec() })
    endTurn(fakes[0])
    await flush(2000)
    expect(title).toHaveBeenCalled()
    expect(finalized()[0].summary.title).toBe('Fix the build')
    expect(m.summary(run.id)?.title).toBe('Fix the build')
  })

  it('stop() on an exec run gives interrupted / endedBy user', async () => {
    const { m } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    await m.stop(run.id)
    expect(m.summary(run.id)).toMatchObject({ status: 'finished', execOutcome: 'interrupted', endedBy: 'user' })
    expect(events.some((e) => e.type === 'run.status' && e.status === 'stopping' && e.endedBy === 'user')).toBe(true)
    expect(finalized()).toHaveLength(1)
  })

  it('stopAll on quit writes interrupted / app on unfinalized exec runs', async () => {
    const { m, fakes } = rig()
    const run = await m.start({ project: proj(), prompt: 'go', overrides: exec() })
    fakes[0].stopEnds = false
    m.markQuit()
    const s = m.summary(run.id)!
    expect(s).toMatchObject({ status: 'finished', execOutcome: 'interrupted', endedBy: 'app' })
    expect(finalized()).toHaveLength(1)
  })
})

describe('overrides', () => {
  it('effectiveRunProject applies before ctx and setLive re-clamps', async () => {
    let saved = proj({ permissionMode: 'acceptEdits' })
    const applyProposal = vi.fn(() => saved)
    const { m, fakes } = rig()
    ;(m as unknown as { setup: { applyProposal: typeof applyProposal } }).setup.applyProposal = applyProposal
    const run = await m.start({ project: saved, prompt: 'go', overrides: exec({ permissionMode: 'default', autoContinue: false, maxAutoContinues: 3 }) })
    const ctx = fakes[0].ctx
    expect(ctx.project.permissionMode).toBe('default')
    expect(ctx.autoContinue).toBe(false)
    expect(ctx.maxAutoContinues).toBe(3)
    expect(m.summary(run.id)?.overrides).toMatchObject({ permissionMode: 'default', execMode: true })
    // The project tightens to 'plan' mid-run: 'default' no longer narrows it, so the project's mode wins.
    saved = proj({ permissionMode: 'plan', maxAutoContinues: 1 })
    const decided = ctx.requestProposal?.({ kind: 'mcpServers', agentId: 'root', title: 't', summary: '', payload: { servers: [] } } as never)
    // Human approves before the policy acts.
    const id = (events.find((e) => e.type === 'proposal.request') as Extract<RunEvent, { type: 'proposal.request' }>).proposal.id
    m.decideProposal(run.id, id, { behavior: 'approve' })
    await decided
    expect(ctx.project.permissionMode).toBe('plan')
    expect(ctx.maxAutoContinues).toBe(1)
    await m.stopAll()
  })

  it('refuses overrides on setup runs', async () => {
    const { m } = rig()
    await expect(m.start({ project: proj(), prompt: 'go', kind: 'setup', overrides: exec() })).rejects.toThrow('Run overrides apply to work runs only.')
  })

  it('continueRun strips exec fields unless exec', async () => {
    const p = proj()
    const { m, fakes } = rig({ resolveProject: () => p })
    const run = await m.start({ project: p, prompt: 'go', team: 'single', overrides: exec({ permissionMode: 'plan', maxBudgetUsd: 3, waitForReset: true, allowUnmerged: true }) })
    endTurn(fakes[0])
    await flush()
    const plain = await m.continueRun(p, run.id, 'more')
    expect(plain.overrides).toEqual({ permissionMode: 'plan', maxBudgetUsd: 3 })
    await m.stopAll()
    const again = await m.continueRun(p, plain.id, 'more', undefined, { exec: true, overrides: exec({ execChainId: run.id }) })
    expect(again.overrides).toMatchObject({ execMode: true, execChainId: run.id, permissionMode: 'plan', maxBudgetUsd: 3 })
    await m.stopAll()
  })

  it('continuedOverrides keeps narrowing fields always and exec fields on exec only', () => {
    const prev: RunOverrides = { execMode: true, execChainId: 'c', permissionMode: 'plan', autoContinue: false, maxAutoContinues: 2, maxBudgetUsd: 1, decisionPolicy: undefined, allowPeerMessages: true }
    expect(continuedOverrides(prev, {})).toEqual({ permissionMode: 'plan', autoContinue: false, maxAutoContinues: 2, maxBudgetUsd: 1 })
    expect(continuedOverrides(prev, { exec: true, allowWidening: true })).toMatchObject({ execMode: true, execChainId: 'c', allowPeerMessages: true })
    // An 'operate'-only resume --exec never inherits the configure-only grants.
    const operate = continuedOverrides({ ...prev, allowUnpricedBudget: true }, { exec: true })
    expect(operate).toMatchObject({ execMode: true, execChainId: 'c' })
    expect(operate).not.toHaveProperty('allowPeerMessages')
    expect(operate).not.toHaveProperty('allowUnpricedBudget')
    expect(continuedOverrides(undefined, {})).toBeUndefined()
    expect(continuedOverrides(prev, { overrides: { maxBudgetUsd: 0.5 } })?.maxBudgetUsd).toBe(0.5)
  })

  it('peer messages are refused on exec runs without allowPeerMessages', async () => {
    const { m, fakes } = rig()
    const target = await m.start({ project: proj(), prompt: 'exec', overrides: exec() })
    const allowed = await m.start({ project: proj(), prompt: 'exec2', overrides: exec({ allowPeerMessages: true }) })
    await m.start({ project: proj(), prompt: 'sender' })
    const sender = fakes[2].ctx
    expect(await sender.messageRun?.(target.id, 'hi')).toMatchObject({ result: 'refused', refusal: 'messaging-off' })
    expect(await sender.messageRun?.(allowed.id, 'hi')).not.toMatchObject({ refusal: 'messaging-off' })
    await m.stopAll()
  })
})
