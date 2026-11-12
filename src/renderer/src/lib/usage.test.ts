import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionInfo, UsageSpend } from '@shared/types'
import { setConnectionRegistry } from './connectionLabel'
import { connectionOrder, connectionsInUse, currentConnection, lifetimeText, periodSince, periodText, periodsCaption, reportsSpend, spendAria, spendLabel, spendLevel, spendPct, spendRowFigure, spendRowLabel, spendSentence, spendText } from './usage'

const proxyInfo = (id: string, kind: 'litellm' | 'openai-compatible', reportsSpendCheck: boolean | null = null, state = 'connected'): ConnectionInfo =>
  ({
    connection: { id, name: id === 'litellm' ? 'Acme proxy' : 'Other proxy', kind, enabled: true, tierModels: {}, anthropicBaseUrl: 'https://proxy.invalid', hasApiKey: true, autoTiers: [] },
    status: { state, checks: { reached: true, keyAccepted: true, modelCount: 1, reportsPrices: null, reportsSpend: reportsSpendCheck } },
    modelCount: 1,
    isDefault: false
  }) as unknown as ConnectionInfo

const all = (): boolean => true
const s = (usd: number, budgetUsd: number | null): UsageSpend => ({ usd, budgetUsd, resetsAt: null, budgetDuration: null, keyAlias: null })
const PERIODS = {
  day: { usd: 3.2, since: Date.UTC(2026, 10, 4) },
  week: { usd: 12.4, since: Date.UTC(2026, 10, 2) },
  month: { usd: 31, since: Date.UTC(2026, 10, 1) }
}
const withPeriods = (usd: number, budgetUsd: number | null): UsageSpend => ({ ...s(usd, budgetUsd), periods: PERIODS })

