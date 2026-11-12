import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/types'
import { activeBubbles, activeTalkers, attachWalk, baseline, bubbleWindow, deliveryEnd, finish, ingest, MAX_AGE } from './scheduler'

const message = (): AgentMessage => ({ from: 'a', to: 'b', toHandle: 'b', text: 'hello', at: 1 })
const agents = new Set(['a', 'b'])

describe('office message scheduler', () => {
  it('baselines history and consumes identical new occurrences separately', () => {
    const old = message(); const one = message(); const two = message()
    const initial = baseline([old])
    const result = ingest(initial, [old, one, two], agents, 1, true, false)
    expect(result.active.map(d => d.message)).toEqual([one, two])
    expect(ingest(result, [one, two], agents, 2, true, false).active).toHaveLength(2)
  })
  it('caps active and coalesces queued bursts; unknown endpoints are ignored', () => {
    const messages = Array.from({ length: 30 }, message)
    messages.push({ ...message(), to: 'unknown' })
    const result = ingest(baseline([]), messages, agents, 1, true, false)
    expect(result.active).toHaveLength(3)
    expect(result.queued).toHaveLength(1)
    expect(result.queued[0].count).toBe(27)
  })
  it('discards hidden backlog, removed agents and stale deliveries', () => {
    const m = message(); const running = ingest(baseline([]), [m], agents, 0, true, false)
    expect(ingest(running, [m, message()], agents, 1, false, false).active).toHaveLength(0)
    expect(ingest(running, [m], new Set(['a']), 1, true, false).active).toHaveLength(0)
    expect(ingest(running, [m], agents, MAX_AGE + 1, true, false).active).toHaveLength(0)
  })
  it('exposes immediate captions under reduced motion without a queue', () => {
    const result = ingest(baseline([]), Array.from({ length: 8 }, message), agents, 0, true, true)
    expect(result.active).toHaveLength(3)
    expect(result.queued).toHaveLength(0)
  })
  it('recognizes new objects across the retained 100 message window', () => {
    const history = Array.from({ length: 100 }, message)
    const appended = message()
    const result = ingest(baseline(history), [...history.slice(1), appended], agents, 1, true, false)
    expect(result.active.map(d => d.message)).toEqual([appended])
  })
  it('does not replay messages seen while hidden after returning', () => {
    const old = message(); const hidden = message()
    const paused = ingest(baseline([old]), [old, hidden], agents, 1, false, false)
    expect(ingest(paused, [old, hidden], agents, 2, true, false).active).toHaveLength(0)
  })
  it('advances queued messages before their age limit', () => {
    const all = Array.from({ length: 4 }, message)
    const initial = ingest(baseline([]), all, agents, 0, true, false)
    const next = finish(initial, 2000)
    expect(next.active.map(d => d.message)).toEqual([all[3]])
    expect(next.active[0].started).toBe(2000)
  })
  it('skips a delivery when either endpoint is outside the current room', () => {
    expect(ingest(baseline([]), [message()], new Set(['a']), 0, true, false).active).toHaveLength(0)
  })
  it('expires reduced-motion captions', () => {
    const state = ingest(baseline([]), [message()], agents, 0, true, true)
    expect(finish(state, MAX_AGE).active).toHaveLength(0)
  })
  it('keeps an admitted journey through its distance-based round trip', () => {
    const state = ingest(baseline([]), [message()], agents, 0, true, false)
    state.active[0].durationMs = 4200
    expect(finish(state, 4199).active).toHaveLength(1)
    expect(finish(state, 4200).active).toHaveLength(0)
  })
})

