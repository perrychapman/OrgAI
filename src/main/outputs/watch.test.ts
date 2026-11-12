import { describe, expect, it, vi } from 'vitest'
import { OUTPUT_EXTERNAL_SETTLE_MS, OUTPUT_WATCH_MAX, OUTPUT_WATCH_TTL_MS } from '../../shared/types'
import type { OutputsChangedEvent, RunOutput } from '../../shared/types'
import type { OutputScope, OutputsServiceApi } from './api'
import { OUTPUT_FOCUS_NEWEST, OUTPUT_FOCUS_TTL_MS, OUTPUT_WATCH_MISSING_MS, OUTPUT_WATCH_POLL_MS, createOutputWatcher } from './watch'

vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const oid = (n: number): string => `out_${String(n).padStart(16, '0')}`
const ref = (n = 1, projectId = 'p1') => ({ projectId, outputId: oid(n) })
const scope = (projectId: string): OutputScope => ({ projectId, projectPath: `/w/${projectId}`, allowedDirectories: [], referenceDirectories: [] })

function rig(opts: { projects?: string[] } = {}) {
  let now = 1_000_000
  const stats = new Map<string, { size: number; mtimeMs: number } | null>()
  const captured: string[] = []
  const pushed: OutputsChangedEvent[] = []
  let timer: (() => void) | undefined
  const timers = { set: 0, cleared: 0 }
  const known = new Set(opts.projects ?? ['p1', 'p2'])
  const listed = new Map<string, RunOutput[]>()
  const service = {
    get: vi.fn((_p: string, id: string) => ({ id }) as RunOutput),
    list: vi.fn((p: string) => listed.get(p) ?? []),
    statCurrent: vi.fn((_s: OutputScope, id: string) => (stats.has(id) ? stats.get(id)! : { size: 1, mtimeMs: 1 })),
    captureExternal: vi.fn(async (_s: OutputScope, id: string) => {
      captured.push(id)
      return null
    })
  } as unknown as OutputsServiceApi
  const w = createOutputWatcher({
    service,
    scopeOf: (p) => (known.has(p) ? scope(p) : null),
    emit: (e) => void pushed.push(e),
    now: () => now,
    setInterval: (fn, ms) => {
      expect(ms).toBe(OUTPUT_WATCH_POLL_MS)
      timer = fn
      timers.set++
      return 'timer-handle'
    },
    clearInterval: (h) => {
      expect(h).toBe('timer-handle')
      timer = undefined
      timers.cleared++
    }
  })
  const advance = async (ms: number, step = OUTPUT_WATCH_POLL_MS): Promise<void> => {
    for (let t = 0; t < ms; t += step) {
      now += Math.min(step, ms - t)
      await w.tick()
    }
  }
  return { w, service, stats, captured, pushed, timers, listed, advance, hasTimer: () => timer !== undefined, setNow: (n: number) => void (now = n), clock: () => now, known }
}

describe('output watcher: timer lifecycle', () => {
  it('has no timer while nothing is watched, one while anything is, and none again after the last unwatch', () => {
    const r = rig()
    expect(r.hasTimer()).toBe(false)
    expect(r.w.watch('window:1', ref(1))).toEqual({ watched: true })
    expect(r.hasTimer()).toBe(true)
    r.w.watch('window:1', ref(2))
    expect(r.timers.set).toBe(1)
    r.w.unwatch('window:1', ref(1))
    expect(r.hasTimer()).toBe(true)
    expect(r.w.unwatch('window:1', ref(2))).toEqual({ watched: false })
    expect(r.hasTimer()).toBe(false)
    expect(r.w.size()).toBe(0)
  })

  it('dispose clears the timer and every watch', () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.w.dispose()
    expect(r.hasTimer()).toBe(false)
    expect(r.w.size()).toBe(0)
  })

  it('refuses an output the service does not know and a project that is gone', () => {
    const r = rig()
    vi.mocked(r.service.get).mockReturnValueOnce(undefined)
    expect(r.w.watch('window:1', ref())).toEqual({ refused: 'That output is not in this project.' })
    expect(r.w.watch('window:1', ref(1, 'p_gone'))).toEqual({ refused: 'Project not found' })
    expect(r.hasTimer()).toBe(false)
  })
})

