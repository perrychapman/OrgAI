import { describe, expect, it } from 'vitest'
import type { RunEvent, RunsEventParams, RunsSubscribeResult, RunSummary } from '../../shared/types'
import { FakeHostClient, flush, summary } from '../testing/fakeContext'
import type { ConnectResult } from '../types'
import { RunStream, type SnapshotResult } from './runStream'

const status = (runId: string, s: RunSummary['status']): RunEvent => ({ type: 'run.status', runId, status: s })
const ev = (seq: number, event: RunEvent) => ({ seq, event })
const snap = (seq: number, runs: RunSummary[] = []): RunsSubscribeResult => ({
  mode: 'snapshot',
  hostInstanceId: 'aaaaaaaaaaaa',
  seq,
  filterKey: 'fk1',
  snapshot: { liveRuns: runs, pendingCards: {}, recentEndedRuns: [] }
})

function harness(clients: (FakeHostClient | ConnectResult)[], o: { windowMs?: number } = {}) {
  const events: RunsEventParams[] = []
  const snapshots: { res: SnapshotResult; firstTime: boolean }[] = []
  const followed = new Set(['run_a'])
  let gone = 0
  let stopped = false
  let t = 0
  const queue = [...clients]
  const first = queue.shift() as FakeHostClient
  const stream = new RunStream({
    client: first,
    connect: async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      return next instanceof FakeHostClient ? { ok: true, client: next } : next
    },
    subscribeInput: () => ({ runIds: [...followed], followChains: true, includeActiveRunRecord: [...followed].at(-1) }),
    onEvent: (p) => {
      events.push(p)
      // A chain successor: the follower adds it to what it resubscribes with.
      followed.add(p.event.runId)
    },
    onSnapshot: (res, firstTime) => snapshots.push({ res, firstTime }),
    onGone: () => void gone++,
    stopped: () => stopped,
    timers: { sleep: async (ms) => void (t += ms), now: () => t },
    ...(o.windowMs !== undefined ? { reconnectWindowMs: o.windowMs } : {})
  })
  return {
    stream,
    events,
    snapshots,
    followed,
    gone: () => gone,
    stop: () => void (stopped = true)
  }
}

describe('RunStream', () => {
  it('applies a snapshot, then pushed events; notifications during the subscribe are queued in order', async () => {
    const h: FakeHostClient = new FakeHostClient({
      'runs:subscribe': () => {
        h.push('runs:event', ev(11, status('run_a', 'running')))
        return snap(10, [summary('run_a', { status: 'starting' })])
      }
    })
    const x = harness([h])
    await x.stream.start()
    expect(h.callsOf('runs:subscribe')[0]).toEqual([{ runIds: ['run_a'], followChains: true, includeActiveRunRecord: 'run_a' }])
    expect(x.snapshots).toHaveLength(1)
    expect(x.snapshots[0].firstTime).toBe(true)
    h.push('runs:event', ev(12, status('run_a', 'idle')))
    h.push('runs:event', ev(12, status('run_a', 'idle')))
    h.push('runs:event', { atSeq: 12, event: { type: 'agent.partial', runId: 'run_a', agentId: 'root', text: 't' } })
    expect(x.events.map((e) => e.seq ?? `@${e.atSeq}`)).toEqual([11, 12, '@12'])
    expect(x.stream.lastSeq).toBe(12)
    x.stream.close()
    expect(h.closed).toBe(true)
  })

  it('a replay after a reconnect applies without duplicates and resubscribes with sinceSeq', async () => {
    const h1 = new FakeHostClient({ 'runs:subscribe': () => snap(10) })
    const h2 = new FakeHostClient({
      'runs:subscribe': () => ({
        mode: 'replay',
        hostInstanceId: 'aaaaaaaaaaaa',
        fromSeq: 11,
        toSeq: 14,
        filterKey: 'fk1',
        events: [ev(11, status('run_a', 'running')), ev(12, status('run_a', 'idle')), ev(13, status('run_b', 'starting'))]
      })
    })
    const x = harness([h1, h2])
    await x.stream.start()
    h1.push('runs:event', ev(11, status('run_a', 'running')))
    h1.hostClose(new Error('reset'))
    for (let i = 0; i < 4; i++) await flush()
    expect(h2.callsOf('runs:subscribe')[0]).toEqual([{ runIds: ['run_a'], followChains: true, includeActiveRunRecord: 'run_a', sinceSeq: 11, hostInstanceId: 'aaaaaaaaaaaa', filterKey: 'fk1' }])
    expect(x.events.map((e) => e.seq)).toEqual([11, 12, 13])
    expect(x.stream.lastSeq).toBe(14)
    expect(x.stream.client).toBe(h2)
    expect(h1.closed).toBe(true)
    expect(x.snapshots).toHaveLength(1)
  })

  it('follows a chain successor: the next resubscribe names it', async () => {
    const h1 = new FakeHostClient({ 'runs:subscribe': () => snap(10) })
    const h2 = new FakeHostClient({ 'runs:subscribe': () => snap(30) })
    const x = harness([h1, h2])
    await x.stream.start()
    h1.push('runs:event', ev(11, status('run_b', 'starting')))
    expect(x.followed.has('run_b')).toBe(true)
    h1.hostClose()
    for (let i = 0; i < 4; i++) await flush()
    expect(h2.callsOf('runs:subscribe')[0]).toMatchObject([{ runIds: ['run_a', 'run_b'], includeActiveRunRecord: 'run_b', sinceSeq: 11 }])
    // The host could not replay: a snapshot resync.
    expect(x.snapshots.map((s) => s.firstTime)).toEqual([true, false])
  })

  it('gives up after the reconnect window and calls onGone once', async () => {
    const h1 = new FakeHostClient({ 'runs:subscribe': () => snap(10) })
    const x = harness([h1, { ok: false, reason: 'no_host', message: 'gone' }], { windowMs: 3_000 })
    await x.stream.start()
    h1.hostClose()
    for (let i = 0; i < 10; i++) await flush()
    expect(x.gone()).toBe(1)
  })

  it('a stopped follower drops events and never reconnects', async () => {
    const h1 = new FakeHostClient({ 'runs:subscribe': () => snap(10) })
    const h2 = new FakeHostClient({ 'runs:subscribe': () => snap(20) })
    const x = harness([h1, h2])
    await x.stream.start()
    x.stop()
    h1.push('runs:event', ev(11, status('run_a', 'running')))
    h1.hostClose()
    for (let i = 0; i < 4; i++) await flush()
    expect(x.events).toEqual([])
    expect(h2.calls).toEqual([])
  })

  it('a failed first subscribe closes the client and rethrows', async () => {
    const h = new FakeHostClient({
      'runs:subscribe': () => {
        throw new Error('refused')
      }
    })
    const x = harness([h])
    await expect(x.stream.start()).rejects.toThrow('refused')
    expect(h.closed).toBe(true)
  })
})