describe('delivery lifetime covers walk and bubble', () => {
  const text = (n: number): AgentMessage => ({ ...message(), text: 'x'.repeat(n) })
  it('defaults to the readable bubble time when there is no walk', () => {
    const state = ingest(baseline([]), [text(10)], agents, 0, true, false)
    expect(deliveryEnd(state.active[0])).toBe(1500 + 450)
    expect(finish(state, 1949).active).toHaveLength(1)
    expect(finish(state, 1950).active).toHaveLength(0)
  })
  it('keeps a delivery alive until its bubble ends after a short walk', () => {
    const state = ingest(baseline([]), [text(80)], agents, 0, true, false)
    attachWalk(state.active[0], 0, 720, 240)
    expect(bubbleWindow(state.active[0])).toEqual({ start: 240, end: 240 + 1500 + 45 * 80 })
    expect(finish(state, 4000).active).toHaveLength(1)
    expect(finish(state, 5340 - 1).active).toHaveLength(1)
    expect(finish(state, 5340).active).toHaveLength(0)
  })
  it('keeps the walk alive past a short bubble', () => {
    const state = ingest(baseline([]), [text(1)], agents, 0, true, false)
    attachWalk(state.active[0], 0, 4200, 2000)
    expect(finish(state, 4199).active).toHaveLength(1)
    expect(finish(state, 4200).active).toHaveLength(0)
  })
  it('honours an explicit bubble length and survives ingest while live, not after', () => {
    const state = ingest(baseline([]), [text(1)], agents, 0, true, false)
    state.active[0].bubbleMs = 7000
    expect(ingest(state, [state.active[0].message], agents, 6999, true, false).active).toHaveLength(1)
    expect(ingest(state, [state.active[0].message], agents, 7000, true, false).active).toHaveLength(0)
  })
  it('shows the newest bubble per recipient, at most three, only inside the bubble window', () => {
    const a = message(); const b = message(); const c: AgentMessage = { ...message(), from: 'b', to: 'a' }
    const state = ingest(baseline([]), [a, b, c], agents, 0, true, false)
    state.active[0].bubbleStart = 500
    state.active[1].bubbleStart = 900
    state.active[2].bubbleStart = 0
    expect(activeBubbles(state, 100).map(d => d.message)).toEqual([c])
    expect(activeBubbles(state, 1000).map(d => d.message).sort()).toEqual([b, c].sort())
    expect(activeBubbles(state, 1000).find(d => d.message.to === 'b')).toBe(state.active[1])
    expect(activeBubbles(state, 60000)).toHaveLength(0)
  })
  it('lists talkers during the outbound walk, or 10 ticks with no walk', () => {
    const state = ingest(baseline([]), [message()], agents, 0, true, false)
    expect([...activeTalkers(state, 1199)]).toEqual(['a'])
    expect([...activeTalkers(state, 1200)]).toEqual([])
    attachWalk(state.active[0], 0, 1200, 600)
    expect([...activeTalkers(state, 599)]).toEqual(['a'])
    expect([...activeTalkers(state, 600)]).toEqual([])
  })
  it('promoted queued deliveries start a fresh lifetime', () => {
    const all = Array.from({ length: 4 }, () => text(1))
    const state = ingest(baseline([]), all, agents, 0, true, false)
    const next = finish(state, 2000)
    expect(next.active).toHaveLength(1)
    expect(deliveryEnd(next.active[0])).toBe(2000 + 1545)
  })
})

describe('no replay of old messages', () => {
  it('a hidden scene consumes messages, and resuming shows nothing', () => {
    const old = message(); const during = message()
    const hidden = ingest(baseline([old]), [old, during], agents, 5, false, false)
    expect(hidden.active).toHaveLength(0)
    const resumed = ingest(baseline([old, during]), [old, during], agents, 6, true, false)
    expect(resumed.active).toHaveLength(0)
    expect(ingest(hidden, [old, during], agents, 6, true, false).active).toHaveLength(0)
  })
  it('a hidden gap drops live deliveries and queue, then only genuinely new messages play', () => {
    const live = ingest(baseline([]), Array.from({ length: 6 }, message), agents, 0, true, false)
    const hidden = ingest(live, live.seen, agents, 1, false, false)
    expect(hidden.active).toHaveLength(0); expect(hidden.queued).toHaveLength(0)
    const fresh = message()
    expect(ingest(hidden, [...live.seen, fresh], agents, 2, true, false).active.map(d => d.message)).toEqual([fresh])
  })
  it('a run switch is a fresh baseline: the new run history never plays, the next message does', () => {
    const history = [message(), message()]
    const switched = baseline(history)
    expect(ingest(switched, history, agents, 0, true, false).active).toHaveLength(0)
    const fresh = message()
    expect(ingest(switched, [...history, fresh], agents, 1, true, false).active.map(d => d.message)).toEqual([fresh])
  })
})
