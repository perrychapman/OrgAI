import { describe, expect, it } from 'vitest'
import { joinAnnouncement } from './CanvasFrame'

describe('joinAnnouncement', () => {
  it('says a line alone when the previous one is old', () => {
    expect(joinAnnouncement({ text: 'A', at: 0 }, 'B', 5000)).toBe('B')
    expect(joinAnnouncement(null, 'B', 1)).toBe('B')
  })
  it('separates two lines said together with a full stop', () => {
    expect(joinAnnouncement({ text: 'Produced 4 outputs', at: 0 }, 'New decision: Edit example.ts', 100)).toBe('Produced 4 outputs. New decision: Edit example.ts')
  })
  it('does not double a stop that is already there', () => {
    expect(joinAnnouncement({ text: 'Done.', at: 0 }, 'Next', 100)).toBe('Done. Next')
    expect(joinAnnouncement({ text: 'Ready?', at: 0 }, 'Next', 100)).toBe('Ready? Next')
  })
  it('adds no stop after an ellipsis, a closing bracket or a closing quote', () => {
    expect(joinAnnouncement({ text: 'Loading…', at: 0 }, 'Next', 100)).toBe('Loading… Next')
    expect(joinAnnouncement({ text: 'Removed X (2)', at: 0 }, 'Next', 100)).toBe('Removed X (2) Next')
    expect(joinAnnouncement({ text: 'Saved "a b"', at: 0 }, 'Next', 100)).toBe('Saved "a b" Next')
    expect(joinAnnouncement({ text: 'Saved “a b”', at: 0 }, 'Next', 100)).toBe('Saved “a b” Next')
  })
  it('trims trailing whitespace before joining', () => {
    expect(joinAnnouncement({ text: 'Done  ', at: 0 }, 'Next', 100)).toBe('Done. Next')
    expect(joinAnnouncement({ text: 'A. B  ', at: 0 }, 'B', 100)).toBe('A. B')
  })
  it('does not repeat a line already at the end', () => {
    expect(joinAnnouncement({ text: 'A. B', at: 0 }, 'B', 100)).toBe('A. B')
  })
})
