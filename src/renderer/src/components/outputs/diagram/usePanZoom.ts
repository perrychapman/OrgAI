// Pan and zoom state of one drawing (docs/design/outputs-2.md section 8.1). The maths is in lib/diagramView.ts.
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DRAG_SLOP,
  KEY_ZOOM_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  actualView,
  centerOnOverview,
  clampView,
  fitScale,
  fitView,
  panBy,
  viewKey,
  wheelFactor,
  zoomAt,
  zoomSpeech,
  type Box,
  type Point,
  type Size,
  type View,
  type ViewKey
} from '../../../lib/diagramView'

export type WheelMode = 'zoom' | 'modifier'

export interface PanZoom {
  /** The view drawn now (the fitted one while mode is 'fit'). */
  view: View
  mode: 'fit' | 'free'
  box: Box
  natural: Size | null
  /** The scale Fit would use now. */
  fitK: number
  dragging: boolean
  atMin: boolean
  atMax: boolean
  /** Callback ref for the viewport element. */
  viewportRef: (el: HTMLDivElement | null) => void
  fit: (speak?: boolean) => void
  actual: (about?: Point, speak?: boolean) => void
  /** Zoom by a factor about the viewport centre (a button or key), spoken. */
  zoomBy: (factor: number) => void
  /** Centres the view on a point of the drawing in overview-panel px. */
  centerOnPanel: (p: Point) => void
  /** Props for the viewport element. */
  bind: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
    onKeyUp: (e: KeyboardEvent<HTMLDivElement>) => void
  }
}

interface Options {
  /** 'zoom': the plain wheel zooms (the Larger view). 'modifier': Ctrl or Cmd + wheel zooms, a plain wheel passes through. */
  wheel: WheelMode
  /** Called (debounced 400 ms) with what a screen reader should hear after a key or button zoom. */
  onSpeak?: (text: string) => void
  /** Keys that are not about the view itself (O, S, F). */
  onCommand?: (cmd: ViewKey) => void
}

const SPEAK_DELAY_MS = 400

