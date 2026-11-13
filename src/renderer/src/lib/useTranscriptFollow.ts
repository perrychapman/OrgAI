import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  FOLLOW_SETTLE_MS,
  distanceFromEnd,
  easeStep,
  followBehavior,
  followDecision,
  nextFollowing,
  scrollKeyDirection
} from './transcriptFollow'

/** How long after a wheel, touch or key event a scroll event still counts as the user's (smooth key scrolling lags the key). */
const GESTURE_MS = 500

export interface TranscriptFollowOptions {
  /** Finds the scrolling element; null while it is not mounted (its tab is closed). */
  find: () => HTMLElement | null
  /** Changes when `find` returns another element or a mounted one starts to show something else (tab, variant). */
  attachKey: string
  /** Changes when the list shows another run or agent: it opens at its end again. */
  resetKey: string
  /** Changes when content arrives at the end (a row, streamed text). Never changes for rows prepended above. */
  contentKey: string
  reducedMotion: boolean
}

export interface TranscriptFollow {
  /** The list is not following: show "Jump to latest". */
  away: boolean
  /** Whether the list follows its end right now (read in render for arrival cues). */
  isFollowing: () => boolean
  /** "Jump to latest": follow again and go to the end. */
  jumpToEnd: () => void
  /** The app moved the list on purpose (chain focus, rows prepended above): hold still like after a user scroll. */
  holdHere: () => void
}

interface State {
  el: HTMLElement | null
  following: boolean
  lastUserAt: number
  lastTop: number
  /** The scrollTop the follow itself wrote last; its scroll event is not the user's. */
  setTop: number
  gestureUntil: number
  pointerHeld: boolean
  settleUntil: number
  shown: boolean
  touchY: number
  raf: number
  rafLast: number
}

/**
 * Keeps a scrolling list at its end while the user does not scroll (docs/design/motion.md 3.11).
 *
 * - The list opens at its end, instantly, whenever it is attached, shown again after being hidden, or `resetKey` changes;
 *   layout that finishes a moment later (images, Markdown) is pinned instantly for FOLLOW_SETTLE_MS.
 * - A wheel, touch, key or scrollbar scroll away from the end releases the follow at once. Content arriving within
 *   FOLLOW_RESUME_IDLE_MS of the last user scroll never moves the list; the first content after that glides back to the
 *   end (instantly under reduced motion). Scrolling back to the end or "Jump to latest" follows again immediately.
 * - While following, one resize-driven glide tracks the end: growth during streaming extends it instead of restarting it.
 * - The follow's own scrolls are recognised by position and never read as the user leaving the end.
 */
