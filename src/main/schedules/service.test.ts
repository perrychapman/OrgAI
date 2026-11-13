import { afterEach, describe, expect, it } from 'vitest'
import { SCHEDULES_MAX, SCHEDULE_FAILURES_TO_PAUSE, SCHEDULE_MAX_CONCURRENT_RUNS } from '@shared/types'
import type { RunEvent, ScheduleSaveInput, SchedulesProposalPayload } from '@shared/types'
import { START_FAILED_DETAIL, runBlocks } from './service'
import { fakeEnv, fakeProject, type FakeEnv } from './testkit'

let env: FakeEnv
afterEach(() => env?.cleanup())

const HOUR = 3_600_000
const base = (over: Partial<ScheduleSaveInput> = {}): ScheduleSaveInput => ({
  name: 'Nightly review',
  prompt: 'Review new pull requests.',
  target: { kind: 'team', projectId: 'p1' },
  timing: { kind: 'daily', time: '00:00' },
  ...over
})
const status = (runId: string, s: Extract<RunEvent, { type: 'run.status' }>['status'], extra: Partial<Extract<RunEvent, { type: 'run.status' }>> = {}): RunEvent => ({ type: 'run.status', runId, status: s, ...extra })

describe('ScheduleService.save', () => {
  it('creates an active schedule with a next run, user-owned defaults and a changed push', () => {
    env = fakeEnv()
    const s = env.service.save(base())
    expect(s.id).toMatch(/^sch_[0-9a-f]+$/)
    expect(s).toMatchObject({ enabled: true, state: 'active', missed: 'run-once', createdBy: 'user', consecutiveFailures: 0, unread: 0 })
    expect(s.nextRunAt).toBe(new Date(2026, 10, 13, 0, 0).getTime())
    expect(env.changed.at(-1)).toEqual({ scheduleIds: [s.id] })
    expect(env.service.list().map((x) => x.id)).toEqual([s.id])
  })

  it('anchors an interval at save time and keeps the anchor when the interval is unchanged', () => {
    env = fakeEnv()
    const s = env.service.save(base({ timing: { kind: 'interval', everyMinutes: 60 } }))
    expect(s.timing).toEqual({ kind: 'interval', everyMinutes: 60, anchor: env.clock.now })
    expect(s.nextRunAt).toBe(env.clock.now + HOUR)
    env.clock.now += 10 * 60_000
    const u = env.service.save({ ...base({ timing: { kind: 'interval', everyMinutes: 60 } }), id: s.id, name: 'Renamed' })
    expect(u.timing).toEqual(s.timing)
  })

  it('refuses bypass, a mode an ask run cannot take, a missing project, a past once and a stale form', () => {
    env = fakeEnv()
    expect(() => env.service.save({ ...base(), permissionMode: 'bypassPermissions' })).toThrow(/bypass/)
    expect(() => env.service.save(base({ target: { kind: 'ask' }, permissionMode: 'acceptEdits' }))).toThrow(/ask run/)
    expect(() => env.service.save(base({ target: { kind: 'team', projectId: 'gone' } }))).toThrow(/no longer exists/)
    expect(() => env.service.save(base({ target: { kind: 'team', projectId: 'quick' } }))).toThrow(/no longer exists/)
    expect(() => env.service.save(base({ timing: { kind: 'once', at: env.clock.now - 1 } }))).toThrow(/already passed/)
    env.folderProblems.set('/bad', 'That folder does not exist.')
    expect(() => env.service.save(base({ target: { kind: 'ask', folder: '/bad' } }))).toThrow('That folder does not exist.')
    const s = env.service.save(base())
    expect(() => env.service.save({ ...base(), id: s.id, expectedUpdatedAt: s.updatedAt - 1 })).toThrow(/changed since/)
    expect(() => env.service.save({ ...base(), id: 'sch_0000ffff' })).toThrow(/no longer exists/)
  })

  it('keeps optional fields on update unless they are cleared with null', () => {
    env = fakeEnv()
    const s = env.service.save(base({ budgetUsd: 2, permissionMode: 'plan' }))
    const kept = env.service.save({ ...base(), id: s.id })
    expect(kept).toMatchObject({ budgetUsd: 2, permissionMode: 'plan' })
    const cleared = env.service.save({ ...base(), id: s.id, budgetUsd: null, permissionMode: null })
    expect(cleared.budgetUsd).toBeUndefined()
    expect(cleared.permissionMode).toBeUndefined()
  })

  it(`stops at ${SCHEDULES_MAX} schedules`, () => {
    env = fakeEnv()
    for (let i = 0; i < SCHEDULES_MAX; i++) env.service.save(base({ name: `S${i}` }))
    expect(() => env.service.save(base({ name: 'one more' }))).toThrow(/at most/)
  })
})

