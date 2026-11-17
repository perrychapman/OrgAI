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

describe('Scheduler re-reads state between starts', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  /** Two schedules due at 10:30 whose start is held open until `release()`; `started` lists the names that began to start. */
  async function twoDueWithHeldStart(): Promise<{ started: string[]; release(): Promise<void>; a: string; b: string; scheduler: Scheduler }> {
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    const started: string[] = []
    env = fakeEnv({
      startTeam: async (project, input) => {
        started.push(input.schedule.name)
        await gate
        const run = { id: `run_held_${started.length}`, projectId: project.id, status: 'running', kind: 'work', prompt: '', startedAt: env.clock.now, totalCostUsd: 0 } as never
        return run
      }
    })
    const a = env.service.save(daily('10:30', { name: 'A' }))
    const b = env.service.save(daily('10:30', { name: 'B' }))
    const { clock, scheduler } = setup()
    scheduler.start()
    await clock.advance(31 * MIN)
    await flush()
    expect(started).toEqual(['A']) // A's start is awaited; B waits behind it
    return {
      started,
      a: a.id,
      b: b.id,
      scheduler,
      release: async () => {
        open()
        await flush()
      }
    }
  }

  it('a schedule deleted while an earlier start is awaited does not start', async () => {
    const t = await twoDueWithHeldStart()
    env.service.remove(t.b)
    await t.release()
    expect(t.started).toEqual(['A'])
    expect(env.service.get(t.b)).toBeUndefined()
    expect(env.store.history(t.b)).toEqual([])
    t.scheduler.stop()
  })

  it('a schedule paused while an earlier start is awaited does not start and gets no next run', async () => {
    const t = await twoDueWithHeldStart()
    env.service.setEnabled(t.b, false)
    await t.release()
    expect(t.started).toEqual(['A'])
    const b = env.service.get(t.b)!
    expect(b.enabled).toBe(false)
    expect(b.nextRunAt).toBeUndefined()
    expect(b.lastSlotAt).toBeUndefined()
    expect(env.store.history(t.b)).toEqual([])
    t.scheduler.stop()
  })

  it('Pause all turned on while an earlier start is awaited gives the next schedule the paused-globally skip', async () => {
    const t = await twoDueWithHeldStart()
    env.paused.value = true
    await t.release()
    expect(t.started).toEqual(['A'])
    expect(env.store.history(t.b).map((h) => [h.result, h.reason])).toEqual([['skipped', 'paused-globally']])
    t.scheduler.stop()
  })
})

describe('catch-up walk over a long gap', () => {
  const SIX_MONTHS_MS = 183 * 24 * HOUR
  const cron15 = { kind: 'cron', expression: '*/15 * * * *' } as const
  const interval15 = { kind: 'interval', everyMinutes: 15, anchor: new Date(2026, 4, 12, 10, 0).getTime() } as const

  it('resolves the latest slot of a 15-minute cron six months back quickly', () => {
    const now = new Date(2026, 10, 12, 10, 7).getTime()
    const first = new Date(2026, 4, 12, 10, 0).getTime()
    const t0 = Date.now()
    const r = latestDueSlot({ timing: cron15 }, first, now)
    expect(Date.now() - t0).toBeLessThan(250)
    expect(r).toEqual({ slot: new Date(2026, 10, 12, 10, 0).getTime(), skippedEarlier: true })
  })

  it('resolves the latest slot of a 15-minute interval six months back quickly', () => {
    const now = new Date(2026, 10, 12, 10, 7).getTime()
    const first = interval15.anchor + 15 * MIN
    const t0 = Date.now()
    const r = latestDueSlot({ timing: interval15 }, first, now)
    expect(Date.now() - t0).toBeLessThan(250)
    expect(r.skippedEarlier).toBe(true)
    expect(r.slot).toBeLessThanOrEqual(now)
    expect(r.slot).toBeGreaterThan(now - 15 * MIN)
    expect((r.slot - interval15.anchor) % (15 * MIN)).toBe(0)
  })

  it('with no slot inside the catch-up window reports the first missed slot without walking from it', () => {
    // One slot a year (1 January 03:00): the one missed slot is far older than the window and no slot lies in (floor, now].
    const timing = { kind: 'cron', expression: '0 3 1 1 *' } as const // once a year
    const first = new Date(2026, 0, 1, 3, 0).getTime()
    const now = new Date(2026, 10, 12, 10, 7).getTime()
    const t0 = Date.now()
    const r = latestDueSlot({ timing }, first, now)
    expect(Date.now() - t0).toBeLessThan(250)
    expect(r.slot).toBe(first)
    expect(r.skippedEarlier).toBe(false) // the next slot (next January) is still in the future
  })

  it('a pass over a schedule whose next run is six months old records one app-closed skip and does not hang', async () => {
    env = fakeEnv() // 2026-11-12 10:00
    const s = env.service.save({ ...daily('x', { name: 'old cron', missed: 'skip' }), timing: cron15 })
    env.store.update((d) => {
      d.schedules.find((x) => x.id === s.id)!.nextRunAt = env.clock.now - SIX_MONTHS_MS
    })
    env.clock.now += 7 * MIN
    const { clock, scheduler } = setup()
    const t0 = Date.now()
    scheduler.start()
    await clock.advance(1)
    scheduler.stop()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(env.starts).toHaveLength(0)
    expect(env.store.history(s.id).map((h) => h.reason)).toEqual(['app-closed'])
    expect(env.service.get(s.id)!.nextRunAt).toBeGreaterThan(env.clock.now)
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
