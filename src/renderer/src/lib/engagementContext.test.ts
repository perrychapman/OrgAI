import { describe, expect, it } from 'vitest'
import { idAfterNoteRemoval, noteSizeLabel, notesCountLine, planDateLabel, planRevisedLine, setupBlocksPlan, sortNotes } from './engagementContext'

describe('engagement context copy', () => {
  it('blocks plan edits only while a setup run is proposing', () => {
    expect(setupBlocksPlan([])).toBe(false)
    expect(setupBlocksPlan([{ status: 'idle', proposals: 0 }])).toBe(false)
    expect(setupBlocksPlan([{ status: 'finished', proposals: 0 }, { status: 'error', proposals: 0 }])).toBe(false)
    expect(setupBlocksPlan([{ status: 'running', proposals: 0 }])).toBe(true)
    expect(setupBlocksPlan([{ status: 'starting', proposals: 0 }])).toBe(true)
    expect(setupBlocksPlan([{ status: 'idle', proposals: 1 }])).toBe(true)
  })
  it('words a plan date', () => {
    expect(planDateLabel(undefined)).toBe('')
    expect(planDateLabel(Date.UTC(2026, 10, 4, 12))).toMatch(/2026/)
  })
  it('words who wrote the plan', () => {
    expect(planRevisedLine({})).toBeNull()
    expect(planRevisedLine({ updatedAt: 0 })).toBeNull()
    const t = Date.UTC(2026, 10, 4, 12)
    expect(planRevisedLine({ updatedAt: t, updatedBy: 'user' })?.text).toMatch(/^Edited by you, /)
    expect(planRevisedLine({ updatedAt: t, updatedBy: 'setup' })?.text).toMatch(/^Approved in the setup interview, /)
  })
  it('sorts notes newest edit first', () => {
    const notes = [
      { id: 'a', title: 'B', updatedAt: 1 },
      { id: 'b', title: 'A', updatedAt: 3 },
      { id: 'c', title: 'C', updatedAt: 3 }
    ]
    expect(sortNotes(notes).map((n) => n.id)).toEqual(['b', 'c', 'a'])
  })
  it('words sizes and counts', () => {
    expect(noteSizeLabel(1)).toBe('1 character')
    expect(noteSizeLabel(0)).toBe('0 characters')
    expect(notesCountLine(12, 50)).toBe('12 of 50 notes')
  })
  it('picks the row to focus after a removal', () => {
    expect(idAfterNoteRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(idAfterNoteRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(idAfterNoteRemoval(['a'], 'a')).toBeNull()
    expect(idAfterNoteRemoval(['a'], 'x')).toBeNull()
  })
})
