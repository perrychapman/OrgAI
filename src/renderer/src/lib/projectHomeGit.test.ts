import { describe, expect, it } from 'vitest'
import { healthLines, mergedRows, nightlyBars, nightlySummary, normalizeGit, oldestText, repoStrip, shortAge } from './projectHomeGit'

const NOW = new Date(2026, 10, 22, 12, 0).getTime()
const H = 3_600_000
const D = 24 * H

describe('normalizeGit', () => {
  it('is null for anything unusable', () => {
    expect(normalizeGit(null)).toBeNull()
    expect(normalizeGit('x')).toBeNull()
    expect(normalizeGit({})).toBeNull()
    expect(normalizeGit({ available: false, branch: 'main' })).toBeNull()
  })
  it('keeps trusted fields only', () => {
    const g = normalizeGit({
      branch: ' main ',
      defaultBranch: 'main',
      lastCommit: { at: 5 },
      dirtyFiles: 3,
      unmerged: { count: 2, oldestAt: 7 },
      ahead: 1,
      behind: -4,
      commits: [{ subject: 'Fix', at: 9, added: 15, removed: 5 }, { subject: '', at: 1 }, { subject: 'No time' }, { subject: 'Odd', at: 2, added: 'x' }]
    })!
    expect(g.branch).toBe('main')
    expect(g.lastMergeAt).toBe(5)
    expect(g.dirtyFiles).toBe(3)
    expect(g.unmerged).toEqual({ count: 2, oldestAt: 7 })
    expect(g.ahead).toBe(1)
    expect(g.behind).toBeUndefined()
    expect(g.commits).toEqual([
      { subject: 'Fix', at: 9, added: 15, removed: 5 },
      { subject: 'Odd', at: 2, added: 0, removed: 0 }
    ])
  })
})

describe('repoStrip', () => {
  it('always has the folder and adds the git facts it knows', () => {
    expect(repoStrip(null, 'C:\\Code\\app', NOW).map((i) => i.key)).toEqual(['folder'])
    const items = repoStrip({ branch: 'main', lastMergeAt: NOW - 2 * H, unmerged: { count: 3 } }, '/work/app', NOW)
    expect(items.map((i) => [i.key, i.value])).toEqual([
      ['branch', 'main'],
      ['merge', '2 h ago'],
      ['branches', '3'],
      ['folder', '/work/app']
    ])
  })
})

describe('health lines', () => {
  const sch = (id: string, lastEntry: unknown) => ({ id, name: `Schedule ${id}`, lastEntry, consecutiveFailures: 0, state: 'active' }) as never
  it('is empty with nothing real to say', () => {
    expect(healthLines(null, [], NOW)).toEqual([])
    expect(healthLines({ branch: 'main' }, [sch('a', undefined)], NOW)).toEqual([])
  })
  it('words the git facts with tones', () => {
    const lines = healthLines({ defaultBranch: 'main', unmerged: { count: 3, oldestAt: NOW - 2 * D }, dirtyFiles: 4, ahead: 1, behind: 2 }, [], NOW)
    expect(lines.map((l) => [l.key, l.value, l.tone])).toEqual([
      ['unmerged', '3, oldest 2 days', 'muted'],
      ['dirty', '4 files', 'warn'],
      ['sync', '1 ahead, 2 behind', 'warn']
    ])
    expect(healthLines({ unmerged: { count: 1, oldestAt: NOW - 9 * D } }, [], NOW)[0].tone).toBe('warn')
  })
  it('says clean states as ok', () => {
    const lines = healthLines({ unmerged: { count: 0 }, dirtyFiles: 0, ahead: 0, behind: 0 }, [], NOW)
    expect(lines.map((l) => [l.value, l.tone])).toEqual([
      ['none', 'ok'],
      ['none', 'ok'],
      ['in step', 'ok']
    ])
  })
  it('adds a line per schedule that has run, failures bad', () => {
    const lines = healthLines(null, [sch('a', { result: 'started', outcome: 'finished', at: 1 }), sch('b', { result: 'started', outcome: 'error', at: 1 }), sch('c', { result: 'skipped', at: 1 })], NOW)
    expect(lines.map((l) => [l.label, l.value, l.tone])).toEqual([
      ['Schedule a', 'finished', 'ok'],
      ['Schedule b', 'failed', 'bad'],
      ['Schedule c', 'skipped', 'warn']
    ])
  })
  it('says the oldest age in days', () => {
    expect(oldestText(NOW - 30 * 60_000, NOW)).toBe('oldest today')
    expect(oldestText(NOW - D, NOW)).toBe('oldest 1 day')
  })
})

describe('nightly bars', () => {
  const e = (daysAgo: number, over: Record<string, unknown> = {}) => ({ at: NOW - daysAgo * D, outcome: 'finished' as const, result: 'started' as const, ...over })
  it('needs at least three entries to draw a pattern', () => {
    expect(nightlyBars([], NOW)).toBeNull()
    expect(nightlyBars([e(1), e(2)], NOW)).toBeNull()
  })
  it('draws oldest first with failures tall and red, and caps the count', () => {
    const bars = nightlyBars([e(1, { outcome: 'error' }), e(2), e(3), e(4, { result: 'skipped', outcome: undefined })], NOW)!
    expect(bars.map((b) => b.tone)).toEqual(['warn', 'ok', 'ok', 'bad'])
    expect(bars[3].height).toBe(100)
    expect(bars[0].label).toContain('skipped')
    const many = Array.from({ length: 30 }, (_, i) => e(i + 1))
    expect(nightlyBars(many, NOW)).toHaveLength(14)
  })
  it('scales finished bars by known cost and has a text alternative', () => {
    const bars = nightlyBars([e(1, { costUsd: 1 }), e(2, { costUsd: 0.5 }), e(3)], NOW)!
    expect(bars[2].height).toBeGreaterThan(bars[1].height)
    expect(bars[1].label).toContain('$0.50')
    expect(nightlySummary(nightlyBars([e(1), e(2), e(3, { outcome: 'error' })], NOW)!)).toBe('Last 3 runs: 2 fine, 1 failed')
  })
})

describe('merged lately', () => {
  it('is empty without commits and shows short ages', () => {
    expect(mergedRows(null, NOW)).toEqual([])
    const rows = mergedRows({ commits: [{ subject: 'A', at: NOW - 2 * H, added: 15, removed: 5 }, { subject: 'B', at: NOW - 1 * D, added: 1, removed: 0 }] }, NOW)
    expect(rows.map((r) => [r.subject, r.added, r.removed, r.when])).toEqual([
      ['A', 15, 5, '2 h'],
      ['B', 1, 0, '1 d']
    ])
    expect(mergedRows({ commits: Array.from({ length: 9 }, (_, i) => ({ subject: `c${i}`, at: NOW, added: 0, removed: 0 })) }, NOW)).toHaveLength(5)
  })
  it('ages: now, minutes, hours, days, weeks', () => {
    expect(shortAge(NOW - 10_000, NOW)).toBe('now')
    expect(shortAge(NOW - 5 * 60_000, NOW)).toBe('5 m')
    expect(shortAge(NOW - 3 * H, NOW)).toBe('3 h')
    expect(shortAge(NOW - 6 * D, NOW)).toBe('6 d')
    expect(shortAge(NOW - 21 * D, NOW)).toBe('3 w')
  })
})
