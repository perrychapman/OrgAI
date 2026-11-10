import { describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/types'
import { cleanRunOverrides } from '../store/runs'
import { continuedOverrides } from './runManager'
import { effectiveRunProject, overridesWidening, runOverridesArgs } from './runOverrides'
import { project } from './testHelpers'

describe('goal override (run staffing)', () => {
  it('runOverridesArgs accepts a staffing goal and refuses anything else', () => {
    for (const goal of ['balanced', 'speed', 'cost'] as const) expect(runOverridesArgs({ goal })).toEqual({ goal })
    for (const v of ['fast', 'SPEED', '', 1, null, true]) {
      let code: string | undefined
      try {
        runOverridesArgs({ goal: v })
      } catch (e) {
        code = (e as { code?: string }).code
        expect((e as Error).message).toMatch(/overrides\.goal/)
      }
      expect(code).toBe('bad_request')
    }
    expect(runOverridesArgs({ goal: undefined })).toBeUndefined()
  })

  it('cleanRunOverrides keeps a known goal and drops a junk one', () => {
    expect(cleanRunOverrides({ goal: 'cost' })).toEqual({ goal: 'cost' })
    expect(cleanRunOverrides({ goal: 'warp' })).toBeUndefined()
    expect(cleanRunOverrides({ goal: 3, strictDelegation: true })).toEqual({ strictDelegation: true })
  })

  it('is carried on every continuation, may be replaced, and never widens', () => {
    const prev: RunOverrides = { goal: 'speed' }
    expect(continuedOverrides(prev, {})).toEqual({ goal: 'speed' })
    expect(continuedOverrides(prev, { exec: true })).toEqual({ goal: 'speed' })
    expect(continuedOverrides(prev, { overrides: { goal: 'cost' } })).toEqual({ goal: 'cost' })
    expect(overridesWidening(project({ staffingGoal: 'cost' }), { goal: 'speed' })).toEqual([])
  })

  it('does not change the effective project (the goal reaches adapters as RuntimeContext.staffingGoal)', () => {
    const p = project({ staffingGoal: 'cost' })
    expect(effectiveRunProject(p, { goal: 'speed' }).staffingGoal).toBe('cost')
  })
})
