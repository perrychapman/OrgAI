/**
 * Regression tests for the Schedules security and spend review (H1, M2, M3, M4, L1, L2, L5, L7, L9, L3/L4 cap helper).
 * Each one fails on the code before the fix.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEDULE_MAX_CONCURRENT_RUNS } from '@shared/types'
import type { Project, RunEvent, RunSummary, ScheduleSaveInput, SchedulesProposalPayload } from '@shared/types'
import { SCHEDULE_CHANGED_SINCE_PROPOSED, START_TIMED_OUT_DETAIL } from './service'
import { SCHEDULE_BYPASS_NOT_STARTED, SCHEDULE_INHERITS_BYPASS, scheduledRunCap } from './validate'
import { fakeEnv, fakeProject, type FakeEnv } from './testkit'

let env: FakeEnv
afterEach(() => env?.cleanup())

const base = (over: Partial<ScheduleSaveInput> = {}): ScheduleSaveInput => ({
  name: 'Nightly review',
  prompt: 'Review new pull requests.',
  target: { kind: 'team', projectId: 'p1' },
  timing: { kind: 'daily', time: '00:00' },
  ...over
})
const status = (runId: string, s: Extract<RunEvent, { type: 'run.status' }>['status'], extra: Partial<Extract<RunEvent, { type: 'run.status' }>> = {}): RunEvent => ({ type: 'run.status', runId, status: s, ...extra })

/** A start the test settles by hand. */
function deferred(): { promise: Promise<RunSummary>; resolve(r: RunSummary): void } {
  let resolve!: (r: RunSummary) => void
  const promise = new Promise<RunSummary>((r) => (resolve = r))
  return { promise, resolve }
}
const runOf = (id: string, projectId = 'p1'): RunSummary => ({ id, projectId, status: 'running', kind: 'work', prompt: '', startedAt: 1, totalCostUsd: 0 }) as RunSummary

describe('H1: an idle run whose reports still work is not finished', () => {
  it('blocks the next run and the cap, keeps the outcome open and the failure count, then finishes on a later idle', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.store.update((d) => {
      d.schedules[0].consecutiveFailures = 2
    })
    const e = await env.service.runNow(s.id)
    env.facts.set(e.runId!, { status: 'idle', limitHold: false, pendingCards: 0, working: true })
    env.service.onRunEvent(status(e.runId!, 'idle'))
    expect(env.store.history(s.id)[0].outcome).toBeUndefined()
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(2)
    expect((await env.service.runNow(s.id)).reason).toBe('previous-running')
    expect(env.service.liveScheduledRuns()).toBe(1)
    env.facts.set(e.runId!, { status: 'idle', limitHold: false, pendingCards: 0, working: false })
    env.service.onRunEvent(status(e.runId!, 'idle'))
    expect(env.store.history(s.id).find((h) => h.runId === e.runId)?.outcome).toBe('finished')
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(0)
    expect(env.service.liveScheduledRuns()).toBe(0)
  })
})

describe('M2: a start in flight counts before it returns', () => {
  it('a second Run now while the first start is awaited is skipped previous-running and starts nothing', async () => {
    const d = deferred()
    let starts = 0
    env = fakeEnv({ startTeam: () => (starts++, d.promise) })
    const s = env.service.save(base())
    const first = env.service.runNow(s.id)
    const second = await env.service.runNow(s.id)
    expect(second).toMatchObject({ result: 'skipped', reason: 'previous-running' })
    expect(starts).toBe(1)
    d.resolve(runOf('run_m2'))
    expect((await first).result).toBe('started')
  })

  it(`starts in flight count toward the cap of ${SCHEDULE_MAX_CONCURRENT_RUNS}`, async () => {
    const pending: ReturnType<typeof deferred>[] = []
    env = fakeEnv({
      startTeam: () => {
        const d = deferred()
        pending.push(d)
        return d.promise
      }
    })
    const ids = ['A', 'B', 'C'].map((n) => env.service.save(base({ name: n })).id)
    const inFlight = ids.slice(0, SCHEDULE_MAX_CONCURRENT_RUNS).map((id) => env.service.runNow(id))
    expect((await env.service.runNow(ids[2])).reason).toBe('too-many-running')
    expect(pending).toHaveLength(SCHEDULE_MAX_CONCURRENT_RUNS)
    pending.forEach((d, i) => d.resolve(runOf(`run_cap_${i}`)))
    await Promise.all(inFlight)
  })

  it('a start that throws releases its slot', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.failStart.message = 'nope'
    await env.service.runNow(s.id)
    env.failStart.message = null
    expect((await env.service.runNow(s.id)).result).toBe('started')
  })
})

