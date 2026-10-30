import { describe, expect, it } from 'vitest'
import { mergeById, mergePendingCards } from './pendingCards'

describe('pendingCards', () => {
  it('keeps held cards and appends only unseen ids', () => {
    const held = [{ id: 'a', v: 1 }]
    expect(mergeById(held, [{ id: 'a', v: 2 }, { id: 'b', v: 3 }])).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 3 }])
  })
  it('returns the same array when nothing is new', () => {
    const held = [{ id: 'a' }]
    expect(mergeById(held, [{ id: 'a' }])).toBe(held)
    expect(mergeById(held, undefined)).toBe(held)
  })
  it('seeds every card kind, tolerating absent held arrays', () => {
    const out = mergePendingCards({ permissions: [], proposals: [] }, { questions: [{ id: 'q' }] as never, mcpInstalls: [{ id: 'm' }] as never })
    expect(out.questions).toHaveLength(1)
    expect(out.mcpInstalls).toHaveLength(1)
    expect(out.permissions).toEqual([])
  })
})
