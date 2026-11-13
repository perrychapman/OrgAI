import { describe, expect, it } from 'vitest'
import type { UsageSpend, UsageStatus } from '@shared/types'
import { accountRowView, missingFiveHour, rowFigures, spendPeriodRows, tightestWindow, tightestWindowRow, usageRows, type AccountRowInput } from './UsageMeter'

const W = { resetsAt: null }
const base: AccountRowInput = { mock: false, name: 'Claude', state: 'connected', isProxy: false, spends: false, apiKey: false, usage: undefined }
const spend = (over: Partial<UsageSpend> = {}): UsageSpend => ({ usd: 3.2, budgetUsd: null, resetsAt: null, ...over }) as UsageSpend
const periods = { day: { usd: 3.2, since: 0 }, week: { usd: 12.4, since: 0 }, month: { usd: 31, since: 0 } }

describe('accountRowView', () => {
  const plan = (windows: UsageStatus['windows'], over: Partial<UsageStatus> = {}) => ({ ...base, usage: status({ windows, ...over }) })
  it('shows both windows as whole percents with spoken names', () => {
    const v = accountRowView(plan({ fiveHour: { utilization: 22.4, ...W }, sevenDay: { utilization: 17.6, ...W } }))
    expect(v.figures.map((f) => `${f.name} ${f.value}`)).toEqual(['5h 22%', '7d 18%'])
    expect(v.words).toBe('five-hour 22 percent, seven-day 18 percent')
    expect(v.text).toBe('')
  })
  it('shows the one reported window', () => {
    expect(accountRowView(plan({ sevenDay: { utilization: 18, ...W } })).figures.map((f) => `${f.name} ${f.value}`)).toEqual(['7d 18%'])
  })
  it('falls back to the tightest model window with a short name', () => {
    const v = accountRowView(plan({}, { modelWindows: [{ model: 'Fable', utilization: 20, resetsAt: null }] }))
    expect(v.figures.map((f) => `${f.name} ${f.value}`)).toEqual(['Fable 20%'])
    expect(rowFigures(status({ windows: { sevenDayOpus: { utilization: 9, ...W }, sevenDaySonnet: { utilization: 30, ...W } } })).map((f) => f.name)).toEqual(['Sonnet'])
  })
  it('keeps warn and danger on the figure itself', () => {
    const v = accountRowView(plan({ fiveHour: { utilization: 100, ...W }, sevenDay: { utilization: 85, ...W } }, { status: 'rejected', limitedWindow: 'five_hour' }))
    expect(v.figures.map((f) => f.level)).toEqual(['danger', 'warn'])
    expect(v.figures[0].sr).toBe('five-hour 100 percent, limit reached')
  })
  it('marks only the tightest figure on an allowed_warning report', () => {
    const v = accountRowView(plan({ fiveHour: { utilization: 50, ...W }, sevenDay: { utilization: 60, ...W } }, { status: 'allowed_warning' }))
    expect(v.figures.map((f) => f.level)).toEqual(['', 'warn'])
  })
  it('API key, no report and unavailable report show one or two words', () => {
    expect(accountRowView({ ...base, apiKey: true, usage: status({ authMode: 'apiKey' }) }).text).toBe('API key')
    expect(accountRowView({ ...base, apiKey: true, keyMissing: true }).text).toBe('Key not set')
    expect(accountRowView(base).text).toBe('Claude')
    expect(accountRowView({ ...base, name: 'OpenAI', usage: status({ available: false }) }).text).toBe('OpenAI')
    expect(accountRowView(plan({})).text).toBe('Claude')
  })
  it('proxy: figure only, name when it reports no spend, Spend unavailable without a report', () => {
    const proxy = { ...base, name: 'LiteLLM', isProxy: true, spends: true }
    expect(accountRowView({ ...proxy, usage: status({ spend: spend({ periods }) }) }).text).toBe('$3.20 today')
    expect(accountRowView({ ...proxy, usage: status({ spend: spend({ budgetUsd: 50, usd: 42.1 }) }) }).text).toBe('$42.10 of $50.00')
    expect(accountRowView({ ...proxy, usage: status({ spend: spend() }) }).text).toBe('$3.20 spent')
    expect(accountRowView({ ...proxy, usage: undefined }).text).toBe('Spend unavailable')
    expect(accountRowView({ ...proxy, spends: false }).text).toBe('LiteLLM')
  })
  it('problem states and the mock adapter', () => {
    expect(accountRowView({ ...base, state: 'disconnected' }).text).toBe('Not connected')
    expect(accountRowView({ ...base, state: 'error' }).text).toBe('Error')
    expect(accountRowView({ ...base, state: 'connecting' }).text).toBe('Connecting…')
    expect(accountRowView({ ...base, state: 'checking' }).text).toBe('Checking…')
    expect(accountRowView({ ...base, mock: true }).text).toBe('Mock adapter')
  })
})

const RESETS_AT = Date.UTC(2026, 10, 11, 12, 0, 0)

function status(over: Partial<UsageStatus> = {}): UsageStatus {
  return {
    authMode: 'subscription',
    subscriptionType: 'max',
    available: true,
    windows: {},
    updatedAt: Date.UTC(2026, 10, 4, 9, 0, 0),
    ...over
  }
}

/** The shape the claude.ai endpoint answered on 2026-11-04 for a Max login: no five-hour window, a weekly one and a per-model weekly one. */
const NOV_4 = status({
  windows: { sevenDay: { utilization: 18, resetsAt: RESETS_AT } },
  modelWindows: [{ model: 'Fable', utilization: 20, resetsAt: RESETS_AT }],
  status: 'allowed'
})

