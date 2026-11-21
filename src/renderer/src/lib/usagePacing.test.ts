import { describe, expect, it } from 'vitest'
import {
  PROJECTION_EARLY_TEXT,
  PROJECTION_MIN_FRACTION,
  PROJECTION_TRUNCATED_TEXT,
  PROJECTION_UNPRICED_TEXT,
  elapsedFraction,
  pacingModel,
  periodBounds,
  previousAtPoint,
  type PacingInput,
  type PacingRun
} from './usagePacing'

const DAY = 86_400_000
const local = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime()

const base = (over: Partial<PacingInput> = {}): PacingInput => ({
  since: 0,
  end: 10 * DAY,
  now: 5 * DAY,
  spendUsd: 10,
  allPriced: true,
  truncated: false,
  previous: { usd: 8, exact: true },
  previousWords: 'the previous 7 days',
  ...over
})

describe('elapsedFraction', () => {
  it('is 0 at the start, exactly a fifth at a fifth, 1 at and past the end', () => {
    expect(elapsedFraction(0, 10 * DAY, 0)).toBe(0)
    expect(elapsedFraction(0, 10 * DAY, 2 * DAY)).toBe(PROJECTION_MIN_FRACTION)
    expect(elapsedFraction(0, 10 * DAY, 10 * DAY)).toBe(1)
    expect(elapsedFraction(0, 10 * DAY, 30 * DAY)).toBe(1)
  })
  it('clamps before the start and treats an empty period as over', () => {
    expect(elapsedFraction(5 * DAY, 10 * DAY, DAY)).toBe(0)
    expect(elapsedFraction(5, 5, 5)).toBe(1)
  })
})

describe('periodBounds', () => {
  const now = local(2026, 11, 21, 12)
  it('rolling days run to the end of today', () => {
    const b = periodBounds({ kind: 'days', days: 7 }, now)
    expect(b.since).toBe(local(2026, 11, 15))
    expect(b.end).toBe(local(2026, 11, 22))
  })
  it('this month runs to the first of the next month; lengths differ', () => {
    expect(periodBounds({ kind: 'this-month' }, now)).toEqual({ since: local(2026, 11, 1), end: local(2026, 12, 1) })
    const feb = local(2026, 2, 10, 12)
    expect(periodBounds({ kind: 'this-month' }, feb).end - periodBounds({ kind: 'this-month' }, feb).since).toBe(28 * DAY)
    const oct = local(2026, 10, 10, 12)
    expect(periodBounds({ kind: 'this-month' }, oct).end - periodBounds({ kind: 'this-month' }, oct).since).toBeGreaterThanOrEqual(31 * DAY - 3_600_000)
  })
  it('a finished month ends where it ends, a running months range at its last month', () => {
    expect(periodBounds({ kind: 'last-month' }, now)).toEqual({ since: local(2026, 10, 1), end: local(2026, 11, 1) })
    expect(periodBounds({ kind: 'months', from: '2026-09', to: '2026-11' }, now)).toEqual({ since: local(2026, 9, 1), end: local(2026, 12, 1) })
    expect(periodBounds({ kind: 'months', from: '2026-08', to: '2026-09' }, now)).toEqual({ since: local(2026, 8, 1), end: local(2026, 10, 1) })
  })
})

describe('previousAtPoint', () => {
  const runs: PacingRun[] = [
    { startedAt: 1 * DAY, usd: 2, exact: true },
    { startedAt: 4 * DAY, usd: 3, exact: true },
    { startedAt: 8 * DAY, usd: 5, exact: true }
  ]
  const prev = { since: 0, until: 10 * DAY }
  it('counts runs that started before the same elapsed time', () => {
    expect(previousAtPoint(runs, prev, 5 * DAY, false)).toEqual({ usd: 5, exact: true })
    expect(previousAtPoint(runs, prev, 0, false)).toEqual({ usd: 0, exact: true })
  })
  it('a period that is over compares with the whole previous period', () => {
    expect(previousAtPoint(runs, prev, 5 * DAY, true).usd).toBe(10)
  })
  it('caps at the previous period when it was shorter (30 days after 31)', () => {
    expect(previousAtPoint(runs, { since: 0, until: 9 * DAY }, 20 * DAY, false).usd).toBe(10)
    expect(previousAtPoint(runs, { since: 0, until: 8 * DAY }, 20 * DAY, false).usd).toBe(5)
  })
  it('an unpriced or partly priced run makes the figure "at least"', () => {
    expect(previousAtPoint([...runs, { startedAt: 2 * DAY, usd: null, exact: false }], prev, 5 * DAY, false)).toEqual({ usd: 5, exact: false })
    expect(previousAtPoint([{ startedAt: 2 * DAY, usd: 1, exact: false }], prev, 5 * DAY, false)).toEqual({ usd: 1, exact: false })
  })
  it('ignores runs outside the previous period', () => {
    expect(previousAtPoint([{ startedAt: -DAY, usd: 9, exact: true }, { startedAt: 12 * DAY, usd: 9, exact: true }], prev, 5 * DAY, true).usd).toBe(0)
  })
})

