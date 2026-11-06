import { describe, expect, it } from 'vitest'
import type { RunUsage, RunUsageRow, UsageStats } from '@shared/types'
import { USAGE_CSV_COLUMNS } from '@shared/types'
import { emptyTokens } from '@shared/defaults'
import { runSummary } from './testHelpers'
import { buildUsageCsv, computeRunUsage, monthRange } from './runUsage'

function usage(over: Partial<RunUsage> = {}): RunUsage {
  const base = computeRunUsage(runSummary(), [], { nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: 1000 })
  return { ...base, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, costUsd: 0.5, ...over }
}

function row(over: Partial<RunUsageRow> = {}): RunUsageRow {
  return { runId: 'r1', kind: 'work', status: 'finished', prompt: 'Do it', startedAt: Date.UTC(2026, 10, 3, 12, 0, 0), usage: usage(), ...over }
}

const UTC0 = { offsetMinutes: () => 0 }

function stats(runs: RunUsageRow[]): UsageStats {
  const totals = usage({ tokens: emptyTokens() })
  return { projectId: 'p1', runs, roles: [], trend: [], totals, generatedAt: 0 }
}

describe('monthRange', () => {
  it('spans the local calendar month', () => {
    const r = monthRange('2026-11')
    expect(r.since).toBe(new Date(2026, 10, 1).getTime())
    expect(r.until).toBe(new Date(2026, 11, 1).getTime())
    expect(r.until).toBeGreaterThan(r.since)
  })

  it('rolls December over to the next January', () => {
    const r = monthRange('2026-12')
    expect(r.since).toBe(new Date(2026, 11, 1).getTime())
    expect(r.until).toBe(new Date(2027, 0, 1).getTime())
  })

  it('has an exclusive end: the last millisecond is in the month, the next is not', () => {
    const r = monthRange('2026-02')
    expect(new Date(r.until - 1).getMonth()).toBe(1)
    expect(new Date(r.until).getMonth()).toBe(2)
    expect(new Date(r.since).getDate()).toBe(1)
    expect(new Date(r.since - 1).getMonth()).toBe(0)
  })

  it('refuses malformed input', () => {
    for (const bad of ['', '2026-1', '2026-13', '2026-00', '1999-12', '3000-01', '2026/11', '2026-11-01', ' 2026-11', 'abcd-ef', '2026-011']) {
      expect(() => monthRange(bad), bad).toThrow('Invalid month')
    }
    expect(() => monthRange(undefined as unknown as string)).toThrow('Invalid month')
    expect(() => monthRange(202611 as unknown as string)).toThrow('Invalid month')
  })

  it('accepts the year bounds', () => {
    expect(() => monthRange('2000-01')).not.toThrow()
    expect(() => monthRange('2999-12')).not.toThrow()
  })
})

