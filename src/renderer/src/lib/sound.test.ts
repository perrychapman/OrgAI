import { describe, expect, it } from 'vitest'
import { CHIME_MIN_GAP_MS, chimeDecision, chimesPlayed, playChime, setAudioFactory } from './sound'

describe('chimeDecision', () => {
  it('never chimes on the first observation (decisions already waiting)', () => {
    const r = chimeDecision({ seen: null, lastAt: 0 }, ['a'], true, 10_000)
    expect(r.chime).toBe(false)
    expect([...r.next.seen!]).toEqual(['a'])
  })
  it('chimes for a new key when on, never when off', () => {
    const s = { seen: new Set(['a']), lastAt: 0 }
    expect(chimeDecision(s, ['a', 'b'], true, 10_000).chime).toBe(true)
    expect(chimeDecision(s, ['a', 'b'], false, 10_000).chime).toBe(false)
    expect(chimeDecision(s, ['a'], true, 10_000).chime).toBe(false)
    expect(chimeDecision(s, [], true, 10_000).chime).toBe(false)
  })
  it('is rate-limited', () => {
    const first = chimeDecision({ seen: new Set(['a']), lastAt: 0 }, ['a', 'b'], true, 10_000)
    expect(first.chime).toBe(true)
    const soon = chimeDecision(first.next, ['a', 'b', 'c'], true, 10_000 + CHIME_MIN_GAP_MS - 1)
    expect(soon.chime).toBe(false)
    expect(chimeDecision(soon.next, ['a', 'b', 'c', 'd'], true, 10_000 + CHIME_MIN_GAP_MS).chime).toBe(true)
  })
})

describe('playChime', () => {
  it('builds two notes on the injected AudioContext and never throws', () => {
    const made: string[] = []
    class FakeCtx {
      currentTime = 0
      destination = {}
      createOscillator(): unknown {
        made.push('osc')
        return { type: '', frequency: { value: 0 }, connect: () => undefined, start: () => undefined, stop: () => undefined }
      }
      createGain(): unknown {
        return { gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined }
      }
    }
    setAudioFactory(FakeCtx as unknown as typeof AudioContext)
    const before = chimesPlayed()
    playChime()
    expect(made).toEqual(['osc', 'osc'])
    expect(chimesPlayed()).toBe(before + 1)
    setAudioFactory(null)
  })
})