/** The view of a drawing of `natural` px inside the viewport element: fit until the user pans or zooms. */
export function usePanZoom(natural: Size | null, { wheel, onSpeak, onCommand }: Options): PanZoom {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  const [mode, setMode] = useState<'fit' | 'free'>('fit')
  const [free, setFree] = useState<View>({ k: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!el) return undefined
    const read = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setBox((b) => (Math.abs(b.w - w) < 0.5 && Math.abs(b.h - h) < 0.5 ? b : { w, h }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])

  const ready = natural !== null && box.w > 0 && box.h > 0
  const fitK = ready ? fitScale(box, natural) : 1
  const view: View = ready && mode === 'fit' ? fitView(box, natural) : free

  // Handlers read the latest state through refs, so they never close over a stale view.
  const live = useRef({ view, mode, box, natural, wheel, onSpeak, onCommand })
  live.current = { view, mode, box, natural, wheel, onSpeak, onCommand }

  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback((text: string): void => {
    if (speakTimer.current) clearTimeout(speakTimer.current)
    speakTimer.current = setTimeout(() => live.current.onSpeak?.(text), SPEAK_DELAY_MS)
  }, [])
  useEffect(
    () => () => {
      if (speakTimer.current) clearTimeout(speakTimer.current)
    },
    []
  )

  const commit = useCallback((next: View): void => {
    const { box: b, natural: n } = live.current
    setFree(n ? clampView(next, b, n) : next)
    setMode('free')
  }, [])

  const fit = useCallback(
    (say = true): void => {
      setMode('fit')
      if (say) speak(zoomSpeech(fitK, true))
    },
    [fitK, speak]
  )
  const actual = useCallback(
    (about?: Point, say = true): void => {
      const { view: v, box: b, natural: n } = live.current
      if (!n) return
      commit(actualView(v, b, n, about))
      if (say) speak(zoomSpeech(1, false))
    },
    [commit, speak]
  )
  const zoomAbout = useCallback(
    (factor: number, at: Point, say: boolean): void => {
      const { view: v } = live.current
      const next = zoomAt(v, at, factor)
      commit(next)
      if (say) speak(zoomSpeech(next.k, false))
    },
    [commit, speak]
  )
  const zoomBy = useCallback(
    (factor: number): void => {
      const { box: b } = live.current
      zoomAbout(factor, { x: b.w / 2, y: b.h / 2 }, true)
    },
    [zoomAbout]
  )
  const centerOnPanel = useCallback(
    (p: Point): void => {
      const { view: v, box: b, natural: n } = live.current
      if (n) commit(centerOnOverview(v, b, n, p))
    },
    [commit]
  )

  // The wheel needs a native, non-passive listener: React's own is passive and could not stop the page scrolling.
  useEffect(() => {
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      const { wheel: w, view: v } = live.current
      const ctrl = e.ctrlKey || e.metaKey
      if (w === 'modifier' && !ctrl) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      if (!ctrl && e.shiftKey) {
        // Shift + wheel pans sideways.
        const dx = -(e.deltaX !== 0 ? e.deltaX : e.deltaY)
        commit(panBy(v, dx, 0))
        return
      }
      zoomAbout(wheelFactor(e.deltaY, e.deltaMode, ctrl), at, false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el, commit, zoomAbout])

  // ---------- pointer ----------
  const pointers = useRef(new Map<number, Point>())
  const drag = useRef<{ last: Point; moved: number } | null>(null)
  const pinch = useRef<{ dist: number; mid: Point } | null>(null)
  const space = useRef(false)

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = el?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const pair = (): [Point, Point] | null => {
    const v = Array.from(pointers.current.values())
    return v.length >= 2 ? [v[0], v[1]] : null
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Left button, middle button or touch/pen; the right button keeps its menu.
    if (e.button !== 0 && e.button !== 1) return
    if (e.button === 1) e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // A synthetic pointer id has nothing to capture.
    }
    pointers.current.set(e.pointerId, local(e))
    const two = pair()
    if (two) {
      pinch.current = { dist: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y), mid: { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 } }
      drag.current = null
    } else {
      drag.current = { last: local(e), moved: 0 }
    }
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, local(e))
    const two = pair()
    if (two && pinch.current) {
      const dist = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y)
      const mid = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 }
      const { view: v } = live.current
      const zoomed = zoomAt(v, mid, pinch.current.dist > 0 ? dist / pinch.current.dist : 1)
      commit(panBy(zoomed, mid.x - pinch.current.mid.x, mid.y - pinch.current.mid.y))
      pinch.current = { dist, mid }
      return
    }
    const d = drag.current
    if (!d) return
    const p = local(e)
    const dx = p.x - d.last.x
    const dy = p.y - d.last.y
    d.moved += Math.abs(dx) + Math.abs(dy)
    d.last = p
    // Under the slop it is still a click: the view does not budge.
    if (d.moved < DRAG_SLOP) return
    commit(panBy(live.current.view, dx, dy))
  }
  const endPointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(e.pointerId)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
    pinch.current = null
    if (pointers.current.size === 1) {
      const rest = Array.from(pointers.current.values())[0]
      drag.current = { last: rest, moved: DRAG_SLOP }
    } else {
      drag.current = null
    }
    if (pointers.current.size === 0) setDragging(false)
  }
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const { mode: m, view: v } = live.current
    // Fit and 100% trade places; the 100% view centres on the pointer.
    if (m === 'fit' || Math.abs(v.k - 1) > 0.005) actual(local(e))
    else fit()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // A control or the source editor keeps its own keys.
    if (e.target !== e.currentTarget) return
    if (e.key === ' ') {
      space.current = true
      e.preventDefault()
      return
    }
    const act = viewKey(e)
    if (!act) return
    e.preventDefault()
    const { box: b } = live.current
    switch (act.type) {
      case 'pan':
        commit(panBy(live.current.view, act.dx, act.dy))
        break
      case 'zoom':
        zoomAbout(act.factor, { x: b.w / 2, y: b.h / 2 }, true)
        break
      case 'fit':
        fit()
        break
      case 'actual':
        actual()
        break
      default:
        live.current.onCommand?.(act)
    }
  }
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ') space.current = false
  }

  return {
    view,
    mode,
    box,
    natural,
    fitK,
    dragging,
    atMin: view.k <= ZOOM_MIN + 1e-9,
    atMax: view.k >= ZOOM_MAX - 1e-9,
    viewportRef: setEl,
    fit,
    actual,
    zoomBy,
    centerOnPanel,
    bind: { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer, onDoubleClick, onKeyDown, onKeyUp }
  }
}

/** The factor of a + / - button press. */
export const BUTTON_ZOOM_IN = KEY_ZOOM_STEP
export const BUTTON_ZOOM_OUT = 1 / KEY_ZOOM_STEP