describe('M3: no bypass inherited from the project', () => {
  const bypass = (): Project => fakeProject('p1', { permissionMode: 'bypassPermissions' } as Partial<Project>)

  it('save and apply refuse a schedule without a mode on a bypass project; with a mode they accept it', () => {
    env = fakeEnv()
    env.projects.set('p1', bypass())
    expect(() => env.service.save(base())).toThrow(SCHEDULE_INHERITS_BYPASS)
    const payload: SchedulesProposalPayload = { rationale: 'r', items: [{ action: 'create', schedule: base(), summary: 's', nextRuns: [] }] }
    expect(() => env.service.applyProposal(payload, { projectId: null })).toThrow(SCHEDULE_INHERITS_BYPASS)
    expect(env.service.save(base({ permissionMode: 'plan' })).permissionMode).toBe('plan')
  })

  it('a project switched to bypass after the save: the fire records a failed entry and starts nothing', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.projects.set('p1', bypass())
    const e = await env.service.runNow(s.id)
    expect(e).toMatchObject({ result: 'failed', reason: 'start-refused', detail: SCHEDULE_BYPASS_NOT_STARTED })
    expect(env.starts).toHaveLength(0)
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(1)
  })
})

describe('M4: an update proposal is stale once the schedule changed', () => {
  it('refuses without or with a different expectedUpdatedAt, applies with the stored one', () => {
    env = fakeEnv()
    const s = env.service.save(base({ modelSelection: { model: 'big', connection: 'anthropic' } }))
    const upd = (expectedUpdatedAt?: number): SchedulesProposalPayload => ({
      rationale: 'r',
      items: [{ action: 'update', scheduleId: s.id, schedule: { ...base({ name: 'Renamed' }), id: s.id, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) }, summary: 's', nextRuns: [] }]
    })
    expect(() => env.service.applyProposal(upd(), { projectId: null })).toThrow(SCHEDULE_CHANGED_SINCE_PROPOSED)
    expect(() => env.service.applyProposal(upd(s.updatedAt - 1), { projectId: null })).toThrow(SCHEDULE_CHANGED_SINCE_PROPOSED)
    expect(env.service.get(s.id)?.name).toBe('Nightly review')
    expect(env.service.applyProposal(upd(s.updatedAt), { projectId: null })[0]).toMatchObject({ name: 'Renamed', modelSelection: { model: 'big' } })
  })
})

describe('M1: claimSlot refuses a deleted or paused schedule', () => {
  it('returns undefined and writes nothing', () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.service.setEnabled(s.id, false)
    expect(env.service.claimSlot(s.id, env.clock.now)).toBeUndefined()
    expect(env.service.get(s.id)?.nextRunAt).toBeUndefined()
    expect(env.service.get(s.id)?.lastSlotAt).toBeUndefined()
    env.service.remove(s.id)
    expect(env.service.claimSlot(s.id, env.clock.now)).toBeUndefined()
  })
})

