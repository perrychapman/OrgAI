// Activity accessors of RunManager (cli-spec 3.2(4)): auto-resume timers, the in-flight resume lease that covers the
// gap from the timer firing to the successor run being registered, and pending title queries. Mock adapter only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { MockAdapter, type MockScript } from './mock'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const HOUR = 60 * 60 * 1000
const limitScript: MockScript = { delayMs: 0, setup: [{ type: 'rateLimit', window: 'five_hour', untilInMs: HOUR }], work: [{ type: 'rateLimit', window: 'five_hour', untilInMs: HOUR }] }

let dir: string
let events: RunEvent[]
let onEvent: (() => void) | undefined

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rig(p: Project, script: MockScript = limitScript, prepare?: (p: Project) => Promise<Project>, options: RunManagerOptions = {}) {
  const own = events
  const setup = {
    applyProposal: vi.fn(() => p),
    complete: vi.fn(() => p),
    markScaffolded: vi.fn(() => p),
    markArchitectureUpdated: vi.fn(() => p),
    hiddenContext: vi.fn(() => 'profile'),
    prepare: vi.fn(prepare ?? (async (x: Project) => x))
  }
  const store = new RunStore(join(dir, 'data'))
  const adapter = new MockAdapter({ script: { delayMs: 0, ...script } })
  const sink = (e: RunEvent): void => {
    own.push(e)
    onEvent?.()
  }
  const m = new RunManager({ mock: adapter }, sink, store, setup as unknown as SetupService, () => 100, { resolveProject: () => p, ...options })
  return { m, store, setup }
}

const pausedEvent = (runId: string) => (e: RunEvent) => e.type === 'run.status' && e.runId === runId && e.status === 'paused'

/** Start a run that pauses at a usage limit with autoResume, and wait until it is no longer live. */
async function pausedRun(m: RunManager, p: Project, kind: 'work' | 'setup' = 'setup') {
  const run = await m.start({ project: p, prompt: 'Big job', kind })
  await vi.waitFor(() => expect(events.some(pausedEvent(run.id))).toBe(true))
  await vi.waitFor(() => expect(m.summaryOf(run.id)).toBeUndefined())
  return run
}

const leases = (m: RunManager): number => m.activeResumeTimerCount() + m.inFlightResumeCount() + m.liveRuns().length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rma-'))
  events = []
  onEvent = undefined
})

