import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatFullDateTime } from './dates'

const at = new Date(2026, 10, 4, 11, 46).getTime()

describe('dates', () => {
  it('formats day-month-year, never month-day', () => {
    expect(formatDate(at)).toBe('4 Nov 2026')
    expect(formatDateTime(at)).toBe('4 Nov 2026 11:46')
  })
  it('is empty for unusable times', () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDate(bad)).toBe('')
      expect(formatDateTime(bad)).toBe('')
      expect(formatFullDateTime(bad)).toBe('')
    }
  })
  it('gives a full local string for titles', () => {
    expect(formatFullDateTime(at)).toBe(new Date(at).toLocaleString())
  })
})
