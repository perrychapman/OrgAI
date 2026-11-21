import { describe, expect, it } from 'vitest'
import { DRAW_PENDING_MS, initDrawTracker, sameFingerprint, stepDraw } from './usageDraw'

const A = { id: 'a' }
const B = { id: 'b' }

describe('stepDraw', () => {
  it('never draws for a background refresh (new data, no bump)', () => {
    const t = initDrawTracker(0, [A, 'cost'])
    const r = stepDraw(t, { seq: 0, fp: [B, 'cost'], now: 10 })
    expect(r.draw).toBe(false)
    expect(r.next.fp[0]).toBe(B)
    expect(r.next.pendingAt).toBeNull()
  })

  it('draws in the commit where a bump and new data arrive together (a metric change)', () => {
    const t = initDrawTracker(0, [A, 'cost'])
    const r = stepDraw(t, { seq: 1, fp: [A, 'tokens'], now: 10 })
    expect(r.draw).toBe(true)
    expect(r.next).toMatchObject({ seq: 1, pendingAt: null })
  })

  it('waits for the data after a bump, then draws once', () => {
    const t0 = initDrawTracker(0, [A])
    const r1 = stepDraw(t0, { seq: 1, fp: [A], now: 100 })
    expect(r1.draw).toBe(false)
    expect(r1.next.pendingAt).toBe(100)
    const r2 = stepDraw(r1.next, { seq: 1, fp: [A], now: 400 })
    expect(r2.draw).toBe(false)
    const r3 = stepDraw(r2.next, { seq: 1, fp: [B], now: 900 })
    expect(r3.draw).toBe(true)
    // The refresh after it is a background update again.
    expect(stepDraw(r3.next, { seq: 1, fp: [A], now: 5000 }).draw).toBe(false)
  })

  it('drops a bump whose data never came', () => {
    const r1 = stepDraw(initDrawTracker(0, [A]), { seq: 1, fp: [A], now: 0 })
    const r2 = stepDraw(r1.next, { seq: 1, fp: [A], now: DRAW_PENDING_MS + 1 })
    expect(r2.next.pendingAt).toBeNull()
    expect(stepDraw(r2.next, { seq: 1, fp: [B], now: DRAW_PENDING_MS + 2 }).draw).toBe(false)
  })

  it('draws again for a second bump (rapid changes restart the draw)', () => {
    const r1 = stepDraw(initDrawTracker(0, [A]), { seq: 1, fp: [B], now: 0 })
    expect(r1.draw).toBe(true)
    const r2 = stepDraw(r1.next, { seq: 2, fp: [A], now: 100 })
    expect(r2.draw).toBe(true)
  })

  it('returns the same tracker when nothing changed', () => {
    const t = initDrawTracker(3, [A, 1])
    expect(stepDraw(t, { seq: 3, fp: [A, 1], now: 5 }).next).toBe(t)
  })

  it('treats an absent drawSeq as zero and compares fingerprints by identity', () => {
    expect(stepDraw(initDrawTracker(undefined, [A]), { seq: undefined, fp: [A], now: 1 }).draw).toBe(false)
    expect(sameFingerprint([A, 1], [A, 1])).toBe(true)
    expect(sameFingerprint([A, 1], [{ id: 'a' }, 1])).toBe(false)
    expect(sameFingerprint([A], [A, 1])).toBe(false)
  })
})