describe('usage', () => {
  beforeEach(() => setConnectionRegistry([proxyInfo('litellm', 'litellm'), proxyInfo('proxy-0badf00d', 'openai-compatible')]))
  afterEach(() => setConnectionRegistry(null))
  it('names a proxy by its own name, a removed one as Removed proxy, in every spend text', () => {
    expect(spendAria(s(10, 50), 'litellm')).toBe('Acme proxy spend 20 percent of budget')
    expect(spendAria(s(10, null), 'litellm')).toBe('Acme proxy spend $10.00, no budget set')
    expect(spendRowLabel(s(1, null), 'proxy-0000dead')).toBe('Removed proxy · $1.00 spent')
    expect(spendSentence(s(1, null), 'proxy-0000dead')).toBe('Removed proxy spend: $1.00. No budget set.')
  })
  it('uses the reporting capability with legacy fallback and respects a negative check', () => {
    expect(reportsSpend(proxyInfo('litellm', 'litellm'))).toBe(true)
    expect(reportsSpend(proxyInfo('litellm', 'litellm', true))).toBe(true)
    expect(reportsSpend(proxyInfo('litellm', 'litellm', false))).toBe(false)
    expect(reportsSpend(proxyInfo('proxy-0badf00d', 'openai-compatible'))).toBe(false)
    const enabled = proxyInfo('proxy-0badf00d', 'openai-compatible')
    enabled.connection = { ...enabled.connection, litellmFeatures: true } as typeof enabled.connection
    expect(reportsSpend(enabled)).toBe(true)
    expect(reportsSpend({ ...enabled, status: { checks: { reportsSpend: false } } })).toBe(false)
    const disabled = proxyInfo('litellm', 'litellm')
    disabled.connection = { ...disabled.connection, litellmFeatures: false } as typeof disabled.connection
    expect(reportsSpend(disabled)).toBe(false)
    expect(reportsSpend({ connection: { id: 'anthropic', enabled: true, tierModels: {}, auth: { kind: 'subscription' } } })).toBe(false)
  })
  it('lists proxies in use after the built-ins, in list order', () => {
    const list = [
      { connection: { id: 'anthropic', enabled: true } as never },
      { connection: { id: 'proxy-aaaaaaaa', enabled: true } as never },
      { connection: { id: 'proxy-bbbbbbbb', enabled: true } as never },
      { connection: { id: 'proxy-cccccccc', enabled: false } as never }
    ]
    const onB = { provider: { id: 'claude', connection: 'proxy-bbbbbbbb' } } as never
    const onC = { provider: { id: 'claude', connection: 'proxy-cccccccc' } } as never
    expect([...connectionsInUse(list, 'proxy-aaaaaaaa', [onB, onC])]).toEqual(['proxy-aaaaaaaa', 'proxy-bbbbbbbb'])
    expect(connectionOrder('anthropic', { 'proxy-bbbbbbbb': { available: true } as never }, () => true)).toEqual(['anthropic', 'proxy-bbbbbbbb'])
  })
  it('picks the project connection, then the default', () => {
    expect(currentConnection('litellm', 'openai')).toBe('litellm')
    expect(currentConnection(undefined, 'openai')).toBe('openai')
    expect(currentConnection(null, null)).toBe('anthropic')
  })
  it('words spend', () => {
    expect(spendLabel(s(42.1, 50), 'litellm')).toBe('Acme proxy · $42.10 of $50.00')
    expect(spendText(s(42.1, null))).toBe('$42.10 spent')
  })
  it('words one period figure', () => {
    expect(periodText(3.2, 'day')).toBe('$3.20 today')
    expect(periodText(12.4, 'week')).toBe('$12.40 this week')
    expect(periodText(31, 'month')).toBe('$31.00 this month')
  })
  it('shows one figure in the account row: today when periods are reported, else the budget text', () => {
    expect(spendRowLabel(withPeriods(42.1, 50), 'litellm')).toBe('Acme proxy · $3.20 today')
    expect(spendRowLabel(withPeriods(42.1, null), 'litellm')).toBe('Acme proxy · $3.20 today')
    expect(spendRowLabel(s(42.1, 50), 'litellm')).toBe('Acme proxy · $42.10 of $50.00')
    expect(spendRowLabel(s(42.1, null), 'litellm')).toBe('Acme proxy · $42.10 spent')
    expect(spendRowFigure(withPeriods(42.1, 50))).toBe('$3.20 today')
    expect(spendRowFigure(s(42.1, 50))).toBe('$42.10 of $50.00')
  })
  it('carries the whole sentence in the tooltip and the rail name', () => {
    expect(spendSentence(withPeriods(42.1, 50), 'litellm')).toBe('Acme proxy spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget.')
    expect(spendSentence(withPeriods(42.1, null), 'litellm')).toBe('Acme proxy spend: $3.20 today, $12.40 this week, $31.00 this month. No budget set.')
    expect(spendSentence(s(42.1, 50), 'litellm')).toBe('Acme proxy spend: $42.10 of $50.00 budget.')
    expect(spendSentence(s(42.1, null), 'litellm')).toBe('Acme proxy spend: $42.10. No budget set.')
  })
  it('captions the week and month for the Dashboard, nothing without periods', () => {
    expect(periodsCaption(withPeriods(1, 50))).toBe('$12.40 this week · $31.00 this month')
    expect(periodsCaption(s(1, 50))).toBe('')
  })
  it('prints a period start in UTC and says so', () => {
    expect(periodSince(Date.UTC(2026, 10, 2), 'en-GB')).toBe('Since Mon 2 Nov (UTC)')
    // A UTC midnight is the previous evening in the Americas; the UTC print never moves to Sunday.
    expect(periodSince(Date.UTC(2026, 10, 2), 'en-US')).toBe('Since Mon, Nov 2 (UTC)')
    expect(periodSince(Number.NaN)).toBe('')
  })
  it('shows a lifetime total only when it differs from the current period spend', () => {
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: 142.1 })).toBe('Lifetime $142.10')
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: 42.1 })).toBe('')
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: 42.104 })).toBe('')
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: null })).toBe('')
    expect(lifetimeText(s(42.1, 50))).toBe('')
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: Number.POSITIVE_INFINITY })).toBe('')
    expect(lifetimeText({ ...s(42.1, 50), totalUsd: -5 })).toBe('')
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
