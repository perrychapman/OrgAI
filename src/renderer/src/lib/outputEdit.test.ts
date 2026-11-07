import { describe, expect, it } from 'vitest'
import {
  JSON_INVALID_SAVE,
  NO_CHANGES_TEXT,
  SVG_ACTIVE_SAVE,
  caretPosition,
  compareLabel,
  discardBody,
  formatJson,
  isDirty,
  jsonStatus,
  readOnlyReason,
  saveAnywayLabel,
  saveBlockedReason,
  saveOutcome,
  staleText,
  tooLargeToEdit
} from './outputEdit'

describe('jsonStatus', () => {
  it('says Valid JSON.', () => {
    expect(jsonStatus('{"a": [1, 2]}')).toEqual({ ok: true, line: 'Valid JSON.' })
  })
  it('names the line of a missing comma', () => {
    const s = jsonStatus('{\n  "a": 1\n  "b": 2\n}')
    expect(s.ok).toBe(false)
    if (!s.ok) {
      expect(s.line).toMatch(/^Line \d+: /)
      expect(s.at).toBeGreaterThanOrEqual(2)
    }
  })
  it('handles an empty text and a text that ends too early', () => {
    const e = jsonStatus('')
    expect(e.ok).toBe(false)
    const t = jsonStatus('{"a": ')
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.line).toMatch(/^Line 1: /)
  })
})

describe('formatJson', () => {
  it('pretty prints with 2 spaces and keeps the final line break', () => {
    expect(formatJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(formatJson('[1]\n')?.endsWith('\n')).toBe(true)
  })
  it('returns null for invalid text', () => {
    expect(formatJson('{')).toBeNull()
  })
})

describe('dirty and size', () => {
  it('compares exact text', () => {
    expect(isDirty('a', 'a')).toBe(false)
    expect(isDirty('a', 'a ')).toBe(true)
  })
  it('counts bytes, not characters', () => {
    expect(tooLargeToEdit('x'.repeat(1024))).toBe(false)
    expect(tooLargeToEdit('é'.repeat(600_000))).toBe(true)
  })
})

describe('readOnlyReason', () => {
  it('orders the reasons', () => {
    expect(readOnlyReason({ output: { missing: true, kind: 'markdown' }, isCurrent: true })).toBe('The file is gone.')
    expect(readOnlyReason({ output: { kind: 'markdown' }, isCurrent: false })).toBe('Restore this version to edit it.')
    expect(readOnlyReason({ output: { kind: 'markdown' }, isCurrent: true, referenceFolder: true })).toMatch(/folder agents may only read/)
    expect(readOnlyReason({ output: { kind: 'docx' }, isCurrent: true })).toMatch(/your own app/)
    expect(readOnlyReason({ output: { kind: 'csv' }, isCurrent: true })).toBeNull()
  })
})

describe('save wording', () => {
  it('says why Save is blocked', () => {
    expect(saveBlockedReason({ dirty: false })).toBe(NO_CHANGES_TEXT)
    expect(saveBlockedReason({ dirty: true, jsonOk: false })).toBe(JSON_INVALID_SAVE)
    expect(saveBlockedReason({ dirty: true, svgRefused: true })).toBe(SVG_ACTIVE_SAVE)
    expect(saveBlockedReason({ dirty: true })).toBeNull()
  })
  it('words the three answers', () => {
    const out = { id: 'o' } as never
    expect(saveOutcome({ ok: true, output: out, version: 4 })).toMatchObject({ kind: 'saved', text: 'Saved as version 4.' })
    expect(saveOutcome({ stale: true, currentVersion: 5 })).toMatchObject({ kind: 'stale', text: staleText(5) })
    expect(saveOutcome({ refused: 'No.' })).toEqual({ kind: 'refused', text: 'No.' })
    expect(saveAnywayLabel(5)).toBe('Save as version 6 anyway')
    expect(compareLabel(5)).toBe('Compare with version 5')
    expect(discardBody('Plan')).toBe('Discard your changes to Plan? They cannot be brought back.')
  })
})

describe('caretPosition', () => {
  it('is 1-based', () => {
    expect(caretPosition('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
    expect(caretPosition('', 0)).toEqual({ line: 1, column: 1 })
  })
})
