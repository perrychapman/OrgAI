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
})
