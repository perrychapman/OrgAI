import { describe, expect, it } from 'vitest'
import { RAIL_BELOW_PX, contentIsRail, resolveCollapsed } from './useSidebarCollapsed'

describe('contentIsRail', () => {
  it('keeps the full content while a collapse glides, then draws the rail', () => {
    expect(contentIsRail(true, 'collapsing')).toBe(false)
    expect(contentIsRail(true, null)).toBe(true)
  })
  it('draws the full content at once on an expand and when expanded', () => {
    expect(contentIsRail(false, 'expanding')).toBe(false)
    expect(contentIsRail(false, null)).toBe(false)
  })
})

describe('resolveCollapsed', () => {
  it('lets the window width decide without a saved choice', () => {
    expect(resolveCollapsed(null, RAIL_BELOW_PX - 1)).toBe(true)
    expect(resolveCollapsed(null, RAIL_BELOW_PX)).toBe(false)
  })
  it('lets an explicit choice win at any width', () => {
    expect(resolveCollapsed('expanded', 800)).toBe(false)
    expect(resolveCollapsed('collapsed', 2000)).toBe(true)
  })
})
