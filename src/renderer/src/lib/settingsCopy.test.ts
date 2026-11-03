import { describe, expect, it } from 'vitest'
import { PERMISSION_MODE_SHORT, SETTINGS_COPY, planGuardLine, type SettingCopy } from './settingsCopy'

const entries = Object.entries(SETTINGS_COPY) as [string, SettingCopy][]
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length

describe('SETTINGS_COPY', () => {
  it('has entries', () => expect(entries.length).toBeGreaterThan(0))
  it.each(entries)('%s has a label', (_k, c) => {
    expect(c.label.trim().length).toBeGreaterThan(0)
  })
  it.each(entries)('%s description is at most 15 words', (_k, c) => {
    if (c.description !== undefined) {
      expect(words(c.description)).toBeGreaterThan(0)
      expect(words(c.description)).toBeLessThanOrEqual(15)
    }
  })
  it.each(entries)('%s names no internal tool', (_k, c) => {
    expect(`${c.label} ${c.description ?? ''}`).not.toMatch(/set_plan|ask_user|mark_blocked/)
  })
})

describe('planGuardLine (ux-review-config-2 N2)', () => {
  it('promises no five-hour stop unless the share is set', () => {
    expect(planGuardLine('auto')).toBe('Plan guard: automatic. Uses the everyday tier when your weekly window passes 80%. A run that reaches a plan limit pauses until it resets.')
    expect(planGuardLine('auto')).not.toMatch(/five-hour/)
    expect(planGuardLine('off', 0)).toBe('Plan guard: off. A run that reaches a plan limit pauses until it resets.')
  })
  it('names a set share', () => {
    expect(planGuardLine('on', 30)).toMatch(/Stops at 30% of the five-hour window\.$/)
    expect(planGuardLine('auto', 250)).toMatch(/Stops at 100% /)
  })
})

describe('PERMISSION_MODE_SHORT (N8)', () => {
  it('uses one name per mode', () => {
    expect(PERMISSION_MODE_SHORT.default).toBe('Ask for everything risky')
    expect(PERMISSION_MODE_SHORT.acceptEdits).toBe('Auto-accept edits')
  })
})
