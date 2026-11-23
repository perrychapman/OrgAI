import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { accentVars, applyAppearance, isAppearanceKnown, normalizeHex, onAccent, parseCachedAppearance, resolveTheme } from './theme'

describe('startup appearance cache', () => {
  it('reads a saved copy, filling missing fields from the defaults', () => {
    const a = parseCachedAppearance(JSON.stringify({ reduceMotion: 'on', theme: 'light', canvas: { pattern: 'grid' } }))
    expect(a?.reduceMotion).toBe('on')
    expect(a?.theme).toBe('light')
    expect(a?.canvas.pattern).toBe('grid')
    expect(a?.canvas.edges).toBe(DEFAULT_APPEARANCE.canvas.edges)
    expect(a?.accent).toBe(DEFAULT_APPEARANCE.accent)
  })
  it('ignores absent, broken or non-object copies', () => {
    for (const raw of [null, '', '{', '[]', '"on"', 'null', '3']) expect(parseCachedAppearance(raw)).toBeNull()
    expect(parseCachedAppearance(JSON.stringify({ canvas: [1] }))?.canvas).toEqual(DEFAULT_APPEARANCE.canvas)
  })
  it('is not known before initTheme has applied a saved appearance', () => {
    expect(isAppearanceKnown()).toBe(false)
  })
})

describe('theme', () => {
  it('writes scene attributes and defaults legacy canvas settings', () => {
    const root = { dataset: {}, style: { removeProperty: () => {}, setProperty: () => {} } } as unknown as HTMLElement
    applyAppearance({ ...DEFAULT_APPEARANCE, canvas: { ...DEFAULT_APPEARANCE.canvas, presentation: 'pocket-office', scenePalette: 'green' } }, true, root)
    expect(root.dataset).toMatchObject({ canvasPresentation: 'pocket-office', canvasScenePalette: 'green' })
    applyAppearance({ ...DEFAULT_APPEARANCE, canvas: { ...DEFAULT_APPEARANCE.canvas, presentation: undefined, scenePalette: undefined } }, false, root)
    expect(root.dataset).toMatchObject({ canvasPresentation: 'graph', canvasScenePalette: 'color' })
  })
  it('writes the Appearance choice attributes only for non-default values, and Motion Off reuses Reduce motion', () => {
    const root = { dataset: {} as Record<string, string>, style: { removeProperty: () => {}, setProperty: () => {} } } as unknown as HTMLElement
    applyAppearance({ ...DEFAULT_APPEARANCE, noMotion: true, glass: false, textSize: 'large', density: 'compact', sidebarActivityDots: false }, true, root)
    expect(root.dataset).toMatchObject({ reduceMotion: 'on', glass: 'off', textSize: 'large', density: 'compact', activityDots: 'off' })
    applyAppearance({ ...DEFAULT_APPEARANCE, noMotion: false, glass: true, textSize: 'default', density: 'comfortable', sidebarActivityDots: true }, true, root)
    for (const k of ['reduceMotion', 'glass', 'textSize', 'density', 'activityDots']) expect(root.dataset[k]).toBeUndefined()
  })
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
    for (const hex of ['#d98e04', '#14b8a6', '#22a559']) expect(onAccent(hex)).toBe('#0b0d12')
  })
})
