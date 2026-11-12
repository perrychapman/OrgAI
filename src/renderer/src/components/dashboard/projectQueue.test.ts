import { describe, expect, it } from 'vitest'
import { createProjectQueue } from './projectQueue'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('projectQueue', () => {
  it('runs at most 3 calls at once', async () => {
    const q = createProjectQueue()
    const calls = Array.from({ length: 5 }, () => deferred<number>())
    let started = 0
    const outs = calls.map((d, i) =>
      q.enqueue('worktrees', `p${i}`, () => {
        started++
        return d.promise
      })
    )
    expect(started).toBe(3)
    expect(q.inFlight()).toBe(3)
    calls[0].resolve(1)
    await tick()
    expect(started).toBe(4)
    calls.slice(1).forEach((d, i) => d.resolve(i + 2))
    await tick()
    await tick()
    expect(await Promise.all(outs)).toEqual([1, 2, 3, 4, 5])
    expect(q.inFlight()).toBe(0)
  })

  it('serves a fresh cached value without a call and re-fetches after the max age', async () => {
    let t = 0
    const q = createProjectQueue({ now: () => t })
    let calls = 0
    const fn = (): Promise<number> => Promise.resolve(++calls)
    expect(await q.enqueue('worktrees', 'p', fn)).toBe(1)
    t = 5 * 60_000
    expect(await q.enqueue('worktrees', 'p', fn)).toBe(1)
    t = 11 * 60_000
    expect(await q.enqueue('worktrees', 'p', fn)).toBe(2)
  })

  it('team reviews are fetched once per session', async () => {
    let t = 0
    const q = createProjectQueue({ now: () => t })
    let calls = 0
    await q.enqueue('teamReview', 'p', () => Promise.resolve(++calls))
    t = 24 * 3_600_000
    await q.enqueue('teamReview', 'p', () => Promise.resolve(++calls))
    expect(calls).toBe(1)
  })

  it('joins a duplicate call and caches null on failure', async () => {
    const q = createProjectQueue()
    let calls = 0
    const d = deferred<number>()
    const a = q.enqueue('mcpList', 'p', () => {
      calls++
      return d.promise
    })
    const b = q.enqueue('mcpList', 'p', () => {
      calls++
      return d.promise
    })
    d.reject(new Error('boom'))
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(calls).toBe(1)
    expect(q.cached('mcpList', 'p')).toBeNull()
  })

  it('forget drops cached values', async () => {
    const q = createProjectQueue()
    await q.enqueue('worktrees', 'p', () => Promise.resolve(3))
    expect(q.cached('worktrees', 'p')).toBe(3)
    q.forget('p')
    expect(q.cached('worktrees', 'p')).toBeUndefined()
  })
})
