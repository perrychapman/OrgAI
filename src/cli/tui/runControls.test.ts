import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '../../shared/types'
import { canNarrowPermissionMode } from '../../main/runtime/runOverrides'
import { CYCLE_MODES, NARROW_LADDER, STAGED_CYCLE_MODES, narrowerMode, nextStagedMode, widensMode } from './runControls'

const ALL: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']

describe('Shift+Tab mode helpers', () => {
  it('steps down auto, acceptEdits, default, plan and stops at plan', () => {
    expect(narrowerMode('auto', CYCLE_MODES)).toBe('acceptEdits')
    expect(narrowerMode('acceptEdits', CYCLE_MODES)).toBe('default')
    expect(narrowerMode('default', CYCLE_MODES)).toBe('plan')
    expect(narrowerMode('plan', CYCLE_MODES)).toBeUndefined()
  })

  it('skips modes the run does not offer and never wraps', () => {
    expect(narrowerMode('auto', ['default', 'plan', 'auto'])).toBe('default')
    expect(narrowerMode('default', ['default', 'auto'])).toBeUndefined()
    expect(narrowerMode('auto', [])).toBeUndefined()
  })

  it('is never wider than the mode in force, for every current mode and every offered subset', () => {
    for (const current of [...ALL, undefined]) {
      const next = narrowerMode(current, CYCLE_MODES)
      if (next !== undefined && current !== undefined) {
        expect(next).not.toBe(current)
        expect(canNarrowPermissionMode(current, next)).toBe(true)
      }
      if (current === undefined && next !== undefined) expect(next).toBe('plan')
    }
    // dontAsk is not narrowed by default (host matrix): only plan is a safe step from it.
    expect(narrowerMode('dontAsk', CYCLE_MODES)).toBe('plan')
  })

  it('widensMode agrees with the host narrowing matrix for every pair', () => {
    for (const from of ALL) for (const to of ALL) expect(widensMode(from, to)).toBe(!canNarrowPermissionMode(from, to))
    expect(widensMode(undefined, 'plan')).toBe(false)
    expect(widensMode(undefined, 'auto')).toBe(true)
  })

  it('the ladder and the staged cycle only hold modes /mode accepts, and staging leaves out auto', () => {
    for (const m of [...NARROW_LADDER, ...STAGED_CYCLE_MODES]) expect(CYCLE_MODES).toContain(m)
    expect(STAGED_CYCLE_MODES).not.toContain('auto')
    expect(nextStagedMode(undefined, CYCLE_MODES)).toBe('default')
    expect(nextStagedMode('default', CYCLE_MODES)).toBe('acceptEdits')
    expect(nextStagedMode('acceptEdits', CYCLE_MODES)).toBe('plan')
    expect(nextStagedMode('plan', CYCLE_MODES)).toBe('default')
    expect(nextStagedMode('auto', CYCLE_MODES)).toBe('default')
  })
})
