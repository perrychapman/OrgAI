import { describe, expect, it } from 'vitest'
import { asciiOnly, composerSurface, glyphs, separatorFor, stateGlyph, stateTone, terminalThemeFor, toneColor } from './theme'
import type { TuiEnv } from './types'

const env = (over: Partial<TuiEnv> = {}): TuiEnv => ({
  bufferMode: 'fullscreen',
  screenReader: false,
  color: true,
  dumbTerminal: false,
  bracketedPaste: true,
  unicode: true,
  ...over
})

describe('theme', () => {
  it('resolves appearance from an override or the terminal background and safely falls back', () => {
    expect(terminalThemeFor({ ORGAI_THEME: 'light', COLORFGBG: '15;0' })).toBe('light')
    expect(terminalThemeFor({ ORGAI_THEME: 'dark', COLORFGBG: '0;15' })).toBe('dark')
    for (const value of ['0;7', '0;15', '0;0;15']) expect(terminalThemeFor({ COLORFGBG: value })).toBe('light')
    for (const value of ['15;0', '7;8', 'bad', '', '0;999']) expect(terminalThemeFor({ COLORFGBG: value })).toBe('dark')
    expect(terminalThemeFor({ ORGAI_THEME: 'unknown' })).toBe('dark')
  })

  it('pairs input text with its surface and disables fills for plain output', () => {
    expect(composerSurface(env())).toEqual({ backgroundColor: '#2d2e34', color: '#e4e7ef' })
    expect(composerSurface(env({ terminalTheme: 'light' }))).toEqual({ backgroundColor: '#f5f5f5', color: '#202124' })
    for (const mode of [{ color: false }, { screenReader: true }, { dumbTerminal: true }]) expect(composerSurface(env(mode))).toEqual({})
  })

  it('has no colour when colour is off or no tone is given', () => {
    expect(toneColor('danger', env({ color: false }))).toBeUndefined()
    expect(toneColor(undefined, env())).toBeUndefined()
    expect(toneColor('danger', env())).toBe('red')
    expect(toneColor('ok', env())).toBe('green')
  })

  it('gives dim no foreground (dimColor alone) and keeps every colour off with colour off', () => {
    expect(toneColor('dim', env())).toBeUndefined()
    expect(toneColor('running', env())).toBe('#287fc0')
    expect(toneColor('warn', env())).toBe('#a87422')
    for (const t of ['ok', 'warn', 'danger', 'dim', 'accent', 'running'] as const) expect(toneColor(t, env({ color: false }))).toBeUndefined()
    expect(toneColor('dim', env())).not.toBe('gray')
  })

  it('separatorFor: commas for a screen reader, bars in ASCII, else a middle dot', () => {
    expect(separatorFor(env())).toBe(' · ')
    expect(separatorFor(env({ screenReader: true }))).toBe(', ')
    expect(separatorFor(env({ unicode: false }))).toBe(' | ')
    expect(separatorFor(env({ dumbTerminal: true }))).toBe(' | ')
  })

  it('uses Unicode glyphs only on a plain Unicode terminal', () => {
    expect(asciiOnly(env())).toBe(false)
    expect(glyphs(env()).bullet).toBe('•')
    expect(stateGlyph('done', env())).toBe('✓')
  })

  it.each([
    ['no unicode', { unicode: false }],
    ['screen reader', { screenReader: true }],
    ['dumb terminal', { dumbTerminal: true }]
  ] as const)('falls back to ASCII for %s', (_name, over) => {
    const e = env(over)
    expect(asciiOnly(e)).toBe(true)
    const g = glyphs(e)
    for (const s of [g.h, g.v, g.tl, g.branch, g.lastBranch, g.bullet, g.arrow, g.check, g.cross, g.ellipsis, ...g.spinner]) {
      expect(s).toMatch(/^[\x20-\x7e]+$/)
    }
    for (const st of ['starting', 'thinking', 'tool', 'waiting', 'delegating', 'idle', 'done', 'error'] as const) {
      expect(stateGlyph(st, e)).toMatch(/^[\x20-\x7e]$/)
    }
  })

  it('maps states to tones', () => {
    expect(stateTone('done')).toBe('ok')
    expect(stateTone('error')).toBe('danger')
    expect(stateTone('waiting')).toBe('warn')
    expect(stateTone('thinking')).toBe('running')
  })

  it('uses accent and warning tones with contrast against light and dark backgrounds', () => {
    for (const tone of ['accent', 'warn', 'running'] as const) {
      const hex = toneColor(tone, env())!
      const channels = hex.slice(1).match(/../g)!.map(v => {
        const c = parseInt(v, 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      expect(1.05 / (luminance + 0.05)).toBeGreaterThan(3)
      expect((luminance + 0.05) / 0.05).toBeGreaterThan(3)
    }
  })
})
