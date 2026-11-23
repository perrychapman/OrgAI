import { describe, expect, it } from 'vitest'
import { CHIME_MIN_GAP_MS, EMPTY_CHIME, chimeDecision, chimesPlayed, playChime, setAudioFactory } from './sound'

const known = (keys: string[], runs = ['r1']): typeof EMPTY_CHIME => ({ seen: new Set(keys), runs: new Set(runs), lastAt: 0 })

describe('chimeDecision', () => {
  it('never chimes on the first observation (decisions already waiting)', () => {
    const r = chimeDecision(EMPTY_CHIME, [['r1', 'a']], ['r1'], true, 10_000)
    expect(r.chime).toBe(false)
    expect([...r.next.seen!]).toEqual(['a'])
  })
  it('chimes for a new key on a known run when on, never when off', () => {
    const s = known(['a'])
    expect(chimeDecision(s, [['r1', 'a'], ['r1', 'b']], ['r1'], true, 10_000).chime).toBe(true)
    expect(chimeDecision(s, [['r1', 'a'], ['r1', 'b']], ['r1'], false, 10_000).chime).toBe(false)
    expect(chimeDecision(s, [['r1', 'a']], ['r1'], true, 10_000).chime).toBe(false)
    expect(chimeDecision(s, [], ['r1'], true, 10_000).chime).toBe(false)
  })
  it('stays silent when a run loads with decisions already waiting (start, history)', () => {
    const s = known([], [])
    const hydrated = chimeDecision(s, [['r2', 'x']], ['r2'], true, 10_000)
    expect(hydrated.chime).toBe(false)
    expect(chimeDecision(hydrated.next, [['r2', 'x'], ['r2', 'y']], ['r2'], true, 20_000).chime).toBe(true)
  })
  it('is rate-limited', () => {
    const first = chimeDecision(known(['a']), [['r1', 'a'], ['r1', 'b']], ['r1'], true, 10_000)
    expect(first.chime).toBe(true)
    const soon = chimeDecision(first.next, [['r1', 'a'], ['r1', 'b'], ['r1', 'c']], ['r1'], true, 10_000 + CHIME_MIN_GAP_MS - 1)
    expect(soon.chime).toBe(false)
    expect(chimeDecision(soon.next, [['r1', 'a'], ['r1', 'b'], ['r1', 'c'], ['r1', 'd']], ['r1'], true, 10_000 + CHIME_MIN_GAP_MS).chime).toBe(true)
  })
})

describe('playChime', () => {
  it('builds two notes on the injected AudioContext and never throws', () => {
    const made: string[] = []
    class FakeCtx {
      currentTime = 0
      state = 'running'
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