describe('output watcher: the settle rule', () => {
  it('hands a file to captureExternal only after size and mtime stayed the same for OUTPUT_EXTERNAL_SETTLE_MS', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    // First look, then settling.
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.captured).toEqual([])
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.captured).toEqual([])
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.captured).toEqual([oid(1)])
    // Unchanged afterwards: nothing more.
    await r.advance(5000)
    expect(r.captured).toEqual([oid(1)])
  })

  it('a file still being written (size or mtime moving each second) is never captured until it stops', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    for (let i = 0; i < 8; i++) {
      r.stats.set(oid(1), { size: 100 + i, mtimeMs: 5000 + i })
      await r.advance(OUTPUT_WATCH_POLL_MS)
    }
    expect(r.captured).toEqual([])
    // It stops changing: captured once after the settle time.
    await r.advance(OUTPUT_EXTERNAL_SETTLE_MS + OUTPUT_WATCH_POLL_MS)
    expect(r.captured).toEqual([oid(1)])
  })

  it('a later change is a new settle cycle and a new capture', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    await r.advance(4000)
    expect(r.captured).toHaveLength(1)
    r.stats.set(oid(1), { size: 2, mtimeMs: 2 })
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.captured).toHaveLength(1)
    await r.advance(4000)
    expect(r.captured).toHaveLength(2)
  })

  it('does not emit a version push of its own (the service raises it through onChange)', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    await r.advance(4000)
    expect(r.captured).toHaveLength(1)
    expect(r.pushed).toEqual([])
  })

  it('a throwing stat or capture never throws out of the tick and the next outputs are still checked', async () => {
    const r = rig()
    r.w.watch('window:1', ref(1))
    r.w.watch('window:1', ref(2))
    vi.mocked(r.service.statCurrent).mockImplementationOnce(() => {
      throw new Error('EBUSY')
    })
    vi.mocked(r.service.captureExternal).mockRejectedValueOnce(new Error('boom'))
    await expect(r.advance(6000)).resolves.toBeUndefined()
    expect(r.service.statCurrent).toHaveBeenCalled()
    // A rejecting capture does not wedge the entry: it is retried when the file changes again.
    r.stats.set(oid(2), { size: 9, mtimeMs: 9 })
    await r.advance(6000)
    expect(r.captured).toContain(oid(2))
  })
})

describe('output watcher: a missing file', () => {
  it('reports a file gone for 5 s once, and again when it is back', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.stats.set(oid(1), null)
    await r.advance(OUTPUT_WATCH_MISSING_MS - 1000)
    expect(r.pushed).toEqual([])
    await r.advance(2000)
    expect(r.pushed).toEqual([{ projectId: 'p1', ids: [oid(1)], what: 'watch' }])
    await r.advance(5000)
    expect(r.pushed).toHaveLength(1)
    r.stats.delete(oid(1))
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.pushed).toHaveLength(2)
  })

  it('a file that comes back before 5 s is never reported', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.stats.set(oid(1), null)
    await r.advance(3000)
    r.stats.delete(oid(1))
    await r.advance(10_000)
    expect(r.pushed).toEqual([])
  })
})

describe('output watcher: caps, TTL and owners', () => {
  it('refuses a watch past OUTPUT_WATCH_MAX per owner with a sentence; another owner has its own budget; re-watching is free', () => {
    const r = rig()
    for (let i = 1; i <= OUTPUT_WATCH_MAX; i++) expect(r.w.watch('window:1', ref(i))).toEqual({ watched: true })
    expect(r.w.watch('window:1', ref(OUTPUT_WATCH_MAX + 1))).toEqual({ refused: `You can watch at most ${OUTPUT_WATCH_MAX} outputs at once. Close one first.` })
    expect(r.w.watch('window:1', ref(1))).toEqual({ watched: true })
    expect(r.w.watch('window:2', ref(OUTPUT_WATCH_MAX + 1))).toEqual({ watched: true })
    r.w.unwatch('window:1', ref(2))
    expect(r.w.watch('window:1', ref(OUTPUT_WATCH_MAX + 2))).toEqual({ watched: true })
  })

  it('a watch lapses after OUTPUT_WATCH_TTL_MS, says so once, and stops the timer', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    await r.advance(OUTPUT_WATCH_TTL_MS - 2000, 2000)
    expect(r.w.size()).toBe(1)
    expect(r.pushed).toEqual([])
    await r.advance(4000, 2000)
    expect(r.w.size()).toBe(0)
    expect(r.pushed).toEqual([{ projectId: 'p1', ids: [oid(1)], what: 'watch' }])
    expect(r.hasTimer()).toBe(false)
  })

  it('watching again or touching (outputs:open) extends the lease', async () => {
    const r = rig()
    r.w.watch('window:1', ref(1))
    r.w.watch('window:1', ref(2))
    await r.advance(OUTPUT_WATCH_TTL_MS - 5000, 5000)
    r.w.watch('window:1', ref(1))
    r.w.touch(ref(2))
    await r.advance(OUTPUT_WATCH_TTL_MS - 5000, 5000)
    expect(r.w.size()).toBe(2)
    expect(r.pushed).toEqual([])
    await r.advance(10_000, 5000)
    expect(r.w.size()).toBe(0)
  })

  it('touch on an output nobody watches does nothing but remember it was opened', () => {
    const r = rig()
    r.w.touch(ref())
    expect(r.w.size()).toBe(0)
    expect(r.w.openedProjectIds()).toEqual(['p1'])
  })

  it('two owners on one output share the entry; it ends when the last one leaves', () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.w.watch('socket:99', ref())
    expect(r.w.size()).toBe(1)
    r.w.dropOwner('window:1')
    expect(r.w.size()).toBe(1)
    expect(r.hasTimer()).toBe(true)
    r.w.dropOwner('socket:99')
    expect(r.w.size()).toBe(0)
    expect(r.hasTimer()).toBe(false)
  })

  it('dropOwner (a window closed) removes all of its watches without a push', async () => {
    const r = rig()
    for (let i = 1; i <= 3; i++) r.w.watch('window:5', ref(i))
    r.w.dropOwner('window:5')
    expect(r.w.size()).toBe(0)
    await r.advance(5000)
    expect(r.pushed).toEqual([])
    expect(r.service.statCurrent).not.toHaveBeenCalled()
  })

  it('release (forget or delete) drops every watch on the output', () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.w.watch('window:2', ref())
    r.w.release(ref())
    expect(r.w.size()).toBe(0)
    expect(r.hasTimer()).toBe(false)
  })

  it('a project that disappears drops its watches', async () => {
    const r = rig()
    r.w.watch('window:1', ref())
    r.known.delete('p1')
    await r.advance(OUTPUT_WATCH_POLL_MS)
    expect(r.w.size()).toBe(0)
  })
})

