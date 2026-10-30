import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'
import { UsageMonitor, type ExtraProbe } from './usageMonitor'

const usage = (provider: 'claude' | 'codex'): UsageStatus => ({ provider, authMode: 'subscription', subscriptionType: null, available: true, windows: {}, updatedAt: 1 })

function monitor(extra?: ExtraProbe[]) {
  const events: RunEvent[] = []
  const adapter = { id: 'claude', probeUsage: vi.fn(async () => usage('claude')) } as unknown as RuntimeAdapter
  const m = new UsageMonitor({ adapter, auth: () => ({ kind: 'subscription' }), broadcast: (e) => events.push(e), liveRuns: () => 0, extraProbes: extra })
  return { m, events }
}

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
})
