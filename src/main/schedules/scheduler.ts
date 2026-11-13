/**
 * Scheduler (docs/design/schedules.md 4): one timer with an injected clock. It wakes at the earliest next run (at most
 * every 60 s, so a sleep or a clock change is noticed) and handles every due schedule in name order:
 *  1. Due when nextRunAt <= now. The slot is marked (lastSlotAt, the next run) BEFORE the run starts, so a crash
 *     never refires it.
 *  2. Lateness over LATE_MS makes the slot missed: with missed 'run-once' and within SCHEDULE_CATCH_UP_WINDOW_MS one
 *     run starts for the latest missed slot (trigger 'catch-up'); otherwise one skipped entry 'app-closed'. Earlier
 *     slots missed alongside an on-time one get one 'app-closed' entry. Never more than one run per schedule per wake.
 *  3. Overlap and the global cap: ScheduleService.fire.
 *  4. Failures and auto-pause: ScheduleService.
 *  5. once and expired schedules go to 'done' (ScheduleService.claimSlot / expire).
 *  6. Catch-up runs start no earlier than BOOT_DELAY_MS after start() and CATCH_UP_GAP_MS apart.
 * While AppSettings.schedulesPaused is on, nothing fires: a due schedule gets one skipped 'paused-globally' entry per
 * pause and its slots move on. Started only by the desktop shell (index.ts); never on the CLI's in-process host.
 */
import { compileScheduleTiming } from '@shared/schedule'
import { SCHEDULE_CATCH_UP_WINDOW_MS } from '@shared/types'
import type { Schedule } from '@shared/types'
import type { ScheduleService } from './service'

export const LATE_MS = 5 * 60_000
export const MAX_SLEEP_MS = 60_000
export const BOOT_DELAY_MS = 30_000
export const CATCH_UP_GAP_MS = 10_000
/** Upper bound of the walk to the latest missed slot (a 15-minute interval over a year is ~35,000 slots). */
const MAX_SLOT_WALK = 50_000

export interface SchedulerClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SchedulerOptions {
  service: ScheduleService
  /** AppSettings.schedulesPaused, read at every wake. */
  globallyPaused(): boolean
  clock?: SchedulerClock
  /** The longest sleep between wakes (ORGAI_SCHEDULE_TEST_TICK_MS with ORGAI_MOCK=1; default MAX_SLEEP_MS). */
  maxSleepMs?: number
  log?(message: string): void
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** The test tick from the environment: honoured only with ORGAI_MOCK=1, between 50 ms and 60 s. */
export function testTickMs(env: Record<string, string | undefined>): number | undefined {
  if (env.ORGAI_MOCK !== '1') return undefined
  const n = Number(env.ORGAI_SCHEDULE_TEST_TICK_MS)
  return Number.isFinite(n) && n >= 50 && n <= MAX_SLEEP_MS ? Math.floor(n) : undefined
}

/**
 * The latest slot at or before `now`, walking from the due slot `first`; and whether earlier slots were passed over.
 * The timing is compiled once. A slot older than SCHEDULE_CATCH_UP_WINDOW_MS + LATE_MS is never caught up or run, so the
 * walk starts no earlier than that floor: when a slot exists in (floor, now] the walk continues from there; when none
 * does, the reported slot is `first` itself (the first missed one, not the latest; the caller only records it in an
 * 'app-closed' skip and claimSlot computes the next run from now, so the difference is harmless).
 */
export function latestDueSlot(s: Pick<Schedule, 'timing'>, first: number, now: number): { slot: number; skippedEarlier: boolean } {
  const next = compileScheduleTiming(s.timing)
  if (next === null) return { slot: first, skippedEarlier: false }
  let slot = first
  let skippedEarlier = false
  const floor = now - SCHEDULE_CATCH_UP_WINDOW_MS - LATE_MS
  if (floor > first) {
    const probe = next(floor)
    if (probe === null || probe > now) {
      const following = next(first)
      return { slot: first, skippedEarlier: following !== null && following <= now }
    }
    slot = probe
    skippedEarlier = true
  }
  for (let i = 0; i < MAX_SLOT_WALK; i++) {
    const n = next(slot)
    if (n === null || n > now) break
    slot = n
    skippedEarlier = true
  }
  return { slot, skippedEarlier }
}

export class Scheduler {
  private readonly clock: SchedulerClock
  private readonly maxSleepMs: number
  private timer: unknown
  private running = false
  private again = false
  private stopped = true
  private startedAt = 0
  private lastCatchUpAt = -Infinity
  /** Schedules that got their 'paused-globally' entry in the current global pause. */
  private readonly pauseNoted = new Set<string>()