describe('usageRows', () => {
  it('lists Seven-day and the Fable weekly window when five_hour is null (2026-11-04 shape)', () => {
    expect(usageRows(NOV_4).map((r) => [r.key, r.label, r.window.utilization, r.limited])).toEqual([
      ['sevenDay', 'Seven-day', 18, false],
      ['model-Fable', 'Fable weekly', 20, false]
    ])
  })

  it('leads with the five-hour row when it is reported', () => {
    const u = status({ ...NOV_4, windows: { ...NOV_4.windows, fiveHour: { utilization: 5, resetsAt: RESETS_AT } } })
    expect(usageRows(u).map((r) => r.key)).toEqual(['fiveHour', 'sevenDay', 'model-Fable'])
  })
})

describe('tightestWindow', () => {
  it('picks the Fable weekly window at 20 percent with no level on the 2026-11-04 shape', () => {
    expect(tightestWindow(NOV_4)).toEqual({ label: 'Fable weekly', pct: 20, level: '' })
  })

  it('lets a limited window beat a higher utilization', () => {
    const u = status({
      windows: { fiveHour: { utilization: 100, resetsAt: RESETS_AT }, sevenDay: { utilization: 60, resetsAt: RESETS_AT } },
      modelWindows: [{ model: 'Fable', utilization: 90, resetsAt: RESETS_AT }],
      status: 'rejected',
      limitedWindow: 'seven_day'
    })
    expect(tightestWindow(u)).toEqual({ label: 'Seven-day', pct: 60, level: 'danger' })
  })

  it('is null for an API key, before the first report, or with no window at all', () => {
    expect(tightestWindow(status({ ...NOV_4, authMode: 'apiKey' }))).toBeNull()
    expect(tightestWindow(status({ ...NOV_4, available: false }))).toBeNull()
    expect(tightestWindow(status())).toBeNull()
    expect(tightestWindow(null)).toBeNull()
    expect(tightestWindow(undefined)).toBeNull()
  })
})

describe('tightestWindowRow', () => {
  it('returns the same choice as tightestWindow plus the plan row with its reset time', () => {
    const row = tightestWindowRow(NOV_4)
    expect(row).toMatchObject({ label: 'Fable weekly', pct: 20, level: '' })
    expect(row?.row.window.resetsAt).toBe(RESETS_AT)
    expect(row?.row.limited).toBe(false)
  })

  it('flags the limited row and is null where tightestWindow is', () => {
    const u = status({ windows: { sevenDay: { utilization: 60, resetsAt: RESETS_AT } }, status: 'rejected', limitedWindow: 'seven_day' })
    expect(tightestWindowRow(u)?.row.limited).toBe(true)
    expect(tightestWindowRow(status({ ...NOV_4, authMode: 'apiKey' }))).toBeNull()
    expect(tightestWindowRow(null)).toBeNull()
  })
})

describe('missingFiveHour', () => {
  it('is true for the 2026-11-04 shape: windows reported, none of them five-hour', () => {
    expect(missingFiveHour(NOV_4)).toBe(true)
  })

  it('is false when the five-hour window is present', () => {
    expect(missingFiveHour(status({ ...NOV_4, windows: { ...NOV_4.windows, fiveHour: { utilization: 5, resetsAt: RESETS_AT } } }))).toBe(false)
    expect(missingFiveHour(status({ windows: { fiveHour: { utilization: null, resetsAt: null } } }))).toBe(false)
  })

  it('is false for an API key or an unavailable report', () => {
    expect(missingFiveHour(status({ ...NOV_4, authMode: 'apiKey' }))).toBe(false)
    expect(missingFiveHour(status({ ...NOV_4, available: false }))).toBe(false)
    expect(missingFiveHour(null)).toBe(false)
    expect(missingFiveHour(undefined)).toBe(false)
  })

  it('is false when no window at all is reported (the empty state covers it)', () => {
    expect(missingFiveHour(status())).toBe(false)
    expect(missingFiveHour(status({ modelWindows: [] }))).toBe(false)
  })
})

describe('SpendSection periods', () => {
  const base: UsageSpend = { usd: 42.1, budgetUsd: 50, resetsAt: null, budgetDuration: '30d', keyAlias: null }

  it('lists Today, This week and This month in order with their money text and a UTC "Since" tooltip', () => {
    const spend: UsageSpend = {
      ...base,
      periods: {
        day: { usd: 3.2, since: Date.UTC(2026, 10, 4) },
        week: { usd: 12.4, since: Date.UTC(2026, 10, 2) },
        month: { usd: 31, since: Date.UTC(2026, 10, 1) }
      }
    }
    const rows = spendPeriodRows(spend)
    expect(rows.map((r) => [r.key, r.label, r.value])).toEqual([
      ['day', 'Today', '$3.20'],
      ['week', 'This week', '$12.40'],
      ['month', 'This month', '$31.00']
    ])
    // The date spelling follows the runtime locale; the shape and the UTC marker do not.
    for (const r of rows) expect(r.since).toMatch(/^Since .+ \(UTC\)$/)
    expect(rows[1].since).toContain('2')
  })

  it('is empty without periods, whether or not a note says why', () => {
    expect(spendPeriodRows(base)).toEqual([])
    expect(spendPeriodRows({ ...base, periodsNote: 'The proxy did not answer its daily spend request.' })).toEqual([])
  })
})
