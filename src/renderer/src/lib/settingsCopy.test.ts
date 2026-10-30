import { describe, expect, it } from 'vitest'
import { SETTINGS_COPY, type SettingCopy } from './settingsCopy'

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
