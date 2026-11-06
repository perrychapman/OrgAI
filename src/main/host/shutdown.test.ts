import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostHandoffFacts } from '../../shared/types'
import { HostActivityTracker } from './activity'
import {
  ShutdownCoordinator,
  ShutdownRefusedError,
  descendantsOf,
  handoffBlockersOf,
  installShutdownSignals,
  killHostDescendants,
  killTrackedChildren,
  parseProcessTable,
  readProcessTable,
  trackChildProcess,
  trackedChildCount,
  trackedChildPids,
  withoutTree,
  type KillDescendantsResult,
  type ProcessRow
} from './shutdown'

afterEach(() => {
  vi.useRealTimers()
  killTrackedChildren()
})

class FakeChild extends EventEmitter {
  killed: (NodeJS.Signals | number | undefined)[] = []
  pid = 4242
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal)
    return true
  }
}

describe('tracked child processes (cli-standalone.md 4.3 hard limit)', () => {
  it('tracks until exit or untrack, and kills what is left with SIGKILL', () => {
    const a = new FakeChild()
    const b = new FakeChild()
    const c = new FakeChild()
    trackChildProcess(a, 'custodian:keychain')
    const untrackB = trackChildProcess(b, 'git')
    trackChildProcess(c, 'custodian:dpapi')
    expect(trackedChildCount('custodian:')).toBe(2)
    a.emit('exit', 0)
    untrackB()
    untrackB()
    expect(trackedChildCount()).toBe(1)
    expect(trackedChildPids()).toEqual([4242])
    expect(killTrackedChildren()).toBe(1)
    expect(c.killed).toEqual(['SIGKILL'])
    expect(a.killed).toEqual([])
    expect(trackedChildCount()).toBe(0)
  })

  it('never throws on a child that cannot be killed', () => {
    trackChildProcess({ kill: () => { throw new Error('gone') } }, 'x')
    expect(trackedChildPids()).toEqual([])
    expect(killTrackedChildren('SIGTERM')).toBe(0)
    expect(trackedChildCount()).toBe(0)
  })
})

describe('process table and descendants (round 6 item 5)', () => {
  it('parses POSIX ps rows with stat and start, Windows rows with ticks, and skips junk', () => {
    const t = parseProcessTable(
      [
        '    1     0 Ss   Sun Oct  4 00:35:02 2026',
        '  100     1 S    Thu Nov  5 10:00:00 2026   ',
        '  101   100 Z    Thu Nov  5 10:00:01 2026',
        '  200   100',
        '300 200 133000000000000000',
        'garbage line',
        ''
      ].join('\n')
    )
    expect(t.get(1)).toEqual({ pid: 1, ppid: 0, start: 'Sun Oct 4 00:35:02 2026' })
    expect(t.get(100)).toEqual({ pid: 100, ppid: 1, start: 'Thu Nov 5 10:00:00 2026' })
    expect(t.get(101)).toEqual({ pid: 101, ppid: 100, start: 'Thu Nov 5 10:00:01 2026', zombie: true })
    expect(t.get(200)).toEqual({ pid: 200, ppid: 100 })
    expect(t.get(300)).toEqual({ pid: 300, ppid: 200, start: '133000000000000000' })
    expect(t.size).toBe(5)
  })

  it('descendantsOf walks the whole tree, skips zombies and the root, and survives cycles', () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 13, ppid: 12, zombie: true },
      { pid: 14, ppid: 13 },
      { pid: 20, ppid: 1 },
      { pid: 30, ppid: 31 },
      { pid: 31, ppid: 30 }
    ]
    const table = new Map(rows.map((r) => [r.pid, r]))
    expect(descendantsOf(table, 10).map((r) => r.pid)).toEqual([11, 12, 14])
    expect(descendantsOf(table, 30).map((r) => r.pid)).toEqual([31])
    expect(descendantsOf(table, 99)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('reads this machine\'s process table and finds this process', async () => {
    const t = await readProcessTable()
    expect(t).not.toBeNull()
    const me = t!.get(process.pid)
    expect(me?.ppid).toBe(process.ppid)
    expect(typeof me?.start).toBe('string')
  })

  it('withoutTree drops the reader and everything under it (ps lists itself as a child of the host)', () => {
    const rows: ProcessRow[] = [
      { pid: 500, ppid: 1 },
      { pid: 501, ppid: 500 }, // an agent CLI: stays
      { pid: 510, ppid: 500 }, // the reader (ps / powershell)
      { pid: 511, ppid: 510 }, // its console host
      { pid: 512, ppid: 510, zombie: true }
    ]
    const table = new Map(rows.map((r) => [r.pid, r]))
    withoutTree(table, 510)
    expect([...table.keys()]).toEqual([500, 501])
  })
})

