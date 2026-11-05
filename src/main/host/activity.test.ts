import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_LEASE_KINDS, DEFAULT_DAEMON_IDLE_MINUTES } from '../../shared/types'
import type { HostActivitySnapshot } from '../../shared/types'
import { HostActivityTracker, daemonIdleMs, noopActivity } from './activity'
import { acquireHostOwnership } from './ownership'
import { newHostInstanceId } from './identity'

afterEach(() => {
  vi.useRealTimers()
})

function tracker(extra: ConstructorParameters<typeof HostActivityTracker>[0] = {}) {
  let t = 1_000
  const logs: string[] = []
  const a = new HostActivityTracker({ now: () => t, log: (m) => logs.push(m), ...extra })
  return { a, logs, advance: (ms: number) => (t += ms), at: () => t }
}

describe('HostActivityTracker leases', () => {
  it('acquire counts a lease and the release is idempotent', () => {
    const { a } = tracker()
    expect(a.isIdle()).toBe(true)
    const r1 = a.acquire('inFlightRpcMutations', 'runs:start')
    const r2 = a.acquire('inFlightRpcMutations')
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(2)
    r1()
    r1()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(1)
    r2()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
    expect(a.isIdle()).toBe(true)
  })

  it('track holds a lease until the promise resolves or rejects, and returns it', async () => {
    const { a } = tracker()
    let ok!: (v: number) => void
    const p = a.track('backgroundTasks', new Promise<number>((r) => (ok = r)))
    expect(a.snapshot().counts.backgroundTasks).toBe(1)
    ok(7)
    await expect(p).resolves.toBe(7)
    expect(a.snapshot().counts.backgroundTasks).toBe(0)

    let fail!: (e: Error) => void
    const q = a.track('backgroundTasks', new Promise<number>((_r, j) => (fail = j)))
    expect(a.snapshot().counts.backgroundTasks).toBe(1)
    fail(new Error('boom'))
    await expect(q).rejects.toThrow('boom')
    expect(a.snapshot().counts.backgroundTasks).toBe(0)
  })
})

describe('HostActivityTracker sources', () => {
  it('sums sources per kind with leases; the remover is idempotent', () => {
    const { a } = tracker()
    let live = 2
    const off = a.addSource('liveRuns', () => live)
    a.addSource('liveRuns', () => 1)
    a.addSource('pausedAutoResumes', () => 3)
    a.acquire('liveRuns')
    let s = a.snapshot()
    expect(s.counts.liveRuns).toBe(4)
    expect(s.counts.pausedAutoResumes).toBe(3)
    expect(s.total).toBe(7)
    live = 0
    expect(a.snapshot().counts.liveRuns).toBe(2)
    off()
    off()
    live = 10
    s = a.snapshot()
    expect(s.counts.liveRuns).toBe(2)
  })

  it('a throwing source counts as busy and is logged once', () => {
    const { a, logs } = tracker()
    const off = a.addSource('activeOAuthFlows', () => {
      throw new Error('broken')
    })
    expect(a.snapshot().counts.activeOAuthFlows).toBe(1)
    expect(a.snapshot().counts.activeOAuthFlows).toBe(1)
    expect(a.isIdle()).toBe(false)
    expect(logs.filter((l) => l.includes('broken'))).toHaveLength(1)
    off()
    expect(a.isIdle()).toBe(true)
  })

  it('a source answering something that is not a count counts as busy', () => {
    const { a, logs } = tracker()
    a.addSource('backgroundTasks', () => NaN)
    expect(a.snapshot().counts.backgroundTasks).toBe(1)
    expect(logs).toHaveLength(1)
  })
})