describe('pacingModel projection', () => {
  it('is a straight line from spend over elapsed time, labelled Projected', () => {
    const m = pacingModel(base())
    expect(m.state).toBe('shown')
    expect(m.projectedUsd).toBe(20)
    expect(m.projectionText).toMatch(/^Projected \$20\.00 by /)
    expect(m.dial?.fill).toBe(0.5)
  })
  it('is hidden under a fifth with the needs-more-data text', () => {
    const m = pacingModel(base({ now: 1.9 * DAY }))
    expect(m.state).toBe('early')
    expect(m.projectionText).toBe(PROJECTION_EARLY_TEXT)
    expect(m.dial).toBeNull()
    expect(m.projectedUsd).toBeNull()
  })
  it('is shown at exactly a fifth', () => {
    const m = pacingModel(base({ now: 2 * DAY, spendUsd: 4 }))
    expect(m.state).toBe('shown')
    expect(m.projectedUsd).toBeCloseTo(20)
  })
  it('is hidden when any run is unpriced, and never turns unknown spend into a figure', () => {
    const m = pacingModel(base({ allPriced: false }))
    expect(m.state).toBe('unpriced')
    expect(m.projectionText).toBe(PROJECTION_UNPRICED_TEXT)
    expect(m.dial).toBeNull()
    expect(pacingModel(base({ spendUsd: null, allPriced: false })).state).toBe('unpriced')
    expect(pacingModel(base({ spendUsd: null, allPriced: false })).projectedUsd).toBeNull()
  })
  it('under a fifth wins over unpriced; both are hidden', () => {
    expect(pacingModel(base({ now: DAY, allPriced: false })).state).toBe('early')
  })
  it('is hidden when the data was cut short', () => {
    const m = pacingModel(base({ truncated: true }))
    expect(m.state).toBe('truncated')
    expect(m.projectionText).toBe(PROJECTION_TRUNCATED_TEXT)
  })
  it('is not needed once the period is over (at and past the end)', () => {
    expect(pacingModel(base({ now: 10 * DAY })).state).toBe('ended')
    expect(pacingModel(base({ now: 40 * DAY })).state).toBe('ended')
    expect(pacingModel(base({ now: 40 * DAY })).dial).toBeNull()
  })
  it('zero spend projects zero and the dial stays empty', () => {
    const m = pacingModel(base({ spendUsd: 0, previous: { usd: 0, exact: true } }))
    expect(m.state).toBe('shown')
    expect(m.projectedUsd).toBe(0)
    expect(m.dial?.fill).toBe(0)
    expect(m.dial?.tick).toBeNull()
  })
})

describe('pacingModel pace and tick', () => {
  it('says more with a glyph and the figure', () => {
    const m = pacingModel(base())
    expect(m.pace).toEqual({ glyph: '▲', text: '▲ $2.00 more than the previous 7 days at this point', deltaUsd: 2 })
  })
  it('says less', () => {
    const m = pacingModel(base({ previous: { usd: 12.4, exact: true } }))
    expect(m.pace?.glyph).toBe('▼')
    expect(m.pace?.text).toBe('▼ $2.40 less than the previous 7 days at this point')
  })
  it('says level inside half a cent', () => {
    const m = pacingModel(base({ previous: { usd: 10.001, exact: true } }))
    expect(m.pace).toEqual({ glyph: null, text: 'Level with the previous 7 days at this point.', deltaUsd: 0 })
  })
  it('puts the tick where the previous period stood, as a share of the projection', () => {
    const m = pacingModel(base())
    expect(m.dial?.tick).toBeCloseTo(8 / 20)
    expect(m.dial?.tickText).toBe('Tick: the previous 7 days at this point, $8.00')
  })
  it('clamps a tick beyond the projection to the end of the dial', () => {
    expect(pacingModel(base({ previous: { usd: 100, exact: true } })).dial?.tick).toBe(1)
  })
  it('compares nothing when either side has an unpriced run and draws no tick for a lower bound', () => {
    const m = pacingModel(base({ previous: { usd: 8, exact: false } }))
    expect(m.pace?.glyph).toBeNull()
    expect(m.pace?.deltaUsd).toBeNull()
    expect(m.dial?.tick).toBeNull()
    expect(m.dial?.tickText).toBeNull()
    expect(pacingModel(base({ allPriced: false })).pace?.deltaUsd).toBeNull()
  })
  it('has no pace sentence without a previous period', () => {
    expect(pacingModel(base({ previous: null })).pace).toBeNull()
    expect(pacingModel(base({ previous: null })).dial?.tick).toBeNull()
  })
  it('a finished period compares in full, without "at this point"', () => {
    expect(pacingModel(base({ now: 12 * DAY })).pace?.text).toBe('▲ $2.00 more than the previous 7 days')
  })
  it('the dial text names spend, projection, share and tick for a screen reader', () => {
    const t = pacingModel(base()).dial?.text ?? ''
    expect(t).toContain('$10.00 so far of a projected $20.00')
    expect(t).toContain('50 percent')
    expect(t).toContain('Tick: the previous 7 days at this point, $8.00')
  })
})

describe('pacingModel across month lengths', () => {
  it('this month on day 21 of 30 against a 31-day month at the same elapsed time', () => {
    const now = local(2026, 11, 21, 0)
    const b = periodBounds({ kind: 'this-month' }, now)
    const m = pacingModel({ ...base(), since: b.since, end: b.end, now, spendUsd: 21, previous: { usd: 18, exact: true } })
    // 20 days into a 30-day month (an hour of DST drift is allowed for).
    expect(m.fraction).toBeCloseTo(20 / 30, 2)
    expect(m.projectedUsd).toBeCloseTo(31.5, 0)
    const oct = { since: local(2026, 10, 1), until: local(2026, 11, 1) }
    const at = previousAtPoint(
      [{ startedAt: local(2026, 10, 20), usd: 5, exact: true }, { startedAt: local(2026, 10, 25), usd: 7, exact: true }],
      oct,
      now - b.since,
      false
    )
    expect(at.usd).toBe(5)
  })
})
