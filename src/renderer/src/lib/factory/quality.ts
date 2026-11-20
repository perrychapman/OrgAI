// Quality steps (docs/design/factory-floor.md section 9.2): high -> low -> minimal, one way per mount. Pure: no three,
// no DOM. The engine feeds it rAF frame intervals measured only while animating (cue, ambient or camera tween frames).
// Slice 6 contract committed by the UI Lead; bodies, the settings table and the memory sums by the Scene Engineer (6a).
import { p95, type FactoryQuality } from './snapshot'

/** A step down happens when the frame interval p95 exceeds this over a full window of animation. */
export const QUALITY_STEP_P95_MS = 24
/** Length of animation (sum of intervals) that one decision looks at. */
export const QUALITY_WINDOW_MS = 2000
/** Longer intervals are a paused, hidden or idle stretch, not a slow frame: ignored. */
export const QUALITY_MAX_INTERVAL_MS = 250

/** The next quality after `current`, or null at minimal. Never steps up. */
export function lowerQuality(current: FactoryQuality): FactoryQuality | null {
  return current === 'high' ? 'low' : current === 'low' ? 'minimal' : null
}

/**
 * Watches animation frame intervals. `push(intervalMs)` returns the quality to step down to once a full window's p95 is
 * over the threshold, else null; after a step the window starts over. Intervals longer than 250 ms (a paused or hidden
 * stretch) are ignored.
 */
export interface QualityGovernor {
  readonly quality: FactoryQuality
  push(intervalMs: number): FactoryQuality | null
}

/**
 * A sliding window over the last QUALITY_WINDOW_MS of animation: once the intervals in it add up to the window, every
 * push looks at their p95 (nearest rank); over QUALITY_STEP_P95_MS steps down one level and empties the window, so the
 * next step needs a whole new window at the new quality. Non-finite, zero and negative intervals are ignored like long
 * ones. At minimal nothing is kept.
 */
export function createQualityGovernor(start: FactoryQuality): QualityGovernor {
  let quality = start
  let window: number[] = []
  let sum = 0
  return {
    get quality() {
      return quality
    },
    push(intervalMs: number): FactoryQuality | null {
      if (quality === 'minimal') return null
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > QUALITY_MAX_INTERVAL_MS) return null
      window.push(intervalMs)
      sum += intervalMs
      // Keep exactly the newest stretch that still covers the window.
      while (window.length > 1 && sum - window[0] >= QUALITY_WINDOW_MS) sum -= window.shift()!
      if (sum < QUALITY_WINDOW_MS) return null
      if (p95(window) <= QUALITY_STEP_P95_MS) return null
      const next = lowerQuality(quality)
      window = []
      sum = 0
      if (!next) return null
      quality = next
      return next
    }
  }
}

/** What one quality level means for the renderer (section 9.1 and 9.2). */
export interface QualitySettings {
  /** Device pixel ratio cap: min(dpr, 1.5) at high, 1 below. */
  pixelRatio: number
  /** Key light shadow map edge in pixels; 0 means shadows off. */
  shadowMapSize: number
  /** Draw the far level of detail at every zoom. */
  farLodOnly: boolean
}

export const HIGH_DPR_CAP = 1.5

export function qualitySettings(quality: FactoryQuality, devicePixelRatio: number): QualitySettings {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  if (quality === 'high') return { pixelRatio: Math.min(dpr, HIGH_DPR_CAP), shadowMapSize: 2048, farLodOnly: false }
  if (quality === 'low') return { pixelRatio: 1, shadowMapSize: 1024, farLodOnly: false }
  return { pixelRatio: 1, shadowMapSize: 0, farLodOnly: true }
}

/** Section 9.1's memory count for a shadow map: width x height x 4 bytes (2048 is 16 MB); 0 when shadows are off. */
export function shadowMapBytes(size: number): number {
  return size > 0 ? size * size * 4 : 0
}

/** Bytes of one RGBA8-style texture from its pixel data, plus a third for a full mip chain when mipmapped. */
export function textureBytes(dataBytes: number, mipmapped: boolean): number {
  if (!(dataBytes > 0)) return 0
  return mipmapped ? Math.round((dataBytes * 4) / 3) : dataBytes
}

/** Section 9.1 budget for texture and shadow memory. */
export const MEMORY_BUDGET_BYTES = 24 * 1024 * 1024
