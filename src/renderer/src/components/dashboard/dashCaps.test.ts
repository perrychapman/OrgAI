import { describe, expect, it } from 'vitest'
import { NARROW_CAPS, WIDE_CAPS, capsFor } from './dashCaps'

describe('dashCaps', () => {
  it('is wide from 1000 px of page width', () => {
    expect(capsFor(999).wide).toBe(false)
    expect(capsFor(1000).wide).toBe(true)
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
