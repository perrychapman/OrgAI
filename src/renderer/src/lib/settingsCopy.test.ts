import { describe, expect, it } from 'vitest'
import {
  PERMISSION_MODE_SHORT,
  SETTINGS_COPY,
  planGuardLine,
  projectKindLine,
  rulePlaceholder,
  ruleExamples,
  rulesSavedIn,
  type SettingCopy
} from './settingsCopy'

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

describe('engagement copy', () => {
  it('names the kind and where rules are saved', () => {
    expect(projectKindLine('engagement')).toBe('Kind: Engagement')
    expect(projectKindLine('code')).toBe('Kind: Code project')
    expect(rulesSavedIn('app')).toBe('Saved in OrgAI for this project.')
    expect(rulesSavedIn('app')).not.toMatch(/\.claude|folder/)
    expect(rulesSavedIn('folder')).toMatch(/settings\.local\.json/)
  })
  it('keeps engagement rule examples free of developer commands', () => {
    expect(ruleExamples('app')).toEqual(['WebSearch', 'WebFetch', 'mcp__<your server>'])
    expect(ruleExamples('app').join(' ')).not.toMatch(/Bash|git|npm/)
    expect(rulePlaceholder('app')).toBe('WebSearch')
    expect(ruleExamples('folder')).toContain('Bash(npm test:*)')
    expect(rulePlaceholder('folder')).toBe('Bash(npm test:*)')
  })
})

describe('PERMISSION_MODE_SHORT (N8)', () => {
  it('uses one name per mode', () => {
    expect(PERMISSION_MODE_SHORT.default).toBe('Ask for everything risky')
    expect(PERMISSION_MODE_SHORT.acceptEdits).toBe('Auto-accept edits')
  })
})
