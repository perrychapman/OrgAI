import { describe, expect, it } from 'vitest'
import { hasHidden, showHidden } from './hiddenChars'

describe('hiddenChars', () => {
  it('detects bidi, zero-width and control characters', () => {
    expect(hasHidden('npx a')).toBe(false)
    expect(hasHidden('line one\n\tline two')).toBe(false)
    expect(hasHidden('a‮b')).toBe(true)
    expect(hasHidden('a​b')).toBe(true)
    expect(hasHidden('a\u0007b')).toBe(true)
    expect(hasHidden(undefined)).toBe(false)
  })
  it('shows them as escapes and leaves the rest alone', () => {
    expect(showHidden('rm‮ -rf')).toBe('rm\\u202e -rf')
    expect(showHidden('a​\u0007b')).toBe('a\\u200b\\u0007b')
    expect(showHidden('plain\nnext')).toBe('plain\nnext')
  })
  it('matches the main-process set: soft hyphen, fillers, word joiner range, tag characters', () => {
    for (const c of ['\u00ad', '\u034f', '\u115f', '\u1160', '\u180e', '\u2060', '\u206f', '\u3164', '\uffa0', '\u{e0041}']) expect(hasHidden(`a${c}b`)).toBe(true)
  })
  it('escapes astral code points with braces', () => {
    expect(showHidden('a\u{e0041}b')).toBe('a\\u{e0041}b')
    expect(showHidden('x\u00ady')).toBe('x\\u00ady')
  })
})
