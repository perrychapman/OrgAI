import { describe, expect, it } from 'vitest'
import { dayKey } from './activityStrip'
import { projectHue } from './projectIdentity'
import { projectShare, shareText, wholePercents, type ShareRun } from './projectShare'

const at = (d: number, h = 12): number => new Date(2026, 10, d, h, 0, 0).getTime()
const keys = new Set([6, 7, 8, 9, 10, 11, 12].map((d) => dayKey(at(d))))
const projects = [
  { id: 'p1', name: 'Billing API' },
  { id: 'p2', name: 'Website' },
  { id: 'p3', name: 'Docs' },
  { id: 'p4', name: 'Mobile' },
  { id: 'p5', name: 'Infra' },
  { id: 'p6', name: 'Research' },
  { id: 'p7', name: 'Idle one' }
]
let n = 0
const runs = (projectId: string, count: number, day = 10): ShareRun[] => Array.from({ length: count }, () => ({ id: `r${n++}`, projectId, startedAt: at(day) }))

describe('wholePercents', () => {
  it('adds up to exactly 100', () => {
    for (const parts of [[1, 1, 1], [5, 3, 2], [1, 2, 4, 8, 16], [7, 7, 7, 7, 7, 7, 7], [1, 1000]]) {
      const p = wholePercents(parts)
      expect(p.reduce((a, b) => a + b, 0)).toBe(100)
    }
  })
  it('gives thirds 34, 33, 33 and keeps a tiny share at 0 or more', () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33])
    expect(wholePercents([0, 0])).toEqual([0, 0])
  })
})

describe('projectShare', () => {
  it('orders by runs, then names the text alternative from the same segments', () => {
    const s = projectShare([...runs('p2', 3), ...runs('p1', 5), ...runs('p3', 2)], keys, projects)
    expect(s.segments.map((x) => [x.name, x.runs])).toEqual([['Billing API', 5], ['Website', 3], ['Docs', 2]])
    expect(s.show).toBe(true)
    expect(s.total).toBe(10)
    expect(s.segments.map((x) => x.pct)).toEqual([50, 30, 20])
    expect(s.text).toBe('Runs by project this week: Billing API 5, Website 3, Docs 2.')
    expect(s.text).toBe(shareText(s.segments))
  })

  it('breaks ties by the newer run, then by name', () => {
    const a = [...runs('p1', 2, 8), ...runs('p2', 2, 11)]
    expect(projectShare(a, keys, projects).segments.map((x) => x.id)).toEqual(['p2', 'p1'])
    const b = [...runs('p2', 2, 9), ...runs('p1', 2, 9)]
    expect(projectShare(b, keys, projects).segments.map((x) => x.id)).toEqual(['p1', 'p2'])
  })

  it('names at most five and folds the rest into a neutral Other', () => {
    const all = [...runs('p1', 9), ...runs('p2', 8), ...runs('p3', 7), ...runs('p4', 6), ...runs('p5', 5), ...runs('p6', 2), ...runs('p7', 1)]
    const s = projectShare(all, keys, projects)
    expect(s.segments.map((x) => x.name)).toEqual(['Billing API', 'Website', 'Docs', 'Mobile', 'Infra', 'Other'])
    const other = s.segments[5]
    expect(other).toMatchObject({ id: 'other', kind: 'other', runs: 3, hue: 0 })
    expect(s.segments.reduce((a, x) => a + x.pct, 0)).toBe(100)
    expect(s.text.endsWith('Infra 5, Other 3.')).toBe(true)
  })

  it('drops projects with no run in the window and counts a run once', () => {
    const dup = { id: 'same', projectId: 'p1', startedAt: at(10) }
    const old = { id: 'old', projectId: 'p3', startedAt: new Date(2026, 9, 1).getTime() }
    const s = projectShare([dup, dup, old, ...runs('p2', 1)], keys, projects)
    expect(s.segments.map((x) => [x.id, x.runs])).toEqual([['p1', 1], ['p2', 1]])
    expect(s.total).toBe(2)
  })

  it('gives Chat and a missing project a neutral entry, never a hue', () => {
    const s = projectShare([...runs('p1', 3), ...runs('quick', 2), ...runs('gone', 1)], keys, projects)
    expect(s.segments.map((x) => [x.name, x.kind, x.hue])).toEqual([['Billing API', 'project', projectHue('p1')], ['Chat', 'chat', 0], ['Other', 'other', 0]])
  })

  it('hides itself below two entries and says so in words when empty', () => {
    expect(projectShare(runs('p1', 4), keys, projects).show).toBe(false)
    const none = projectShare([], keys, projects)
    expect(none).toMatchObject({ show: false, total: 0, segments: [] })
    expect(none.text).toBe('No runs by project this week.')
  })
})
