import { describe, expect, it } from 'vitest'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'
import { ratesFromModelUsage, sumByModel, type TokenMix } from './claudeCost'

const mix = (input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenMix => ({ input, output, cacheRead, cacheCreation })
const usage = (costUSD: number, input: number, output: number): ModelUsage =>
  ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD, contextWindow: 0, maxOutputTokens: 0 }) as ModelUsage

describe('sumByModel', () => {
  it('sums tokens per model, with cache categories kept apart', () => {
    const out = sumByModel(
      [
        { model: 'a', mix: mix(10, 5, 100, 20) },
        { model: 'a', mix: mix(1, 1, 1, 1) },
        { model: 'b', mix: mix(2, 3) }
      ],
      null
    )
    expect(out.get('a')?.mix).toEqual(mix(11, 6, 101, 21))
    expect(out.get('b')?.mix).toEqual(mix(2, 3))
    expect(out.get('a')?.costUsd).toBeNull()
  })

  it('costs each model at its own SDK-derived rate', () => {
    const rates = ratesFromModelUsage({ a: usage(1, 100, 0), b: usage(4, 100, 0) })!
    const out = sumByModel([{ model: 'a', mix: mix(50, 0) }, { model: 'b', mix: mix(50, 0) }], rates)
    expect(out.get('a')?.costUsd).toBeCloseTo(0.5)
    expect(out.get('b')?.costUsd).toBeCloseTo(2)
  })

  it('falls back to the given model for messages without one', () => {
    expect(sumByModel([{ mix: mix(1, 1) }], null, 'fallback').has('fallback')).toBe(true)
  })

  it('gives no rates (so no provider cost) for a LiteLLM-shaped result with costUSD 0', () => {
    expect(ratesFromModelUsage({ 'gpt-x': usage(0, 100, 50) })).toBeNull()
  })
})