afterEach(() => {
  vi.useRealTimers()
  onEvent = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('RunManager activity accessors', () => {
  it('a run paused with autoResume holds one resume timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p)
    const run = await pausedRun(m, p)
    expect(m.hasAutoResume(run.id)).toBe(true)
    expect(m.activeResumeTimerCount()).toBe(1)
    expect(m.inFlightResumeCount()).toBe(0)
    expect(m.liveRuns()).toHaveLength(0)
    m.cancelAutoResume(run.id)
  })

  it('never shows zero leases between the timer firing and the successor run (delayed setup.prepare)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const gate = deferred<Project>()
    const { m, setup } = rig(p, limitScript, () => gate.promise)
    const run = await pausedRun(m, p)
    expect(leases(m)).toBe(1)

    const samples: number[] = []
    const sample = (): void => void samples.push(leases(m))
    onEvent = sample
    const continueRun = vi.spyOn(m, 'continueRun')

    vi.advanceTimersByTime(HOUR + 1000)
    // The timer fired: its entry is gone, the in-flight lease holds the host.
    expect(m.activeResumeTimerCount()).toBe(0)
    expect(m.inFlightResumeCount()).toBe(1)
    sample()
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
      sample()
    }
    expect(setup.prepare).toHaveBeenCalledTimes(1)
    expect(continueRun).not.toHaveBeenCalled()
    expect(m.inFlightResumeCount()).toBe(1)

    gate.resolve(p)
    // Step through microtasks until the successor is live and the lease is gone.
    for (let i = 0; i < 200 && m.inFlightResumeCount() > 0; i++) {
      await Promise.resolve()
      sample()
    }
    expect(continueRun).toHaveBeenCalledTimes(1)
    const next = await continueRun.mock.results[0].value
    sample()
    expect(next.resumedFrom).toBe(run.id)
    expect(m.inFlightResumeCount()).toBe(0)
    expect(samples.length).toBeGreaterThan(20)
    expect(samples.every((n) => n > 0)).toBe(true)
    await m.stopAll()
  })

  it('a failed resume (prepare throws) drops the lease and keeps the error handling and events', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const { m, store } = rig(p, limitScript, async () => {
      throw new Error('profile failed')
    })
    const run = await pausedRun(m, p)
    const seen = events.length
    vi.advanceTimersByTime(HOUR + 1000)
    expect(m.inFlightResumeCount()).toBe(1)
    await vi.waitFor(() => expect(m.inFlightResumeCount()).toBe(0))
    const after = events.slice(seen)
    expect(after).toContainEqual(expect.objectContaining({ type: 'log', runId: run.id, level: 'error', message: 'Could not resume the paused run: profile failed' }))
    expect(after).toContainEqual(expect.objectContaining({ type: 'run.status', runId: run.id, status: 'paused', autoResume: false }))
    expect(store.get(run.id)).toMatchObject({ status: 'paused', autoResume: false })
    expect(m.activeResumeTimerCount()).toBe(0)
    expect(m.liveRuns()).toHaveLength(0)
  })

  it('a manual resumeNow takes the lease across setup.prepare and releases it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const gate = deferred<Project>()
    const { m } = rig(p, limitScript, () => gate.promise)
    const run = await pausedRun(m, p)
    const resumed = m.resumeNow(run.id)
    // resumeNow clears the timer synchronously; the lease covers the gap.
    expect(m.activeResumeTimerCount()).toBe(0)
    expect(m.inFlightResumeCount()).toBe(1)
    gate.resolve(p)
    const next = await resumed
    expect(next.resumedFrom).toBe(run.id)
    expect(m.inFlightResumeCount()).toBe(0)
    // The successor is live (or already paused again at the same limit, with its own timer).
    expect(leases(m)).toBeGreaterThan(0)
    await m.stopAll()
  })

  it('a refused manual resumeNow releases the lease too', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p)
    await expect(m.resumeNow('nope')).rejects.toThrow('Run not found')
    expect(m.inFlightResumeCount()).toBe(0)
  })

  it('cancelAutoResume and stopAll bring the timer count to zero', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p)
    const a = await pausedRun(m, p)
    expect(m.activeResumeTimerCount()).toBe(1)
    m.cancelAutoResume(a.id)
    expect(m.activeResumeTimerCount()).toBe(0)

    await pausedRun(m, p, 'work')
    expect(m.activeResumeTimerCount()).toBe(1)
    await m.stopAll()
    expect(m.activeResumeTimerCount()).toBe(0)
    expect(m.inFlightResumeCount()).toBe(0)
  })

  it('titleTaskCount counts a pending run title', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p, { delayMs: 0, work: [{ type: 'text', text: 'ok' }] })
    expect(m.titleTaskCount()).toBe(0)
    await m.start({ project: p, prompt: 'Slow title please [mock:title-slow]' })
    await vi.waitFor(() => expect(m.titleTaskCount()).toBeGreaterThan(0))
    await vi.waitFor(() => expect(events.some((e) => e.type === 'run.title')).toBe(true))
    await vi.waitFor(() => expect(m.titleTaskCount()).toBe(0))
    await m.stopAll()
  })
})

