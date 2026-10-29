import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, UsageStatus } from '@shared/types'
import type { RuntimeAdapter } from './runtime/types'
import { UsageMonitor } from './usageMonitor'

const usage = (provider: 'claude' | 'codex'): UsageStatus => ({ provider, authMode: 'subscription', subscriptionType: null, available: true, windows: {}, updatedAt: 1 })

function monitor(extra?: (() => Promise<UsageStatus | null>)[]) {
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
})
