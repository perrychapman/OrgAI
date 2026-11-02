import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quitGate, type QuitGateDeps } from './quitGate'

function setup(over: Partial<QuitGateDeps> & { stop?: () => Promise<void> } = {}) {
  let resolveStop: () => void = () => {}
  let rejectStop: (e: Error) => void = () => {}
  const stopAll = vi.fn(
    over.stop ??
      (() =>
        new Promise<void>((res, rej) => {
          resolveStop = res
          rejectStop = rej
        }))
  )
  const markQuit = vi.fn()
  const warn = vi.fn()
  const deps: QuitGateDeps = { liveCount: () => 2, stopAll, markQuit, deadlineMs: 3000, quit: vi.fn(), warn, now: () => Date.now(), ...over }
  // app.quit() re-enters the gate, as Electron's before-quit does.
  const gate = quitGate({ ...deps, quit: () => { (deps.quit as () => void)(); fire() } })
  const prevented: boolean[] = []
  function fire(): boolean {
    let held = false
    gate({ preventDefault: () => (held = true) })
    prevented.push(held)
    return held
  }
  return { fire, stopAll, markQuit, warn, quit: deps.quit as ReturnType<typeof vi.fn>, prevented, resolveStop: () => resolveStop(), rejectStop: (e: Error) => rejectStop(e) }
}

describe('quitGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('with no live runs lets the quit through and writes nothing pending', () => {
    const g = setup({ liveCount: () => 0 })
    expect(g.fire()).toBe(false)
    expect(g.stopAll).not.toHaveBeenCalled()
    expect(g.markQuit).toHaveBeenCalledTimes(1)
  })

  it('holds the quit until stopAll resolves, then quits once', async () => {
    const g = setup()
    expect(g.fire()).toBe(true)
    expect(g.stopAll).toHaveBeenCalledTimes(1)
    g.resolveStop()
    await vi.advanceTimersByTimeAsync(0)
    expect(g.quit).toHaveBeenCalledTimes(1)
    // The second pass (the gate's own app.quit) went through.
    expect(g.prevented).toEqual([true, false])
    expect(g.markQuit).toHaveBeenCalledTimes(1)
    expect(g.warn).not.toHaveBeenCalled()
  })

  it('on the deadline calls markQuit before quitting', async () => {
    const g = setup()
    g.fire()
    await vi.advanceTimersByTimeAsync(2999)
    expect(g.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(g.warn).toHaveBeenCalledWith(expect.stringContaining('did not stop within 3000 ms'))
    expect(g.markQuit).toHaveBeenCalled()
    expect(g.markQuit.mock.invocationCallOrder[0]).toBeLessThan(g.quit.mock.invocationCallOrder[0])
    expect(g.quit).toHaveBeenCalledTimes(1)
  })

  it('a rejecting stopAll warns, writes through markQuit and quits', async () => {
    const g = setup()
    g.fire()
    g.rejectStop(new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(g.warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(g.markQuit.mock.invocationCallOrder[0]).toBeLessThan(g.quit.mock.invocationCallOrder[0])
    expect(g.quit).toHaveBeenCalledTimes(1)
  })

  it('a stopAll that throws synchronously is handled like a rejection', async () => {
    const g = setup({
      stop: () => {
        throw new Error('sync')
      }
    })
    expect(g.fire()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(g.warn).toHaveBeenCalledWith(expect.stringContaining('sync'))
    expect(g.markQuit).toHaveBeenCalled()
    expect(g.quit).toHaveBeenCalledTimes(1)
  })

  it('a re-entrant quit before the deadline is held and reuses the pending stopAll', async () => {
    const g = setup()
    g.fire()
    await vi.advanceTimersByTimeAsync(1000)
    expect(g.fire()).toBe(true)
    expect(g.stopAll).toHaveBeenCalledTimes(1)
    expect(g.markQuit).not.toHaveBeenCalled()
    g.resolveStop()
    await vi.advanceTimersByTimeAsync(0)
    expect(g.quit).toHaveBeenCalledTimes(1)
  })

  it('a re-entrant quit after the deadline is forced through with markQuit', () => {
    let t = 0
    const g = setup({ now: () => t })
    g.fire()
    // The deadline passed but the timer has not run yet (a busy event loop).
    t = 3000
    expect(g.fire()).toBe(false)
    expect(g.markQuit).toHaveBeenCalledTimes(1)
    expect(g.stopAll).toHaveBeenCalledTimes(1)
  })
})
