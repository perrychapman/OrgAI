import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { OUTBOUND_QUEUE_MAX_BYTES, OutboundQueue, frameKey, type WritableSocketLike } from './outboundQueue'

/** A socket that accepts writes while `open`, else reports backpressure until drain(). */
class FakeSocket extends EventEmitter implements WritableSocketLike {
  written: string[] = []
  open = true
  destroyed = false
  ended = false
  pendingCbs: Array<() => void> = []

  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.written.push(chunk)
    if (this.open) {
      cb?.()
      return true
    }
    if (cb) this.pendingCbs.push(() => cb())
    return false
  }

  drain(): void {
    this.open = true
    for (const cb of this.pendingCbs.splice(0)) cb()
    this.emit('drain')
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }
}

const K = frameKey('r1', 'root')
const partial = (t: string): string => `partial ${t}\n`

describe('OutboundQueue', () => {
  it('writes straight through while the socket accepts', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    q.enqueue('a\n')
    q.enqueue('b\n', { push: true })
    expect(s.written).toEqual(['a\n', 'b\n'])
    expect(q.length).toBe(0)
  })

  it('waits for drain under backpressure, then flushes in order', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('a\n')
    q.enqueue('b\n')
    q.enqueue('c\n')
    expect(s.written).toEqual(['a\n'])
    expect(q.length).toBe(2)
    s.drain()
    expect(s.written).toEqual(['a\n', 'b\n', 'c\n'])
  })

  it('a new partial of the same pair replaces the unwritten one at the tail', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('blocker\n')
    const dropped: string[] = []
    q.enqueue(partial('he'), { push: true, meta: { kind: 'partial', key: K }, onDone: () => dropped.push('he') })
    q.enqueue('other\n', { push: true })
    q.enqueue(partial('hello'), { push: true, meta: { kind: 'partial', key: K } })
    expect(dropped).toEqual(['he'])
    s.drain()
    expect(s.written).toEqual(['blocker\n', 'other\n', partial('hello')])
  })

  it('partials of another pair are kept', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('blocker\n')
    q.enqueue(partial('a'), { push: true, meta: { kind: 'partial', key: frameKey('r1', 'other') } })
    q.enqueue(partial('b'), { push: true, meta: { kind: 'partial', key: K } })
    s.drain()
    expect(s.written).toEqual(['blocker\n', partial('a'), partial('b')])
  })

  it('a transcript drops every queued partial of its pair', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('blocker\n')
    q.enqueue(partial('x'), { push: true, meta: { kind: 'partial', key: K } })
    q.enqueue('transcript\n', { push: true, meta: { kind: 'transcript', key: K } })
    s.drain()
    expect(s.written).toEqual(['blocker\n', 'transcript\n'])
  })

  it('an intervening agent.upsert (or transcript) of the pair prevents replacement', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('blocker\n')
    q.enqueue(partial('one'), { push: true, meta: { kind: 'partial', key: K } })
    q.enqueue('upsert\n', { push: true, meta: { kind: 'upsert', key: K } })
    q.enqueue(partial('two'), { push: true, meta: { kind: 'partial', key: K } })
    s.drain()
    expect(s.written).toEqual(['blocker\n', partial('one'), 'upsert\n', partial('two')])
  })

  it('destroys the socket when queued pushes pass 16 MB', () => {
    const s = new FakeSocket()
    const overflows: number[] = []
    const q = new OutboundQueue(s, { onOverflow: (n) => overflows.push(n) })
    s.open = false
    q.enqueue('blocker\n')
    const chunk = `${'x'.repeat(1024 * 1024 - 1)}\n`
    for (let i = 0; i < 16; i++) expect(q.enqueue(chunk, { push: true })).toBe(true)
    expect(q.queuedBytes).toBe(16 * 1024 * 1024)
    expect(q.enqueue('y\n', { push: true })).toBe(false)
    expect(s.destroyed).toBe(true)
    expect(overflows).toEqual([OUTBOUND_QUEUE_MAX_BYTES + 2])
    expect(q.enqueue('z\n')).toBe(false)
  })

  it('responses never trip the cap', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s, { maxQueuedBytes: 10 })
    s.open = false
    q.enqueue('blocker\n')
    expect(q.enqueue(`${'r'.repeat(100)}\n`)).toBe(true)
    expect(s.destroyed).toBe(false)
  })

  it('end() flushes and then ends; destroy() calls onDone of unwritten frames', () => {
    const s = new FakeSocket()
    const q = new OutboundQueue(s)
    s.open = false
    q.enqueue('a\n')
    q.enqueue('b\n')
    q.end()
    expect(s.ended).toBe(false)
    s.drain()
    expect(s.ended).toBe(true)

    const s2 = new FakeSocket()
    const q2 = new OutboundQueue(s2)
    s2.open = false
    q2.enqueue('a\n')
    let done = 0
    q2.enqueue('b\n', { onDone: () => done++ })
    q2.destroy()
    q2.destroy()
    expect(done).toBe(1)
    expect(s2.destroyed).toBe(true)
  })
})