// Review H3: runs that only wait on their user neither keep a host busy nor make the desktop ask before closing.
describe('RunManager working and busy run counts', () => {
  const idleScript: MockScript = { delayMs: 0, work: [{ type: 'text', text: 'Done for now.' }] }
  const askScript: MockScript = { delayMs: 0, work: [{ type: 'tool', name: 'Bash', input: { command: 'npm test' }, ask: true }] }

  it('an idle run is live but neither working nor busy', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, idleScript)
    const run = await m.start({ project: p, prompt: 'Hi', kind: 'work' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status).toBe('idle'))
    await vi.waitFor(() => expect(m.workingRunCount()).toBe(0))
    expect(m.liveRuns()).toHaveLength(1)
    expect(m.busyRunCount()).toBe(0)
    await m.stopAll()
  })

  it('a run in a turn is working and busy', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, { delayMs: 300, work: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    const run = await m.start({ project: p, prompt: 'Hi', kind: 'work' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status).toBe('running'))
    expect(m.workingRunCount()).toBe(1)
    expect(m.busyRunCount()).toBe(1)
    await m.stopAll()
  })

  it('a run waiting on a permission card is neither working nor busy', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, askScript)
    const run = await m.start({ project: p, prompt: 'Run the tests', kind: 'work' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'permission.request' && e.runId === run.id)).toBe(true))
    expect(m.liveRuns()).toHaveLength(1)
    expect(m.workingRunCount()).toBe(0)
    expect(m.busyRunCount()).toBe(0)
    await m.stopAll()
  })

  it('a paused run with an auto-resume timer is not a working run (its timer counts separately)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p)
    const run = await pausedRun(m, p)
    expect(m.workingRunCount()).toBe(0)
    expect(m.busyRunCount()).toBe(0)
    expect(m.activeResumeTimerCount()).toBe(1)
    m.cancelAutoResume(run.id)
  })
})

// Wave 7 (cli-standalone.md 4.4 step 4): the handoff predicate is stricter than busyRunCount: every live run in any
// form, every paused run with a resume pending and every open card blocks the app's handoff.
describe('RunManager.handoffFacts', () => {
  const idleScript: MockScript = { delayMs: 0, work: [{ type: 'text', text: 'Done for now.' }] }
  const askScript: MockScript = { delayMs: 0, work: [{ type: 'tool', name: 'Bash', input: { command: 'npm test' }, ask: true }] }
  const none = { workingRuns: 0, waitingRuns: 0, heldRuns: 0, pausedRuns: 0, openCards: 0 }

  it('is all zeros with no runs', () => {
    const p = makeProject({ path: join(dir, 'repo') })
    expect(rig(p).m.handoffFacts()).toEqual(none)
  })

  it('a run in a turn is a working run', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, { delayMs: 300, work: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    const run = await m.start({ project: p, prompt: 'Hi', kind: 'work' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status).toBe('running'))
    expect(m.handoffFacts()).toEqual({ ...none, workingRuns: 1 })
    await m.stopAll()
  })

  it('an idle run blocks the handoff although it keeps no host busy', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, idleScript)
    const run = await m.start({ project: p, prompt: 'Hi', kind: 'work' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status).toBe('idle'))
    await vi.waitFor(() => expect(m.workingRunCount()).toBe(0))
    expect(m.busyRunCount()).toBe(0)
    expect(m.handoffFacts()).toEqual({ ...none, waitingRuns: 1 })
    await m.stopAll()
    expect(m.handoffFacts()).toEqual(none)
  })

  it('a run waiting on a card counts as waiting and its card as open', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, askScript)
    const run = await m.start({ project: p, prompt: 'Run the tests', kind: 'work' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'permission.request' && e.runId === run.id)).toBe(true))
    expect(m.busyRunCount()).toBe(0)
    expect(m.handoffFacts()).toEqual({ ...none, waitingRuns: 1, openCards: 1 })
    await m.stopAll()
  })

  it('a run held by the user\'s interrupt is a held run', async () => {
    const p = makeProject({ path: join(dir, 'repo'), autoContinue: false })
    const { m } = rig(p, idleScript)
    const run = await m.start({ project: p, prompt: 'Hi', kind: 'work' })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status).toBe('idle'))
    await m.interrupt(run.id)
    await vi.waitFor(() => expect(m.handoffFacts()).toEqual({ ...none, heldRuns: 1 }))
    await m.stopAll()
  })

  it('a paused run with an auto-resume pending is a paused run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const p = makeProject({ path: join(dir, 'repo') })
    const { m } = rig(p)
    const run = await pausedRun(m, p)
    expect(m.busyRunCount()).toBe(0)
    expect(m.handoffFacts()).toEqual({ ...none, pausedRuns: 1 })
    m.cancelAutoResume(run.id)
    expect(m.handoffFacts()).toEqual(none)
  })
})
