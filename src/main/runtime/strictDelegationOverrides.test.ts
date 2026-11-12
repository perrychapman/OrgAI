import { describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/types'
import { overridesFromFlags } from '../../cli/commands/exec'
import { cleanRunOverrides } from '../store/runs'
import { continuedOverrides } from './runManager'
import { overridesWidening, runOverridesArgs } from './runOverrides'
import { project } from './testHelpers'

describe('strictDelegation override', () => {
  it('runOverridesArgs accepts exactly true', () => {
    expect(runOverridesArgs({ strictDelegation: true })).toEqual({ strictDelegation: true })
    for (const v of [false, 'true', 1, null]) expect(() => runOverridesArgs({ strictDelegation: v })).toThrow(/strictDelegation/)
    expect(runOverridesArgs({ strictDelegation: undefined })).toBeUndefined()
  })
  it('cleanRunOverrides keeps true only', () => {
    expect(cleanRunOverrides({ strictDelegation: true })).toEqual({ strictDelegation: true })
    expect(cleanRunOverrides({ strictDelegation: false })).toBeUndefined()
    expect(cleanRunOverrides({ strictDelegation: 'yes' })).toBeUndefined()
  })
  it('is carried on every continuation and is not widening', () => {
    const prev: RunOverrides = { strictDelegation: true }
    expect(continuedOverrides(prev, {})).toEqual({ strictDelegation: true })
    expect(continuedOverrides(prev, { exec: true })).toEqual({ strictDelegation: true })
    expect(overridesWidening(project({}), { strictDelegation: true })).toEqual([])
  })
  it('orgai exec --strict-delegation sets it', () => {
    expect(overridesFromFlags({ 'strict-delegation': true })).toEqual({ execMode: true, strictDelegation: true })
    expect(overridesFromFlags({})).toEqual({ execMode: true })
  })
})
