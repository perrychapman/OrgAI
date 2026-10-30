import { describe, expect, it } from 'vitest'
import { nextWide } from './panelWidth'

describe('nextWide', () => {
  it('turns wide at 480 and stays wide down to 448', () => {
    expect(nextWide(false, 479)).toBe(false)
    expect(nextWide(false, 480)).toBe(true)
    expect(nextWide(true, 460)).toBe(true)
    expect(nextWide(true, 448)).toBe(true)
    expect(nextWide(true, 447)).toBe(false)
  })
  it('does not turn wide between 448 and 480 from narrow', () => {
    expect(nextWide(false, 460)).toBe(false)
  })
})