describe('ScheduleService enable, remove and history', () => {
  it('pausing clears the next run; enabling clears an error state and the failure count', () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const p = env.service.setEnabled(s.id, false)
    expect(p).toMatchObject({ enabled: false, state: 'paused' })
    expect(p.nextRunAt).toBeUndefined()
    env.store.update((d) => {
      Object.assign(d.schedules[0], { state: 'error', stateReason: 'x', consecutiveFailures: 3 })
    })
    const on = env.service.setEnabled(s.id, true)
    expect(on).toMatchObject({ enabled: true, state: 'active', consecutiveFailures: 0 })
    expect(on.stateReason).toBeUndefined()
    expect(on.nextRunAt).toBeGreaterThan(env.clock.now)
  })

  it('history is newest first and clears unread; remove drops schedule and history', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    await env.service.runNow(s.id)
    env.clock.now += 1000
    await env.service.runNow(s.id)
    expect(env.service.get(s.id)?.unread).toBe(2)
    const h = env.service.history(s.id)
    expect(h).toHaveLength(2)
    expect(h[0].at).toBeGreaterThan(h[1].at)
    expect(env.service.get(s.id)?.unread).toBe(0)
    env.service.remove(s.id)
    expect(env.service.list()).toEqual([])
    expect(env.store.history(s.id)).toEqual([])
    expect(env.changed.at(-1)).toEqual({ scheduleIds: [], removed: [s.id] })
  })
})

