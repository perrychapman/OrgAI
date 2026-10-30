import { describe, expect, it } from 'vitest'
import { parseJsonc } from './jsonc'

describe('parseJsonc', () => {
  it('strips comments and trailing commas but not inside strings', () => {
    const r = parseJsonc('﻿{\n // c\n "a": "http://x/*y*/", /* b */ "b": [1, 2, ], "c": {"d": 1,\n // z\n },\n}')
    expect(r.value).toEqual({ a: 'http://x/*y*/', b: [1, 2], c: { d: 1 } })
  })
  it('reports errors without throwing', () => {
    expect(parseJsonc('{ "a": ').error).toBeTruthy()
    expect(parseJsonc('/* open').error).toMatch(/comment/)
  })
})