describe('HostActivityTracker snapshot and onChange', () => {
  it('reports every lease kind, total, idle, idleSince and state', () => {
    const { a, advance, at } = tracker()
    const s = a.snapshot()
    expect(Object.keys(s.counts).sort()).toEqual([...ACTIVITY_LEASE_KINDS].sort())
    expect(Object.keys(s.counts)).toHaveLength(7)
    expect(s).toMatchObject({ total: 0, idle: true, idleSince: 1_000, state: 'ready' })
    advance(500)
    const r = a.acquire('interactiveClients')
    const busy = a.snapshot()
    expect(busy).toMatchObject({ total: 1, idle: false, state: 'ready' })
    expect(busy.idleSince).toBeUndefined()
    advance(500)
    r()
    expect(a.snapshot().idleSince).toBe(at())
    expect(a.state()).toBe('ready')
  })

  it('fires onChange on lease changes and on the state change; the unsubscribe works', async () => {
    const { a } = tracker()
    const seen: HostActivitySnapshot[] = []
    const off = a.onChange((s) => seen.push(s))
    const r = a.acquire('activeWorktreeOps')
    expect(seen.at(-1)).toMatchObject({ total: 1, idle: false })
    r()
    expect(seen.at(-1)).toMatchObject({ total: 0, idle: true })
    expect(seen).toHaveLength(2)
    await a.requestDrain()
    expect(seen.at(-1)?.state).toBe('draining')
    const n = seen.length
    off()
    a.acquire('activeWorktreeOps')
    expect(seen).toHaveLength(n)
  })

  it('a listener that throws is logged and does not stop the others', () => {
    const { a, logs } = tracker()
    const seen: number[] = []
    a.onChange(() => {
      throw new Error('listener down')
    })
    a.onChange((s) => seen.push(s.total))
    a.acquire('liveRuns')
    expect(seen).toEqual([1])
    expect(logs.some((l) => l.includes('listener down'))).toBe(true)
  })

  it('noopActivity is always idle and refuses to drain', async () => {
    const n = noopActivity()
    n.acquire('liveRuns')()
    expect(n.isIdle()).toBe(true)
    expect(n.snapshot().total).toBe(0)
    await expect(n.requestDrain({ force: true })).resolves.toEqual({ stopping: false })
  })
})

describe('HostActivityTracker idle exit', () => {
  it('drains only after idleMs of continuous idleness; activity resets the clock; disarm stops it', async () => {
    vi.useFakeTimers()
    const onDrained = vi.fn()
    const a = new HostActivityTracker({ idleMs: 60_000, pollMs: 10_000, onDrained })
    a.armIdleExit()
    vi.advanceTimersByTime(50_000)
    expect(onDrained).not.toHaveBeenCalled()
    // A lease in between resets idleSince.
    a.acquire('inFlightRpcMutations')()
    vi.advanceTimersByTime(50_000)
    expect(onDrained).not.toHaveBeenCalled()
    // A polled source that is busy at a poll resets it too.
    let busy = 1
    a.addSource('liveRuns', () => busy)
    vi.advanceTimersByTime(10_000)
    busy = 0
    vi.advanceTimersByTime(50_000)
    expect(onDrained).not.toHaveBeenCalled()
    expect(a.state()).toBe('ready')
    vi.advanceTimersByTime(20_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(a.state()).toBe('draining')
    vi.advanceTimersByTime(600_000)
    await Promise.resolve()
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it('never drains while busy', async () => {
    vi.useFakeTimers()
    const onDrained = vi.fn()
    const a = new HostActivityTracker({ idleMs: 1_000, pollMs: 100, onDrained })
    a.acquire('pausedAutoResumes')
    a.armIdleExit()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(onDrained).not.toHaveBeenCalled()
  })

  it('disarmIdleExit stops the poll', async () => {
    vi.useFakeTimers()
    const onDrained = vi.fn()
    const a = new HostActivityTracker({ idleMs: 1_000, pollMs: 100, onDrained })
    a.armIdleExit()
    vi.advanceTimersByTime(500)
    a.disarmIdleExit()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(onDrained).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an idleMs of Infinity arms nothing', () => {
    vi.useFakeTimers()
    const a = new HostActivityTracker({ idleMs: Infinity })
    a.armIdleExit()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('daemonIdleMs parses ORGAI_DAEMON_IDLE_MINUTES', () => {
    const def = DEFAULT_DAEMON_IDLE_MINUTES * 60_000
    expect(def).toBe(30 * 60_000)
    expect(daemonIdleMs({})).toBe(def)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: '45' })).toBe(45 * 60_000)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: '0' })).toBe(Infinity)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: 'abc' })).toBe(def)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: '-1' })).toBe(def)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: '' })).toBe(def)
    expect(daemonIdleMs({ ORGAI_DAEMON_IDLE_MINUTES: 'Infinity' })).toBe(def)
  })
})

