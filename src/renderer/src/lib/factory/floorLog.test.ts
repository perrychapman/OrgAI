import { describe, expect, it } from 'vitest'
import { ANNOUNCE_WINDOW_MS, AnnounceGate, FLOOR_LOG_CAP, appendLog, logMessageText, logText } from './floorLog'
import type { FloorEvent } from './types'

describe('logText: every section 6.5 template (no time prefix)', () => {
  const cases: [FloorEvent, string | null][] = [
    [{ kind: 'assigned', at: 1, parent: 'Lead', child: 'Impl', childId: 'i' }, 'Lead assigned work to Impl'],
    [{ kind: 'started', at: 1, name: 'Orchestrator' }, 'Orchestrator started the shift'],
    [{ kind: 'message', at: 1, sender: 'Lead', recipient: 'Impl', text: 'go', offFloor: false }, 'Lead to Impl: “go”'],
    [{ kind: 'message', at: 1, sender: 'Lead', recipient: 'reviewer-1', text: 'ready', offFloor: true }, 'Lead to reviewer-1: “ready”'],
    [{ kind: 'state', at: 1, id: 'i', name: 'Impl', word: 'Needs you' }, 'Impl: Needs you'],
    [{ kind: 'merged', at: 1, name: 'Impl', into: 'main' }, "Impl's branch merged into the main checkout"],
    [{ kind: 'merged', at: 1, name: 'Impl', into: 'Lead' }, "Impl's branch merged into Lead's branch"],
    [{ kind: 'branch', at: 1, id: 'i', name: 'Impl', status: 'conflict' }, "Impl's branch has a merge conflict"],
    [{ kind: 'branch', at: 1, id: 'i', name: 'Impl', status: 'review' }, "Impl's branch is waiting for your review"],
    [{ kind: 'branch', at: 1, id: 'i', name: 'Impl', status: 'held' }, "Impl's branch is held"],
    [{ kind: 'branch', at: 1, id: 'i', name: 'Impl', status: 'empty' }, 'Impl changed no files'],
    [{ kind: 'plan', at: 1, done: 2, total: 5 }, 'Plan updated: 2 of 5 steps done'],
    [{ kind: 'run', at: 1, status: 'paused' }, 'Line stopped: run paused'],
    [{ kind: 'run', at: 1, status: 'resumed' }, 'Run resumed'],
    [{ kind: 'run', at: 1, status: 'ended' }, 'Shift over'],
    [{ kind: 'left', at: 1, id: 'i', name: 'Impl' }, null]
  ]
  for (const [event, text] of cases) {
    it(`${event.kind} ${'status' in event ? event.status : ''}`, () => expect(logText(event)).toBe(text))
  }

  it('cuts message text to 80 characters with an ellipsis, flattens whitespace, keeps markup as text', () => {
    const long = 'x'.repeat(100)
    expect(logMessageText(long)).toBe(`${'x'.repeat(80)}…`)
    expect(logMessageText('y'.repeat(80))).toBe('y'.repeat(80))
    expect(logMessageText('  a\n\nb\tc  ')).toBe('a b c')
    expect(logMessageText(`${'e'.repeat(79)}😀😀`)).toBe(`${'e'.repeat(79)}😀…`)
    const html = '<img src=x onerror=alert(1)>'
    expect(logText({ kind: 'message', at: 1, sender: 'A', recipient: 'B', text: html, offFloor: false })).toBe(`A to B: “${html}”`)
  })
})

describe('appendLog', () => {
  let n = 0
  const id = (): string => `l${++n}`

  it('prepends newest first, skips events without a line', () => {
    const log = appendLog([], [{ kind: 'started', at: 1, name: 'R' }, { kind: 'left', at: 2, id: 'x', name: 'X' }, { kind: 'plan', at: 3, done: 0, total: 1 }], id)
    expect(log.map((e) => e.text)).toEqual(['Plan updated: 0 of 1 steps done', 'R started the shift'])
    expect(log.map((e) => e.at)).toEqual([3, 1])
    const more = appendLog(log, [{ kind: 'run', at: 4, status: 'ended' }], id)
    expect(more.map((e) => e.text)[0]).toBe('Shift over')
    expect(new Set(more.map((e) => e.id)).size).toBe(3)
  })

  it('keeps at most 50 entries', () => {
    const events: FloorEvent[] = Array.from({ length: 70 }, (_, i) => ({ kind: 'plan', at: i, done: i, total: 70 }))
    const log = appendLog([], events, id)
    expect(log).toHaveLength(FLOOR_LOG_CAP)
    expect(log[0].at).toBe(69)
    expect(log[49].at).toBe(20)
    expect(appendLog(log, [{ kind: 'run', at: 99, status: 'paused' }], id)).toHaveLength(50)
    expect(appendLog(log, [], id)).toHaveLength(50)
  })
})

describe('AnnounceGate (section 7.5)', () => {
  const failed = (id: string, at = 0): FloorEvent => ({ kind: 'state', at, id, name: id.toUpperCase(), word: 'Failed' })
  const conflict = (id: string): FloorEvent => ({ kind: 'branch', at: 0, id, name: id.toUpperCase(), status: 'conflict' })

  it('announces failures and conflicts only', () => {
    const g = new AnnounceGate()
    expect(g.offer([{ kind: 'state', at: 0, id: 'a', name: 'A', word: 'Needs you' }, { kind: 'branch', at: 0, id: 'a', name: 'A', status: 'held' }], 0)).toBeNull()
    expect(g.pendingIn(0)).toBeNull()
    expect(g.offer([failed('a')], 10)).toBe('A failed')
    expect(g.offer([conflict('b')], 5000)).toBe("B's branch has a merge conflict")
  })

  it('one per 2 s; the window coalesces; due releases held text', () => {
    const g = new AnnounceGate()
    expect(g.offer([failed('a')], 1000)).toBe('A failed')
    expect(g.offer([failed('b')], 1500)).toBeNull()
    expect(g.offer([failed('c')], 2000)).toBeNull()
    expect(g.pendingIn(2000)).toBe(1000)
    expect(g.due(2999)).toBeNull()
    expect(g.due(1000 + ANNOUNCE_WINDOW_MS)).toBe('2 workers failed')
    expect(g.pendingIn(3000)).toBeNull()
    expect(g.offer([conflict('d'), conflict('e'), failed('f')], 3500)).toBeNull()
    expect(g.due(5000)).toBe("F failed. 2 branches have merge conflicts")
  })

  it('both kinds joined, the same worker counted once', () => {
    const g = new AnnounceGate()
    expect(g.offer([failed('a'), failed('a'), conflict('b')], 0)).toBe("A failed. B's branch has a merge conflict")
  })

  it('a late offer after the window announces held and new text together', () => {
    const g = new AnnounceGate()
    g.offer([failed('a')], 0)
    expect(g.offer([failed('b')], 100)).toBeNull()
    expect(g.offer([failed('c')], 2500)).toBe('2 workers failed')
  })
})
