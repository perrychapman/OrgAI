import { describe, expect, it } from 'vitest'
import { TEAM_HINT_KEY, TEAM_LAYOUT_KEY, readTeamHintSeen, readTeamLayout, writeTeamHintSeen, writeTeamLayout, type StorageLike } from './teamPrefs'

function memory(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    }
  }
}

const broken: StorageLike = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  }
}

describe('Team layout preference', () => {
  it('defaults to top to bottom and ignores an unknown value', () => {
    const s = memory()
    expect(readTeamLayout(s)).toBe('top-down')
    s.data[TEAM_LAYOUT_KEY] = 'radial'
    expect(readTeamLayout(s)).toBe('top-down')
  })

  it('round-trips left to right under orgai.teamLayout', () => {
    const s = memory()
    writeTeamLayout(s, 'left-right')
    expect(s.data['orgai.teamLayout']).toBe('left-right')
    expect(readTeamLayout(s)).toBe('left-right')
    writeTeamLayout(s, 'top-down')
    expect(readTeamLayout(s)).toBe('top-down')
  })

  it('survives a store that throws or is missing', () => {
    expect(readTeamLayout(broken)).toBe('top-down')
    expect(() => writeTeamLayout(broken, 'left-right')).not.toThrow()
    expect(readTeamLayout(undefined)).toBe('top-down')
  })
})

describe('first-visit hint memory', () => {
  it('is unseen until written, then seen', () => {
    const s = memory()
    expect(readTeamHintSeen(s)).toBe(false)
    writeTeamHintSeen(s)
    expect(s.data[TEAM_HINT_KEY]).toBe('1')
    expect(readTeamHintSeen(s)).toBe(true)
  })

  it('treats a throwing store as unseen and never throws on write', () => {
    expect(readTeamHintSeen(broken)).toBe(false)
    expect(() => writeTeamHintSeen(broken)).not.toThrow()
  })
})
