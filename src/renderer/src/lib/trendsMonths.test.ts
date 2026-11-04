import { describe, expect, it } from 'vitest'
import type { RunUsageRow } from '@shared/types'
import { chartSpan, copiedText, csvFileName, csvRowCount, fillBuckets, groupByKind, kindLabel, monthBounds, monthOptions, parseRangeKey, rangeToKey } from './trends'

const now = new Date(2026, 10, 4, 12).getTime()

describe('month ranges', () => {
  it('lists the current month first, then 23 earlier ones', () => {
    const o = monthOptions(now)
    expect(o).toHaveLength(24)
    expect(o[0].value).toBe('2026-11')
    expect(o[0].label).toMatch(/, so far$/)
    expect(o[1].value).toBe('2026-10')
    expect(o[23].value).toBe('2024-12')
  })

  it('round-trips range keys and falls back to 30 days', () => {
    expect(parseRangeKey('7', now)).toEqual({ kind: 'days', days: 7 })
    expect(parseRangeKey('month:2026-09', now)).toEqual({ kind: 'month', month: '2026-09' })
    expect(rangeToKey({ kind: 'month', month: '2026-09' })).toBe('month:2026-09')
    expect(parseRangeKey('month:2019-01', now)).toEqual({ kind: 'days', days: 30 })
    expect(parseRangeKey('x', now)).toEqual({ kind: 'days', days: 30 })
    expect(parseRangeKey(null, now)).toEqual({ kind: 'days', days: 30 })
  })

  it('fills the whole month with day buckets', () => {
    const span = chartSpan({ kind: 'month', month: '2026-11' }, now)
    expect(span.since).toBe(monthBounds('2026-11').start)
    expect(fillBuckets([], span.since, span.until, 'day')).toHaveLength(30)
    expect(fillBuckets([], chartSpan({ kind: 'month', month: '2026-02' }, now).since, chartSpan({ kind: 'month', month: '2026-02' }, now).until, 'day')).toHaveLength(28)
  })
})

describe('csv helpers', () => {
  it('names the file without path characters', () => {
    expect(csvFileName('Acme/Q3: plan', { kind: 'month', month: '2026-11' })).toBe('Acme Q3 plan usage 2026-11.csv')
    expect(csvFileName('', { kind: 'days', days: 30 })).toBe('Project usage last 30 days.csv')
  })

  it('counts data rows, ignoring quoted line breaks', () => {
    expect(csvRowCount('a,b\r\n')).toBe(0)
    expect(csvRowCount('a,b\r\n1,2\r\n3,"x\r\ny"\r\n')).toBe(2)
    expect(csvRowCount('a,b\n1,2')).toBe(1)
    expect(csvRowCount('')).toBe(0)
  })

  it('words the copy status', () => {
    expect(copiedText(1)).toBe('Copied 1 run as CSV.')
    expect(copiedText(23)).toBe('Copied 23 runs as CSV.')
  })
})

describe('kinds', () => {
  it('labels Ask, Chat and the rest', () => {
    expect(kindLabel('work')).toBe('Work')
    expect(kindLabel('work', { team: 'single' })).toBe('Ask')
    expect(kindLabel('work', { quick: {} })).toBe('Chat')
    expect(kindLabel('setup')).toBe('Setup')
  })

  it('groups rows in a fixed order and never turns unknown cost into 0', () => {
    const row = (runId: string, kind: RunUsageRow['kind'], costUsd: number | null): RunUsageRow =>
      ({ runId, kind, status: 'finished', prompt: '', startedAt: 1, usage: { tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd, costSource: 'none' } }) as unknown as RunUsageRow
    const out = groupByKind([row('a', 'setup', null), row('b', 'work', 1), row('c', 'work', 2), row('d', 'work', null)], (id) => (id === 'c' ? { team: 'single' } : undefined))
    expect(out.map((r) => r.label)).toEqual(['Work', 'Ask', 'Setup'])
    expect(out[0]).toMatchObject({ runs: 2, costUsd: 1, costUnknownRuns: 1 })
    expect(out[2].costUsd).toBeNull()
  })
})
