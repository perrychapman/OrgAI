import { describe, expect, it } from 'vitest'
import type { RunEstimate as RuntimeEstimate } from '@shared/types'
import { costText, estimateFromRuntime, estimateNote, timeText } from './useRunEstimate'

const none: RuntimeEstimate = { basis: 'none', sampleRuns: 1, costUsd: null, minutes: null, note: 'Only 1 finished run so far.' }
const history = (cost: [number, number, number] | null, minutes: [number, number, number] | null): RuntimeEstimate => ({
  basis: 'history',
  sampleRuns: 6,
  costUsd: cost && { low: cost[0], median: cost[1], high: cost[2] },
  minutes: minutes && { low: minutes[0], median: minutes[1], high: minutes[2] },
  note: 'From 6 finished runs.'
})

describe('estimateFromRuntime', () => {
  it('is unknown with the runtime sentence when there is no basis', () => {
    const e = estimateFromRuntime(none)
    expect(e).toEqual({ state: 'unknown', note: 'Only 1 finished run so far.' })
    expect(costText(e)).toBe('Unknown')
    expect(timeText(e)).toBe('Unknown')
    expect(estimateNote(e)).toBe('Only 1 finished run so far.')
  })
  it('never turns a missing figure into a number', () => {
    const e = estimateFromRuntime(history(null, [11, 12, 13]))
    expect(costText(e)).toBe('Unknown')
    expect(timeText(e)).toBe('about 12 min')
  })
})

describe('costText and timeText', () => {
  it('shows the range with the cost formatter', () => {
    const e = estimateFromRuntime(history([0.4, 0.9, 1.25], [8, 12, 25]))
    expect(costText(e)).toBe('$0.40 to $1.25')
    expect(timeText(e)).toBe('8 to 25 min')
  })
  it('collapses a point and a narrow spread', () => {
    const e = estimateFromRuntime(history([2, 2, 2], [11, 12, 13]))
    expect(costText(e)).toBe('about $2.00')
    expect(timeText(e)).toBe('about 12 min')
  })
  it('reads hours', () => {
    expect(timeText(estimateFromRuntime(history(null, [50, 70, 130])))).toBe('50 min to 2 h 10 min')
  })
  it('is a placeholder while loading', () => {
    expect(costText({ state: 'loading' })).toBe('…')
  })
})
