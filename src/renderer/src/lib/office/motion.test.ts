import { describe, expect, it } from 'vitest'
import {
  admitArrivals, ARRIVAL_QUEUE_GAP_MS, bubbleDurationMs, bubbleText, DEFAULT_BUBBLE_TIMING, emptyArrivalQueue, freshIds, journeyDuration, MAX_ARRIVAL_QUEUE,
  MAX_WALKS, outboundDuration, planArrival, planMessageWalk, releaseArrivals, routesConflict, sampleArrival, sampleJourney, TALK_MARK_TICKS, type Point
} from './motion'

const line = (n: number, y = 0): Point[] => Array.from({ length: n }, (_, x) => ({ x, y }))

describe('Office message journeys', () => {
  const path = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]
  it('walks in integer pixels at a distance-based cadence and turns with the route', () => {
    expect(sampleJourney(path, 60)).toMatchObject({ x: 24, y: 16, direction: 'right', phase: 'outbound' })
    expect(sampleJourney(path, 120)).toMatchObject({ x: 32, y: 16, direction: 'down', pose: 'walk-2' })
    expect(Number.isInteger(sampleJourney(path, 91).x)).toBe(true)
  })
  it('holds a real arrival, reverses the same route and ends exactly at its desk', () => {
    expect(journeyDuration(path)).toBe(720)
    expect(sampleJourney(path, 240)).toMatchObject({ x: 32, y: 32, phase: 'settle', pose: 'idle' })
    expect(sampleJourney(path, 479).phase).toBe('settle')
    expect(sampleJourney(path, 540)).toMatchObject({ x: 32, y: 24, phase: 'return', direction: 'up' })
    expect(sampleJourney(path, 660)).toMatchObject({ x: 24, y: 16, phase: 'return', direction: 'left' })
    expect(sampleJourney(path, 720)).toMatchObject({ x: 16, y: 16, phase: 'done' })
  })
  it('rejects empty, discontinuous and excessively long journeys instead of rushing them', () => {
    expect(journeyDuration([])).toBeNull()
    expect(journeyDuration([{ x: 0, y: 0 }, { x: 3, y: 0 }])).toBeNull()
    expect(journeyDuration(Array.from({ length: 42 }, (_, x) => ({ x, y: 0 })))).toBeNull()
    expect(journeyDuration(Array.from({ length: 41 }, (_, x) => ({ x, y: 0 })))).toBe(9840)
  })
  it('reserves intersecting and adjacent target corridors while allowing disjoint walks', () => {
    expect(routesConflict(path, [{ x: 2, y: 3 }])).toBe(true)
    expect(routesConflict([{ x: 1, y: 1 }], [{ x: 1, y: 3 }])).toBe(true)
    expect(routesConflict(path, [{ x: 5, y: 5 }])).toBe(false)
  })
})

describe('message walk planning (no floors)', () => {
  it('walks the full route when the round trip fits 10 s', () => {
    const plan = planMessageWalk(line(41), line(5))
    expect(plan?.kind).toBe('full')
    expect(plan?.path).toHaveLength(41)
  })
  it('truncates to the sender doorway when the full round trip is too long', () => {
    const plan = planMessageWalk(line(42), line(5))
    expect(plan?.kind).toBe('doorway')
    expect(plan?.path).toEqual(line(5))
    expect(journeyDuration(plan!.path)).toBe(4 * 240 + 240)
  })
  it('gives no walk when blocked, empty, discontinuous or when even the doorway is too far', () => {
    expect(planMessageWalk([], [])).toBeNull()
    expect(planMessageWalk([], line(5))?.kind).toBe('doorway')
    expect(planMessageWalk(line(42), [])).toBeNull()
    expect(planMessageWalk(line(42), line(60))).toBeNull()
    expect(planMessageWalk([{ x: 0, y: 0 }, { x: 5, y: 0 }], [{ x: 0, y: 0 }])).toBeNull()
    expect(planMessageWalk(line(41), line(5), { stepMs: 120, settleMs: 240, maxMs: 5000 })?.kind).toBe('doorway')
  })
  it('starts the recipient bubble when the sender arrives', () => {
    expect(outboundDuration(line(6))).toBe(600)
    expect(outboundDuration([])).toBe(0)
  })
})

describe('bubble text and timing', () => {
  it('uses 1500 ms plus 45 ms per displayed character', () => {
    expect(DEFAULT_BUBBLE_TIMING).toEqual({ baseMs: 1500, perCharMs: 45, maxMs: 6000 })
    expect(bubbleDurationMs('')).toBe(1500)
    expect(bubbleDurationMs('hello')).toBe(1500 + 45 * 5)
    expect(bubbleDurationMs('  hello  ')).toBe(1725)
  })
  it('counts the trimmed display text, so long messages top out at 81 characters', () => {
    expect(bubbleText('x'.repeat(80))).toBe('x'.repeat(80))
    expect(bubbleText('x'.repeat(81))).toBe(`${'x'.repeat(80)}…`)
    expect(bubbleDurationMs('x'.repeat(5000))).toBe(1500 + 45 * 81)
  })
  it('clamps to the maximum', () => {
    expect(bubbleDurationMs('x'.repeat(5000), { baseMs: 1500, perCharMs: 100, maxMs: 6000 })).toBe(6000)
    expect(bubbleDurationMs('abc', { baseMs: 1500, perCharMs: 45, maxMs: 1600 })).toBe(1600)
  })
  it('does not split surrogate pairs and keeps the talk mark at 10 ticks', () => {
    expect(bubbleText('😀'.repeat(81))).toBe(`${'😀'.repeat(80)}…`)
    expect(TALK_MARK_TICKS).toBe(10)
  })
})

