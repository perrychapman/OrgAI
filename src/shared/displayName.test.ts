import { describe, expect, it } from 'vitest'
import { DISPLAY_NAME_MAX_CHARS, cleanDisplayName } from './displayName'

describe('cleanDisplayName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanDisplayName('  Ada \t  Lovelace\n')).toBe('Ada Lovelace')
  })
  it('keeps plain non-ASCII names', () => {
    expect(cleanDisplayName('Zoë 李')).toBe('Zoë 李')
  })
  it('returns undefined for non-strings and empty results', () => {
    for (const v of [undefined, null, 5, {}, ['a'], true, '', '   \n\t']) expect(cleanDisplayName(v)).toBeUndefined()
  })
  it('refuses control, bidi, zero-width and format characters', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u007fb', 'a‮b', 'a​b', 'a﻿b', 'a⁦b', 'a­b', '\u{e0041}a'])
      expect(cleanDisplayName(bad)).toBeUndefined()
  })
  it('counts code points: 40 passes, 41 does not, nothing is clipped', () => {
    expect(cleanDisplayName('a'.repeat(DISPLAY_NAME_MAX_CHARS))).toBe('a'.repeat(40))
    expect(cleanDisplayName('a'.repeat(41))).toBeUndefined()
    expect(cleanDisplayName('😀'.repeat(40))).toBe('😀'.repeat(40))
    expect(cleanDisplayName('😀'.repeat(41))).toBeUndefined()
  })
})
