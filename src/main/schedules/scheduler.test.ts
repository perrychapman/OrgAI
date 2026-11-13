import { afterEach, describe, expect, it } from 'vitest'
import { SCHEDULE_CATCH_UP_WINDOW_MS } from '@shared/types'
import type { ScheduleSaveInput } from '@shared/types'
import { BOOT_DELAY_MS, CATCH_UP_GAP_MS, LATE_MS, MAX_SLEEP_MS, Scheduler, latestDueSlot, testTickMs, type SchedulerClock } from './scheduler'
import { fakeEnv, type FakeEnv } from './testkit'

let env: FakeEnv
afterEach(() => env?.cleanup())

const MIN = 60_000
const HOUR = 60 * MIN

/** A clock whose timers only run when the test advances it. */
function fakeClock(e: FakeEnv): SchedulerClock & { timers: { at: number; fn: () => void; id: number }[]; advance(ms: number): Promise<void> } {
  let seq = 0
  const timers: { at: number; fn: () => void; id: number }[] = []
  const clock = {
    timers,
    now: () => e.clock.now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.push({ at: e.clock.now + ms, fn, id })
      return id
    },
    clearTimeout: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    async advance(ms: number) {
      const end = e.clock.now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        e.clock.now = Math.max(e.clock.now, t.at)
        t.fn()
        // Let the async wake (and its awaited starts) finish.
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
      e.clock.now = end
    }
  }
  return clock
}

const daily = (time: string, over: Partial<ScheduleSaveInput> = {}): ScheduleSaveInput => ({
  name: `At ${time}`,
  prompt: 'Do it.',
  target: { kind: 'team', projectId: 'p1' },
  timing: { kind: 'daily', time },
  ...over
})

function setup(): { clock: ReturnType<typeof fakeClock>; scheduler: Scheduler } {
  const clock = fakeClock(env)
  const scheduler = new Scheduler({ service: env.service, globallyPaused: () => env.paused.value, clock })
  return { clock, scheduler }
}