export function useTranscriptFollow(opts: TranscriptFollowOptions): TranscriptFollow {
  const [away, setAway] = useState(false)
  const s = useRef<State>({ el: null, following: true, lastUserAt: -Infinity, lastTop: 0, setTop: -1, gestureUntil: 0, pointerHeld: false, settleUntil: 0, shown: false, touchY: 0, raf: 0, rafLast: 0 })
  const o = useRef(opts)
  o.current = opts
  const rendered = useRef<{ observe: (() => void) | null }>({ observe: null })

  const setFollowing = useCallback((value: boolean): void => {
    s.current.following = value
    setAway(!value)
  }, [])

  const stopGlide = useCallback((): void => {
    const st = s.current
    if (st.raf) cancelAnimationFrame(st.raf)
    st.raf = 0
  }, [])

  const write = useCallback((el: HTMLElement, top: number): void => {
    const st = s.current
    el.scrollTop = top
    st.setTop = el.scrollTop
    st.lastTop = el.scrollTop
  }, [])

  const toEnd = useCallback(
    (mode: 'instant' | 'smooth'): void => {
      const st = s.current
      const el = st.el
      if (!el || el.clientHeight === 0) return
      const end = (): number => Math.max(0, el.scrollHeight - el.clientHeight)
      if (mode === 'instant') {
        stopGlide()
        write(el, end())
        return
      }
      if (st.raf) return // gliding already: every frame reads the end afresh
      st.rafLast = performance.now()
      const frame = (t: number): void => {
        st.raf = 0
        if (st.el !== el || !st.following) return
        const remaining = end() - el.scrollTop
        if (remaining <= 0.5) {
          if (remaining > 0) write(el, end())
          return
        }
        const dt = Math.min(64, t - st.rafLast)
        st.rafLast = t
        write(el, el.scrollTop + easeStep(remaining, dt))
        st.raf = requestAnimationFrame(frame)
      }
      st.raf = requestAnimationFrame(frame)
    },
    [stopGlide, write]
  )

  /** Open at the end, following, with no memory of an earlier user scroll. */
  const reset = useCallback((): void => {
    const st = s.current
    stopGlide()
    st.lastUserAt = -Infinity
    st.settleUntil = Date.now() + FOLLOW_SETTLE_MS
    setFollowing(true)
    if (st.el && st.el.clientHeight > 0) write(st.el, Math.max(0, st.el.scrollHeight - st.el.clientHeight))
  }, [setFollowing, stopGlide, write])

  /** The user (or the app on their behalf) moved the list: stamp it and stop any glide. */
  const stamp = useCallback((): void => {
    const st = s.current
    const now = Date.now()
    st.lastUserAt = now
    st.gestureUntil = now + GESTURE_MS
    st.setTop = -1
    stopGlide()
  }, [stopGlide])

  const release = useCallback((): void => {
    if (s.current.following) setFollowing(false)
  }, [setFollowing])

  /** Content arrived (a row, streamed text): may resume a released list after the idle time. */
  const onContent = useCallback((): void => {
    const st = s.current
    const el = st.el
    if (!el || el.clientHeight === 0) return
    const d = followDecision({ following: st.following, now: Date.now(), lastUserAt: st.lastUserAt, reducedMotion: o.current.reducedMotion, delta: distanceFromEnd(el), viewportHeight: el.clientHeight })
    if (d.following !== st.following) setFollowing(d.following)
    if (d.move !== 'none') toEnd(Date.now() < st.settleUntil ? 'instant' : d.move)
  }, [setFollowing, toEnd])

  // Attach to the scroller: listeners, and a size observer that pins layout growth while following and notices the list being shown.
  useLayoutEffect(() => {
    const st = s.current
    const el = o.current.find()
    st.el = el
    if (!el) return undefined
    st.shown = el.clientHeight > 0
    st.lastTop = el.scrollTop
    reset()

    const onWheel = (e: WheelEvent): void => {
      stamp()
      if (e.deltaY < 0 && el.scrollTop > 0) release()
    }
    const onTouchStart = (e: TouchEvent): void => {
      st.touchY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? st.touchY
      const down = y > st.touchY // the finger moves down: the content goes up
      st.touchY = y
      stamp()
      if (down && el.scrollTop > 0) release()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.target !== el || e.ctrlKey || e.altKey || e.metaKey) return
      const dir = scrollKeyDirection(e.key)
      if (!dir) return
      stamp()
      if (dir === 'up' && el.scrollTop > 0) release()
    }
    const onPointerDown = (e: PointerEvent): void => {
      // A press on the scrollbar (the area right of the content box) starts a drag; presses on content are not scrolls.
      if (e.target === el && e.clientX > el.getBoundingClientRect().left + el.clientWidth) {
        st.pointerHeld = true
        stamp()
        const up = (): void => {
          st.pointerHeld = false
          window.removeEventListener('pointerup', up, true)
          window.removeEventListener('pointercancel', up, true)
        }
        window.addEventListener('pointerup', up, true)
        window.addEventListener('pointercancel', up, true)
        return
      }
      // Opening a disclosure grows the list under the reader: hold still instead of chasing the end.
      if (e.target instanceof Element && e.target.closest('summary')) {
        stamp()
        release()
      }
    }
    const onScroll = (): void => {
      const top = el.scrollTop
      const now = Date.now()
      const user = now <= st.gestureUntil || st.pointerHeld
      // A scroll the follow wrote itself (same position) is neither a user scroll nor a reason to change the follow state.
      if (!user && Math.abs(top - st.setTop) <= 1.5) {
        st.lastTop = top
        return
      }
      if (user) st.lastUserAt = now
      const next = nextFollowing({ following: st.following, user, prevTop: st.lastTop, top, distance: distanceFromEnd(el) })
      st.lastTop = top
      if (next !== st.following) setFollowing(next)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('scroll', onScroll, { passive: true })

    const observed = new Set<Element>()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nowShown = el.clientHeight > 0
      if (nowShown && !st.shown) {
        // Shown again after a hidden tab or a collapsed panel: open at the end.
        st.shown = true
        reset()
        return
      }
      st.shown = nowShown
      if (nowShown && st.following) onContent()
    })
    const observe = (): void => {
      if (!ro) return
      const now = new Set<Element>([el, ...Array.from(el.children)])
      for (const c of now) if (!observed.has(c)) { ro.observe(c); observed.add(c) }
      for (const c of observed) if (!now.has(c)) { ro.unobserve(c); observed.delete(c) }
    }
    observe()
    rendered.current.observe = observe
    return () => {
      rendered.current.observe = null
      ro?.disconnect()
      stopGlide()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('scroll', onScroll)
      st.pointerHeld = false
      st.el = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.attachKey])

  // Another run or agent in the same list: open at its end.
  useLayoutEffect(() => {
    reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.resetKey])

  // New content at the end; rows may have been added or removed, so the observed children are synced first.
  useLayoutEffect(() => {
    rendered.current.observe?.()
    onContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.contentKey])

  const jumpToEnd = useCallback((): void => {
    const st = s.current
    const el = st.el
    if (!el) return
    setFollowing(true)
    const behavior = followBehavior({ delta: distanceFromEnd(el), viewportHeight: el.clientHeight, sinceUserScrollMs: Infinity, reducedMotion: o.current.reducedMotion })
    toEnd(behavior === 'smooth' ? 'smooth' : 'instant')
  }, [setFollowing, toEnd])

  const holdHere = useCallback((): void => {
    const st = s.current
    st.lastUserAt = Date.now()
    stopGlide()
    release()
  }, [release, stopGlide])

  const isFollowing = useCallback((): boolean => s.current.following, [])
  return { away, isFollowing, jumpToEnd, holdHere }
}