describe('buildUsageCsv', () => {
  it('writes the header and one CRLF-separated row per run', () => {
    const csv = buildUsageCsv(stats([row({ endedAt: Date.UTC(2026, 10, 3, 12, 5, 0), title: 'Fix it' }), row({ runId: 'r2' })]), { ...UTC0, project: 'Acme site', client: 'Acme' })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('﻿' + USAGE_CSV_COLUMNS.join(','))
    expect(lines[0]!.slice(1).split(',').slice(0, 5)).toEqual(['project', 'client', 'started', 'started_utc', 'ended'])
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(
      'Acme site,Acme,2026-11-03T12:00:00+00:00,2026-11-03T12:00:00.000Z,2026-11-03T12:05:00+00:00,work,finished,Fix it,0,10,20,30,40,0.500000,'
    )
    expect(lines[2]!.split(',')[4]).toBe('')
    expect(lines[2]!.split(',')[7]).toBe('Do it')
  })

  it('writes local times with the UTC offset, keeping started_utc', () => {
    const t = Date.UTC(2026, 10, 4, 14, 15, 0)
    const at = (offsetMinutes: number): string[] =>
      buildUsageCsv(stats([row({ startedAt: t, endedAt: t + 3600000 })]), { offsetMinutes: () => offsetMinutes }).split('\r\n')[1]!.split(',')
    expect(at(-300).slice(2, 5)).toEqual(['2026-11-04T09:15:00-05:00', '2026-11-04T14:15:00.000Z', '2026-11-04T10:15:00-05:00'])
    expect(at(330)[2]).toBe('2026-11-04T19:45:00+05:30')
    expect(at(0)[2]).toBe('2026-11-04T14:15:00+00:00')
    expect(at(-570)[2]).toBe('2026-11-04T04:45:00-09:30')
  })

  it('leaves project and client blank when not given, and prefixes a client starting with =', () => {
    const plain = buildUsageCsv(stats([row()]), UTC0).split('\r\n')[1]!.split(',')
    expect(plain.slice(0, 2)).toEqual(['', ''])
    const csv = buildUsageCsv(stats([row()]), { ...UTC0, project: '+Plan', client: '=HYPERLINK("x")' })
    expect(csv.split('\r\n')[1]).toMatch(/^'\+Plan,"'=HYPERLINK\(""x""\)",/)
  })

  it('writes kind ask for a single-team work row and keeps work otherwise', () => {
    const lines = buildUsageCsv(stats([row({ team: 'single' }), row({ runId: 'r2' }), row({ runId: 'r3', kind: 'setup', team: 'single' })])).split('\r\n')
    expect(lines[1]!.split(',')[5]).toBe('ask')
    expect(lines[2]!.split(',')[5]).toBe('work')
    expect(lines[3]!.split(',')[5]).toBe('setup')
  })

  it('is only the header for no runs', () => {
    expect(buildUsageCsv(stats([]))).toBe('﻿' + USAGE_CSV_COLUMNS.join(','))
  })

  it('never uses exponent notation for small costs and keeps truncated rows as they are', () => {
    const csv = buildUsageCsv({ ...stats([row({ usage: usage({ costUsd: 0.0000001 }) })]), truncated: true } as UsageStats)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.split(',')[13]).toBe('0.000000')
    expect(csv).not.toMatch(/e-/)
  })

  it('leaves unknown cost blank (never 0) and marks partial cost', () => {
    const csv = buildUsageCsv(stats([row({ usage: usage({ costUsd: null }) }), row({ usage: usage({ costPartial: true }) })]))
    const [, unknown, partial] = csv.split('\r\n')
    expect(unknown!.split(',').slice(-2)).toEqual(['', ''])
    expect(partial!.split(',').slice(-2)).toEqual(['0.500000', 'true'])
  })

  it('counts roles', () => {
    const roles = [{ roleId: 'a' }, { roleId: 'b' }] as unknown as RunUsage['roles']
    const cells = buildUsageCsv(stats([row({ usage: usage({ roles }) })])).split('\r\n')[1]!.split(',')
    expect(cells[8]).toBe('2')
  })

  it('quotes commas, quotes and line breaks, doubling inner quotes', () => {
    const csv = buildUsageCsv(stats([row({ title: 'a, "b"\nc' })]))
    expect(csv).toContain('"a, ""b""\nc"')
    const cr = buildUsageCsv(stats([row({ title: 'x\ry' })]))
    expect(cr).toContain('"x\ry"')
  })

  it('neutralises formula starts before quoting', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const csv = buildUsageCsv(stats([row({ title: `${lead}SUM(A1)` })]))
      expect(csv, JSON.stringify(lead)).toContain(`'${lead}SUM(A1)`)
    }
    for (const lead of ['\n', ' =', ' +', '  @', ' -', '＝', '＋', '－', '＠', ' ＝']) {
      const csv = buildUsageCsv(stats([row({ title: `${lead}SUM(A1)` })]))
      expect(csv, JSON.stringify(lead)).toContain(`'${lead}SUM(A1)`)
    }
    const csv = buildUsageCsv(stats([row({ title: '=1+1' })]))
    expect(csv).toContain(",'=1+1,")
    // A prefixed cell that also needs quoting gets both.
    expect(buildUsageCsv(stats([row({ title: '=a,b' })]))).toContain(`,"'=a,b",`)
  })

  it('falls back to the prompt and survives a missing end', () => {
    const csv = buildUsageCsv(stats([row({ prompt: 'only prompt', title: '' })]))
    expect(csv.split('\r\n')[1]!.split(',')[7]).toBe('only prompt')
  })
})
