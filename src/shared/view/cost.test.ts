import { describe, expect, it } from 'vitest'
import { agentCostInput, costView, formatDuration, formatUsd, formatUsdCompact, runCostInput, sumCosts, unpricedModels } from './cost'

describe('cost', () => {
  it('formats amounts', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(12.5)).toBe('$12.50')
  })
  it('uses one precision rule so totals agree with their rows', () => {
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(0.0057)).toBe('$0.0057')
    expect(formatUsd(0.0114)).toBe('$0.0114')
    expect(formatUsd(0.0057 + 0.0043 + 0.0014)).toBe('$0.0114')
    expect(formatUsd(0.1257)).toBe('$0.1257')
    expect(formatUsd(0.03)).toBe('$0.03')
    expect(formatUsd(0.00001)).toBe('<$0.0001')
    expect(formatUsd(0.99999)).toBe('$1.00')
    expect(formatUsd(3)).toBe('$3.00')
  })
  it('names unpriced models in the tooltip', () => {
    const models = [
      { model: 'a', costUsd: 1, priceSource: 'builtin' as const },
      { model: 'mock-unpriced', costUsd: null, priceSource: 'unknown' as const }
    ]
    expect(unpricedModels(models)).toEqual(['mock-unpriced'])
    expect(costView({ costUsd: null, costSource: 'unknown', models }).title).toContain('mock-unpriced')
    expect(costView({ costUsd: 1, costSource: 'computed', costPartial: true, models }).title).toContain('mock-unpriced')
    expect(costView({ costUsd: 1, costSource: 'provider', models }).title).not.toContain('No price')
  })
  it('says reported or computed for mixed aggregates', () => {
    expect(costView({ costUsd: 1, costSource: 'provider', sourceMixed: true }).title).toContain('or computed')
  })
  it('never shows unknown as $0', () => {
    const v = costView({ costUsd: null, costSource: 'unknown' })
    expect(v.text).toBe('unknown')
    expect(v.text).not.toContain('$')
    expect(v.kind).toBe('unknown')
  })
  it('marks partial costs as a lower bound', () => {
    const v = costView({ costUsd: 0.42, costSource: 'computed', costPartial: true })
    expect(v.text).toBe('$0.42+')
    expect(v.title).toContain('At least $0.42')
  })
  it('explains provider and computed in the tooltip only', () => {
    expect(costView({ costUsd: 1, costSource: 'provider' })).toMatchObject({ text: '$1.00', title: 'Reported by the provider' })
    expect(costView({ costUsd: 1, costSource: 'computed' })).toMatchObject({ text: '$1.00', title: 'Computed by OrgAI from model prices' })
  })
  it('notes legacy records', () => {
    expect(costView({ costUsd: 1, costSource: 'provider', legacy: true }).title).toContain('before usage tracking')
    expect(costView({ costUsd: null, costSource: 'unknown', legacy: true }).title).toContain('before usage tracking')
  })
  it('nothing spent is empty, not unknown', () => {
    expect(costView({ costUsd: 0, costSource: 'none' })).toMatchObject({ kind: 'none', empty: true, text: '—' })
  })
  it('falls back to the mirrored cost without usage', () => {
    expect(agentCostInput({ costUsd: 0.5 })).toEqual({ costUsd: 0.5, costSource: 'provider' })
    expect(runCostInput({ totalCostUsd: 0 })).toEqual({ costUsd: 0, costSource: 'none' })
  })
  it('sums with unknown parts as a lower bound', () => {
    const a = { costUsd: 1, costSource: 'provider' as const }
    const b = { costUsd: 2, costSource: 'computed' as const }
    const u = { costUsd: null, costSource: 'unknown' as const }
    const none = { costUsd: 0, costSource: 'none' as const }
    expect(sumCosts([a, b])).toEqual({ costUsd: 3, costSource: 'computed' })
    expect(sumCosts([a, u])).toEqual({ costUsd: 1, costSource: 'provider', costPartial: true })
    expect(sumCosts([u, u]).costUsd).toBeNull()
    expect(sumCosts([none, none])).toEqual({ costUsd: 0, costSource: 'none' })
  })
  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(80_000)).toBe('1m 20s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
  })
})

describe('compact cost', () => {
  it('rounds to cents and keeps the full figure in the title', () => {
    expect(formatUsdCompact(0.02571)).toBe('$0.03')
    expect(formatUsdCompact(0.004)).toBe('<$0.01')
    expect(formatUsdCompact(12.4)).toBe('$12.40')
    const v = costView({ costUsd: 0.02571, costSource: 'provider' }, { compact: true })
    expect(v.text).toBe('$0.03')
    expect(v.title).toContain('$0.02571')
  })
  it('keeps the partial mark and leaves unknown and none alone', () => {
    expect(costView({ costUsd: 0.004, costSource: 'computed', costPartial: true }, { compact: true }).text).toBe('<$0.01+')
    expect(costView({ costUsd: null, costSource: 'unknown' }, { compact: true }).text).toBe('unknown')
    expect(costView({ costUsd: 0, costSource: 'none' }, { compact: true }).text).toBe('—')
  })
})
