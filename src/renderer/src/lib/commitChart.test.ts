import { describe, expect, it } from 'vitest'
import { barHeightPx, COMMIT_MIN_SEGMENT_PX, commitChart, commitsWord, minBarPx, weekDays, type CommitActivityInput } from './commitChart'
import { projectHue } from './projectIdentity'

// Thursday 19 Nov 2026, local noon.
const NOW = new Date(2026, 10, 19, 12).getTime()
const KEYS = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']

function activity(projectId: string, counts: number[], available = true): CommitActivityInput {
  return { projectId, available, days: KEYS.map((date, i) => ({ date, commits: counts[i] ?? 0 })), total: counts.reduce((a, b) => a + b, 0) }
}
const P = [
  { id: 'billing', name: 'Billing API' },
  { id: 'site', name: 'Website' },
  { id: 'cli', name: 'CLI' }
]

describe('weekDays', () => {
  it('is seven local days, oldest first, today last', () => {
    const w = weekDays(NOW)
    expect(w.map((d) => d.key)).toEqual(KEYS)
    expect(w.map((d) => d.today)).toEqual([false, false, false, false, false, false, true])
  })
  it('does not skip or repeat a day across a daylight saving change', () => {
    const w = weekDays(new Date(2026, 2, 30, 12).getTime())
    expect(new Set(w.map((d) => d.key)).size).toBe(7)
    expect(w[6].key).toBe('2026-03-30')
  })
})

