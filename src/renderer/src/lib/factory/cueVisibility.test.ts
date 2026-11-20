import { describe, expect, it } from 'vitest'
import { hiddenKey, hiddenStations } from './cueVisibility'

describe('hiddenStations', () => {
  it('hides the target of a tote in flight and a station whose arrive still waits', () => {
    const h = hiddenStations([
      { kind: 'tote', from: 'lead', to: 'w1', progress: 0.4 },
      { kind: 'arrive', from: 'w1', progress: 0 },
      { kind: 'arrive', from: 'w2', progress: 0 }
    ])
    expect([...h].sort()).toEqual(['w1', 'w2'])
  })

  it('shows a station again as soon as it starts to rise, even with a second tote flying to it', () => {
    const h = hiddenStations([
      { kind: 'tote', from: 'lead', to: 'w1', progress: 0.2 },
      { kind: 'arrive', from: 'w1', progress: 0.01 }
    ])
    expect(h.size).toBe(0)
  })

  it('ignores capsules, crates to the dock and other cues', () => {
    const h = hiddenStations([
      { kind: 'capsule', from: 'a', to: 'b', progress: 0.5 },
      { kind: 'crate', from: 'a', to: 'dock', progress: 0.5 },
      { kind: 'tote', from: 'a', to: 'dock', progress: 0.5 },
      { kind: 'tote', from: 'a', to: null, progress: 0.5 },
      { kind: 'part', from: 'a', progress: 0.5 },
      { kind: 'leave', from: 'c', progress: 0.5 }
    ])
    expect(h.size).toBe(0)
  })

  it('has an order-free key', () => {
    expect(hiddenKey(new Set(['b', 'a']))).toBe(hiddenKey(new Set(['a', 'b'])))
    expect(hiddenKey(new Set())).toBe('')
  })
})
