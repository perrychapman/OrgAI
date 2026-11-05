import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type RunEvent } from '../../shared/types'
import { HOST_PUSH_CHANNELS, HostEventBus } from './events'
import { PUSH_CHANNELS } from './jsonCodec'

const ev = (n: number): RunEvent => ({ type: 'log', runId: `r${n}`, level: 'info', message: `m${n}` }) as RunEvent

afterEach(() => vi.restoreAllMocks())

describe('HostEventBus', () => {
  it('delivers synchronously in subscription order', () => {
    const bus = new HostEventBus()
    const seen: string[] = []
    bus.on((ch, p) => seen.push(`a:${ch}:${(p as RunEvent).runId}`))
    bus.on((ch) => seen.push(`b:${ch}`))
    bus.emit(IPC.runEvent, ev(1))
    expect(seen).toEqual(['a:runs:event:r1', 'b:runs:event'])
  })

  it('a throwing listener is logged and the rest still run', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new HostEventBus()
    const seen: number[] = []
    bus.on(() => seen.push(1))
    bus.on(() => {
      throw new Error('boom')
    })
    bus.on(() => seen.push(3))
    expect(() => bus.emit(IPC.runEvent, ev(1))).not.toThrow()
    expect(seen).toEqual([1, 3])
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops delivery and is idempotent', () => {
    const bus = new HostEventBus()
    const a: number[] = []
    const b: number[] = []
    const offA = bus.on(() => a.push(1))
    bus.on(() => b.push(1))
    offA()
    offA()
    bus.emit(IPC.runEvent, ev(1))
    expect(a).toEqual([])
    expect(b).toEqual([1])
    // A second unsubscribe never removes someone else.
    const offC = bus.on(() => a.push(2))
    offA()
    bus.emit(IPC.runEvent, ev(2))
    expect(a).toEqual([2])
    expect(b).toEqual([1, 1])
    offC()
  })

  it('a listener added during an emit does not get that emit', () => {
    const bus = new HostEventBus()
    const late: string[] = []
    let added = false
    bus.on(() => {
      if (added) return
      added = true
      bus.on((_ch, p) => late.push((p as RunEvent).runId))
    })
    bus.emit(IPC.runEvent, ev(1))
    expect(late).toEqual([])
    bus.emit(IPC.runEvent, ev(2))
    expect(late).toEqual(['r2'])
  })

  it('a listener removed during an emit, before its turn, is not called', () => {
    const bus = new HostEventBus()
    const seen: number[] = []
    let offB = (): void => {}
    bus.on(() => offB())
    offB = bus.on(() => seen.push(2))
    bus.emit(IPC.runEvent, ev(1))
    expect(seen).toEqual([])
  })
})

describe('HOST_PUSH_CHANNELS', () => {
  it('plus the two window-targeted channels equals every push channel', () => {
    expect(new Set([...HOST_PUSH_CHANNELS, IPC.appFocusRun, IPC.menuAction])).toEqual(new Set(PUSH_CHANNELS))
    expect(HOST_PUSH_CHANNELS).toHaveLength(8)
    expect(HOST_PUSH_CHANNELS).not.toContain(IPC.appFocusRun)
    expect(HOST_PUSH_CHANNELS).not.toContain(IPC.menuAction)
  })
})
