import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'
import { UsageMonitor, type ExtraProbe } from './usageMonitor'

const usage = (provider: 'claude' | 'codex'): UsageStatus => ({ provider, authMode: 'subscription', subscriptionType: null, available: true, windows: {}, updatedAt: 1 })

function monitor(extra?: ExtraProbe[], probeUsage: () => Promise<UsageStatus | null> = async () => usage('claude')) {
  const events: RunEvent[] = []
  const probe = vi.fn(probeUsage)
  const adapter = { id: 'claude', probeUsage: probe } as unknown as RuntimeAdapter
  const m = new UsageMonitor({ adapter, auth: () => ({ kind: 'subscription' }), broadcast: (e) => events.push(e), liveRuns: () => 0, extraProbes: extra })
  return { m, events, probe }
}

const claudeEvent = (u: UsageStatus): RunEvent => ({ type: 'usage.status', runId: 'run-1', usage: u })

describe('UsageMonitor', () => {
  it('keeps the Claude behaviour without extra probes', async () => {
    const { m, events } = monitor()
    expect(await m.refresh()).toMatchObject({ provider: 'claude' })
    expect(m.latest()?.provider).toBe('claude')
    expect(events).toHaveLength(1)
  })

  it('broadcasts extra probes (Codex) without changing latest() or the return value', async () => {
    const { m, events } = monitor([async () => usage('codex'), async () => { throw new Error('boom') }, async () => null])
    const result = await m.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(result?.provider).toBe('claude')
    expect(m.latest()?.provider).toBe('claude')
    expect(m.latestAll().map((u) => u.provider)).toEqual(['claude', 'codex'])
    expect(events.map((e) => (e.type === 'usage.status' ? e.usage.provider : null)).sort()).toEqual(['claude', 'codex'])
  })

  it('refreshProbe runs one keyed probe, one call in flight, without probing Claude', async () => {
    const spend: UsageStatus = { connection: 'litellm', authMode: 'apiKey', subscriptionType: null, available: true, windows: {}, spend: { usd: 1, budgetUsd: null, resetsAt: null, budgetDuration: null, keyAlias: null }, updatedAt: 2 }
    let release: () => void = () => {}
    const probe = vi.fn(() => new Promise<UsageStatus | null>((r) => (release = () => r(spend))))
    const codex = vi.fn(async () => usage('codex'))
    const { m, events } = monitor([codex, { key: 'litellm', probe }])
    const a = m.refreshProbe('litellm')
    const b = m.refreshProbe('litellm')
    expect(probe).toHaveBeenCalledTimes(0) // started on the next microtask
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([a, b])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(codex).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'usage.status', runId: '', usage: spend }])
    expect(m.latestAll()).toEqual([spend])
    await m.refreshProbe('unknown')
    probe.mockImplementationOnce(() => {
      throw new Error('sync boom')
    })
    await m.refreshProbe('litellm')
    probe.mockImplementationOnce(async () => spend)
    await m.refreshProbe('litellm') // a synchronous throw did not wedge the in-flight slot
    expect(probe).toHaveBeenCalledTimes(3)
  })

  describe('observe (a run report survives the idle probe)', () => {
    const T0 = 1_000_000
    const runReport: UsageStatus = {
      provider: 'claude',
      authMode: 'subscription',
      subscriptionType: 'max',
      available: true,
      windows: { fiveHour: { utilization: 22, resetsAt: T0 + 3 * 60 * 60_000 }, sevenDay: { utilization: 6, resetsAt: T0 + 5 * 24 * 60 * 60_000 } },
      status: 'allowed',
      updatedAt: T0
    }
    const probeReport = (updatedAt: number): UsageStatus => ({
      provider: 'claude',
      authMode: 'subscription',
      subscriptionType: 'max',
      available: true,
      windows: { sevenDay: { utilization: 18, resetsAt: T0 + 5 * 24 * 60 * 60_000 } },
      updatedAt
    })

    it('merges a sevenDay-only probe onto the five-hour window a run reported, in the broadcast and the return value', async () => {
      const { m, events } = monitor(undefined, async () => probeReport(T0 + 60_000))
      m.observe(claudeEvent(runReport))
      expect(m.latest()).toBe(runReport)
      const result = await m.refresh()
      expect(result?.windows).toEqual({ fiveHour: runReport.windows.fiveHour, sevenDay: { utilization: 18, resetsAt: T0 + 5 * 24 * 60 * 60_000 } })
      expect(result?.status).toBe('allowed')
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ type: 'usage.status', runId: '', usage: result })
      expect(m.latest()).toBe(result)
      expect(m.latestAll()).toEqual([result])
    })

    it('drops the five-hour window once its reset is in the past', async () => {
      const { m } = monitor(undefined, async () => probeReport(T0 + 4 * 60 * 60_000))
      m.observe(claudeEvent(runReport))
      const result = await m.refresh()
      expect(result?.windows.fiveHour).toBeUndefined()
      expect(result?.windows.sevenDay?.utilization).toBe(18)
    })

    it('keeps the window across two idle probes until the reset passes', async () => {
      let at = T0 + 60_000
      const { m } = monitor(undefined, async () => probeReport(at))
      m.observe(claudeEvent(runReport))
      expect((await m.refresh())?.windows.fiveHour).toEqual(runReport.windows.fiveHour)
      at = T0 + 2 * 60 * 60_000
      expect((await m.refresh())?.windows.fiveHour).toEqual(runReport.windows.fiveHour)
      at = T0 + 4 * 60 * 60_000
      expect((await m.refresh())?.windows.fiveHour).toBeUndefined()
    })

    it('ignores reports of other connections and non-usage events', () => {
      const { m } = monitor()
      const other = (connection: 'openai' | 'litellm'): UsageStatus => ({ ...usage('codex'), connection, updatedAt: 5 })
      m.observe({ type: 'usage.status', runId: '', usage: other('openai') })
      m.observe({ type: 'usage.status', runId: '', usage: other('litellm') })
      m.observe({ type: 'run.title', runId: 'r', title: 'x' })
      expect(m.latest()).toBeNull()
      m.observe(claudeEvent({ ...runReport, connection: 'anthropic' }))
      expect(m.latest()?.connection).toBe('anthropic')
      m.observe({ type: 'usage.status', runId: '', usage: other('openai') })
      expect(m.latest()?.connection).toBe('anthropic')
    })

    it('returns the probe result unchanged when nothing was observed', async () => {
      const report = probeReport(T0)
      const { m, events } = monitor(undefined, async () => report)
      expect(await m.refresh()).toBe(report)
      expect(events[0]).toEqual({ type: 'usage.status', runId: '', usage: report })
    })
  })
})
