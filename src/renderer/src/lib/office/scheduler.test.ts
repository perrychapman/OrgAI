import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/types'
import { baseline, finish, ingest, MAX_AGE } from './scheduler'

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
})
