import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvolvePostRunResult, RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { MockAdapter } from './mock'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rm-evolve-'))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RunManagerOptions = {}) {
  const p = makeProject({ path: join(dir, 'repo') })
  const setup = { applyProposal: vi.fn(() => p), complete: vi.fn(() => p), markScaffolded: vi.fn(() => p), markArchitectureUpdated: vi.fn(() => p), hiddenContext: vi.fn(() => 'profile') } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void events.push(e), store, setup, () => 100, { resolveProject: () => p, ...options })
  return { m, p, store }
}

const RESULT: EvolvePostRunResult = { projectId: 'x', ratchet: 'promoted', ratchetReason: 'cheaper' }

/** Ends a run the way a headless exec run ends on its own (finalized 'completed'), not stopped by the user. */
async function endRun(m: RunManager, id: string): Promise<void> {
  await vi.waitFor(() => expect(['idle', 'finished']).toContain(m.summary(id)?.status))
  await m.finalizeExecRun(id, 'completed')
  await vi.waitFor(() => expect(m.summaryOf(id)).toBeUndefined())
}

describe('RunManager post-run evolve pass', () => {
  it('runs once after a work run that asked for evolve, with its strategy and window, and awaitEvolvePass returns it', async () => {
    // What the engine would read at pass time: the stored record must already carry its closing status and usage.
    let seen: { status?: string; usage: unknown; live: unknown } | undefined
    const afterRun = vi.fn(async () => {
      const s = store.list(p.id)[0]
      const rec = s ? store.getRecord(s.id) : null
      seen = { status: rec?.summary.status, usage: rec?.summary.usage, live: m.summary(s.id)?.usage }
      return RESULT
    })
    const { m, p, store } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: 'hybrid', evolveWindowRuns: 4 })
    expect(afterRun).not.toHaveBeenCalled()
    await endRun(m, run.id)
    expect(await m.awaitEvolvePass(run.id)).toEqual(RESULT)
    expect(afterRun).toHaveBeenCalledTimes(1)
    expect(afterRun).toHaveBeenCalledWith({ projectId: p.id, evolve: true, strategy: 'hybrid', evalWindowRuns: 4 })
    // The record was on disk before the pass ran.
    expect(store.getRecord(run.id)?.summary.status).toBe('finished')
    // Ordering: the closing usage refresh is synchronous and precedes the pass, so the pass reads the final usage.
    expect(seen?.status).toBe('finished')
    expect(seen?.usage).toBeTruthy()
    // Compare the figures the engine measures. `updatedAt` and the per-role / per-agent wall times are recomputed against
    // the clock on every usage refresh (a later refresh at teardown differs by a millisecond), so they are not compared.
    const stable = (u: unknown) => {
      const x = u as { tokens: unknown; costUsd: unknown; costSource: unknown; turns: unknown; toolCalls: unknown; agents: unknown }
      return { tokens: x.tokens, costUsd: x.costUsd, costSource: x.costSource, turns: x.turns, toolCalls: x.toolCalls, agents: x.agents }
    }
    expect(stable(seen?.usage)).toEqual(stable(seen?.live))
  })

  it('a run the user stopped (or interrupted) gets no pass: nothing is spent or changed after a stop', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: 'hybrid' })
    await vi.waitFor(() => expect(['idle', 'finished']).toContain(m.summary(run.id)?.status))
    await m.stop(run.id)
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    expect(await m.awaitEvolvePass(run.id)).toBeUndefined()
    expect(afterRun).not.toHaveBeenCalled()
    const second = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: true })
    await vi.waitFor(() => expect(['idle', 'finished']).toContain(m.summary(second.id)?.status))
    await m.finalizeExecRun(second.id, 'interrupted', { endedBy: 'user' })
    await vi.waitFor(() => expect(m.summaryOf(second.id)).toBeUndefined())
    expect(afterRun).not.toHaveBeenCalled()
    expect(m.evolvePassCount()).toBe(0)
  })

  it('a pass still running counts as background work, so shutdown waits for it before letting go of the folder', async () => {
    let release!: (r: EvolvePostRunResult) => void
    const afterRun = vi.fn(() => new Promise<EvolvePostRunResult>((r) => (release = r)))
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: true })
    await endRun(m, run.id)
    await vi.waitFor(() => expect(afterRun).toHaveBeenCalledTimes(1))
    expect(m.evolvePassCount()).toBe(1)
    release(RESULT)
    expect(await m.awaitEvolvePass(run.id)).toEqual(RESULT)
    expect(m.evolvePassCount()).toBe(0)
  })

  it('a run the user interrupted gets no pass, even if it then ends on its own before their next message', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: 'hybrid' })
    await vi.waitFor(() => expect(['idle', 'finished']).toContain(m.summary(run.id)?.status))
    await m.interrupt(run.id)
    await m.finalizeExecRun(run.id, 'completed')
    await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
    expect(await m.awaitEvolvePass(run.id)).toBeUndefined()
    expect(afterRun).not.toHaveBeenCalled()
  })

  it('evolve: true passes no strategy', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: true })
    await endRun(m, run.id)
    await m.awaitEvolvePass(run.id)
    expect(afterRun).toHaveBeenCalledWith({ projectId: p.id, evolve: true })
  })

  it('does nothing without evolve, with evolve false, and with no hook', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const a = rig({ evolveAfterRun: afterRun })
    const r1 = await a.m.start({ project: a.p, prompt: '[mock:model-switch]' })
    await endRun(a.m, r1.id)
    const r2 = await a.m.start({ project: a.p, prompt: '[mock:model-switch]', evolve: false })
    await endRun(a.m, r2.id)
    expect(afterRun).not.toHaveBeenCalled()
    expect(await a.m.awaitEvolvePass(r1.id)).toBeUndefined()
    const b = rig()
    const r3 = await b.m.start({ project: b.p, prompt: '[mock:model-switch]', evolve: true })
    await endRun(b.m, r3.id)
    expect(await b.m.awaitEvolvePass(r3.id)).toBeUndefined()
  })

  it('is dropped for setup runs and the single assistant', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const setup = await m.start({ project: p, prompt: '[mock:model-switch]', kind: 'setup', evolve: true })
    await endRun(m, setup.id)
    const single = await m.start({ project: p, prompt: '[mock:model-switch]', team: 'single', evolve: true })
    await endRun(m, single.id)
    expect(afterRun).not.toHaveBeenCalled()
  })

  it('swallows a failing pass and never fails or delays the run', async () => {
    const afterRun = vi.fn(async () => {
      throw new Error('engine exploded')
    })
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const run = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: true })
    await endRun(m, run.id)
    expect(await m.awaitEvolvePass(run.id)).toBeUndefined()
    expect(afterRun).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'run.status' && e.status === 'finished' && e.runId === run.id)).toBe(true)
  })

  it('a continuation does not carry evolve (one pass per started run)', async () => {
    const afterRun = vi.fn(async () => RESULT)
    const { m, p } = rig({ evolveAfterRun: afterRun })
    const first = await m.start({ project: p, prompt: '[mock:model-switch]', evolve: true })
    await endRun(m, first.id)
    await m.awaitEvolvePass(first.id)
    const next = await m.continueRun(p, first.id, '[mock:model-switch]')
    await endRun(m, next.id)
    expect(afterRun).toHaveBeenCalledTimes(1)
  })
})
