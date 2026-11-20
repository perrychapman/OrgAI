import { beforeEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_LOSS_WINDOW_MS,
  FACTORY_RENDERER_KEY,
  cachedWebGL2Probe,
  probeWebGL2,
  readForcedRenderer,
  recordContextLoss,
  resetWebGL2Probe,
  type ProbeCanvas
} from './capability'

interface Call {
  strict: boolean
}

/** A canvas factory whose contexts appear per attempt: `answers[i]` is true when attempt i yields a context. */
function fakeCanvases(answers: boolean[]): { create: () => ProbeCanvas; calls: Call[]; released: number; created: number } {
  const state = { calls: [] as Call[], released: 0, created: 0 }
  const create = (): ProbeCanvas => {
    state.created++
    return {
      getContext: (_id, options) => {
        const i = state.calls.length
        state.calls.push({ strict: options?.failIfMajorPerformanceCaveat === true })
        if (!answers[i]) return null
        return {
          getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => state.released++ } : null)
        }
      }
    }
  }
  return {
    create,
    get calls() {
      return state.calls
    },
    get released() {
      return state.released
    },
    get created() {
      return state.created
    }
  }
}

describe('probeWebGL2', () => {
  it('reports hardware WebGL2 at high quality after one strict attempt, and releases the context', () => {
    const f = fakeCanvases([true])
    expect(probeWebGL2(f.create)).toEqual({ ok: true, software: false, quality: 'high' })
    expect(f.calls).toEqual([{ strict: true }])
    expect(f.released).toBe(1)
  })

  it('falls back to a context without the caveat flag as software at minimal quality', () => {
    const f = fakeCanvases([false, true])
    expect(probeWebGL2(f.create)).toEqual({ ok: true, software: true, quality: 'minimal' })
    expect(f.calls).toEqual([{ strict: true }, { strict: false }])
    expect(f.created).toBe(2)
    expect(f.released).toBe(1)
  })

  it('reports no WebGL2 when both attempts return null', () => {
    const f = fakeCanvases([false, false])
    expect(probeWebGL2(f.create).ok).toBe(false)
    expect(f.released).toBe(0)
  })

  it('treats a throwing getContext or canvas factory as no context', () => {
    expect(probeWebGL2(() => ({ getContext: () => { throw new Error('boom') } })).ok).toBe(false)
    expect(probeWebGL2(() => { throw new Error('no canvas') }).ok).toBe(false)
  })

  it('survives a context without WEBGL_lose_context', () => {
    expect(probeWebGL2(() => ({ getContext: () => ({ getExtension: () => null }) })).ok).toBe(true)
  })
})

describe('cachedWebGL2Probe', () => {
  beforeEach(() => resetWebGL2Probe())

  it('probes once per session until reset', () => {
    const f = fakeCanvases([true, true, true])
    cachedWebGL2Probe(f.create)
    cachedWebGL2Probe(f.create)
    expect(f.calls.length).toBe(1)
    resetWebGL2Probe()
    cachedWebGL2Probe(f.create)
    expect(f.calls.length).toBe(2)
  })
})

describe('readForcedRenderer', () => {
  it('reads the three developer values and nothing else', () => {
    const store = (v: string | null) => (k: string) => (k === FACTORY_RENDERER_KEY ? v : null)
    expect(readForcedRenderer(store('floor-plan'))).toBe('floor-plan')
    expect(readForcedRenderer(store('no-webgl2'))).toBe('no-webgl2')
    expect(readForcedRenderer(store('chunk-failed'))).toBe('chunk-failed')
    expect(readForcedRenderer(store('webgl2'))).toBeNull()
    expect(readForcedRenderer(store(null))).toBeNull()
    expect(readForcedRenderer(null)).toBeNull()
    expect(readForcedRenderer(() => { throw new Error('denied') })).toBeNull()
  })
})

describe('recordContextLoss', () => {
  it('flags the third loss within ten minutes', () => {
    let h: number[] = []
    let r = recordContextLoss(h, 0)
    expect(r.third).toBe(false)
    h = r.history
    r = recordContextLoss(h, 60_000)
    expect(r.third).toBe(false)
    h = r.history
    r = recordContextLoss(h, 120_000)
    expect(r.third).toBe(true)
  })

  it('forgets losses older than the window', () => {
    const r = recordContextLoss([0, 1_000], CONTEXT_LOSS_WINDOW_MS + 1_000)
    expect(r.history).toEqual([CONTEXT_LOSS_WINDOW_MS + 1_000])
    expect(r.third).toBe(false)
  })

  it('does not mutate the given history', () => {
    const h = [5]
    recordContextLoss(h, 10)
    expect(h).toEqual([5])
  })
})