describe('ScheduleService.fire', () => {
  it('starts a team run with the schedule, its prompt, model, mode and budget; records started with lastEntry', async () => {
    env = fakeEnv()
    const s = env.service.save(base({ budgetUsd: 3, permissionMode: 'plan', modelSelection: { model: 'm1', connection: 'anthropic' }, target: { kind: 'team', projectId: 'p1', team: 'single' } }))
    const e = await env.service.runNow(s.id)
    expect(e).toMatchObject({ result: 'started', trigger: 'manual', projectId: 'p1' })
    expect(env.starts[0]).toMatchObject({
      kind: 'team',
      input: { schedule: { id: s.id, name: 'Nightly review' }, prompt: 'Review new pull requests.', budgetUsd: 3, permissionMode: 'plan', modelSelection: { model: 'm1', connection: 'anthropic' }, team: 'single' }
    })
    expect(env.service.get(s.id)?.lastEntry).toMatchObject({ result: 'started', runId: e.runId })
  })

  it('starts an ask run with its folder, re-checking the folder at each fire', async () => {
    env = fakeEnv()
    const s = env.service.save(base({ target: { kind: 'ask', folder: '/work', allowEdits: true } }))
    await env.service.runNow(s.id)
    expect(env.starts[0]).toMatchObject({ kind: 'ask', input: { folder: '/work', allowEdits: true } })
    env.folderProblems.set('/work', 'That folder is gone.')
    env.facts.clear()
    const e = await env.service.runNow(s.id)
    expect(e).toMatchObject({ result: 'failed', reason: 'start-refused', detail: START_FAILED_DETAIL })
    expect(env.starts).toHaveLength(1)
  })

  it('skips while the previous run still works or waits on a card, not when it went idle', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const first = await env.service.runNow(s.id)
    expect((await env.service.runNow(s.id)).reason).toBe('previous-running')
    env.facts.set(first.runId!, { status: 'idle', limitHold: false, pendingCards: 1, working: false })
    expect((await env.service.runNow(s.id)).reason).toBe('previous-running')
    env.facts.set(first.runId!, { status: 'idle', limitHold: false, pendingCards: 0, working: false })
    expect((await env.service.runNow(s.id)).result).toBe('started')
  })

  it(`skips with too-many-running at ${SCHEDULE_MAX_CONCURRENT_RUNS} live scheduled runs`, async () => {
    env = fakeEnv()
    const ids = ['A', 'B', 'C'].map((n) => env.service.save(base({ name: n })).id)
    for (const id of ids.slice(0, SCHEDULE_MAX_CONCURRENT_RUNS)) expect((await env.service.runNow(id)).result).toBe('started')
    expect((await env.service.runNow(ids[2])).reason).toBe('too-many-running')
  })

  it('disables a schedule whose project is gone, at once, and notifies', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.projects.delete('p1')
    const e = await env.service.runNow(s.id)
    expect(e).toMatchObject({ result: 'skipped', reason: 'project-missing' })
    expect(env.service.get(s.id)).toMatchObject({ enabled: false, state: 'error' })
    expect(env.notices).toHaveLength(1)
  })

  it(`a start that throws records an OrgAI sentence (never the error) and pauses after ${SCHEDULE_FAILURES_TO_PAUSE} in a row`, async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.failStart.message = 'provider said: secret-ish raw text'
    for (let i = 0; i < SCHEDULE_FAILURES_TO_PAUSE; i++) {
      const e = await env.service.runNow(s.id)
      expect(e.detail).toBe(START_FAILED_DETAIL)
    }
    const after = env.service.get(s.id)!
    expect(after).toMatchObject({ enabled: false, state: 'error', consecutiveFailures: SCHEDULE_FAILURES_TO_PAUSE })
    expect(after.nextRunAt).toBeUndefined()
    expect(JSON.stringify(env.store.history(s.id))).not.toContain('secret-ish')
    expect(env.notices.at(-1)?.title).toMatch(/paused/)
  })
})

describe('ScheduleService run-end bookkeeping', () => {
  it('fills outcome and cost, resets failures on a finished run and counts an error', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    env.store.update((d) => {
      d.schedules[0].consecutiveFailures = 2
    })
    const e = await env.service.runNow(s.id)
    env.summaries.set(e.runId!, { ...env.summaries.get(e.runId!)!, totalCostUsd: 0.25 })
    env.facts.delete(e.runId!)
    env.service.onRunEvent(status(e.runId!, 'finished'))
    expect(env.store.history(s.id)[0]).toMatchObject({ outcome: 'finished', costUsd: 0.25 })
    expect(env.service.get(s.id)).toMatchObject({ consecutiveFailures: 0, lastEntry: { outcome: 'finished' } })
    const e2 = await env.service.runNow(s.id)
    env.service.onRunEvent(status(e2.runId!, 'error'))
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(1)
  })

  it('a card marks needs-you; the end overwrites it; budget ends count as errors and user ends as stopped', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const e = await env.service.runNow(s.id)
    env.service.onRunEvent({ type: 'permission.request', runId: e.runId!, request: {} } as unknown as RunEvent)
    expect(env.store.history(s.id)[0].outcome).toBe('needs-you')
    env.service.onRunEvent(status(e.runId!, 'finished', { endedBy: 'budget' }))
    expect(env.store.history(s.id)[0].outcome).toBe('error')
    expect(env.service.get(s.id)?.consecutiveFailures).toBe(1)
    env.facts.clear()
    const e2 = await env.service.runNow(s.id)
    env.service.onRunEvent(status(e2.runId!, 'finished', { endedBy: 'user' }))
    expect(env.store.history(s.id).find((h) => h.runId === e2.runId)?.outcome).toBe('stopped')
  })

  it('an idle run without cards is finished for the schedule; a usage-limit pause hand-over is not an outcome', async () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const e = await env.service.runNow(s.id)
    env.service.onRunEvent(status(e.runId!, 'finished', { pausedUntil: env.clock.now + HOUR }))
    expect(env.store.history(s.id)[0].outcome).toBeUndefined()
    env.facts.set(e.runId!, { status: 'idle', limitHold: false, pendingCards: 0, working: false })
    env.service.onRunEvent(status(e.runId!, 'idle'))
    expect(env.store.history(s.id)[0].outcome).toBe('finished')
    expect(runBlocks({ status: 'idle', limitHold: false, pendingCards: 0, working: false })).toBe(false)
    expect(runBlocks({ status: 'idle', limitHold: true, pendingCards: 0, working: false })).toBe(true)
    expect(runBlocks({ status: 'idle', limitHold: false, pendingCards: 0, working: true })).toBe(true)
    expect(runBlocks(null)).toBe(false)
  })

  it('ignores runs it did not start', () => {
    env = fakeEnv()
    env.service.onRunEvent(status('run_other', 'error'))
    expect(env.changed).toEqual([])
  })
})

