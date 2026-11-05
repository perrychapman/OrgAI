import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { TERMINAL_ACCESS_LEVEL_OPTIONS, isTerminalAccessLevel, terminalAccessLevelOf, terminalAccessLevelPatch } from './terminalAccess'

describe('terminal access level (review H2)', () => {
  it("defaults to 'operate'; only 'full' reads as full", () => {
    expect(terminalAccessLevelOf(undefined)).toBe('operate')
    expect(terminalAccessLevelOf({} as Partial<AppSettings>)).toBe('operate')
    expect(terminalAccessLevelOf({ terminalAccessLevel: 'full' } as unknown as Partial<AppSettings>)).toBe('full')
    expect(terminalAccessLevelOf({ terminalAccessLevel: 'configure' } as unknown as Partial<AppSettings>)).toBe('operate')
  })
  it('offers operate first and full second', () => {
    expect(TERMINAL_ACCESS_LEVEL_OPTIONS.map((o) => o.value)).toEqual(['operate', 'full'])
    expect(isTerminalAccessLevel('full')).toBe(true)
    expect(isTerminalAccessLevel('decide')).toBe(false)
  })
  it('patches the field', () => {
    expect(terminalAccessLevelPatch('full')).toEqual({ terminalAccessLevel: 'full' })
  })
})
