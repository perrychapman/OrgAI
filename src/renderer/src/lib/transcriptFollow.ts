/** Follow decisions for the transcript (docs/design/motion.md 3.11). Pure; the DOM side is `useTranscriptFollow`. */

/** Distance from the end of a list under which it still counts as scrolled to the end. */
export const STICK_PX = 48

/** Quiet time after a user scroll during which a follow jumps instead of gliding (the user is still moving the list). */
export const FOLLOW_USER_SCROLL_QUIET_MS = 300

/**
 * How long a released list stays where the user left it. Content that arrives inside this window never moves the
 * viewport; the first row or streamed text after it glides the list back to the end and following resumes.
 */
export const FOLLOW_RESUME_IDLE_MS = 10_000

/** After a list opens (run, agent or tab switch, shown again) layout may still grow; the end is pinned instantly meanwhile. */
export const FOLLOW_SETTLE_MS = 800

/** The glide to the end settles in about this long (`--dur-base`); the time constant of the ease is a third of it. */
export const FOLLOW_EASE_MS = 160

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

/** Distance still to scroll to reach the end of a scroller. */
export function distanceFromEnd(m: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight
}

export interface ScrollEventInput {
  following: boolean
  /** The scroll came from a wheel, touch, key or scrollbar gesture (not from a layout change or the follow itself). */
  user: boolean
  /** scrollTop before and after this event. */
  prevTop: number
  top: number
  /** Distance from the end after the event. */
  distance: number
}

/**
 * Whether the list is following after a scroll event. A user scroll up releases at once, however small (a short wheel
 * notch inside STICK_PX must not be undone by the next token); a user scroll down re-follows once within STICK_PX of the
 * end. A scroll the user did not cause only ever re-follows when the list sits at the very end.
 */
export function nextFollowing(i: ScrollEventInput): boolean {
  if (i.user) {
    if (i.top < i.prevTop) return false
    if (i.top > i.prevTop && i.distance <= STICK_PX) return true
    return i.following
  }
  return i.distance <= 1 ? true : i.following
}

export interface FollowDecisionInput {
  following: boolean
  now: number
  /** When the user last scrolled this list (wheel, touch, key, scrollbar, or a position the app put them at). */
  lastUserAt: number
  reducedMotion: boolean
  /** Distance still to scroll to reach the end, in px. */
  delta: number
  viewportHeight: number
}

export interface FollowDecision {
  /** The follow state after this decision. */
  following: boolean
  /** How to move: not at all, straight to the end, or glide there. */
  move: 'none' | 'instant' | 'smooth'
}

/**
 * New content (a row, streamed text) arrived. Following lists keep the end in view; a released list holds still until
 * FOLLOW_RESUME_IDLE_MS have passed since the user's last scroll, then returns to the end (instantly under reduced
 * motion) and follows again. Nothing happens when the idle time runs out on its own, only when content arrives.
 */
export function followDecision(i: FollowDecisionInput): FollowDecision {
  if (i.following) {
    if (i.delta <= 0) return { following: true, move: 'none' }
    const behavior = followBehavior({ delta: i.delta, viewportHeight: i.viewportHeight, sinceUserScrollMs: i.now - i.lastUserAt, reducedMotion: i.reducedMotion })
    return { following: true, move: behavior === 'smooth' ? 'smooth' : 'instant' }
  }
  if (i.now - i.lastUserAt < FOLLOW_RESUME_IDLE_MS) return { following: false, move: 'none' }
  if (i.delta <= 0) return { following: true, move: 'none' }
  return { following: true, move: i.reducedMotion ? 'instant' : 'smooth' }
}

/**
 * The next frame of the glide: a share of what is left (frame-rate independent), at least 1 px so it finishes, never more
 * than what is left. One glide tracks a moving end, so streaming growth never restarts it.
 */
export function easeStep(remaining: number, dtMs: number): number {
  if (remaining <= 0) return 0
  const share = 1 - Math.exp(-Math.max(0, dtMs) / (FOLLOW_EASE_MS / 3))
  return Math.min(remaining, Math.max(1, remaining * share))
}

/** Keys that scroll a focused list: whether they go up (release at once) or down. Space and arrows only on the list itself. */
export function scrollKeyDirection(key: string): 'up' | 'down' | null {
  if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') return 'up'
  if (key === 'ArrowDown' || key === 'PageDown' || key === 'End' || key === ' ') return 'down'
  return null
}