describe('ScheduleService.applyProposal', () => {
  const create = (over: Partial<ScheduleSaveInput> = {}): SchedulesProposalPayload => ({ rationale: 'r', items: [{ action: 'create', schedule: base(over), summary: 's', nextRuns: [] }] })

  it('saves agent schedules from Chat and reports them through access().applied', () => {
    env = fakeEnv()
    const payload = create()
    const saved = env.service.applyProposal(payload, { projectId: null })
    expect(saved[0]).toMatchObject({ createdBy: 'agent', state: 'active' })
    expect(env.service.access().applied(payload)?.map((s) => s.id)).toEqual([saved[0].id])
  })

  it('a project run may only touch its own project', () => {
    env = fakeEnv()
    env.projects.set('p2', fakeProject('p2'))
    expect(() => env.service.applyProposal(create({ target: { kind: 'team', projectId: 'p2' } }), { projectId: 'p1' })).toThrow(/own project/)
    expect(() => env.service.applyProposal(create({ target: { kind: 'ask' } }), { projectId: 'p1' })).toThrow(/own project/)
    const other = env.service.save(base({ target: { kind: 'team', projectId: 'p2' } }))
    expect(() => env.service.applyProposal({ rationale: 'r', items: [{ action: 'pause', scheduleId: other.id, summary: 's', nextRuns: [] }] }, { projectId: 'p1' })).toThrow(/own project/)
  })

  it('refuses a mode wider than the target project and writes nothing when any item fails', () => {
    env = fakeEnv()
    const before = env.service.list().length
    const payload: SchedulesProposalPayload = {
      rationale: 'r',
      items: [
        { action: 'create', schedule: base({ name: 'ok' }), summary: 's', nextRuns: [] },
        { action: 'create', schedule: base({ name: 'wide', permissionMode: 'acceptEdits' }), summary: 's', nextRuns: [] }
      ]
    }
    expect(() => env.service.applyProposal(payload, { projectId: null })).toThrow(/wider/)
    expect(env.service.list().length).toBe(before)
    expect(env.service.applyProposal(create({ permissionMode: 'plan' }), { projectId: null })[0].permissionMode).toBe('plan')
  })

  it('pause, resume and remove items', () => {
    env = fakeEnv()
    const s = env.service.save(base())
    const item = (action: 'pause' | 'resume' | 'remove') => ({ rationale: 'r', items: [{ action, scheduleId: s.id, summary: 's', nextRuns: [] }] })
    expect(env.service.applyProposal(item('pause'), { projectId: 'p1' })[0]).toMatchObject({ enabled: false, state: 'paused' })
    expect(env.service.applyProposal(item('resume'), { projectId: 'p1' })[0]).toMatchObject({ enabled: true, state: 'active' })
    env.service.applyProposal(item('remove'), { projectId: null })
    expect(env.service.list()).toEqual([])
  })
})
