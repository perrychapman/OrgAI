import { describe, expect, it } from 'vitest'
import { clampLabel } from './clampLabel'

describe('clampLabel', () => {
  it('keeps short text', () => expect(clampLabel('abc')).toBe('abc'))
  it('clamps long text to max with an ellipsis', () => {
    const out = clampLabel('x'.repeat(500))
    expect(out.length).toBe(80)
    expect(out.endsWith('…')).toBe(true)
  })
  it('honours a custom max', () => expect(clampLabel('abcdef', 4)).toBe('abc…'))
  it('replaces bidi, zero-width and control characters', () => {
    expect(clampLabel('ev‮il')).toBe('ev il')
    expect(clampLabel('a​b\u0007c')).toBe('a b c')
    expect(clampLabel('  x\ny ')).toBe('x y')
  })
  it('does not fail on a non-string', () => expect(clampLabel(undefined as unknown as string)).toBe(''))
})
