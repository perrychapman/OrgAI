import { describe, expect, it } from 'vitest'
import { connectionOrder, currentConnection, spendLabel, spendLevel, spendPct, spendText } from './usage'

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
  it('handles no-budget, zero-budget and over-budget spend', () => {
    expect(spendPct(s(5, null))).toBeNull()
    expect(spendPct(s(5, 0))).toBeNull()
    expect(spendLevel(s(5, 0))).toBe('')
    expect(spendText(s(60, 50))).toBe('$60.00 of $50.00')
    expect(spendLevel(s(60, 50))).toBe('danger')
    expect(spendLevel(s(40, 50))).toBe('warn')
  })
  it('lists only available connections besides the current one', () => {
    const off = { available: false } as never
    const ok = { available: true } as never
    expect(connectionOrder('anthropic', { anthropic: ok, litellm: off, openai: off })).toEqual(['anthropic'])
    expect(connectionOrder('anthropic', { litellm: ok })).toEqual(['anthropic', 'litellm'])
  })
})
