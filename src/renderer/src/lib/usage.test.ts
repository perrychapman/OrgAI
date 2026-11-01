import { describe, expect, it } from 'vitest'
import { connectionOrder, connectionsInUse, currentConnection, spendLabel, spendLevel, spendPct, spendText } from './usage'

const all = (): boolean => true
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
    expect(connectionOrder('litellm', { anthropic: ok, litellm: ok }, all)).toEqual(['litellm', 'anthropic'])
    expect(connectionOrder('openai', {}, all)).toEqual(['openai'])
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
    expect(connectionOrder('anthropic', { anthropic: ok, litellm: off, openai: off }, all)).toEqual(['anthropic'])
    expect(connectionOrder('anthropic', { litellm: ok }, all)).toEqual(['anthropic', 'litellm'])
  })
  it('lists another connection only while it is in use', () => {
    const ok = { available: true } as never
    const none = (): boolean => false
    // A stale Codex report of a connection nobody uses adds no section; the current one always shows.
    expect(connectionOrder('anthropic', { anthropic: ok, openai: ok }, none)).toEqual(['anthropic'])
    expect(connectionOrder('openai', { openai: ok }, none)).toEqual(['openai'])
    expect(connectionOrder('anthropic', { openai: ok, litellm: ok }, (id) => id === 'openai')).toEqual(['anthropic', 'openai'])
  })
  it('works out which connections are in use', () => {
    const conn = (id: 'anthropic' | 'openai' | 'litellm', enabled: boolean) => ({ connection: { id, enabled } as never })
    const list = [conn('anthropic', true), conn('openai', true), conn('litellm', false)]
    const anth = { provider: { id: 'claude', connection: 'anthropic' } } as never
    const codex = { provider: { id: 'codex', connection: 'openai' } } as never
    const lite = { provider: { id: 'claude', connection: 'litellm' } } as never
    // Enabled OpenAI, but every project and the default on Anthropic: only Anthropic.
    expect([...connectionsInUse(list, 'anthropic', [anth])]).toEqual(['anthropic'])
    expect([...connectionsInUse(list, 'anthropic', [anth, codex])]).toEqual(['anthropic', 'openai'])
    expect([...connectionsInUse(list, 'openai', [])]).toEqual(['openai'])
    // A disabled connection never counts, even when a project points at it.
    expect([...connectionsInUse(list, 'anthropic', [lite])]).toEqual(['anthropic'])
    // Before the list loads only Anthropic can count.
    expect([...connectionsInUse(null, null, [codex])]).toEqual(['anthropic'])
  })
})