describe('HostActivityTracker requestDrain', () => {
  function fakeOwnership(order: string[] = []) {
    return {
      order,
      markDraining: vi.fn(() => {
        order.push('markDraining')
        return true
      }),
      release: vi.fn(() => {
        order.push('release')
      })
    }
  }

  it('refuses while busy with the blocking counts and changes nothing', async () => {
    const own = fakeOwnership()
    const onDrained = vi.fn()
    const { a } = tracker({ ownership: own, onDrained })
    a.acquire('liveRuns')
    a.addSource('backgroundTasks', () => 2)
    await expect(a.requestDrain()).resolves.toEqual({ stopping: false, refusedBecause: { liveRuns: 1, backgroundTasks: 2 } })
    expect(a.state()).toBe('ready')
    expect(own.markDraining).not.toHaveBeenCalled()
    expect(own.release).not.toHaveBeenCalled()
    expect(onDrained).not.toHaveBeenCalled()
  })

  it('with force, marks draining, calls forceStop and then releases, even when forceStop throws', async () => {
    const order: string[] = []
    const own = fakeOwnership(order)
    const forceStop = vi.fn(async () => {
      order.push('forceStop')
      throw new Error('stop failed')
    })
    const { a, logs } = tracker({
      ownership: own,
      forceStop,
      forceStopFallback: () => order.push('fallback'),
      quiesce: () => order.push('quiesce'),
      onDrained: () => order.push('onDrained')
    })
    a.acquire('liveRuns')
    await expect(a.requestDrain({ force: true })).resolves.toEqual({ stopping: true })
    expect(order).toEqual(['markDraining', 'quiesce', 'forceStop', 'fallback', 'release', 'onDrained'])
    expect(logs.some((l) => l.includes('stop failed'))).toBe(true)
    expect(a.state()).toBe('draining')
  })

  it('a forceStop that never settles is cut at forceStopMs: the fallback writes the runs and the drain finishes', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const own = fakeOwnership(order)
    const forceStop = vi.fn(() => new Promise<void>(() => {}))
    const fallback = vi.fn(() => order.push('fallback'))
    const onDrained = vi.fn(() => order.push('onDrained'))
    const { a, logs } = tracker({ ownership: own, forceStop, forceStopMs: 3_000, forceStopFallback: fallback, onDrained })
    a.acquire('liveRuns')
    let settled = false
    const p = a.requestDrain({ force: true }).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
    expect(own.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toEqual({ stopping: true })
    expect(order).toEqual(['markDraining', 'fallback', 'release', 'onDrained'])
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('did not finish within 3000 ms'))).toBe(true)
  })

  it('a forceStop that finishes in time never calls the fallback', async () => {
    const fallback = vi.fn()
    const { a } = tracker({ ownership: fakeOwnership(), forceStop: async () => {}, forceStopFallback: fallback })
    await expect(a.requestDrain({ force: true })).resolves.toEqual({ stopping: true })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('quiesce runs before forceStop, so background work forceStop would start is never waited on', async () => {
    vi.useFakeTimers()
    const own = fakeOwnership()
    // Stands in for CapabilityService: a run ending arms a debounced review (a backgroundTasks count) unless disposed.
    let disposed = false
    let reviews = 0
    const forceStop = vi.fn(async () => {
      if (!disposed) reviews++
    })
    const { a } = tracker({ ownership: own, forceStop, quiesce: () => (disposed = true), forceSettleMs: 10_000, forceSettlePollMs: 50 })
    a.addSource('backgroundTasks', () => reviews)
    a.acquire('liveRuns')
    const p = a.requestDrain({ force: true })
    await vi.advanceTimersByTimeAsync(0)
    await expect(p).resolves.toEqual({ stopping: true })
    expect(reviews).toBe(0)
    expect(own.release).toHaveBeenCalledTimes(1)
  })

  it('a throwing quiesce is logged and the drain goes on', async () => {
    const own = fakeOwnership()
    const { a, logs } = tracker({
      ownership: own,
      quiesce: () => {
        throw new Error('dispose broke')
      }
    })
    await expect(a.requestDrain()).resolves.toEqual({ stopping: true })
    expect(own.release).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('dispose broke'))).toBe(true)
  })

  it('a forced drain is draining while forceStop runs, joins concurrent stops and calls forceStop once', async () => {
    const order: string[] = []
    const own = fakeOwnership(order)
    let finishStop!: () => void
    const forceStop = vi.fn(() => new Promise<void>((r) => (finishStop = r)))
    const { a } = tracker({ ownership: own, forceStop, onDrained: () => order.push('onDrained') })
    a.acquire('liveRuns')
    const first = a.requestDrain({ force: true })
    // Synchronously draining: new mutations are refused from here on.
    expect(a.state()).toBe('draining')
    expect(own.markDraining).toHaveBeenCalledTimes(1)
    const second = a.requestDrain({ force: true })
    const plain = a.requestDrain()
    await Promise.resolve()
    expect(forceStop).toHaveBeenCalledTimes(1)
    expect(own.release).not.toHaveBeenCalled()
    finishStop()
    await expect(Promise.all([first, second, plain])).resolves.toEqual([{ stopping: true }, { stopping: true }, { stopping: true }])
    expect(order).toEqual(['markDraining', 'release', 'onDrained'])
  })

  it('a forced drain waits for in-flight writers before it releases ownership', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const own = fakeOwnership(order)
    const { a } = tracker({ ownership: own, forceStop: async () => {}, forceSettlePollMs: 10, forceSettleMs: 60_000 })
    const mutation = a.acquire('inFlightRpcMutations', 'projects:remove')
    let tasks = 1
    a.addSource('backgroundTasks', () => tasks)
    a.acquire('activeOAuthFlows') // never waited on: a sign-in can wait on the user forever
    let settled = false
    const p = a.requestDrain({ force: true }).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(own.release).not.toHaveBeenCalled()
    mutation()
    await vi.advanceTimersByTimeAsync(50)
    expect(own.release).not.toHaveBeenCalled()
    tasks = 0
    await vi.advanceTimersByTimeAsync(20)
    expect(own.release).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)
    await expect(p).resolves.toEqual({ stopping: true })
  })

  it('a forced drain releases anyway (logged) once the writer wait times out', async () => {
    vi.useFakeTimers()
    let t = 0
    const own = fakeOwnership()
    const logs: string[] = []
    const a = new HostActivityTracker({ ownership: own, now: () => t, log: (m) => logs.push(m), forceStop: async () => {}, forceSettleMs: 100, forceSettlePollMs: 10 })
    a.acquire('activeWorktreeOps')
    const p = a.requestDrain({ force: true })
    for (let i = 0; i < 12; i++) {
      t += 10
      await vi.advanceTimersByTimeAsync(10)
    }
    await expect(p).resolves.toEqual({ stopping: true })
    expect(own.release).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('activeWorktreeOps 1'))).toBe(true)
  })

  it('drains once: markDraining, release, onDrained, even with concurrent calls', async () => {
    const order: string[] = []
    const own = fakeOwnership(order)
    const onDrained = vi.fn(() => order.push('onDrained'))
    const { a } = tracker({ ownership: own, onDrained })
    const results = await Promise.all([a.requestDrain(), a.requestDrain(), a.requestDrain({ force: true })])
    expect(results).toEqual([{ stopping: true }, { stopping: true }, { stopping: true }])
    await a.requestDrain()
    expect(order).toEqual(['markDraining', 'release', 'onDrained'])
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(a.state()).toBe('draining')
    expect(a.snapshot().state).toBe('draining')
    // Leases still work after the drain; the state stays.
    const r = a.acquire('inFlightRpcMutations')
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(1)
    r()
    expect(a.state()).toBe('draining')
  })

  it('a throwing release is logged and onDrained still runs', async () => {
    const onDrained = vi.fn()
    const { a, logs } = tracker({
      ownership: {
        markDraining: () => true,
        release: () => {
          throw new Error('release broke')
        }
      },
      onDrained
    })
    await a.requestDrain()
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('release broke'))).toBe(true)
  })
})

