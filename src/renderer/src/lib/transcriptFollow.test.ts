import { describe, expect, it } from 'vitest'
import { arriveClass, followBehavior } from './transcriptFollow'

const base = { delta: 120, viewportHeight: 500, sinceUserScrollMs: 1000, reducedMotion: false }
describe('followBehavior', () => {
  it('is smooth for a short hop', () => expect(followBehavior(base)).toBe('smooth'))
  it('is instant for a long jump', () => expect(followBehavior({ ...base, delta: 500 })).toBe('auto'))
  it('is instant right after the user scrolled', () => expect(followBehavior({ ...base, sinceUserScrollMs: 100 })).toBe('auto'))
  it('is instant under reduced motion', () => expect(followBehavior({ ...base, reducedMotion: true })).toBe('auto'))
  it('is instant when already at the end', () => expect(followBehavior({ ...base, delta: 0 })).toBe('auto'))
})
describe('arriveClass', () => {
  it('adds the class only for arrivals', () => {
    expect(arriveClass(true)).toBe(' transcript-arrive')
    expect(arriveClass(false)).toBe('')
    expect(arriveClass(undefined)).toBe('')
  })
})