describe('commitChart', () => {
  it('builds stacked columns in project order with day names and readouts', () => {
    const c = commitChart([activity('site', [0, 0, 0, 0, 0, 1, 3]), activity('billing', [0, 0, 0, 0, 0, 2, 4])], P, NOW)
    expect(c.empty).toBe(false)
    expect(c.total).toBe(10)
    expect(c.max).toBe(7)
    // Billing API (6) outranks Website (4): first in the legend, drawn at the bottom.
    expect(c.legend.map((l) => [l.name, l.total])).toEqual([['Billing API', 6], ['Website', 4]])
    const today = c.columns[6]
    expect(today.today).toBe(true)
    expect(today.total).toBe(7)
    expect(today.segments.map((s) => [s.id, s.commits, s.hue])).toEqual([['billing', 4, projectHue('billing')], ['site', 3, projectHue('site')]])
    expect(today.name).toBe('Today, Thu 19 Nov: 7 commits, Billing API 4, Website 3')
    expect(today.readout).toBe('Today: 7 commits · Billing API 4 · Website 3')
    expect(c.columns[5].name).toBe('Wed 18 Nov: 3 commits, Billing API 2, Website 1')
    expect(c.columns[5].readout).toBe('Wed 18 Nov: 3 commits · Billing API 2 · Website 1')
    expect(c.weekReadout).toBe('Last 7 days: 10 commits · Billing API 6 · Website 4')
  })

  it('scales linearly from zero against the busiest day', () => {
    const c = commitChart([activity('billing', [1, 0, 0, 0, 0, 2, 4])], P, NOW)
    expect(c.columns.map((x) => Math.round(x.pct))).toEqual([25, 0, 0, 0, 0, 50, 100])
  })

  it('leaves out unavailable projects, unknown ids and malformed day lists', () => {
    const bad: CommitActivityInput = { projectId: 'site', available: true, days: [{ date: KEYS[6], commits: 9 }], total: 9 }
    const c = commitChart([activity('billing', [0, 0, 0, 0, 0, 0, 2]), activity('site', [0, 0, 0, 0, 0, 0, 5], false), activity('ghost', [0, 0, 0, 0, 0, 0, 7]), bad], P, NOW)
    expect(c.total).toBe(2)
    expect(c.legend.map((l) => l.id)).toEqual(['billing'])
  })

  it('ignores a repeated project, junk entries and junk counts', () => {
    const junk = { projectId: 'cli', available: true, days: KEYS.map((date) => ({ date, commits: Number.NaN })), total: 0 }
    const c = commitChart([activity('billing', [0, 0, 0, 0, 0, 0, 2]), activity('billing', [0, 0, 0, 0, 0, 0, 9]), junk, null as unknown as CommitActivityInput], P, NOW)
    expect(c.total).toBe(2)
    expect(c.legend).toHaveLength(1)
    expect(commitChart(undefined, P, NOW).empty).toBe(true)
    expect(commitChart('x' as unknown as CommitActivityInput[], P, NOW).empty).toBe(true)
  })

  it('matches days by date, so a stale answer loses its oldest day instead of shifting', () => {
    const stale: CommitActivityInput = { projectId: 'billing', available: true, days: ['2026-11-12', ...KEYS.slice(0, 6)].map((date, i) => ({ date, commits: i === 0 ? 8 : 1 })), total: 14 }
    const c = commitChart([stale], P, NOW)
    expect(c.total).toBe(6)
    expect(c.columns[6].total).toBe(0)
    expect(c.columns[5].total).toBe(1)
  })

  it('folds everything beyond the top five into a neutral Other, last', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const projects = ids.map((id) => ({ id, name: id.toUpperCase() }))
    const input = ids.map((id, i) => activity(id, [0, 0, 0, 0, 0, 0, 10 - i]))
    const c = commitChart(input, projects, NOW)
    expect(c.legend.map((l) => l.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other'])
    const other = c.legend[5]
    expect(other).toMatchObject({ kind: 'other', hue: 0, total: 5 + 4 })
    const segs = c.columns[6].segments
    expect(segs[segs.length - 1]).toMatchObject({ id: 'other', kind: 'other', hue: 0, commits: 9 })
    expect(c.columns[6].total).toBe(10 + 9 + 8 + 7 + 6 + 5 + 4)
  })

  it('breaks ties by name, then id', () => {
    const c = commitChart([activity('site', [0, 0, 0, 0, 0, 0, 2]), activity('billing', [0, 0, 0, 0, 0, 0, 2]), activity('cli', [0, 0, 0, 0, 0, 0, 2])], P, NOW)
    expect(c.legend.map((l) => l.name)).toEqual(['Billing API', 'CLI', 'Website'])
  })

  it('is empty when no available project has a commit', () => {
    const c = commitChart([activity('billing', []), activity('site', [0, 0, 0, 0, 0, 0, 3], false)], P, NOW)
    expect(c.empty).toBe(true)
    expect(c.total).toBe(0)
    expect(c.legend).toEqual([])
    expect(c.columns).toHaveLength(7)
    expect(c.columns.every((x) => x.pct === 0 && x.segments.length === 0)).toBe(true)
    expect(c.columns[0].name).toBe('Fri 13 Nov: no commits')
    expect(c.columns[6].name).toBe('Today, Thu 19 Nov: no commits')
    expect(c.text).toBe('No commits in the last 7 days.')
    expect(c.weekReadout).toBe('No commits in the last 7 days')
  })

  it('labels the columns with weekday initials', () => {
    const c = commitChart([activity('billing', [1])], P, NOW)
    expect(c.columns.map((x) => x.initial)).toEqual(['F', 'S', 'S', 'M', 'T', 'W', 'T'])
  })

  it('writes one text alternative from the same numbers', () => {
    const c = commitChart([activity('billing', [0, 0, 0, 0, 0, 2, 4]), activity('site', [0, 0, 0, 0, 0, 1, 3])], P, NOW)
    expect(c.text).toBe(
      'Commits by project, last 7 days: 10 commits. Billing API 6, Website 4. By day: Fri 13 Nov none; Sat 14 Nov none; Sun 15 Nov none; Mon 16 Nov none; Tue 17 Nov none; Wed 18 Nov 3 (Billing API 2, Website 1); Today 7 (Billing API 4, Website 3).'
    )
  })

  it('uses the singular for one commit', () => {
    expect(commitsWord(1)).toBe('1 commit')
    expect(commitsWord(2)).toBe('2 commits')
    const c = commitChart([activity('billing', [0, 0, 0, 0, 0, 0, 1])], P, NOW)
    expect(c.columns[6].name).toBe('Today, Thu 19 Nov: 1 commit, Billing API 1')
  })
})

describe('bar geometry', () => {
  it('is linear from zero with a 2 px floor for any day with commits', () => {
    expect(barHeightPx(0, 10, 96)).toBe(0)
    expect(barHeightPx(10, 10, 96)).toBe(96)
    expect(barHeightPx(5, 10, 96)).toBe(48)
    expect(barHeightPx(1, 1000, 96)).toBe(COMMIT_MIN_SEGMENT_PX)
    expect(barHeightPx(3, 0, 96)).toBe(0)
  })
  it('reserves the minimum of every stacked segment plus the 2 px gaps', () => {
    expect(minBarPx(0)).toBe(0)
    expect(minBarPx(1)).toBe(2)
    expect(minBarPx(3)).toBe(10)
  })
})