describe('Scheduler', () => {
  it('fires a due slot once, marking it before the start, and plans the next one', async () => {
    env = fakeEnv() // 2026-11-12 10:00 local
    const s = env.service.save(daily('10:30'))
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(29 * MIN)
    expect(env.starts).toHaveLength(0)
    await clock.advance(2 * MIN)
    expect(env.starts).toHaveLength(1)
    const after = env.service.get(s.id)!
    expect(after.lastSlotAt).toBe(new Date(2026, 10, 12, 10, 30).getTime())
    expect(after.nextRunAt).toBe(new Date(2026, 10, 13, 10, 30).getTime())
    await clock.advance(10 * MIN)
    expect(env.starts).toHaveLength(1)
    // Never sleeps longer than MAX_SLEEP_MS.
    expect(Math.max(...clock.timers.map((t) => t.at)) - env.clock.now).toBeLessThanOrEqual(MAX_SLEEP_MS)
    scheduler.stop()
  })

  it('a crash between mark and start never refires the slot', async () => {
    env = fakeEnv()
    const s = env.service.save(daily('10:30'))
    const slot = env.service.get(s.id)!.nextRunAt!
    env.clock.now = slot + MIN
    env.service.claimSlot(s.id, slot) // the mark landed, then the process died
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(BOOT_DELAY_MS + MIN)
    expect(env.starts).toHaveLength(0)
    scheduler.stop()
  })

  it('after a long sleep starts one catch-up for the latest missed slot, after the boot delay', async () => {
    env = fakeEnv()
    const s = env.service.save({ ...daily('x'), timing: { kind: 'interval', everyMinutes: 60 } })
    env.clock.now += 5 * HOUR + 10 * MIN // five slots passed while OrgAI was closed
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(BOOT_DELAY_MS - 1000)
    expect(env.starts).toHaveLength(0)
    await clock.advance(2000)
    expect(env.starts).toHaveLength(1)
    const h = env.store.history(s.id)
    expect(h.map((x) => [x.trigger, x.result])).toEqual([['catch-up', 'started']])
    expect(env.service.get(s.id)!.nextRunAt).toBeGreaterThan(env.clock.now)
    scheduler.stop()
  })

  it('catch-ups of several schedules start CATCH_UP_GAP_MS apart', async () => {
    env = fakeEnv()
    env.service.save({ ...daily('a', { name: 'A' }), timing: { kind: 'interval', everyMinutes: 60 } })
    env.service.save({ ...daily('b', { name: 'B', target: { kind: 'ask' } }), timing: { kind: 'interval', everyMinutes: 60 } })
    env.clock.now += 2 * HOUR + 10 * MIN
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(BOOT_DELAY_MS + 1000)
    expect(env.starts).toHaveLength(1)
    await clock.advance(CATCH_UP_GAP_MS)
    expect(env.starts).toHaveLength(2)
    scheduler.stop()
  })

  it("records app-closed for a missed slot with missed 'skip' or outside the catch-up window", async () => {
    env = fakeEnv()
    const skip = env.service.save(daily('10:30', { name: 'skip', missed: 'skip' }))
    // A daily slot is never older than a day, so the slot outside the window is a once schedule's.
    const old = env.service.save({ ...daily('x', { name: 'old' }), timing: { kind: 'once', at: env.clock.now + 5 * MIN } })
    env.clock.now += SCHEDULE_CATCH_UP_WINDOW_MS + 2 * HOUR
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(BOOT_DELAY_MS + MIN)
    expect(env.starts).toHaveLength(0)
    for (const id of [skip.id, old.id]) expect(env.store.history(id).map((x) => x.reason)).toEqual(['app-closed'])
    scheduler.stop()
  })

  it('a slot late by less than LATE_MS fires on time (trigger timer)', async () => {
    env = fakeEnv()
    const s = env.service.save(daily('10:30'))
    env.clock.now = env.service.get(s.id)!.nextRunAt! + LATE_MS - 1000
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(10)
    expect(env.store.history(s.id)[0]).toMatchObject({ trigger: 'timer', result: 'started' })
    scheduler.stop()
  })

  it('the global pause records one paused-globally entry per schedule per pause and moves the slots on', async () => {
    env = fakeEnv()
    const s = env.service.save({ ...daily('x'), timing: { kind: 'interval', everyMinutes: 15 } })
    env.paused.value = true
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(HOUR + MIN)
    expect(env.starts).toHaveLength(0)
    expect(env.store.history(s.id).map((h) => h.reason)).toEqual(['paused-globally'])
    expect(env.service.get(s.id)!.nextRunAt).toBeGreaterThan(env.clock.now)
    env.paused.value = false
    await clock.advance(16 * MIN)
    expect(env.starts).toHaveLength(1)
    scheduler.stop()
  })

  it('a once schedule goes to done after its run; an expired one goes to done without a run', async () => {
    env = fakeEnv()
    const once = env.service.save({ ...daily('x', { name: 'once' }), timing: { kind: 'once', at: env.clock.now + 5 * MIN } })
    const exp = env.service.save(daily('23:00', { name: 'exp', expiresAt: env.clock.now + 20 * HOUR }))
    expect(env.service.get(exp.id)?.nextRunAt).toBeDefined()
    // The end date moved before the next slot (an older file, a clock change): the scheduler retires it unrun.
    env.store.update((d) => {
      d.schedules.find((x) => x.id === exp.id)!.expiresAt = env.clock.now + 2 * HOUR
    })
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(6 * MIN)
    expect(env.starts).toHaveLength(1)
    expect(env.service.get(once.id)).toMatchObject({ state: 'done', enabled: false })
    expect(env.service.get(exp.id)).toMatchObject({ state: 'done', enabled: false })
    scheduler.stop()
  })

  it('overlap: a slot while the previous run still works is skipped previous-running', async () => {
    env = fakeEnv()
    const s = env.service.save({ ...daily('x'), timing: { kind: 'interval', everyMinutes: 15 } })
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(16 * MIN)
    await clock.advance(15 * MIN)
    expect(env.starts).toHaveLength(1)
    expect(env.store.history(s.id).map((h) => h.reason ?? h.result)).toEqual(['previous-running', 'started'])
    scheduler.stop()
  })

  it('stop() cancels the timer; start() is idempotent', async () => {
    env = fakeEnv()
    env.service.save(daily('10:30'))
    const { clock, scheduler } = setup()
    scheduler.start()
    scheduler.start()
    expect(clock.timers).toHaveLength(1)
    scheduler.stop()
    expect(clock.timers).toHaveLength(0)
    await clock.advance(HOUR)
    expect(env.starts).toHaveLength(0)
  })
})

describe('scheduler helpers', () => {
  it('latestDueSlot walks to the last slot at or before now', () => {
    const t0 = Date.UTC(2026, 0, 1)
    const r = latestDueSlot({ timing: { kind: 'interval', everyMinutes: 60, anchor: t0 } }, t0 + HOUR, t0 + 5 * HOUR + 1)
    expect(r).toEqual({ slot: t0 + 5 * HOUR, skippedEarlier: true })
    expect(latestDueSlot({ timing: { kind: 'interval', everyMinutes: 60, anchor: t0 } }, t0 + HOUR, t0 + HOUR + 1)).toEqual({ slot: t0 + HOUR, skippedEarlier: false })
  })

  it('the test tick is honoured only with ORGAI_MOCK=1 and within bounds', () => {
    expect(testTickMs({ ORGAI_SCHEDULE_TEST_TICK_MS: '500' })).toBeUndefined()
    expect(testTickMs({ ORGAI_MOCK: '1', ORGAI_SCHEDULE_TEST_TICK_MS: '500' })).toBe(500)
    expect(testTickMs({ ORGAI_MOCK: '1', ORGAI_SCHEDULE_TEST_TICK_MS: '5' })).toBeUndefined()
    expect(testTickMs({ ORGAI_MOCK: '1' })).toBeUndefined()
  })
})
