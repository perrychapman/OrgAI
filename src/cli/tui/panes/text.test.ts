import { describe, expect, it } from 'vitest'
import { alignRight, clampInt, padToWidth, textWidth, truncateEnd, wrapText } from './text'

describe('pane text helpers', () => {
  it('counts wide characters as two columns and combining marks as none', () => {
    expect(textWidth('abc')).toBe(3)
    expect(textWidth('漢字')).toBe(4)
    expect(textWidth('ｱ')).toBe(1)
    expect(textWidth('Ａ')).toBe(2)
    expect(textWidth('é')).toBe(1)
    expect(textWidth('🎉')).toBe(2)
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
