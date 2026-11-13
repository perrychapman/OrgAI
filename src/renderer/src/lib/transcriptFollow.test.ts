import { describe, expect, it } from 'vitest'
import {
  FOLLOW_EASE_MS,
  FOLLOW_RESUME_IDLE_MS,
  STICK_PX,
  arriveClass,
  distanceFromEnd,
  easeStep,
  followBehavior,
  followDecision,
  nextFollowing,
  scrollKeyDirection
} from './transcriptFollow'

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

describe('distanceFromEnd', () => {
  it('is what is left to scroll', () => expect(distanceFromEnd({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 })).toBe(200))
  it('is zero at the end', () => expect(distanceFromEnd({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(0))
})

describe('nextFollowing', () => {
  const ev = { following: true, user: true, prevTop: 500, top: 500, distance: 0 }
  it('releases on a user scroll up, even a short one inside STICK_PX', () => {
    expect(nextFollowing({ ...ev, top: 490, distance: 10 })).toBe(false)
    expect(nextFollowing({ ...ev, top: 499, distance: 1 })).toBe(false)
  })
  it('releases on a user scroll up far from the end', () => expect(nextFollowing({ ...ev, top: 100, distance: 400 })).toBe(false))
  it('stays released while the user scrolls down but is not yet near the end', () => {
    expect(nextFollowing({ ...ev, following: false, prevTop: 100, top: 200, distance: STICK_PX + 1 })).toBe(false)
  })
  it('follows again when the user scrolls down to within STICK_PX of the end', () => {
    expect(nextFollowing({ ...ev, following: false, prevTop: 400, top: 450, distance: STICK_PX })).toBe(true)
    expect(nextFollowing({ ...ev, following: false, prevTop: 400, top: 500, distance: 0 })).toBe(true)
  })
  it('keeps the state when a user event did not move the list', () => {
    expect(nextFollowing({ ...ev, following: false, prevTop: 100, top: 100, distance: 400 })).toBe(false)
    expect(nextFollowing({ ...ev, following: true })).toBe(true)
  })
  it('does not release for a scroll the user did not cause', () => {
    expect(nextFollowing({ ...ev, user: false, top: 300, distance: 200 })).toBe(true)
  })
  it('does not re-follow for a layout scroll that is not at the very end', () => {
    expect(nextFollowing({ ...ev, following: false, user: false, top: 460, distance: 30 })).toBe(false)
  })
  it('re-follows for a scroll the user did not cause when the list sits at the very end', () => {
    expect(nextFollowing({ ...ev, following: false, user: false, prevTop: 400, top: 500, distance: 0 })).toBe(true)
    expect(nextFollowing({ ...ev, following: false, user: false, prevTop: 400, top: 500, distance: 1 })).toBe(true)
  })
})

describe('followDecision', () => {
  const now = 1_000_000
  const d = { following: true, now, lastUserAt: now - 5_000, reducedMotion: false, delta: 120, viewportHeight: 500 }
  describe('while following', () => {
    it('glides for a short hop', () => expect(followDecision(d)).toEqual({ following: true, move: 'smooth' }))
    it('jumps for a hop of a viewport or more', () => expect(followDecision({ ...d, delta: 500 })).toEqual({ following: true, move: 'instant' }))
    it('jumps while the user has only just scrolled', () => expect(followDecision({ ...d, lastUserAt: now - 100 })).toEqual({ following: true, move: 'instant' }))
    it('jumps under reduced motion', () => expect(followDecision({ ...d, reducedMotion: true })).toEqual({ following: true, move: 'instant' }))
    it('does nothing at the end', () => expect(followDecision({ ...d, delta: 0 })).toEqual({ following: true, move: 'none' }))
    it('treats a list never scrolled by the user as quiet', () => expect(followDecision({ ...d, lastUserAt: -Infinity }).move).toBe('smooth'))
  })
  describe('after the user scrolled away', () => {
    const away = { ...d, following: false }
    it('holds still just after the scroll', () => expect(followDecision({ ...away, lastUserAt: now })).toEqual({ following: false, move: 'none' }))
    it('holds still inside the idle window', () => expect(followDecision({ ...away, lastUserAt: now - (FOLLOW_RESUME_IDLE_MS - 1) })).toEqual({ following: false, move: 'none' }))
    it('resumes exactly at the idle time', () => expect(followDecision({ ...away, lastUserAt: now - FOLLOW_RESUME_IDLE_MS })).toEqual({ following: true, move: 'smooth' }))
    it('resumes after the idle time with a glide, however far away', () => {
      expect(followDecision({ ...away, lastUserAt: now - FOLLOW_RESUME_IDLE_MS - 1, delta: 4000 })).toEqual({ following: true, move: 'smooth' })
    })
    it('resumes instantly under reduced motion', () => {
      expect(followDecision({ ...away, lastUserAt: now - FOLLOW_RESUME_IDLE_MS, reducedMotion: true })).toEqual({ following: true, move: 'instant' })
    })
    it('resumes without moving when the list is at the end anyway', () => {
      expect(followDecision({ ...away, lastUserAt: now - FOLLOW_RESUME_IDLE_MS, delta: 0 })).toEqual({ following: true, move: 'none' })
    })
    it('never resumes before the idle time under reduced motion either', () => {
      expect(followDecision({ ...away, lastUserAt: now - 100, reducedMotion: true })).toEqual({ following: false, move: 'none' })
    })
  })
  it('the idle time is ten seconds', () => expect(FOLLOW_RESUME_IDLE_MS).toBe(10_000))
})

describe('easeStep', () => {
  it('moves a share of what is left', () => {
    const step = easeStep(300, 16.7)
    expect(step).toBeGreaterThan(30)
    expect(step).toBeLessThan(100)
  })
  it('never overshoots', () => {
    expect(easeStep(0.4, 16.7)).toBe(0.4)
    expect(easeStep(5, 10_000)).toBe(5)
  })
  it('moves at least 1 px so the glide finishes', () => expect(easeStep(3, 1)).toBeGreaterThanOrEqual(1))
  it('does not move when nothing is left', () => expect(easeStep(0, 16)).toBe(0))
  it('is frame-rate independent: two half frames cover about one frame', () => {
    const one = easeStep(400, 16)
    const half = easeStep(400, 8)
    const twice = half + easeStep(400 - half, 8)
    expect(Math.abs(one - twice)).toBeLessThan(0.5)
  })
  it('settles within the ease time', () => {
    let left = 400
    let t = 0
    while (left > 0.5 && t < 2000) {
      left -= easeStep(left, 16)
      t += 16
    }
    expect(t).toBeLessThanOrEqual(FOLLOW_EASE_MS * 3)
  })
})

describe('scrollKeyDirection', () => {
  it('names the keys that go up', () => {
    for (const k of ['ArrowUp', 'PageUp', 'Home']) expect(scrollKeyDirection(k)).toBe('up')
  })
  it('names the keys that go down', () => {
    for (const k of ['ArrowDown', 'PageDown', 'End', ' ']) expect(scrollKeyDirection(k)).toBe('down')
  })
  it('ignores other keys', () => {
    expect(scrollKeyDirection('a')).toBeNull()
    expect(scrollKeyDirection('Tab')).toBeNull()
  })
})
