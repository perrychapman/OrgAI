/** Smooth-follow decision for the transcript (docs/design/motion.md 3.11). Pure. */
export const FOLLOW_USER_SCROLL_QUIET_MS = 300

export interface FollowInput {
  /** Distance still to scroll to reach the end, in px. */
  delta: number
  viewportHeight: number
  /** Milliseconds since the user last scrolled this list. */
  sinceUserScrollMs: number
  reducedMotion: boolean
}

/** Smooth only for a short hop (under one viewport) while the user is not scrolling; instant otherwise and under reduced motion. */
export function followBehavior(i: FollowInput): ScrollBehavior {
  if (i.reducedMotion) return 'auto'
  if (i.delta <= 0 || i.delta >= i.viewportHeight) return 'auto'
  if (i.sinceUserScrollMs < FOLLOW_USER_SCROLL_QUIET_MS) return 'auto'
  return 'smooth'
}

/** The class a freshly appended row carries. */
export function arriveClass(arrive: boolean | undefined): string {
  return arrive ? ' transcript-arrive' : ''
}
