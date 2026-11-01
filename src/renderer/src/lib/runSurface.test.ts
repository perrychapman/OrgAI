import { describe, expect, it } from 'vitest'
import { isTeamSurfaceRun } from './runSurface'

describe('isTeamSurfaceRun', () => {
  it('is true only for the team surface', () => {
    expect(isTeamSurfaceRun({ surface: 'team' })).toBe(true)
    expect(isTeamSurfaceRun({})).toBe(false)
    expect(isTeamSurfaceRun(null)).toBe(false)
  })
})
