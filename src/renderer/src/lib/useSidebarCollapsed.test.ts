import { describe, expect, it } from 'vitest'
import { RAIL_BELOW_PX, resolveCollapsed } from './useSidebarCollapsed'

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
