import { describe, expect, it } from 'vitest'
import { DOT_GAP_PX, layoutRail, MIN_SPAN_MS, outcomeTone, pickRailRows, railDomain, railItemName, railTicks, railX, RAIL_PAD_PX, spreadDots } from './scheduleRail'

const at = (h: number, m = 0): number => new Date(2026, 10, 19, h, m).getTime()
const midnight = new Date(2026, 10, 20).getTime()

describe('railDomain', () => {
  it('runs from the hour of now to midnight', () => {
    const d = railDomain([at(14, 30)], at(9, 20))
    expect(d.start).toBe(at(9))
    expect(d.end).toBe(midnight)
  })
  it('starts at the earliest run that already happened', () => {
    expect(railDomain([at(6, 15), at(14)], at(9, 20)).start).toBe(at(6))
  })
  it('never gets shorter than six hours, and never goes before 00:00', () => {
    const d = railDomain([at(23)], at(22, 40))
    expect(d.end - d.start).toBe(MIN_SPAN_MS)
    expect(d.start).toBe(at(18))
    const late = railDomain([], at(1))
    expect(late.start).toBe(at(1))
  })
})

describe('railTicks', () => {
  it('lists whole hours strictly inside the domain', () => {
    const ticks = railTicks({ start: at(9, 20), end: at(12) })
    expect(ticks).toEqual([at(10), at(11)])
  })
  it('skips a tick on the start itself only once', () => {
    expect(railTicks({ start: at(9), end: at(11) })).toEqual([at(10)])
  })
})

describe('railX', () => {
  const domain = { start: at(12), end: at(24) }
  it('maps the domain across the padded width and clamps', () => {
    expect(railX(at(12), domain, 400)).toBe(RAIL_PAD_PX)
    expect(railX(at(24), domain, 400)).toBe(400 - RAIL_PAD_PX)
    expect(railX(at(18), domain, 400)).toBe(200)
    expect(railX(at(3), domain, 400)).toBe(RAIL_PAD_PX)
  })
})

describe('spreadDots', () => {
  it('keeps order and the minimum distance', () => {
    const out = spreadDots([100, 101, 102], 0, 400)
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(DOT_GAP_PX)
    expect(out[2] - out[1]).toBeGreaterThanOrEqual(DOT_GAP_PX)
  })
  it('pushes a crowd at the right edge back inside', () => {
    const out = spreadDots([398, 399, 400], 0, 400)
    expect(out[2]).toBe(400)
    expect(out[1]).toBe(400 - DOT_GAP_PX)
    expect(out[0]).toBe(400 - 2 * DOT_GAP_PX)
  })
})

describe('layoutRail', () => {
  const domain = { start: at(9), end: midnight }
  it('puts well separated labels in lane 0', () => {
    const out = layoutRail(
      [
        { key: 'a', at: at(10), labelChars: 8 },
        { key: 'b', at: at(16), labelChars: 8 }
      ],
      domain,
      600
    )
    expect(out.map((p) => p.lane)).toEqual([0, 0])
    expect(out[0].x).toBeLessThan(out[1].x)
  })
  it('drops a colliding label to lane 1, then folds the next into a count', () => {
    const out = layoutRail(
      [
        { key: 'a', at: at(10), labelChars: 8 },
        { key: 'b', at: at(10, 10), labelChars: 8 },
        { key: 'c', at: at(10, 20), labelChars: 8 },
        { key: 'd', at: at(10, 30), labelChars: 8 }
      ],
      domain,
      600
    )
    expect(out[0].lane).toBe(0)
    expect(out[1].lane).toBe(1)
    expect(out.slice(2).some((p) => p.lane === null)).toBe(true)
    const folded = out.reduce((n, p) => n + p.extra, 0)
    expect(folded).toBe(out.filter((p) => p.lane === null).length)
    // Dots never collide, even where labels fold.
    for (let i = 1; i < out.length; i++) expect(out[i].x - out[i - 1].x).toBeGreaterThanOrEqual(DOT_GAP_PX - 0.001)
  })
  it('is in time order whatever the input order', () => {
    const out = layoutRail(
      [
        { key: 'late', at: at(20), labelChars: 8 },
        { key: 'early', at: at(10), labelChars: 8 }
      ],
      domain,
      600
    )
    expect(out.map((p) => p.key)).toEqual(['early', 'late'])
  })
  it('handles one item and none', () => {
    expect(layoutRail([], domain, 600)).toEqual([])
    expect(layoutRail([{ key: 'a', at: at(12), labelChars: 8 }], domain, 600)[0].lane).toBe(0)
  })
})

describe('pickRailRows', () => {
  const rows = [
    { id: 'r1', state: 'ran' as const, at: at(6) },
    { id: 'r2', state: 'ran' as const, at: at(8) },
    { id: 'u1', state: 'upcoming' as const, at: at(12) },
    { id: 'u2', state: 'upcoming' as const, at: at(14) },
    { id: 'u3', state: 'upcoming' as const, at: at(16) }
  ]
  it('keeps everything at or under the cap', () => {
    expect(pickRailRows(rows, 5)).toHaveLength(5)
  })
  it('keeps the next upcoming first, then more upcoming, then the latest ran', () => {
    expect(pickRailRows(rows, 1).map((r) => r.id)).toEqual(['u1'])
    expect(pickRailRows(rows, 4).map((r) => r.id)).toEqual(['r2', 'u1', 'u2', 'u3'])
  })
})

describe('outcomeTone', () => {
  it('maps each outcome and the missing one', () => {
    expect([outcomeTone('finished'), outcomeTone('error'), outcomeTone('stopped'), outcomeTone('needs-you'), outcomeTone(undefined)]).toEqual(['ok', 'danger', 'stopped', 'warn', 'neutral'])
  })
})

describe('railItemName', () => {
  it('reads time, name, target and the action', () => {
    expect(railItemName({ time: '09:00 AM', name: 'Digest', target: 'Billing API', opens: 'schedule' })).toBe('09:00 AM Digest, Billing API. Open schedule')
    expect(railItemName({ time: '09:00 AM', name: 'Digest', target: 'Chat', outcome: 'Finished', opens: 'run' })).toBe('09:00 AM Digest, Chat, Finished. Open run')
  })
})
