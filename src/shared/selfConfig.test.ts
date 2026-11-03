import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  MAX_CONCURRENT_SUBAGENTS_LIMIT,
  MAX_SUBAGENT_DEPTH_LIMIT,
  connectionConfigured,
  connectionUsable,
  effectiveDefaultConnection,
  effectiveSubagentLimits,
  effortOptionsFor,
  hasWeeklyPlanWindow,
  orgChartDepth,
  planGuardEngaged,
  planGuardOf,
  skillEvaluationOf,
  storedSkillEvaluation
} from './defaults'
import type { ProviderConnections, Role, UsageStatus } from './types'

// Self-configuration helpers (the "self-configuring harness" pass): pure, token-free.

describe('effectiveDefaultConnection', () => {
  it('keeps the stored default while it is connected', () => {
    expect(effectiveDefaultConnection({ stored: 'openai', states: { anthropic: 'connected', openai: 'connected' } })).toBe('openai')
  })

  it('moves to the only connected connection when the stored one is down', () => {
    expect(effectiveDefaultConnection({ stored: 'anthropic', states: { anthropic: 'disconnected', litellm: 'connected' } })).toBe('litellm')
    expect(effectiveDefaultConnection({ stored: 'anthropic', states: { anthropic: 'error', openai: 'connected' } })).toBe('openai')
  })

  it('picks the first connected in CONNECTION_IDS order when several are connected', () => {
    expect(effectiveDefaultConnection({ stored: 'anthropic', states: { anthropic: 'disconnected', openai: 'connected', litellm: 'connected' } })).toBe('openai')
    expect(effectiveDefaultConnection({ stored: 'litellm', states: { anthropic: 'connected', openai: 'connected', litellm: 'error' } })).toBe('anthropic')
  })

  it('falls back to the stored value (anthropic when unset) when nothing is connected', () => {
    expect(effectiveDefaultConnection({ stored: 'openai', states: { anthropic: 'disconnected', openai: 'error' } })).toBe('openai')
    expect(effectiveDefaultConnection({ stored: undefined, states: {} })).toBe('anthropic')
    expect(effectiveDefaultConnection({ stored: 'bogus' as never, states: { openai: 'disconnected' } })).toBe('anthropic')
  })

  it('does not flip while the stored default is still being probed', () => {
    expect(effectiveDefaultConnection({ stored: 'openai', states: { anthropic: 'connected', openai: 'connecting' } })).toBe('openai')
    expect(effectiveDefaultConnection({ stored: 'openai', states: { anthropic: 'connected', openai: 'unknown' } })).toBe('openai')
  })

  it('ignores connections left out of states (not configured)', () => {
    expect(effectiveDefaultConnection({ stored: 'anthropic', states: { anthropic: 'disconnected' } })).toBe('anthropic')
  })

  it('gives the same answer whether or not the stored value was chosen', () => {
    const states = { anthropic: 'disconnected', openai: 'connected' } as const
    expect(effectiveDefaultConnection({ stored: 'anthropic', chosen: true, states })).toBe('openai')
    expect(effectiveDefaultConnection({ stored: 'anthropic', chosen: false, states })).toBe('openai')
  })
})

describe('connectionConfigured / connectionUsable', () => {
  const c = (patch: Partial<ProviderConnections>): ProviderConnections => ({ ...DEFAULT_APP_SETTINGS.connections, ...patch })
  it('anthropic is always configured; openai when enabled; litellm with base URL and key', () => {
    const base = DEFAULT_APP_SETTINGS.connections
    expect(connectionConfigured('anthropic', base)).toBe(true)
    expect(connectionConfigured('openai', c({ openai: { ...base.openai, enabled: false } }))).toBe(false)
    expect(connectionConfigured('openai', c({ openai: { ...base.openai, enabled: true } }))).toBe(true)
    expect(connectionConfigured('litellm', c({ litellm: { ...base.litellm, enabled: true, baseUrl: 'http://x', hasApiKey: false } }))).toBe(false)
    expect(connectionConfigured('litellm', c({ litellm: { ...base.litellm, enabled: true, baseUrl: '  ', hasApiKey: true } }))).toBe(false)
    expect(connectionConfigured('litellm', c({ litellm: { ...base.litellm, enabled: true, baseUrl: 'http://x', hasApiKey: true } }))).toBe(true)
  })
  it('usable also needs a connected status', () => {
    const base = DEFAULT_APP_SETTINGS.connections
    expect(connectionUsable('anthropic', base, 'connected')).toBe(true)
    expect(connectionUsable('anthropic', base, 'error')).toBe(false)
    expect(connectionUsable('anthropic', base, undefined)).toBe(false)
    expect(connectionUsable('openai', c({ openai: { ...base.openai, enabled: false } }), 'connected')).toBe(false)
  })
})

