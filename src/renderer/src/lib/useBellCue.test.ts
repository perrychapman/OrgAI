import { describe, expect, it } from 'vitest'
import { BELL_CUE_MOUNT_GRACE_MS, BELL_CUE_THROTTLE_MS, shouldCue } from './useBellCue'

describe('shouldCue', () => {
  const mounted = 0
  const later = BELL_CUE_MOUNT_GRACE_MS + 1000
  it('plays when the count rises after the mount grace', () => {
    expect(shouldCue(0, 1, null, later, mounted)).toBe(true)
    expect(shouldCue(2, 5, null, later, mounted)).toBe(true)
  })
  it('stays quiet when the count falls or holds', () => {
    expect(shouldCue(3, 2, null, later, mounted)).toBe(false)
    expect(shouldCue(3, 3, null, later, mounted)).toBe(false)
  })
  it('stays quiet for a count that settles in right after mount', () => {
    expect(shouldCue(0, 2, null, BELL_CUE_MOUNT_GRACE_MS - 1, mounted)).toBe(false)
  })
  it('plays at most once per throttle window', () => {
    expect(shouldCue(1, 2, later, later + BELL_CUE_THROTTLE_MS - 1, mounted)).toBe(false)
    expect(shouldCue(1, 2, later, later + BELL_CUE_THROTTLE_MS, mounted)).toBe(true)
  })
})
