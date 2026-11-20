// Quality steps (docs/design/factory-floor.md section 9.2): high -> low -> minimal, one way per mount. Pure: no three,
// no DOM. The engine feeds it rAF frame intervals measured only while animating (cue, ambient or camera tween frames).
// Slice 6 contract committed by the UI Lead; the Scene Engineer implements the bodies and the tests.
import type { FactoryQuality } from './snapshot'

/** A step down happens when the frame interval p95 exceeds this over a full window of animation. */
export const QUALITY_STEP_P95_MS = 24
/** Length of animation (sum of intervals) that one decision looks at. */
export const QUALITY_WINDOW_MS = 2000

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

export function createQualityGovernor(start: FactoryQuality): QualityGovernor {
  void start
  throw new Error('createQualityGovernor: not implemented (slice 6a)')
}
