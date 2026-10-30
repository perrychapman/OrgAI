import { describe, expect, it } from 'vitest'
import { connectionOrder, currentConnection, runCostLabel, spendLabel, spendLevel, spendText } from './usage'
import { formatCost } from './layout'

const s = (usd: number, budgetUsd: number | null) => ({ usd, budgetUsd, resetsAt: null, budgetDuration: null, keyAlias: null })

describe('usage', () => {
  it('picks the project connection, then the default', () => {
    expect(currentConnection('litellm', 'openai')).toBe('litellm')
    expect(currentConnection(undefined, 'openai')).toBe('openai')
    expect(currentConnection(null, null)).toBe('anthropic')
  })
  it('words spend', () => {
    expect(spendLabel(s(42.1, 50))).toBe('LiteLLM · $42.10 of $50.00')
    expect(spendText(s(42.1, null))).toBe('$42.10 spent')
  })
  it('levels', () => {
    expect(spendLevel(s(10, 50))).toBe('')
    expect(spendLevel(s(40, 50))).toBe('warn')
    expect(spendLevel(s(50, 50))).toBe('danger')
    expect(spendLevel(s(500, null))).toBe('')
  })
  it('orders current first', () => {
    const ok = { available: true } as never
    expect(connectionOrder('litellm', { anthropic: ok, litellm: ok })).toEqual(['litellm', 'anthropic'])
    expect(connectionOrder('openai', {})).toEqual(['openai'])
  })
  it('labels cost by the run connection', () => {
    expect(runCostLabel(0.5, 'litellm', 'subscription', formatCost).text).toBe('≈$0.50 est.')
    expect(runCostLabel(0.5, 'openai', 'apiKey', formatCost).hidden).toBe(true)
    expect(runCostLabel(0, 'litellm', 'unknown', formatCost).hidden).toBe(true)
    expect(runCostLabel(0.5, undefined, 'apiKey', formatCost).text).toBe('$0.50')
    expect(runCostLabel(0.5, 'anthropic', 'subscription', formatCost).text).toBe('≈$0.50')
  })
})