// Real ownership files under a short temp base (macOS's os.tmpdir() would push the socket past the 100-byte limit).
describe.skipIf(process.platform === 'win32')('HostActivityTracker drain with real host ownership', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function own() {
    const base = realpathSync(mkdtempSync(join('/tmp', 'orgai-act-')))
    dirs.push(base)
    const dataDir = join(base, 'data')
    const runtimeBase = join(base, 'rt')
    mkdirSync(runtimeBase, { recursive: true, mode: 0o700 })
    const ownership = await acquireHostOwnership({ dataDir, hostKind: 'headless-host', appVersion: '0.0.0-test', hostInstanceId: newHostInstanceId(), runtimeBase })
    return { ownership, runDir: join(dataDir, 'run') }
  }

  it('removes daemon.json and daemon.secret on drain', async () => {
    const { ownership, runDir } = await own()
    expect(existsSync(join(runDir, 'daemon.json'))).toBe(true)
    expect(existsSync(join(runDir, 'daemon.secret'))).toBe(true)
    const a = new HostActivityTracker({ ownership })
    await expect(a.requestDrain()).resolves.toEqual({ stopping: true })
    expect(existsSync(join(runDir, 'daemon.json'))).toBe(false)
    expect(existsSync(join(runDir, 'daemon.secret'))).toBe(false)
  })

  it("leaves a daemon.json that names another host in place", async () => {
    const { ownership, runDir } = await own()
    const path = join(runDir, 'daemon.json')
    const other = { ...JSON.parse(readFileSync(path, 'utf8')), hostInstanceId: newHostInstanceId() }
    writeFileSync(path, JSON.stringify(other))
    const a = new HostActivityTracker({ ownership })
    await a.requestDrain()
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).hostInstanceId).toBe(other.hostInstanceId)
  })
})