describe('output watcher: window focus check', () => {
  const outputsOf = (r: ReturnType<typeof rig>, projectId: string, n: number): void =>
    void r.listed.set(
      projectId,
      Array.from({ length: n }, (_v, i) => ({ id: oid(i + 1) }) as RunOutput)
    )

  it('stats only the newest 20 of each project plus the outputs opened this session, and hands a moved or new file to the poller', async () => {
    const r = rig()
    outputsOf(r, 'p1', 30)
    r.w.noteOpened({ projectId: 'p1', outputId: oid(99) })
    r.w.checkProjects(['p1'])
    const statted = vi.mocked(r.service.statCurrent).mock.calls.map((c) => c[1])
    expect(new Set(statted).size).toBe(OUTPUT_FOCUS_NEWEST + 1)
    expect(statted).toContain(oid(99))
    expect(statted).toContain(oid(OUTPUT_FOCUS_NEWEST))
    expect(statted).not.toContain(oid(OUTPUT_FOCUS_NEWEST + 1))
    // Nothing was hashed or captured by the focus check itself.
    expect(r.captured).toEqual([])
    // The poller settles them and asks the service once each.
    await r.advance(4000)
    expect(r.captured).toHaveLength(OUTPUT_FOCUS_NEWEST + 1)
  })

  it('a file that looks the same as the last check is not handed on again', async () => {
    const r = rig()
    outputsOf(r, 'p1', 2)
    r.w.checkProjects(['p1'])
    await r.advance(OUTPUT_FOCUS_TTL_MS + 3000)
    expect(r.w.size()).toBe(0)
    const before = r.captured.length
    r.w.checkProjects(['p1'])
    expect(r.w.size()).toBe(0)
    await r.advance(4000)
    expect(r.captured.length).toBe(before)
    // A change since the last look is picked up.
    r.stats.set(oid(1), { size: 77, mtimeMs: 77 })
    r.w.checkProjects(['p1'])
    expect(r.w.size()).toBe(1)
    await r.advance(4000)
    expect(r.captured.length).toBe(before + 1)
  })

  it('a focus entry lapses quietly (no watch push) and never counts against the owner cap', async () => {
    const r = rig()
    outputsOf(r, 'p1', 3)
    r.w.checkProjects(['p1'])
    for (let i = 1; i <= OUTPUT_WATCH_MAX; i++) expect(r.w.watch('window:1', ref(100 + i))).toEqual({ watched: true })
    await r.advance(OUTPUT_FOCUS_TTL_MS + 2000)
    expect(r.pushed).toEqual([])
  })

  it('skips an unknown project and survives a failing list or stat', () => {
    const r = rig()
    expect(() => r.w.checkProjects(['p_gone'])).not.toThrow()
    vi.mocked(r.service.list).mockImplementationOnce(() => {
      throw new Error('index unreadable')
    })
    expect(() => r.w.checkProjects(['p1', 'p2'])).not.toThrow()
    expect(r.service.list).toHaveBeenCalledTimes(2)
  })

  it('openedProjectIds lists each project once', () => {
    const r = rig()
    r.w.noteOpened(ref(1, 'p1'))
    r.w.noteOpened(ref(2, 'p1'))
    r.w.noteOpened(ref(1, 'p2'))
    expect(r.w.openedProjectIds().sort()).toEqual(['p1', 'p2'])
  })
})

describe('settle constant', () => {
  it('the poll period is shorter than the settle time (a change is seen and then settles)', () => {
    expect(OUTPUT_WATCH_POLL_MS).toBeLessThan(OUTPUT_EXTERNAL_SETTLE_MS)
  })
})