describe('killHostDescendants (fakes)', () => {
  /** A fake process world: a table that reflects which pids are alive, and signals that kill per a policy. */
  function world(rows: ProcessRow[], ignoresTerm: number[] = []) {
    const alive = new Map(rows.map((r) => [r.pid, { ...r }]))
    const sent: string[] = []
    return {
      alive,
      sent,
      readTable: async () => new Map([...alive].map(([p, r]) => [p, { ...r }])),
      signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => {
        sent.push(`${sig}:${pid}`)
        if (sig === 'SIGKILL' || !ignoresTerm.includes(pid)) {
          alive.delete(pid)
          // Orphans are re-parented to init.
          for (const r of alive.values()) if (r.ppid === pid) r.ppid = 1
        }
      }
    }
  }
  const sleep = (): Promise<void> => Promise.resolve()

  it('SIGTERMs every descendant, SIGKILLs the ones that ignore it (re-parented orphans included), and reports none left', async () => {
    const w = world(
      [
        { pid: 1, ppid: 0 },
        { pid: 500, ppid: 1, start: 'host' },
        { pid: 501, ppid: 500, start: 'a' }, // agent CLI
        { pid: 502, ppid: 501, start: 'b' }, // its shell, ignores SIGTERM
        { pid: 503, ppid: 502, start: 'c' }, // git hook, ignores SIGTERM
        { pid: 600, ppid: 1, start: 'x' } // not ours
      ],
      [502, 503]
    )
    const logs: string[] = []
    const r = await killHostDescendants({ rootPid: 500, readTable: w.readTable, signal: w.signal, extraPids: () => [], sleep, termGraceMs: 3, stepMs: 1, waitMs: 5, log: (m) => logs.push(m) })
    expect(r).toEqual({ found: 3, remaining: 0, tableReadable: true })
    expect(w.sent.filter((s) => s.startsWith('SIGTERM')).sort()).toEqual(['SIGTERM:501', 'SIGTERM:502', 'SIGTERM:503'])
    expect(w.sent.filter((s) => s.startsWith('SIGKILL')).sort()).toEqual(['SIGKILL:502', 'SIGKILL:503'])
    expect(w.alive.has(500)).toBe(true)
    expect(w.alive.has(600)).toBe(true)
    expect(logs.some((l) => l.includes('SIGKILL'))).toBe(true)
  })

  it('stops the SIGTERM grace early when the tree is gone, and never signals a reused pid', async () => {
    const w = world([
      { pid: 500, ppid: 1 },
      { pid: 501, ppid: 500, start: 'a' }
    ])
    let slept = 0
    const r = await killHostDescendants({
      rootPid: 500,
      readTable: w.readTable,
      signal: (pid, sig) => {
        w.signal(pid, sig)
        // The pid comes back at once as a stranger's process (another start time, not under the host).
        if (pid === 501) w.alive.set(501, { pid: 501, ppid: 1, start: 'stranger' })
      },
      extraPids: () => [],
      sleep: async () => void slept++,
      termGraceMs: 5_000,
      stepMs: 1_000,
      waitMs: 5_000
    })
    expect(r.remaining).toBe(0)
    expect(slept).toBe(1)
    expect(w.sent).toEqual(['SIGTERM:501'])
  })

  it('adds the tracked children found in the table, never the root', async () => {
    const w = world([
      { pid: 500, ppid: 1 },
      { pid: 700, ppid: 1, start: 'detached custodian' }
    ])
    await killHostDescendants({ rootPid: 500, readTable: w.readTable, signal: w.signal, extraPids: () => [700, 500, 999], sleep, termGraceMs: 1, stepMs: 1, waitMs: 1 })
    expect(w.sent).toEqual(['SIGTERM:700'])
  })

  it('an unreadable process table is retried in steps up to waitMs, then it gives up (logged)', async () => {
    let reads = 0
    const logs: string[] = []
    const r = await killHostDescendants({
      rootPid: 500,
      readTable: async () => {
        reads++
        return null
      },
      signal: () => {
        throw new Error('nothing to signal')
      },
      sleep,
      termGraceMs: 5,
      stepMs: 1,
      waitMs: 4,
      log: (m) => logs.push(m)
    })
    expect(r).toEqual({ found: 0, remaining: 1, tableReadable: false })
    expect(reads).toBe(6)
    expect(logs.some((l) => l.includes('could not be read'))).toBe(true)
  })

  it('a table that becomes readable during the wait still gets its descendants killed', async () => {
    const w = world([
      { pid: 500, ppid: 1 },
      { pid: 501, ppid: 500, start: 'a' }
    ])
    let reads = 0
    const r = await killHostDescendants({
      rootPid: 500,
      readTable: async () => (++reads < 3 ? null : w.readTable()),
      signal: w.signal,
      extraPids: () => [],
      sleep,
      termGraceMs: 1,
      stepMs: 1,
      waitMs: 10
    })
    expect(r.remaining).toBe(0)
    expect(w.sent).toEqual(['SIGKILL:501'])
  })

  it('survivors past waitMs are reported and logged', async () => {
    const w = world([
      { pid: 500, ppid: 1 },
      { pid: 501, ppid: 500, start: 'a' }
    ])
    const logs: string[] = []
    const r = await killHostDescendants({ rootPid: 500, readTable: w.readTable, signal: (pid, sig) => void w.sent.push(`${sig}:${pid}`), extraPids: () => [], sleep, termGraceMs: 2, stepMs: 1, waitMs: 3, log: (m) => logs.push(m) })
    expect(r).toEqual({ found: 1, remaining: 1, tableReadable: true })
    expect(logs.some((l) => l.includes('still alive'))).toBe(true)
  })
})

