import { describe, expect, it } from 'vitest'
import { asciiOnly, glyphs, separatorFor, stateGlyph, stateTone, toneColor } from './theme'
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
  it('has no colour when colour is off or no tone is given', () => {
    expect(toneColor('danger', env({ color: false }))).toBeUndefined()
    expect(toneColor(undefined, env())).toBeUndefined()
    expect(toneColor('danger', env())).toBe('red')
    expect(toneColor('ok', env())).toBe('green')
  })

  it('gives dim no foreground (dimColor alone) and keeps every colour off with colour off', () => {
    expect(toneColor('dim', env())).toBeUndefined()
    expect(toneColor('running', env())).toBe('blueBright')
    expect(toneColor('warn', env())).toBe('magenta')
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
})