const usage = (patch: Partial<UsageStatus>): UsageStatus => ({ authMode: 'subscription', subscriptionType: 'max', available: true, windows: {}, updatedAt: 1, ...patch })

describe('plan guard', () => {
  it('reads explicit values and treats unset as auto (legacy field honoured)', () => {
    expect(planGuardOf({ preferEverydayNearLimit: true })).toBe('on')
    expect(planGuardOf({ preferEverydayNearLimit: false })).toBe('off')
    expect(planGuardOf({})).toBe('auto')
    expect(planGuardOf(undefined)).toBe('auto')
    expect(planGuardOf({ preferSonnetNearLimit: true })).toBe('on')
    expect(planGuardOf({ preferSonnetNearLimit: false })).toBe('off')
    expect(planGuardOf({ preferEverydayNearLimit: false, preferSonnetNearLimit: true })).toBe('off')
  })

  it('on and off ignore the usage report', () => {
    expect(planGuardEngaged('on', null)).toBe(true)
    expect(planGuardEngaged('off', usage({ windows: { sevenDay: { utilization: 99 } } as UsageStatus['windows'] }))).toBe(false)
  })

  it('auto engages with a weekly window or an allowed_warning status', () => {
    const week = { utilization: 10, resetsAt: 0 } as unknown as NonNullable<UsageStatus['windows']['sevenDay']>
    expect(planGuardEngaged('auto', null)).toBe(false)
    expect(planGuardEngaged('auto', usage({}))).toBe(false)
    expect(planGuardEngaged('auto', usage({ windows: { fiveHour: week } }))).toBe(false)
    expect(planGuardEngaged('auto', usage({ windows: { sevenDay: week } }))).toBe(true)
    expect(planGuardEngaged('auto', usage({ windows: { sevenDayOpus: week } }))).toBe(true)
    expect(planGuardEngaged('auto', usage({ modelWindows: [{ name: 'Fable', utilization: 5 } as never] }))).toBe(true)
    expect(planGuardEngaged('auto', usage({ status: 'allowed_warning' }))).toBe(true)
    expect(planGuardEngaged('auto', usage({ status: 'allowed' }))).toBe(false)
  })

  it('auto never engages on an API key report', () => {
    const week = { utilization: 90 } as unknown as NonNullable<UsageStatus['windows']['sevenDay']>
    expect(planGuardEngaged('auto', usage({ authMode: 'apiKey', windows: { sevenDay: week }, status: 'allowed_warning' }))).toBe(false)
    expect(hasWeeklyPlanWindow(usage({ authMode: 'apiKey', windows: { sevenDay: week } }))).toBe(false)
  })
})

const role = (id: string, reportsTo: string | null): Pick<Role, 'id' | 'reportsTo'> => ({ id, reportsTo })