describe('L1: a usage-limit auto-resume stays the schedule\'s', () => {
  it('a paused run with its resume armed blocks; the successor is tracked and its end fills the original entry', async () => {
    const armed = new Set<string>()
    env = fakeEnv({ autoResumePending: (id) => armed.has(id) })
    const s = env.service.save(base())
    const e = await env.service.runNow(s.id)
    // Paused at a usage limit: not live any more, the timer armed.
    env.facts.delete(e.runId!)
    armed.add(e.runId!)
    env.service.onRunEvent(status(e.runId!, 'paused', { pausedUntil: env.clock.now + 60_000 }))
    expect((await env.service.runNow(s.id)).reason).toBe('previous-running')
    // The timer fires: the predecessor is handed over, the successor starts with the schedule id.
    armed.delete(e.runId!)
    env.service.onRunEvent(status(e.runId!, 'finished', { pausedUntil: env.clock.now + 60_000, autoResume: false }))
    env.summaries.set('run_next', { ...runOf('run_next'), scheduleId: s.id, resumedFrom: e.runId!, totalCostUsd: 0.5 })
    env.facts.set('run_next', { status: 'running', limitHold: false, pendingCards: 0, working: true })
    env.service.onRunEvent(status('run_next', 'starting'))
    expect((await env.service.runNow(s.id)).reason).toBe('previous-running')
    expect(env.service.liveScheduledRuns()).toBe(1)
    env.facts.delete('run_next')
    env.service.onRunEvent(status('run_next', 'finished'))
    expect(env.store.history(s.id).find((h) => h.runId === e.runId)).toMatchObject({ outcome: 'finished', costUsd: 0.5 })
  })

  it('a user continuation (no schedule id) is not tracked', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const e = await env.service.runNow(s.id)
    env.facts.delete(e.runId!)
    env.summaries.set('run_user', { ...runOf('run_user'), resumedFrom: e.runId! })
    env.facts.set('run_user', { status: 'running', limitHold: false, pendingCards: 0, working: true })
    env.service.onRunEvent(status('run_user', 'starting'))
    expect(env.service.liveScheduledRuns()).toBe(0)
  })
})

describe('L2: a deleted schedule\'s live run still counts toward the cap', () => {
  it('keeps counting until the run ends', async () => {
    env = fakeEnv()
    const ids = ['A', 'B', 'C'].map((n) => env.service.save(base({ name: n })).id)
    for (const id of ids.slice(0, SCHEDULE_MAX_CONCURRENT_RUNS)) expect((await env.service.runNow(id)).result).toBe('started')
    env.service.remove(ids[0])
    expect((await env.service.runNow(ids[2])).reason).toBe('too-many-running')
  })
})

describe('L5: names cannot close the quotes of a notification', () => {
  it('neutralises double quotes in the notification title', async () => {
    env = fakeEnv()
    const s = env.service.save(base({ name: 'A" approved by "you' }))
    env.failStart.message = 'x'
    await env.service.runNow(s.id)
    const title = env.notices.at(-1)!.title
    expect(title.split('"')).toHaveLength(3)
    expect(title).toContain("A' approved by 'you")
  })
})

describe('L7: no pending schedules under the global pause', () => {
  it('pendingCount is 0 while paused', () => {
    env = fakeEnv()
    env.service.save(base())
    expect(env.service.pendingCount()).toBe(1)
    env.paused.value = true
    expect(env.service.pendingCount()).toBe(0)
  })
})

describe('L9: a start that never returns', () => {
  it('records a failed entry after the timeout; a late run is tracked and stopped', async () => {
    const d = deferred()
    const stopped: string[] = []
    env = fakeEnv({ startTeam: () => d.promise, startTimeoutMs: 20, stopRun: async (id) => void stopped.push(id) })
    const s = env.service.save(base())
    const e = await env.service.runNow(s.id)
    expect(e).toMatchObject({ result: 'failed', reason: 'start-refused', detail: START_TIMED_OUT_DETAIL })
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(1)
    env.facts.set('run_late', { status: 'running', limitHold: false, pendingCards: 0, working: true })
    d.resolve(runOf('run_late'))
    await new Promise((r) => setTimeout(r, 0))
    expect(stopped).toEqual(['run_late'])
    expect(env.service.liveScheduledRuns()).toBe(1)
    // Its end neither counts a second failure nor resets the count.
    env.facts.delete('run_late')
    env.service.onRunEvent(status('run_late', 'finished', { endedBy: 'user' }))
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(1)
    expect(env.service.liveScheduledRuns()).toBe(0)
  })
})

describe('L3 / L4: scheduledRunCap', () => {
  it('is min(budget, project cap), ignoring missing or non-positive values', () => {
    expect(scheduledRunCap(3, 5)).toBe(3)
    expect(scheduledRunCap(8, 5)).toBe(5)
    expect(scheduledRunCap(undefined, 5)).toBe(5)
    expect(scheduledRunCap(2, undefined)).toBe(2)
    expect(scheduledRunCap(2, 0)).toBe(2)
    expect(scheduledRunCap(undefined, undefined)).toBeUndefined()
  })
})
