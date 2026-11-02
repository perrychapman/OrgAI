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
})