  constructor(private readonly opts: SchedulerOptions) {
    this.clock = opts.clock ?? realClock
    this.maxSleepMs = opts.maxSleepMs ?? MAX_SLEEP_MS
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.startedAt = this.clock.now()
    this.arm(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Re-plan now (a schedule or the global pause changed). */
  poke(): void {
    if (!this.stopped) this.arm(0)
  }

  private arm(ms: number): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.wake()
    }, Math.max(0, Math.min(ms, this.maxSleepMs)))
  }

  /** One pass over the due schedules; exported through the class for tests. */
  async wake(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    let wakeAt = Infinity
    try {
      do {
        this.again = false
        wakeAt = await this.pass()
      } while (this.again && !this.stopped)
    } catch (e) {
      this.opts.log?.(`The scheduler pass failed: ${(e as Error)?.message ?? String(e)}`)
    } finally {
      this.running = false
    }
    if (!this.stopped) this.arm(Number.isFinite(wakeAt) ? wakeAt - this.clock.now() : this.maxSleepMs)
  }

  /** Handle due schedules; returns when to wake next (epoch ms). */
  private async pass(): Promise<number> {
    const svc = this.opts.service
    let wakeAt = Infinity
    const due = (s: Schedule): boolean => s.enabled && s.nextRunAt !== undefined && s.nextRunAt <= this.clock.now()
    // The order and planned slot come from one snapshot; everything else is re-read on every iteration, because an
    // awaited start lets the user delete, pause or edit another schedule or turn on Pause all.
    const snapshot = svc.list().map((x) => ({ id: x.id, nextRunAt: x.nextRunAt }))
    for (const snap of snapshot) {
      if (this.stopped) break
      const s = svc.get(snap.id)
      // An edited schedule (a different next run) is re-planned by the next pass: the service pokes the scheduler.
      if (!s || !s.enabled || s.nextRunAt === undefined || s.nextRunAt !== snap.nextRunAt) continue
      const paused = this.opts.globallyPaused()
      if (!paused) this.pauseNoted.clear()
      const now = this.clock.now()
      if (s.expiresAt !== undefined && s.nextRunAt > s.expiresAt) {
        svc.expire(s.id)
        continue
      }
      if (!due(s)) {
        wakeAt = Math.min(wakeAt, s.nextRunAt)
        continue
      }
      const { slot, skippedEarlier } = latestDueSlot(s, s.nextRunAt, now)
      if (paused) {
        const claimed = svc.claimSlot(s.id, slot)
        if (!this.pauseNoted.has(s.id)) {
          this.pauseNoted.add(s.id)
          svc.recordSkip(s.id, slot, 'timer', 'paused-globally')
        }
        if (claimed?.nextRunAt !== undefined) wakeAt = Math.min(wakeAt, claimed.nextRunAt)
        continue
      }
      const late = now - slot > LATE_MS
      if (!late) {
        // On time: earlier slots passed over (a sleep shorter than the catch-up rules care about) are recorded once.
        if (skippedEarlier) svc.recordSkip(s.id, s.nextRunAt, 'timer', 'app-closed')
        const claimed = svc.claimSlot(s.id, slot)
        if (!claimed) continue
        if (claimed.nextRunAt !== undefined) wakeAt = Math.min(wakeAt, claimed.nextRunAt)
        await svc.fire(claimed, slot, 'timer')
        continue
      }
      const catchUp = s.missed === 'run-once' && now - slot <= SCHEDULE_CATCH_UP_WINDOW_MS
      if (!catchUp) {
        const claimed = svc.claimSlot(s.id, slot)
        svc.recordSkip(s.id, slot, 'timer', 'app-closed')
        if (claimed?.nextRunAt !== undefined) wakeAt = Math.min(wakeAt, claimed.nextRunAt)
        continue
      }
      // Boot stagger: no catch-up in the first BOOT_DELAY_MS, and CATCH_UP_GAP_MS between two catch-ups.
      const allowedAt = Math.max(this.startedAt + BOOT_DELAY_MS, this.lastCatchUpAt + CATCH_UP_GAP_MS)
      if (now < allowedAt) {
        wakeAt = Math.min(wakeAt, allowedAt)
        continue
      }
      this.lastCatchUpAt = now
      const claimed = svc.claimSlot(s.id, slot)
      if (!claimed) continue
      if (claimed.nextRunAt !== undefined) wakeAt = Math.min(wakeAt, claimed.nextRunAt)
      await svc.fire(claimed, slot, 'catch-up')
    }
    return wakeAt
  }
}