// A real process tree: an intermediate node process stands in for the host (so this test process's other children are
// never touched); under it a child that ignores SIGTERM, and a child whose own child (a grandchild) ignores SIGTERM.
describe.skipIf(process.platform === 'win32')('killHostDescendants (real processes)', () => {
  const started: ChildProcess[] = []
  afterEach(() => {
    for (const c of started.splice(0)) c.kill('SIGKILL')
  })

  const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  const HOST_SCRIPT = `
    const { spawn } = require('node:child_process')
    const a = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM)}], { stdio: 'ignore' })
    const b = spawn(process.execPath, ['-e', ${JSON.stringify(
      `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM)}], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`
    )}], { stdio: ['ignore', 'pipe', 'ignore'] })
    b.stdout.once('data', (d) => console.log(JSON.stringify({ a: a.pid, b: b.pid, c: Number(String(d).trim()) })))
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
  `

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('ends a descendant that ignores SIGTERM and a grandchild orphaned by its parent, leaving the root alone', async () => {
    const host = spawn(process.execPath, ['-e', HOST_SCRIPT], { stdio: ['ignore', 'pipe', 'inherit'] })
    started.push(host)
    const pids = await new Promise<{ a: number; b: number; c: number }>((resolve, reject) => {
      host.stdout!.once('data', (d) => resolve(JSON.parse(String(d))))
      host.once('exit', () => reject(new Error('the stand-in host exited')))
    })
    expect([pids.a, pids.b, pids.c].every(isAlive)).toBe(true)
    const logs: string[] = []
    const r: KillDescendantsResult = await killHostDescendants({ rootPid: host.pid!, extraPids: () => [], termGraceMs: 500, stepMs: 100, waitMs: 5_000, log: (m) => logs.push(m) })
    expect(r).toEqual({ found: 3, remaining: 0, tableReadable: true })
    // a and b may linger as zombies of the stand-in host for a moment (it reaps them); the grandchild c was re-parented
    // and is gone; none of them runs anymore.
    const table = await readProcessTable()
    for (const pid of [pids.a, pids.b, pids.c]) {
      const row = table?.get(pid)
      expect(row === undefined || row.zombie === true, `pid ${pid}`).toBe(true)
    }
    expect(isAlive(host.pid!)).toBe(true)
    expect(logs.some((l) => l.includes('SIGKILL'))).toBe(true)
  }, 20_000)
})

