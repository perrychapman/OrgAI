import { describe, expect, it } from 'vitest'
import { easeOutCubic, parseDurationText, parseTokenText, shouldTween, tweenAt } from './tween'

const base = { prev: 100, next: 200, key: 2, lastKey: 1, reduced: false, durationMs: 260 }

describe('shouldTween', () => {
  it('tweens a keyed change', () => expect(shouldTween(base)).toBe(true))
  it('does not tween without a key change (first paint, poll refresh)', () =>
    expect(shouldTween({ ...base, key: 1 })).toBe(false))
  it('does not tween a refresh that lands after the user change expired (key bumped, value unchanged, later poll)', () => {
    expect(shouldTween({ ...base, keyAgeMs: 30_000 })).toBe(false)
    expect(shouldTween({ ...base, keyAgeMs: 400 })).toBe(true)
  })
  it('skips changes under 1%', () => expect(shouldTween({ ...base, prev: 1000, next: 1005 })).toBe(false))
  it('never tweens from or to unknown', () => {
    expect(shouldTween({ ...base, prev: null })).toBe(false)
    expect(shouldTween({ ...base, next: null })).toBe(false)
  })
  it('skips under reduced motion or zero duration', () => {
    expect(shouldTween({ ...base, reduced: true })).toBe(false)
    expect(shouldTween({ ...base, durationMs: 0 })).toBe(false)
  })
})

describe('tweenAt', () => {
  it('starts at from, ends exactly at to, eases out', () => {
    expect(tweenAt(0, 10, 0, 100)).toBe(0)
    expect(tweenAt(0, 10, 100, 100)).toBe(10)
    expect(tweenAt(0, 10, 50, 100)).toBeGreaterThan(5)
    expect(easeOutCubic(2)).toBe(1)
  })
})

describe('display parsers', () => {
  it('parses token text', () => {
    expect(parseTokenText('620')).toBe(620)
    expect(parseTokenText('6.0k')).toBe(6000)
    expect(parseTokenText('1.20M')).toBe(1_200_000)
    expect(parseTokenText('—')).toBeNull()
  })
  it('parses durations', () => {
    expect(parseDurationText('42s')).toBe(42000)
    expect(parseDurationText('3m 05s')).toBe(185000)
    expect(parseDurationText('1h 02m')).toBe(3720000)
    expect(parseDurationText('—')).toBeNull()
  })
})
