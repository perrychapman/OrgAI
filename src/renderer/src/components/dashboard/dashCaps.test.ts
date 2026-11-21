import { describe, expect, it } from 'vitest'
import { NARROW_CAPS, WIDE_CAPS, capsFor } from './dashCaps'

describe('dashCaps', () => {
  it('is wide (two work columns) from 880 px of page width', () => {
    expect(capsFor(879).wide).toBe(false)
    expect(capsFor(880).wide).toBe(true)
  })
  it('pairs half-width sections from 1280 px', () => {
    expect(capsFor(1279).pair).toBe(false)
    expect(capsFor(1280).pair).toBe(true)
    expect(capsFor(1280).wide).toBe(true)
    expect(capsFor(879).pair).toBe(false)
  })
  it('carries the overhaul caps (narrow / wide)', () => {
    expect([NARROW_CAPS.needs, WIDE_CAPS.needs]).toEqual([3, 5])
    expect([NARROW_CAPS.setup, WIDE_CAPS.setup]).toEqual([3, 5])
    expect([NARROW_CAPS.resume, WIDE_CAPS.resume]).toEqual([4, 6])
    expect([NARROW_CAPS.schedules, WIDE_CAPS.schedules]).toEqual([4, 6])
    expect([NARROW_CAPS.todos, WIDE_CAPS.todos]).toEqual([3, 5])
    expect([NARROW_CAPS.bandRuns, WIDE_CAPS.bandRuns]).toEqual([3, 5])
    expect([NARROW_CAPS.bandAgentsPerRun, WIDE_CAPS.bandAgentsPerRun]).toEqual([4, 6])
  })
})
