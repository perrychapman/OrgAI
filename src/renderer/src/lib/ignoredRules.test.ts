import { describe, expect, it } from 'vitest'
import { cleanIgnored, ignoredDisplay, ignoredRemovable, ignoredRemoveLabel } from './ignoredRules'

describe('ignoredRules', () => {
  it('cleans junk lists', () => {
    expect(cleanIgnored(undefined)).toEqual([])
    expect(cleanIgnored([null, { rule: 1 }, { rule: 'Bash', reason: 'Too broad.' }])).toEqual([{ rule: 'Bash', reason: 'Too broad.' }])
  })
  it('does not offer removal for a cut rule', () => {
    expect(ignoredRemovable({ rule: 'x', reason: 'r', cut: true })).toBe(false)
    expect(ignoredRemovable({ rule: 'x', reason: 'r' })).toBe(true)
  })
  it('shows hidden characters and marks a cut rule', () => {
    expect(ignoredDisplay({ rule: 'Bash(a​b)', reason: 'r', hiddenChar: true })).toBe('Bash(a\\u200bb)')
    expect(ignoredDisplay({ rule: 'abc', reason: 'r', cut: true })).toBe('abc…')
  })
  it('names the rule in the button label', () => {
    expect(ignoredRemoveLabel({ rule: 'Bash', reason: 'r' }, false)).toBe('Remove unused rule Bash')
    expect(ignoredRemoveLabel({ rule: 'Bash', reason: 'r' }, true)).toBe('Removing unused rule Bash')
  })
})
