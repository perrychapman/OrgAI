import { describe, expect, it } from 'vitest'
import { outcomeText, sinceLabel, sinceSentence, sinceSummary, spentText, type SinceRun } from './sinceSummary'

const local = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime()
const NOW = local(21, 20, 0)
const SEEN = local(20, 18, 40)

let n = 0
const run = (endedAt: number, extra: Partial<SinceRun> = {}): SinceRun => {
  n += 1
  return { id: `r${n}`, status: 'finished', startedAt: endedAt - 60_000, endedAt, totalCostUsd: 0, ...extra }
}
const input = (summaries: SinceRun[], over: Partial<Parameters<typeof sinceSummary>[0]> = {}): Parameters<typeof sinceSummary>[0] => ({
  summaries,
  lastSeen: SEEN,
  now: NOW,
  firstVisit: false,
  ready: true,
  ...over
})

describe('sinceLabel', () => {
  it('says the time today, yesterday, a weekday and a date', () => {
    expect(sinceLabel(local(21, 9, 5), NOW)).toBe('Since 09:05')
    expect(sinceLabel(local(20, 18, 40), NOW)).toBe('Since yesterday 18:40')
    expect(sinceLabel(local(18, 9, 0), NOW)).toBe('Since Wed 09:00')
    expect(sinceLabel(local(10, 9, 0), NOW)).toBe('Since 10 Nov')
  })
})

describe('outcomeText', () => {
  it('words each outcome', () => {
    expect(outcomeText({ outcome: 'finished', count: 4 })).toBe('4 runs finished')
    expect(outcomeText({ outcome: 'finished', count: 1 })).toBe('1 run finished')
    expect(outcomeText({ outcome: 'failed', count: 1 })).toBe('1 failed')
    expect(outcomeText({ outcome: 'stopped', count: 2 })).toBe('2 stopped')
  })
})

describe('sinceSummary', () => {
  it('counts runs that ended after the last-seen time by outcome', () => {
    n = 0
    const out = sinceSummary(
      input([
        run(local(20, 19), {}),
        run(local(20, 20), {}),
        run(local(21, 8), {}),
        run(local(21, 9), {}),
        run(local(21, 10), { status: 'error' }),
        run(local(21, 11), { endedBy: 'user' }),
        // Ended before the last visit: not counted.
        run(local(20, 12), {})
      ])
    )
    expect(out?.label).toBe('Since yesterday 18:40')
    expect(out?.parts).toEqual([
      { outcome: 'finished', count: 4 },
      { outcome: 'failed', count: 1 },
      { outcome: 'stopped', count: 1 }
    ])
    expect(sinceSentence(out!)).toBe('Since yesterday 18:40: 4 runs finished, 1 failed, 1 stopped.')
  })
  it('is omitted on a first visit, before history is in and when nothing changed', () => {
    const list = [run(local(21, 8))]
    expect(sinceSummary(input(list, { firstVisit: true }))).toBeNull()
    expect(sinceSummary(input(list, { ready: false }))).toBeNull()
    expect(sinceSummary(input([run(local(20, 9))]))).toBeNull()
    expect(sinceSummary(input([]))).toBeNull()
  })
  it('leaves live and paused runs out', () => {
    expect(sinceSummary(input([run(local(21, 8), { status: 'running' }), run(local(21, 9), { status: 'paused' })]))).toBeNull()
  })
  it('says what the ended runs cost only when it can be said truthfully', () => {
    const priced = sinceSummary(input([run(local(21, 8), { totalCostUsd: 6.42, usage: undefined })]))
    expect(priced?.spent).toBe('$6.42 spent')
    expect(sinceSentence(priced!)).toBe('Since yesterday 18:40: 1 run finished, $6.42 spent.')
    expect(sinceSummary(input([run(local(21, 8))]))?.spent).toBe('')
    expect(sinceSummary(input([run(local(21, 8), { usage: { costUsd: null, costSource: 'unknown' } as SinceRun['usage'] })]))?.spent).toBe('')
  })
})

describe('spentText', () => {
  it('never says $0 and marks a lower bound', () => {
    expect(spentText(undefined)).toBe('')
    expect(spentText({ costUsd: 0, costSource: 'none' })).toBe('')
    expect(spentText({ costUsd: null, costSource: 'unknown' })).toBe('')
    expect(spentText({ costUsd: 1.42, costSource: 'provider' })).toBe('$1.42 spent')
    expect(spentText({ costUsd: 1.42, costSource: 'provider', costPartial: true })).toBe('at least $1.42 spent')
    expect(spentText({ costUsd: 0.004, costSource: 'provider' })).toBe('less than $0.01 spent')
    expect(spentText({ costUsd: 0.004, costSource: 'provider', costPartial: true })).toBe('')
  })
})
