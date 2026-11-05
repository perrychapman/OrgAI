import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../shared/types'
import { EventJournal, JOURNAL_MAX_BYTES, JOURNAL_MAX_EVENTS, base64ByteLength, scrubImages } from './eventJournal'

const log = (n: number, runId = 'r1'): RunEvent => ({ type: 'log', runId, level: 'info', message: `m${n}` })
const partial = (text: string): RunEvent => ({ type: 'agent.partial', runId: 'r1', agentId: 'root', text })

function imageEvent(bytes: number): RunEvent {
  const data = Buffer.alloc(bytes, 7).toString('base64')
  return {
    type: 'transcript',
    runId: 'r1',
    entry: { id: 'e1', agentId: 'root', at: 1, block: { kind: 'user', text: 'look', images: [{ mediaType: 'image/png', data, name: 'a.png' }] } }
  }
}

describe('EventJournal', () => {
  it('hands out monotonic seqs from 1 and replays since a seq', () => {
    const j = new EventJournal()
    expect(j.currentSeq).toBe(0)
    expect(j.since(0)).toEqual([])
    expect(j.append(log(1)).seq).toBe(1)
    expect(j.append(log(2)).seq).toBe(2)
    expect(j.append(log(3)).seq).toBe(3)
    expect(j.currentSeq).toBe(3)
    expect(j.oldestSeq).toBe(1)
    const since = j.since(1)
    expect(since).not.toBe('evicted')
    expect((since as { seq: number }[]).map((e) => e.seq)).toEqual([2, 3])
    expect(j.since(3)).toEqual([])
    expect(j.since(4)).toBe('evicted')
    expect(j.since(-1)).toBe('evicted')
  })

  it('never stores agent.partial; it carries atSeq = the current seq', () => {
    const j = new EventJournal()
    j.append(log(1))
    const p = j.append(partial('he'))
    expect(p.seq).toBeUndefined()
    expect(p.atSeq).toBe(1)
    expect(j.size).toBe(1)
    expect(j.currentSeq).toBe(1)
    expect(j.append(log(2)).seq).toBe(2)
  })

  it('keeps at most 2000 events, evicting the oldest', () => {
    const j = new EventJournal()
    for (let i = 1; i <= JOURNAL_MAX_EVENTS + 5; i++) j.append(log(i))
    expect(j.size).toBe(JOURNAL_MAX_EVENTS)
    expect(j.oldestSeq).toBe(6)
    expect(j.since(4)).toBe('evicted')
    expect((j.since(5) as unknown[]).length).toBe(JOURNAL_MAX_EVENTS)
  })

  it('keeps at most 16 MB of serialized events', () => {
    const j = new EventJournal()
    const big = (n: number): RunEvent => ({ type: 'log', runId: 'r1', level: 'info', message: `${n}`.padEnd(400 * 1024, 'x') })
    for (let i = 0; i < 50; i++) j.append(big(i))
    expect(j.storedBytes).toBeLessThanOrEqual(JOURNAL_MAX_BYTES)
    expect(j.size).toBeLessThan(50)
    expect(j.size).toBeGreaterThan(30)
    expect(j.oldestSeq).toBe(50 - j.size + 1)
  })

  it('scrubs images of an event over 512 KB to OmittedImage, leaving the original untouched', () => {
    const j = new EventJournal()
    const original = imageEvent(600 * 1024)
    const before = JSON.stringify(original)
    const out = j.append(original)
    expect(JSON.stringify(original)).toBe(before)
    expect(out.event).not.toBe(original)
    const block = (out.event as Extract<RunEvent, { type: 'transcript' }>).entry.block as { images: unknown[] }
    expect(block.images[0]).toEqual({ mediaType: 'image/png', byteLength: 600 * 1024, omittedBase64: true })
    expect(out.json.length).toBeLessThan(2000)
    const stored = j.since(0) as { event: RunEvent }[]
    expect(stored[0].event).toBe(out.event)
  })

  it('leaves small image events whole', () => {
    const j = new EventJournal()
    const e = imageEvent(1024)
    expect(j.append(e).event).toBe(e)
  })
})

describe('scrubImages', () => {
  it('replaces every images entry at any depth and shares the rest', () => {
    const untouched = { a: 1 }
    const rec = { untouched, transcript: [{ block: { kind: 'user', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] } }] }
    const out = scrubImages(rec)
    expect(out.untouched).toBe(untouched)
    expect(out.transcript[0].block.images[0]).toEqual({ mediaType: 'image/jpeg', byteLength: 3, omittedBase64: true })
    expect(rec.transcript[0].block.images[0]).toEqual({ mediaType: 'image/jpeg', data: 'AAAA' })
    const plain = { x: [1, 2] }
    expect(scrubImages(plain)).toBe(plain)
  })

  it('counts decoded bytes', () => {
    expect(base64ByteLength(Buffer.from('hello').toString('base64'))).toBe(5)
    expect(base64ByteLength('')).toBe(0)
  })
})

describe('EventJournal.markGap', () => {
  it('drops stored events and makes a seq from before the gap evicted', () => {
    const j = new EventJournal()
    const a = j.append({ type: 'log', runId: 'r', level: 'info', message: 'a' })
    j.markGap()
    expect(j.size).toBe(0)
    expect(j.storedBytes).toBe(0)
    const b = j.append({ type: 'log', runId: 'r', level: 'info', message: 'b' })
    expect(b.seq).toBe((a.seq ?? 0) + 2)
    expect(j.since(a.seq ?? 0)).toBe('evicted')
    expect(j.since(b.seq ?? 0)).toEqual([])
    expect(j.since((b.seq ?? 0) - 1)).toEqual([{ seq: b.seq, event: b.event }])
  })
})