describe('arrival', () => {
  it('walks the full route from the door when it is within 8 s, else the doorway, else appears at the desk', () => {
    expect(planArrival(line(67), line(5))).toMatchObject({ from: 'door' })
    expect(planArrival(line(68), line(5))).toMatchObject({ from: 'doorway' })
    expect(planArrival(line(68), line(68))).toBeNull()
    expect(planArrival([], [])).toBeNull()
    expect(planArrival([{ x: 0, y: 0 }], [{ x: 0, y: 0 }])).toBeNull()
    expect(planArrival([{ x: 0, y: 0 }, { x: 4, y: 0 }], line(3))?.from).toBe('doorway')
  })
  it('samples a tile per tick, turns, sits two ticks facing up, then hands over', () => {
    const path = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]
    expect(sampleArrival(path, 0)).toMatchObject({ x: 16, y: 16, direction: 'right', pose: 'walk-1', phase: 'arrive', cue: 'arriving' })
    expect(sampleArrival(path, 60)).toMatchObject({ x: 24, y: 16, direction: 'right', phase: 'arrive' })
    expect(sampleArrival(path, 120)).toMatchObject({ x: 32, y: 16, direction: 'down', pose: 'walk-2', phase: 'arrive' })
    expect(sampleArrival(path, 239)).toMatchObject({ phase: 'arrive', cue: 'arriving' })
    expect(sampleArrival(path, 240)).toMatchObject({ x: 32, y: 32, direction: 'up', pose: 'idle', phase: 'sit', cue: 'none' })
    expect(sampleArrival(path, 479).phase).toBe('sit')
    expect(sampleArrival(path, 480)).toMatchObject({ x: 32, y: 32, phase: 'done', pose: 'idle' })
    for (let t = 0; t < 500; t += 7) expect(Number.isInteger(sampleArrival(path, t).x) && Number.isInteger(sampleArrival(path, t).y)).toBe(true)
  })
  it('treats agents known at baseline as settled', () => {
    expect(freshIds(new Set(['a', 'b']), ['a', 'b', 'c'])).toEqual(['c'])
    expect(freshIds(new Set(['a']), ['a'])).toEqual([])
  })
})

describe('walk admission', () => {
  const ids = (n: number, prefix = 'n'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  it('starts up to the shared 3-walk cap, queues 6 more, and sends the rest to their desks', () => {
    const r = admitArrivals(emptyArrivalQueue, ids(12), 1000, 0)
    expect(MAX_WALKS).toBe(3)
    expect(r.start).toEqual(['n0', 'n1', 'n2'])
    expect(r.queue.queued.map(q => q.id)).toEqual(ids(MAX_ARRIVAL_QUEUE + 3).slice(3))
    expect(r.desk).toEqual(['n9', 'n10', 'n11'])
  })
  it('counts message walks against the cap', () => {
    expect(admitArrivals(emptyArrivalQueue, ['a', 'b'], 0, 2).start).toEqual(['a'])
    expect(admitArrivals(emptyArrivalQueue, ['a'], 0, 3).start).toEqual([])
    expect(admitArrivals(emptyArrivalQueue, ['a'], 0, 3).queue.queued).toHaveLength(1)
  })
  it('releases queued arrivals one per 480 ms when a slot is free', () => {
    let q = admitArrivals(emptyArrivalQueue, ids(6), 0, 0).queue
    const present = new Set(ids(6))
    expect(releaseArrivals(q, 500, 3, present).start).toEqual([])
    expect(releaseArrivals(q, 100, 0, present).start).toEqual([])
    const first = releaseArrivals(q, 500, 0, present)
    expect(first.start).toEqual(['n3'])
    q = first.queue
    expect(releaseArrivals(q, 500 + ARRIVAL_QUEUE_GAP_MS - 1, 0, present).start).toEqual([])
    const second = releaseArrivals(q, 500 + ARRIVAL_QUEUE_GAP_MS, 0, present)
    expect(second.start).toEqual(['n4'])
    expect(releaseArrivals(second.queue, 500 + ARRIVAL_QUEUE_GAP_MS * 2, 0, present).start).toEqual(['n5'])
  })
  it('new arrivals wait behind the queue, drop departed agents and expire to the desk', () => {
    const q = admitArrivals(emptyArrivalQueue, ids(4), 0, 0).queue
    expect(admitArrivals(q, ['late'], 10, 0).start).toEqual([])
    const r = releaseArrivals(q, 100, 0, new Set())
    expect(r.start).toEqual([]); expect(r.queue.queued).toEqual([])
    const old = releaseArrivals(q, 8000, 3, new Set(ids(4)))
    expect(old.desk).toEqual(['n3']); expect(old.queue.queued).toEqual([])
  })
})
