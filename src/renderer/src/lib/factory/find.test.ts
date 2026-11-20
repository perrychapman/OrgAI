import { describe, expect, it } from 'vitest'
import { filterFind, groupFind, type FindEntry } from './find'

const entries: FindEntry[] = [
  { id: 'a', name: 'Orchestrator', handle: 'root', session: 'current' },
  { id: 'b', name: 'Reviewer', handle: 'rev-1', session: 'current' },
  { id: 'c', name: 'Old Builder', session: 'earlier' }
]

describe('find', () => {
  it('keeps everything for a blank query', () => {
    expect(filterFind(entries, '  ')).toHaveLength(3)
  })
  it('matches name or handle case-insensitively', () => {
    expect(filterFind(entries, 'REV').map((e) => e.id)).toEqual(['b'])
    expect(filterFind(entries, 'root').map((e) => e.id)).toEqual(['a'])
    expect(filterFind(entries, 'builder').map((e) => e.id)).toEqual(['c'])
    expect(filterFind(entries, 'zzz')).toEqual([])
  })
  it('groups current before earlier', () => {
    const g = groupFind(entries)
    expect(g.current.map((e) => e.id)).toEqual(['a', 'b'])
    expect(g.earlier.map((e) => e.id)).toEqual(['c'])
  })
})