describe('effectiveSubagentLimits', () => {
  it('measures the longest reportsTo chain in edges', () => {
    expect(orgChartDepth([])).toBe(0)
    expect(orgChartDepth([role('root', null)])).toBe(0)
    expect(orgChartDepth([role('root', null), role('lead', 'root'), role('eng', 'lead'), role('rev', 'root')])).toBe(2)
  })

  it('survives cycles and dangling managers', () => {
    expect(orgChartDepth([role('a', 'b'), role('b', 'a')])).toBe(1)
    expect(orgChartDepth([role('a', 'missing')])).toBe(0)
  })

  it('derives depth from the chart plus one, within 1..MAX_SUBAGENT_DEPTH_LIMIT', () => {
    expect(effectiveSubagentLimits({ roles: [role('root', null)] }).depth).toBe(1)
    expect(effectiveSubagentLimits({ roles: [role('root', null), role('lead', 'root'), role('eng', 'lead')] }).depth).toBe(3)
    const deep = Array.from({ length: 10 }, (_, i) => role(`r${i}`, i === 0 ? null : `r${i - 1}`))
    expect(effectiveSubagentLimits({ roles: deep }).depth).toBe(MAX_SUBAGENT_DEPTH_LIMIT)
    expect(effectiveSubagentLimits({}).depth).toBe(1)
  })

  it('uses the default concurrency when unset', () => {
    expect(effectiveSubagentLimits({ roles: [] })).toEqual({ depth: 1, concurrency: DEFAULT_MAX_CONCURRENT_SUBAGENTS, explicit: { depth: false, concurrency: false } })
  })

  it('keeps explicit values, clamped, and ignores junk', () => {
    const roles = [role('root', null), role('a', 'root')]
    expect(effectiveSubagentLimits({ roles, maxSubagentDepth: 4, maxConcurrentSubagents: 3 })).toEqual({ depth: 4, concurrency: 3, explicit: { depth: true, concurrency: true } })
    expect(effectiveSubagentLimits({ roles, maxSubagentDepth: 99, maxConcurrentSubagents: 999 })).toMatchObject({ depth: MAX_SUBAGENT_DEPTH_LIMIT, concurrency: MAX_CONCURRENT_SUBAGENTS_LIMIT })
    expect(effectiveSubagentLimits({ roles, maxSubagentDepth: 0, maxConcurrentSubagents: Number.NaN })).toEqual({ depth: 2, concurrency: DEFAULT_MAX_CONCURRENT_SUBAGENTS, explicit: { depth: false, concurrency: false } })
  })
})

describe('skill evaluation follows the Team assistant', () => {
  it('derives enabled from teamReview.auto when unset', () => {
    expect(skillEvaluationOf({}).enabled).toBe(true) // DEFAULT_TEAM_REVIEW.auto is 'ai'
    expect(skillEvaluationOf({ teamReview: { auto: 'ai', tokenBudget: 20_000, everyRuns: 3 } }).enabled).toBe(true)
    expect(skillEvaluationOf({ teamReview: { auto: 'free', tokenBudget: 20_000, everyRuns: 3 } }).enabled).toBe(false)
    expect(skillEvaluationOf({ teamReview: { auto: 'off', tokenBudget: 20_000, everyRuns: 3 } }).enabled).toBe(false)
    expect(skillEvaluationOf({ skillEvaluation: { tokenBudget: 5_000 }, teamReview: { auto: 'off', tokenBudget: 20_000, everyRuns: 3 } })).toEqual({ enabled: false, tokenBudget: 5_000 })
  })

  it('an explicit value wins either way', () => {
    expect(skillEvaluationOf({ skillEvaluation: { enabled: false, tokenBudget: 20_000 }, teamReview: { auto: 'ai', tokenBudget: 20_000, everyRuns: 3 } }).enabled).toBe(false)
    expect(skillEvaluationOf({ skillEvaluation: { enabled: true, tokenBudget: 20_000 }, teamReview: { auto: 'off', tokenBudget: 20_000, everyRuns: 3 } }).enabled).toBe(true)
  })

  it('stored form keeps an unset enabled unset and clamps the budget', () => {
    expect(storedSkillEvaluation({ tokenBudget: 10 })).toEqual({ tokenBudget: 1_000 })
    expect(storedSkillEvaluation({ enabled: false, tokenBudget: 10_000 })).toEqual({ enabled: false, tokenBudget: 10_000 })
    expect(storedSkillEvaluation(undefined)).toEqual({ tokenBudget: 20_000 })
    expect('enabled' in storedSkillEvaluation({ enabled: 'yes' as never, tokenBudget: 10_000 })).toBe(false)
  })
})

describe('effortOptionsFor', () => {
  it('offers every level on Claude and the mock, three on Codex', () => {
    expect(effortOptionsFor('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortOptionsFor('mock')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortOptionsFor('codex')).toEqual(['low', 'medium', 'high'])
    expect(effortOptionsFor(undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})
