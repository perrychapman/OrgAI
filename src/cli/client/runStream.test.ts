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

  it('resubscribe queues notifications during the call, keeps seq dedupe and resumes with sinceSeq', async () => {
    let n = 0
    const h: FakeHostClient = new FakeHostClient({
      'runs:subscribe': () => {
        n++
        if (n === 1) return snap(10)
        // During the resubscribe: one already applied (11), one new (13).
        h.push('runs:event', ev(11, status('run_a', 'running')))
        h.push('runs:event', ev(13, status('run_a', 'finished')))
        return { mode: 'replay', hostInstanceId: 'aaaaaaaaaaaa', fromSeq: 11, toSeq: 12, filterKey: 'fk1', events: [ev(12, status('run_a', 'idle'))] }
      }
    })
    const subscribed: string[] = []
    const x = harness([h])
    ;(x.stream as unknown as { o: { onSubscribed: (m: string) => void } }).o.onSubscribed = (m) => subscribed.push(m)
    await x.stream.start()
    h.push('runs:event', ev(11, status('run_a', 'running')))
    await x.stream.resubscribe()
    expect(h.callsOf('runs:subscribe')[1]).toEqual([{ runIds: ['run_a'], followChains: true, includeActiveRunRecord: 'run_a', sinceSeq: 11, hostInstanceId: 'aaaaaaaaaaaa', filterKey: 'fk1' }])
    expect(x.events.map((e) => e.seq)).toEqual([11, 12, 13])
    expect(x.stream.lastSeq).toBe(13)
    expect(subscribed).toEqual(['snapshot', 'replay'])
    // After the call, pushes apply at once again.
    h.push('runs:event', ev(14, status('run_a', 'idle')))
    expect(x.events.map((e) => e.seq)).toEqual([11, 12, 13, 14])
  })

  it('a resubscribe asked for while one is in flight runs once more with the newest input', async () => {
    let release: (() => void) | undefined
    let n = 0
    const h = new FakeHostClient({
      'runs:subscribe': async () => {
        n++
        if (n === 2) await new Promise<void>((r) => (release = r))
        return snap(10 + n)
      }
    })
    const x = harness([h])
    await x.stream.start()
    const first = x.stream.resubscribe()
    await flush()
    x.followed.add('run_z')
    await x.stream.resubscribe()
    release?.()
    await first
    for (let i = 0; i < 3; i++) await flush()
    const subs = h.callsOf('runs:subscribe') as { runIds: string[] }[][]
    expect(subs).toHaveLength(3)
    expect(subs[2][0].runIds).toEqual(['run_a', 'run_z'])
  })

  it('a socket that closes during a resubscribe starts the reconnect loop; a refused one rejects', async () => {
    let n = 0
    const h1: FakeHostClient = new FakeHostClient({
      'runs:subscribe': () => {
        n++
        if (n === 1) return snap(10)
        h1.hostClose()
        throw new Error('closed')
      }
    })
    const h2 = new FakeHostClient({ 'runs:subscribe': () => snap(20) })
    const x = harness([h1, h2])
    await x.stream.start()
    await x.stream.resubscribe()
    for (let i = 0; i < 4; i++) await flush()
    expect(x.stream.client).toBe(h2)
    expect(x.snapshots.map((s) => s.firstTime)).toEqual([true, false])

    const g = new FakeHostClient({
      'runs:subscribe': () => {
        if (g.calls.length > 1) throw new Error('refused')
        return snap(10)
      }
    })
    const y = harness([g])
    await y.stream.start()
    await expect(y.stream.resubscribe()).rejects.toThrow('refused')
  })
})
