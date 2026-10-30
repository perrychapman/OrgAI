import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { accentVars, normalizeHex, onAccent, resolveTheme } from './theme'

describe('theme', () => {
  it('resolves system with the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
  })
  it('normalizes hex input', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('7C5CFF')).toBe('#7c5cff')
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('zzzzzz')).toBeNull()
  })
  it('keeps designed tokens for the default accent and derives variants otherwise', () => {
    expect(accentVars(DEFAULT_APPEARANCE.accent, 'dark')).toEqual({})
    const v = accentVars('#10b981', 'light')
    expect(v['--accent']).toBe('#10b981')
    expect(v['--accent-hover']).toContain('color-mix')
  })
  it('picks readable text on the accent', () => {
    expect(onAccent('#ffee00')).toBe('#0b0d12')
    expect(onAccent('#3b2fd0')).toBe('#ffffff')
  })
})