describe('ShutdownCoordinator (cli-standalone.md 4.3)', () => {
  function rig(opts: { facts?: HostHandoffFacts; hardLimitMs?: number; kill?: () => Promise<KillDescendantsResult> } = {}) {
    const order: string[] = []
    const logs: string[] = []
    const onReleased = vi.fn((info: unknown) => order.push(`released:${JSON.stringify(info)}`))
    const shutdown = new ShutdownCoordinator({
      release: () => order.push('release'),
      closeSocket: async (ms) => void order.push(`closeSocket:${ms}`),
      ...(opts.facts ? { handoffFacts: () => opts.facts! } : {}),
      onReleased,
      ...(opts.hardLimitMs !== undefined ? { hardLimitMs: opts.hardLimitMs } : {}),
      killDescendants: opts.kill ?? (async () => ({ found: 0, remaining: 0, tableReadable: true })),
      log: (m) => logs.push(m)
    })
    const forceStop = vi.fn(async () => void order.push('forceStop'))
    const activity = new HostActivityTracker({
      ownership: { markDraining: () => (order.push('markDraining'), true) },
      forceStop,
      settlePollMs: 10,
      ...shutdown.activityHooks()
    })
    shutdown.attachActivity(activity)
    return { shutdown, activity, order, logs, onReleased, forceStop }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const until = async (fn: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !fn(); i++) await tick()
  }

  it('host.stop: drain, the reply first, then closeGracefully, then release, then the exit', async () => {
    const { shutdown, order, onReleased } = rig()
    expect(shutdown.phase()).toBe('running')
    // The socket answers host.stop through a promise chain; the coordinator must not close the socket before it.
    void shutdown.stop({}).then(() => order.push('reply queued'))
    expect(shutdown.phase()).toBe('draining')
    await shutdown.released()
    expect(order).toEqual([
      'markDraining',
      'reply queued',
      'closeSocket:2000',
      'release',
      `released:${JSON.stringify({ reason: 'host.stop', forced: false, hardLimit: false })}`
    ])
    expect(shutdown.phase()).toBe('released')
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it('ownership stays while a writer is in flight ("settling"); released only once it ends', async () => {
    const { shutdown, activity, order } = rig()
    let release!: () => void
    const p = shutdown.shutdown('desktop-quit', { force: true })
    // A write that started before the drain (it was leased) and is still running.
    release = activity.acquire('backgroundTasks', 'vault write-back')
    await until(() => shutdown.phase() === 'settling')
    expect(shutdown.phase()).toBe('settling')
    await new Promise((r) => setTimeout(r, 60))
    expect(order).not.toContain('release')
    release()
    await p
    expect(order.slice(-2)).toEqual(['release', `released:${JSON.stringify({ reason: 'desktop-quit', forced: true, hardLimit: false })}`])
  })

  it('at the hard limit: abandons the writers, kills the descendants, then closes, releases and exits', async () => {
    vi.useFakeTimers()
    const kill = vi.fn(async (): Promise<KillDescendantsResult> => ({ found: 2, remaining: 0, tableReadable: true }))
    const { shutdown, activity, order, logs } = rig({ hardLimitMs: 60_000, kill })
    activity.acquire('activeWorktreeOps', 'git merge') // never ends
    const done = shutdown.shutdown('signal', { force: true })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(kill).not.toHaveBeenCalled()
    expect(order).not.toContain('release')
    await vi.advanceTimersByTimeAsync(1_000)
    await done
    expect(kill).toHaveBeenCalledTimes(1)
    expect(order.slice(-3)).toEqual(['closeSocket:2000', 'release', `released:${JSON.stringify({ reason: 'signal', forced: true, hardLimit: true })}`])
    expect(logs.some((l) => l.includes('writers still in flight after 60 s'))).toBe(true)
    // The abandoned settle never calls onDrained afterwards (no second release).
    await vi.advanceTimersByTimeAsync(10_000)
    expect(order.filter((o) => o === 'release')).toHaveLength(1)
  })

  it('at the hard limit a process-owning host exits before releasing (its exit hook releases)', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const shutdown = new ShutdownCoordinator({
      release: () => order.push('release'),
      closeSocket: async () => void order.push('closeSocket'),
      killDescendants: async () => (order.push('kill'), { found: 1, remaining: 0, tableReadable: true }),
      exitAtHardLimit: (info) => order.push(`exit:${info.hardLimit}`),
      onReleased: () => order.push('onReleased'),
      hardLimitMs: 1_000
    })
    const activity = new HostActivityTracker({ settlePollMs: 10, ...shutdown.activityHooks() })
    shutdown.attachActivity(activity)
    activity.acquire('inFlightRpcMutations')
    const done = shutdown.shutdown('signal', { force: true })
    await vi.advanceTimersByTimeAsync(1_000)
    await done
    // A real exit never returns; this fake does, so the coordinator still releases afterwards.
    expect(order).toEqual(['kill', 'closeSocket', 'exit:true', 'release', 'onReleased'])
  })

  it('a hard limit that the normal path beat does nothing', async () => {
    vi.useFakeTimers()
    const kill = vi.fn(async (): Promise<KillDescendantsResult> => ({ found: 0, remaining: 0, tableReadable: true }))
    const { shutdown } = rig({ hardLimitMs: 1_000, kill })
    const done = shutdown.shutdown('idle-exit')
    await vi.advanceTimersByTimeAsync(5)
    await done
    await vi.advanceTimersByTimeAsync(5_000)
    expect(kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a drain the tracker starts by itself (the idle exit) runs the same sequence with reason idle-exit', async () => {
    vi.useFakeTimers()
    const { shutdown, activity, order } = rig()
    ;(activity as unknown as { opts: { idleMs: number; pollMs: number } }).opts.idleMs = 1_000
    ;(activity as unknown as { opts: { idleMs: number; pollMs: number } }).opts.pollMs = 100
    activity.armIdleExit()
    await vi.advanceTimersByTimeAsync(1_200)
    await shutdown.released()
    expect(order.at(-1)).toBe(`released:${JSON.stringify({ reason: 'idle-exit', forced: false, hardLimit: false })}`)
  })

  it('a non-forced shutdown of a busy host is refused (ShutdownRefusedError) and starts nothing', async () => {
    const { shutdown, activity, order } = rig()
    activity.acquire('liveRuns')
    await expect(shutdown.shutdown('inproc-cleanup')).rejects.toBeInstanceOf(ShutdownRefusedError)
    await expect(shutdown.shutdown('inproc-cleanup')).rejects.toMatchObject({ result: { stopping: false, refusedBecause: { liveRuns: 1 } } })
    expect(shutdown.phase()).toBe('running')
    expect(order).toEqual([])
  })

  it('a forced request joins a non-forced one under way and upgrades it (forceStop runs once)', async () => {
    const { shutdown, activity, forceStop, onReleased } = rig()
    let writer: () => void = () => {}
    ;(activity as unknown as { opts: { quiesce: () => void } }).opts.quiesce = () => (writer = activity.acquire('backgroundTasks'))
    const first = shutdown.shutdown('host.stop')
    await until(() => shutdown.phase() === 'settling')
    expect(forceStop).not.toHaveBeenCalled()
    const second = shutdown.shutdown('desktop-quit', { force: true })
    await until(() => forceStop.mock.calls.length > 0)
    expect(forceStop).toHaveBeenCalledTimes(1)
    writer()
    await Promise.all([first, second])
    expect(forceStop).toHaveBeenCalledTimes(1)
    expect(onReleased).toHaveBeenCalledWith({ reason: 'host.stop', forced: true, hardLimit: false })
    // A shutdown after the release resolves at once.
    await expect(shutdown.shutdown('signal', { force: true })).resolves.toBeUndefined()
  })

  it('a throwing closeSocket, release or exit is logged and the sequence still ends released', async () => {
    const logs: string[] = []
    const shutdown = new ShutdownCoordinator({
      release: () => {
        throw new Error('release broke')
      },
      closeSocket: async () => {
        throw new Error('close broke')
      },
      onReleased: () => {
        throw new Error('exit broke')
      },
      log: (m) => logs.push(m)
    })
    const activity = new HostActivityTracker({ ...shutdown.activityHooks() })
    shutdown.attachActivity(activity)
    await shutdown.shutdown('host.stop')
    expect(shutdown.phase()).toBe('released')
    for (const m of ['close broke', 'release broke', 'exit broke']) expect(logs.some((l) => l.includes(m)), m).toBe(true)
  })

  it('closeSocket that never settles is cut at its grace (plus a margin)', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const shutdown = new ShutdownCoordinator({ release: () => order.push('release'), closeSocket: () => new Promise(() => {}), socketGraceMs: 2_000 })
    const activity = new HostActivityTracker({ ...shutdown.activityHooks() })
    shutdown.attachActivity(activity)
    const p = shutdown.shutdown('host.stop')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    await p
    expect(order).toEqual(['release'])
  })

  describe('handoff stop (4.4 step 4)', () => {
    const none: HostHandoffFacts = { workingRuns: 0, waitingRuns: 0, heldRuns: 0, pausedRuns: 0, openCards: 0, terminalSessions: 2 }

    it.each([
      ['workingRuns', { workingRuns: 1 }],
      ['waitingRuns (an idle run, which idle exit would not count)', { waitingRuns: 1 }],
      ['heldRuns', { heldRuns: 2 }],
      ['pausedRuns (a resume pending)', { pausedRuns: 1 }],
      ['openCards', { openCards: 3, waitingRuns: 1 }]
    ])('refuses while %s, without starting a drain', async (_label, extra) => {
      const facts = { ...none, ...extra }
      const { shutdown, activity, order } = rig({ facts })
      const r = await shutdown.stop({ handoff: true })
      expect(r).toEqual({ stopping: false, handoffBlockers: extra })
      expect(activity.state()).toBe('ready')
      expect(shutdown.phase()).toBe('running')
      expect(order).toEqual([])
    })

    it('also names the busy leases, as a plain stop would', async () => {
      const { shutdown, activity } = rig({ facts: { ...none, workingRuns: 1 } })
      activity.acquire('liveRuns')
      activity.acquire('interactiveClients')
      await expect(shutdown.stop({ handoff: true })).resolves.toEqual({
        stopping: false,
        handoffBlockers: { workingRuns: 1 },
        refusedBecause: { liveRuns: 1, interactiveClients: 1 }
      })
    })

    it('terminal sessions alone do not block it; leases still do (the attached TUI is interactiveClients)', async () => {
      const busy = rig({ facts: none })
      busy.activity.acquire('interactiveClients')
      await expect(busy.shutdown.stop({ handoff: true })).resolves.toEqual({ stopping: false, refusedBecause: { interactiveClients: 1 } })
      const idle = rig({ facts: none })
      await expect(idle.shutdown.stop({ handoff: true })).resolves.toEqual({ stopping: true })
      await idle.shutdown.released()
      expect(idle.order.at(-1)).toBe(`released:${JSON.stringify({ reason: 'handoff', forced: false, hardLimit: false })}`)
    })

    it('forced ignores the predicate and stops everything', async () => {
      const { shutdown, forceStop } = rig({ facts: { ...none, workingRuns: 2, openCards: 1 } })
      await expect(shutdown.stop({ handoff: true, force: true })).resolves.toEqual({ stopping: true })
      expect(forceStop).toHaveBeenCalledTimes(1)
      await shutdown.released()
    })

    it('handoffBlockersOf keeps only the non-zero blockers (never terminalSessions)', () => {
      expect(handoffBlockersOf(none)).toBeUndefined()
      expect(handoffBlockersOf({ ...none, pausedRuns: 1, openCards: 0 })).toEqual({ pausedRuns: 1 })
    })
  })
})

describe('installShutdownSignals', () => {
  it('a signal starts one forced shutdown; a second is only logged; uninstall removes the handlers', async () => {
    const target = new EventEmitter()
    const shutdown = vi.fn(async () => {})
    const logs: string[] = []
    const off = installShutdownSignals({ shutdown }, { target: target as never, platform: 'linux', log: (m) => logs.push(m) })
    target.emit('SIGTERM', 'SIGTERM')
    target.emit('SIGINT', 'SIGINT')
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith('signal', { force: true })
    expect(logs.some((l) => l.includes('received again'))).toBe(true)
    expect(target.listenerCount('SIGHUP')).toBe(1)
    off()
    expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT') + target.listenerCount('SIGHUP')).toBe(0)
    const win = new EventEmitter()
    installShutdownSignals({ shutdown }, { target: win as never, platform: 'win32' })
    expect(win.listenerCount('SIGHUP')).toBe(0)
  })
})
