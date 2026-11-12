import { describe, expect, it } from 'vitest'
import { alignRight, clampInt, graphemes, padToWidth, sliceToWidth, textWidth, truncateEnd, wrapText } from './text'

describe('pane text helpers', () => {
  it('counts wide characters as two columns and combining marks as none', () => {
    expect(textWidth('abc')).toBe(3)
    expect(textWidth('漢字')).toBe(4)
    expect(textWidth('ｱ')).toBe(1)
    expect(textWidth('Ａ')).toBe(2)
    expect(textWidth('é')).toBe(1)
    expect(textWidth('🎉')).toBe(2)
  })

  it('counts by grapheme cluster: VS16, ZWJ, flags and marks after wide characters', () => {
    expect(textWidth('❤️')).toBe(2)
    expect(textWidth('☀️')).toBe(2)
    expect(textWidth('1️⃣')).toBe(2)
    expect(textWidth('👨‍👩‍👧')).toBe(2)
    expect(textWidth('🇩🇪')).toBe(2)
    expect(textWidth('🇩🇪🇫🇷')).toBe(4)
    expect(textWidth('漢́')).toBe(2)
    expect(textWidth('é')).toBe(1)
    expect(textWidth('a👨‍👩‍👧b')).toBe(4)
    expect(graphemes('a👨‍👩‍👧🇩🇪')).toHaveLength(3)
  })

  it('never splits a cluster when cutting, padding or wrapping', () => {
    const family = '👨‍👩‍👧'
    expect(sliceToWidth(`a${family}b`, 2)).toBe('a')
    expect(sliceToWidth(`a${family}b`, 3)).toBe(`a${family}`)
    expect(sliceToWidth('🇩🇪🇫🇷', 3)).toBe('🇩🇪')
    expect(sliceToWidth('漢́字', 2)).toBe('漢́')
    expect(truncateEnd(`ab${family}cd`, 4)).toBe('ab…')
    expect(truncateEnd(`${family}${family}`, 3)).toBe(`${family}…`)
    expect(padToWidth(family, 4)).toBe(`${family}  `)
    expect(wrapText(`${family}${family}${family}`, 3)).toEqual([family, family, family])
    // Every cut piece is a whole number of clusters (no lone surrogate).
    for (const piece of wrapText('🇩🇪🇫🇷👨‍👩‍👧x❤️', 3)) expect(piece).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('truncates, pads and right-aligns by columns', () => {
    expect(truncateEnd('hello world', 8)).toBe('hello w…')
    expect(truncateEnd('漢字漢字', 5)).toBe('漢字…')
    expect(truncateEnd('abc', 0)).toBe('')
    expect(truncateEnd('abcdef', 2, '...')).toBe('..')
    expect(padToWidth('ab', 4)).toBe('ab  ')
    expect(alignRight('left side', '$1', 14)).toBe('left side   $1')
    expect(alignRight('a long left side', '$1.00', 12)).toBe('a lon… $1.00')
    expect(textWidth(alignRight('x', 'too wide for this', 5))).toBeLessThanOrEqual(5)
  })

  it('wraps at spaces, hard-cuts long words and keeps empty lines', () => {
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three'])
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('a\n\nb', 5)).toEqual(['a', '', 'b'])
    expect(wrapText('漢字漢字', 3)).toEqual(['漢', '字', '漢', '字'])
    expect(wrapText('anything', 0)).toEqual([])
    expect(wrapText('漢', 1)).toEqual([''])
  })

  it('clamps', () => {
    expect(clampInt(5.7, 0, 3)).toBe(3)
    expect(clampInt(Number.NaN, 2, 9)).toBe(2)
    expect(clampInt(-1, 0, 3)).toBe(0)
  })
})
