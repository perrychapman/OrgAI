import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArrivalTracker } from './useArrival'
import { cssTimeMs, exitProps, nextPresence, tokenMs } from './useExitPresence'
import { beginLayoutMotion, isLayoutMoving, onLayoutSettled, resetLayoutMotion } from './layoutMotion'

describe('ArrivalTracker', () => {
  it('marks the first render seen and later ids new once', () => {
    const t = new ArrivalTracker({ windowMs: 1000 })
    t.update(['a', 'b'], 'run1', 0)
    expect(t.isNew('a', 0)).toBe(false)
    expect(t.isNew('b', 0)).toBe(false)
    t.update(['a', 'b', 'c'], 'run1', 100)
    expect(t.isNew('c', 100)).toBe(true)
    // Stable across re-renders inside the window, gone after it.
    t.update(['a', 'b', 'c'], 'run1', 500)
    expect(t.isNew('c', 500)).toBe(true)
    expect(t.isNew('c', 1100)).toBe(false)
  })

  it('treats a scope change like a first render', () => {
    const t = new ArrivalTracker()
    t.update(['a'], 'p1', 0)
    t.update(['x', 'y'], 'p2', 10)
    expect(t.isNew('x', 10)).toBe(false)
    expect(t.isNew('y', 10)).toBe(false)
    t.update(['x', 'y', 'z'], 'p2', 20)
    expect(t.isNew('z', 20)).toBe(true)
  })

  it('a new tracker (remount) never replays', () => {
    const a = new ArrivalTracker()
    a.update(['a'], '', 0)
    a.update(['a', 'b'], '', 10)
    expect(a.isNew('b', 10)).toBe(true)
    const b = new ArrivalTracker()
    b.update(['a', 'b'], '', 20)
    expect(b.isNew('b', 20)).toBe(false)
  })

  it('an id that left and came back is not new again', () => {
    const t = new ArrivalTracker({ windowMs: 100 })
    t.update(['a'], '', 0)
    t.update([], '', 10)
    t.update(['a'], '', 500)
    expect(t.isNew('a', 500)).toBe(false)
  })

  it('a burst past maxPerBatch animates none', () => {
    const t = new ArrivalTracker({ maxPerBatch: 6 })
    t.update([], '', 0)
    const burst = Array.from({ length: 7 }, (_, i) => `r${i}`)
    t.update(burst, '', 10)
    expect(burst.some((id) => t.isNew(id, 10))).toBe(false)
    const six = Array.from({ length: 6 }, (_, i) => `s${i}`)
    t.update([...burst, ...six], '', 20)
    expect(six.every((id) => t.isNew(id, 20))).toBe(true)
  })

  it('is idempotent for the same ids (StrictMode double render)', () => {
    const t = new ArrivalTracker()
    t.update(['a'], '', 0)
    t.update(['a', 'b'], '', 10)
    t.update(['a', 'b'], '', 10)
    expect(t.isNew('b', 10)).toBe(true)
  })

  it('markArrived makes revealed ids new', () => {
    const t = new ArrivalTracker()
    t.update(['a'], '', 0)
    t.markArrived(['b'], 5)
    t.update(['a', 'b'], '', 6)
    expect(t.isNew('b', 6)).toBe(true)
  })
})

describe('exit presence', () => {
  it('parses CSS times', () => {
    expect(cssTimeMs('100ms')).toBe(100)
    expect(cssTimeMs(' 0.2s ')).toBe(200)
    expect(cssTimeMs('0.01ms')).toBe(0)
    expect(cssTimeMs('')).toBe(0)
    expect(cssTimeMs('junk')).toBe(0)
    expect(cssTimeMs(undefined)).toBe(0)
  })

  it('reads 0 outside a DOM', () => {
    expect(tokenMs()).toBe(0)
  })

  it('lingers only when leaving with a duration', () => {
    expect(nextPresence(false, true, 100).lingering).toBe(true)
    expect(nextPresence(false, true, 0).lingering).toBe(false)
    expect(nextPresence(false, false, 100).lingering).toBe(false)
    expect(nextPresence(true, true, 100).lingering).toBe(false)
  })

  it('a leaving node is inert and hidden', () => {
    expect(exitProps('out')).toEqual({ 'data-state': 'out', inert: true, 'aria-hidden': true })
    expect(exitProps('in')).toEqual({ 'data-state': 'in' })
  })
})

describe('layout motion', () => {
  afterEach(() => {
    resetLayoutMotion()
    vi.useRealTimers()
  })

  it('signals one settle after overlapping glides', () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    onLayoutSettled(settled)
    beginLayoutMotion(260)
    vi.advanceTimersByTime(100)
    beginLayoutMotion(260)
    expect(isLayoutMoving()).toBe(true)
    vi.advanceTimersByTime(260 + 50 - 1)
    expect(settled).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(isLayoutMoving()).toBe(false)
  })

  it('an instant change (reduced motion) never marks moving', () => {
    const settled = vi.fn()
    onLayoutSettled(settled)
    beginLayoutMotion(0)
    expect(isLayoutMoving()).toBe(false)
    expect(settled).not.toHaveBeenCalled()
  })
})
