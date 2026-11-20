import { describe, expect, it } from 'vitest'
import {
  QUALITY_MAX_INTERVAL_MS,
  QUALITY_STEP_P95_MS,
  QUALITY_WINDOW_MS,
  createQualityGovernor,
  lowerQuality,
  qualitySettings,
  shadowMapBytes,
  textureBytes,
  type QualityGovernor
} from './quality'
import type { FactoryQuality } from './snapshot'

/** Pushes `n` intervals of `ms` and returns every non-null step in order. */
function feed(g: QualityGovernor, ms: number, n: number): FactoryQuality[] {
  const steps: FactoryQuality[] = []
  for (let i = 0; i < n; i++) {
    const s = g.push(ms)
    if (s) steps.push(s)
  }
  return steps
}

describe('lowerQuality', () => {
  it('steps high to low to minimal and never up', () => {
    expect(lowerQuality('high')).toBe('low')
    expect(lowerQuality('low')).toBe('minimal')
    expect(lowerQuality('minimal')).toBeNull()
  })
})

describe('createQualityGovernor', () => {
  it('starts at the given quality', () => {
    expect(createQualityGovernor('high').quality).toBe('high')
    expect(createQualityGovernor('low').quality).toBe('low')
    expect(createQualityGovernor('minimal').quality).toBe('minimal')
  })

  it('never steps on a steady 60 Hz series, however long', () => {
    const g = createQualityGovernor('high')
    expect(feed(g, 16.7, 2000)).toEqual([])
    expect(g.quality).toBe('high')
  })

  it('waits for a full window of animation before deciding', () => {
    const g = createQualityGovernor('high')
    // 40 ms frames: 49 of them are 1960 ms, one short of the window.
    expect(feed(g, 40, 49)).toEqual([])
    expect(g.quality).toBe('high')
    // The 50th completes 2000 ms with p95 40 > 24: one step.
    expect(g.push(40)).toBe('low')
    expect(g.quality).toBe('low')
  })

  it('restarts the window after a step, then steps to minimal on a second full slow window', () => {
    const g = createQualityGovernor('high')
    expect(feed(g, 40, 50)).toEqual(['low'])
    // The window starts over: another 49 slow frames are not enough.
    expect(feed(g, 40, 49)).toEqual([])
    expect(g.push(40)).toBe('minimal')
    // Minimal is the floor: nothing more, ever.
    expect(feed(g, 200, 500)).toEqual([])
    expect(g.quality).toBe('minimal')
  })

  it('steps only when the p95 is over the threshold, not the mean', () => {
    // About 115 frames per 2 s at 16.7 ms; 2 % long frames (even very long ones) stay above rank 95.
    const g = createQualityGovernor('high')
    const series: number[] = []
    for (let i = 0; i < 400; i++) series.push(i % 50 === 49 ? 200 : 16.7)
    expect(series.map((ms) => g.push(ms)).filter(Boolean)).toEqual([])
    // 10 % long frames do.
    const h = createQualityGovernor('high')
    const slow: number[] = []
    for (let i = 0; i < 400; i++) slow.push(i % 10 === 9 ? 40 : 16.7)
    expect(slow.map((ms) => h.push(ms)).filter(Boolean)).toEqual(['low', 'minimal'])
  })

  it('treats exactly the threshold as fine', () => {
    const g = createQualityGovernor('high')
    expect(feed(g, QUALITY_STEP_P95_MS, 500)).toEqual([])
  })

  it('ignores intervals over 250 ms (hidden or paused stretches) and nonsense values', () => {
    const g = createQualityGovernor('high')
    expect(feed(g, QUALITY_MAX_INTERVAL_MS + 1, 100)).toEqual([])
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(g.push(v)).toBeNull()
    // None of them counted towards the window: a full slow window is still needed.
    expect(feed(g, 40, 49)).toEqual([])
    expect(g.push(40)).toBe('low')
  })

  it('a short hitch inside smooth animation never steps (a few long frames per 2 s window)', () => {
    const g = createQualityGovernor('high')
    expect(feed(g, 16.7, 200)).toEqual([])
    expect(feed(g, 60, 3)).toEqual([])
    expect(feed(g, 16.7, 200)).toEqual([])
    expect(feed(g, 60, 3)).toEqual([])
    expect(feed(g, 16.7, 200)).toEqual([])
    expect(g.quality).toBe('high')
  })

  it('slides: a slow stretch that fills most of a window steps even when smooth frames complete it', () => {
    const g = createQualityGovernor('high')
    // 1.5 s of 50 ms frames, then smooth frames: the first full window is half slow.
    expect(feed(g, 50, 30)).toEqual([])
    expect(feed(g, 16.7, 40)).toEqual(['low'])
  })

  it('a governor that starts at minimal (software WebGL) never steps', () => {
    const g = createQualityGovernor('minimal')
    expect(feed(g, 100, 200)).toEqual([])
  })

  it('a governor that starts at low steps once, to minimal', () => {
    const g = createQualityGovernor('low')
    expect(feed(g, 30, Math.ceil(QUALITY_WINDOW_MS / 30) + 10)).toEqual(['minimal'])
  })
})

describe('qualitySettings', () => {
  it('follows sections 9.1 and 9.2', () => {
    expect(qualitySettings('high', 2)).toEqual({ pixelRatio: 1.5, shadowMapSize: 2048, farLodOnly: false })
    expect(qualitySettings('high', 1)).toEqual({ pixelRatio: 1, shadowMapSize: 2048, farLodOnly: false })
    expect(qualitySettings('high', 1.25).pixelRatio).toBe(1.25)
    expect(qualitySettings('low', 2)).toEqual({ pixelRatio: 1, shadowMapSize: 1024, farLodOnly: false })
    expect(qualitySettings('minimal', 2)).toEqual({ pixelRatio: 1, shadowMapSize: 0, farLodOnly: true })
    expect(qualitySettings('high', Number.NaN).pixelRatio).toBe(1)
  })
})

describe('memory sums', () => {
  it('counts the 2048 shadow map as 16 MB and no shadows as 0', () => {
    expect(shadowMapBytes(2048)).toBe(16 * 1024 * 1024)
    expect(shadowMapBytes(1024)).toBe(4 * 1024 * 1024)
    expect(shadowMapBytes(0)).toBe(0)
  })

  it('adds a third for a mip chain', () => {
    expect(textureBytes(64 * 64 * 4, false)).toBe(16384)
    expect(textureBytes(64 * 64 * 4, true)).toBe(21845)
    expect(textureBytes(0, true)).toBe(0)
  })
})
