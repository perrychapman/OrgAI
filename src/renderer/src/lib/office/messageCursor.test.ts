import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/types'
import { consumeSceneMessages } from './messageCursor'

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
})
