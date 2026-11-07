import { describe, expect, it } from 'vitest'
import { SHORT_REGION_PX, capsFor, isShortRegion } from './dashCaps'

describe('dashCaps', () => {
  it('is wide from 1280 px', () => {
    expect(capsFor(1279).wide).toBe(false)
    expect(capsFor(1280).wide).toBe(true)
  })
  it('calls a region short under 700 px, never before it is measured', () => {
    expect(isShortRegion(584)).toBe(true)
    expect(isShortRegion(SHORT_REGION_PX - 1)).toBe(true)
    expect(isShortRegion(SHORT_REGION_PX)).toBe(false)
    expect(isShortRegion(920)).toBe(false)
    expect(isShortRegion(0)).toBe(false)
  })
})
