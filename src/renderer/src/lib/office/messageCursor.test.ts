import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/types'
import { consumeSceneMessages, recentMessages } from './messageCursor'

const message = (): AgentMessage => ({ from: 'a', to: 'b', toHandle: 'b', text: 'A real message', at: 1 })
describe('run-scoped office message baseline', () => {
  it('does not replay prefilled cross-floor history on a same-geometry run change, then consumes a new occurrence', () => {
    const old = message(); const history = message()
    const next = consumeSceneMessages({ runId: 'old', seen: [old] }, 'new', [history])
    expect(next.reset).toBe(true)
    expect(next.fresh).toEqual([])
    const fresh = message()
    expect(consumeSceneMessages(next.cursor, 'new', [history, fresh]).fresh).toEqual([fresh])
  })
  it('resets even when the new run has the same or empty history reference', () => {
    const history = [message()]
    expect(consumeSceneMessages({ runId: 'old', seen: history }, 'new', history).reset).toBe(true)
    expect(consumeSceneMessages({ runId: 'old', seen: [] }, 'new', []).fresh).toEqual([])
  })
  it('does not replay what was consumed while hidden or paused when the scene resumes', () => {
    const a = message(); const b = message(); const c = message()
    const hidden = consumeSceneMessages({ runId: 'r', seen: [a] }, 'r', [a, b, c])
    expect(hidden.fresh).toEqual([b, c])
    expect(consumeSceneMessages(hidden.cursor, 'r', [a, b, c]).fresh).toEqual([])
    const d = message()
    expect(consumeSceneMessages(hidden.cursor, 'r', [a, b, c, d]).fresh).toEqual([d])
  })
  it('a new run with a retained history window replays nothing and a rolled window yields only the new tail', () => {
    const history = Array.from({ length: 100 }, message)
    const switched = consumeSceneMessages({ runId: 'a', seen: [] }, 'b', history)
    expect(switched.fresh).toEqual([])
    const tail = message()
    expect(consumeSceneMessages(switched.cursor, 'b', [...history.slice(1), tail]).fresh).toEqual([tail])
  })
})

describe('recentMessages', () => {
  const at = (n: number): AgentMessage => ({ from: 'a', to: 'b', toHandle: 'b', text: `m${n}`, at: n })
  it('returns the last three of this run newest first, independent of active deliveries', () => {
    const all = [1, 2, 3, 4, 5].map(at)
    expect(recentMessages(all).map(m => m.at)).toEqual([5, 4, 3])
    expect(recentMessages(all, 2).map(m => m.at)).toEqual([5, 4])
    expect(recentMessages(all, 10).map(m => m.at)).toEqual([5, 4, 3, 2, 1])
  })
  it('handles empty input, non-positive counts and does not mutate', () => {
    const all = [at(1), at(2)]
    expect(recentMessages([])).toEqual([])
    expect(recentMessages(all, 0)).toEqual([])
    recentMessages(all)
    expect(all.map(m => m.at)).toEqual([1, 2])
  })
})
