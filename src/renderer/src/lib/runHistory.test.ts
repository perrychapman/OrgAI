import { describe, expect, it } from 'vitest'
import {
  agentTally,
  bucketCounts,
  bucketOf,
  chainFacts,
  dayLabel,
  groupByDay,
  inPeriod,
  matchesQuery,
  oneLine,
  resultLine,
  runSummaryText,
  stepTone,
  takeDays,
  tallyText
} from './runHistory'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
// Saturday 7 November 2026, mid-afternoon.
const NOW = at(2026, 11, 7, 15)

describe('buckets', () => {
  it('maps every status word', () => {
    expect(bucketOf('Running')).toBe('running')
    expect(bucketOf('Needs you')).toBe('open')
    expect(bucketOf('Idle')).toBe('open')
    expect(bucketOf('Paused')).toBe('open')
    expect(bucketOf('Finished')).toBe('finished')
    expect(bucketOf('Failed')).toBe('failed')
    expect(bucketOf('Stopped')).toBe('stopped')
  })
  it('counts', () => {
    expect(bucketCounts(['finished', 'finished', 'failed'])).toEqual({ running: 0, open: 0, finished: 2, failed: 1, stopped: 0 })
  })
})

describe('period and search', () => {
  it('keeps the last N calendar days including today', () => {
    expect(inPeriod(at(2026, 11, 1, 0), '7', NOW)).toBe(true)
    expect(inPeriod(at(2026, 10, 31, 23), '7', NOW)).toBe(false)
    expect(inPeriod(at(2020, 1, 1), 'all', NOW)).toBe(true)
  })
  it('matches every word in any field', () => {
    expect(matchesQuery(['Fix the flaky test', 'src/notes.js'], 'flaky notes')).toBe(true)
    expect(matchesQuery(['Fix the flaky test'], 'flaky pagination')).toBe(false)
    expect(matchesQuery([undefined, 'x'], '')).toBe(true)
  })
})

describe('days', () => {
  it('labels today, yesterday, weekdays and dates', () => {
    expect(dayLabel(at(2026, 11, 7, 1), NOW)).toBe('Today')
    expect(dayLabel(at(2026, 11, 6, 23), NOW)).toBe('Yesterday')
    expect(dayLabel(at(2026, 11, 3), NOW)).toBe('Tuesday')
    expect(dayLabel(at(2026, 10, 20), NOW)).toBe('20 Oct')
    expect(dayLabel(at(2025, 10, 20), NOW)).toBe('20 Oct 2025')
  })
  it('groups consecutive items by local day', () => {
    const items = [at(2026, 11, 7, 14), at(2026, 11, 7, 9), at(2026, 11, 6, 20)]
    const days = groupByDay(items, (x) => x, NOW)
    expect(days.map((d) => [d.label, d.items.length])).toEqual([['Today', 2], ['Yesterday', 1]])
  })
  it('never cuts a day and reports what is left', () => {
    const days = groupByDay([at(2026, 11, 7, 14), at(2026, 11, 7, 9), at(2026, 11, 6, 20), at(2026, 11, 5, 8)], (x) => x, NOW)
    const t = takeDays(days, 2)
    expect(t.shown).toHaveLength(1)
    expect(t.hidden).toBe(2)
    expect(takeDays(days, 0).hidden).toBe(0)
    expect(takeDays(days, 3).shown).toHaveLength(2)
  })
})

describe('conversation facts', () => {
  const usage = (agents: number, wallMs: number) => ({ usage: { agents, wallMs } as never })
  it('sums sessions', () => {
    expect(chainFacts([usage(3, 1000), usage(2, 500)])).toEqual({ agents: 5, wallMs: 1500 })
  })
  it('is unknown, not smaller, when one session has no usage', () => {
    expect(chainFacts([usage(3, 1000), {}])).toEqual({ agents: null, wallMs: null })
  })
})

describe('result line', () => {
  it('starts with the status word', () => {
    expect(resultLine({ word: 'Finished', sessions: 1 })).toBe('Finished')
    expect(resultLine({ word: 'Finished', sessions: 3 })).toBe('Finished · 3 sessions')
  })
  it('says why a run failed or paused, else the note', () => {
    expect(resultLine({ word: 'Failed', error: 'Rate limit\nsecond line', sessions: 1 })).toBe('Failed · Rate limit')
    expect(resultLine({ word: 'Paused', pauseReason: 'Usage limit', sessions: 1 })).toBe('Paused · Usage limit')
    expect(resultLine({ word: 'Stopped', note: 'You ended this session', sessions: 1 })).toBe('Stopped · You ended this session')
  })
  it('clips one line', () => {
    expect(oneLine('a'.repeat(200), 10)).toHaveLength(10)
    expect(oneLine(undefined)).toBe('')
  })
})

describe('agents and steps', () => {
  it('tallies final states, trouble first', () => {
    const t = agentTally(['done', 'done', 'error', 'thinking'])
    expect(t.total).toBe(4)
    expect(tallyText(t)).toBe('1 failed, 1 working, 2 done')
  })
  it('caps the marks but keeps the counts', () => {
    const t = agentTally(Array.from({ length: 30 }, () => 'done' as const), 24)
    expect(t.marks).toHaveLength(24)
    expect(t.more).toBe(6)
    expect(t.counts.done).toBe(30)
  })
  it('maps plan statuses', () => {
    expect(stepTone('done')).toBe('ok')
    expect(stepTone('blocked')).toBe('bad')
    expect(stepTone('in_progress')).toBe('working')
    expect(stepTone('pending')).toBe('pending')
  })
  it('prefers the plan summary and clips', () => {
    expect(runSummaryText({ planSummary: ' Done. ', rootResult: 'x' })).toBe('Done.')
    expect(runSummaryText({ rootResult: 'x'.repeat(500) }, 20)).toHaveLength(20)
    expect(runSummaryText({})).toBe('')
  })
})
