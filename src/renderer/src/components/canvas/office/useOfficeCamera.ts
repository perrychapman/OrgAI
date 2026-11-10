import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import {
  clampScroll, defaultView, fitView, panBy, pinScroll, revealScroll, stageCentre, stepZoom, toContent, toScreen, toWorld, zoomLabel, zoomName, FIND_RING_MS,
  OFFICE_TILE_PX, type Point, type Rect, type Size, type View, type Zoom
} from '../../../lib/office/camera'
import { tokenMs } from '../../../lib/useExitPresence'

/** Room under the plate for Find and focus reveals, in CSS pixels (two plate lines plus its gap). */
const PLATE_RESERVE = 44
const PLATE_MIN_WIDTH = 96
/** Room above the head for a three-line message bubble and its tail, CSS pixels. */
const BUBBLE_RESERVE = 72
const SPRITE = { width: 16, height: 24 }

export interface OfficeCameraOptions {
  stage: RefObject<HTMLDivElement | null>
  /** Drawn rectangle in tiles. */
  area: Rect
  /** The lobby, centred in the default view when the building does not fit at 2x. */
  lobby: Rect | null
  /** Default view again when this changes (the run id); not on resize. */
  resetKey: string | undefined
  /** Smooth scrolling is replaced by instant scrolling when motion is reduced or paused. */
  motionOff: boolean
  selectedId?: string
  /** Sprite top-left per person at rest, building pixels. Identity changes when the layout may have moved someone. */
  positions: ReadonlyMap<string, Point>
  /** Said once through the frame live region after Find or Show: `Showing {name}, {room label}`. */
  describe(id: string): string | null
  announce: ((text: string) => void) | null
}

export interface OfficeCamera {
  zoom: Zoom
  zoomLabel: string
  zoomIn(): void
  zoomOut(): void
  fit(): void
  /** Default view again (Home). */
  home(): void
  /** Pan so the person and plate are inside the stage, ring them for `--office-find-duration` and announce once. Does not select. */
  show(id: string): void
  /** Bring a person into view without a ring (keyboard focus): instant. */
  reveal(id: string): void
  /** The person with the Find ring right now. */
  foundId: string | null
  client: Size
  stageProps: {
    onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
    onPointerDown(event: PointerEvent<HTMLDivElement>): void
    onPointerMove(event: PointerEvent<HTMLDivElement>): void
    onPointerUp(event: PointerEvent<HTMLDivElement>): void
    onPointerCancel(event: PointerEvent<HTMLDivElement>): void
    onScroll(): void
    onWheel(): void
  }
}

const personWorldCentre = (position: Point): Point => ({ x: position.x + SPRITE.width / 2, y: position.y + SPRITE.height / 2 })

export function useOfficeCamera(options: OfficeCameraOptions): OfficeCamera {
  const { stage, area, lobby, resetKey, motionOff, selectedId, positions, describe, announce } = options
  const [zoom, setZoom] = useState<Zoom>(2)
  const [client, setClient] = useState<Size>({ width: 0, height: 0 })
  const [nonce, setNonce] = useState(0)
  const [foundId, setFoundId] = useState<string | null>(null)
  const pending = useRef<{ world: Point; screen: Point } | null>(null)
  const touched = useRef(false)
  const defaulted = useRef<string | null>(null)
  const lastScroll = useRef<Point>({ x: 0, y: 0 })
  const snapshot = useRef<{ area: Rect; zoom: number; client: Size; positions: ReadonlyMap<string, Point> } | null>(null)
  const drag = useRef<{ pointer: number; startX: number; startY: number; left: number; top: number } | null>(null)
  const findTimer = useRef(0)


  const scrollOf = (): Point => ({ x: stage.current?.scrollLeft ?? 0, y: stage.current?.scrollTop ?? 0 })
  const viewNow = (): View => ({ area, zoom, client, scroll: scrollOf() })
  const scrollTo = (point: Point, behavior: ScrollBehavior): void => {
    const element = stage.current
    if (!element) return
    element.scrollTo({ left: point.x, top: point.y, behavior })
    if (behavior === 'auto') lastScroll.current = point
  }

  // Measure before paint, then follow the stage's size.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const read = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      setClient(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [stage])

  const requestPin = (nextZoom: Zoom, world: Point, screen: Point): void => {
    pending.current = { world, screen }
    setZoom(nextZoom)
    setNonce(n => n + 1)
  }

  // Default view on the first measure and whenever the run changes; never on resize.
  useLayoutEffect(() => {
    if (!client.width || !client.height) return
    const key = resetKey ?? ''
    if (defaulted.current === key) return
    defaulted.current = key
    touched.current = false
    const view = defaultView(area, lobby, client)
    requestPin(view.zoom, view.focus, stageCentre(client))
  }, [client, resetKey])

  // Apply a requested pin once the DOM shows the new zoom.
  useLayoutEffect(() => {
    const request = pending.current
    if (!request) return
    pending.current = null
    scrollTo(pinScroll({ area, zoom, client }, request.world, request.screen), 'auto')
  }, [zoom, nonce])

  // A layout change is instant. A focused or selected person stays under the same screen point; with nobody to keep,
  // an untouched camera follows the lobby the way the default view does.
  const areaKey = `${area.x},${area.y},${area.width},${area.height}`
  useLayoutEffect(() => {
    const before = snapshot.current
    snapshot.current = { area, zoom, client, positions }
    if (!before || before.positions === positions || pending.current || before.zoom !== zoom) return
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-office-worker-id]')?.dataset.officeWorkerId
    const trackedId = [focusedId, selectedId].find(id => id && before.positions.has(id) && positions.has(id))
    if (trackedId) {
      const was = before.positions.get(trackedId)!
      const now = positions.get(trackedId)!
      if (was.x === now.x && was.y === now.y && before.area.x === area.x && before.area.y === area.y) return
      const screen = toScreen({ area: before.area, zoom: before.zoom, client: before.client, scroll: lastScroll.current }, personWorldCentre(was))
      scrollTo(pinScroll({ area, zoom, client }, personWorldCentre(now), screen), 'auto')
      return
    }
    if (!touched.current && client.width && client.height && (before.area.width !== area.width || before.area.height !== area.height || before.area.y !== area.y)) {
      const view = defaultView(area, lobby, client)
      requestPin(view.zoom, view.focus, stageCentre(client))
    }
  }, [positions, areaKey, zoom, client])

  useEffect(() => () => window.clearTimeout(findTimer.current), [])

  const changeZoom = (next: Zoom): void => {
    if (next === zoom) return
    touched.current = true
    const view = viewNow()
    let anchor: { world: Point; screen: Point } | null = null
    // Keep the keyboard-focused person under the same screen point first (they must not leave the view), then the selection.
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-office-worker-id]')?.dataset.officeWorkerId
    for (const id of [focusedId, selectedId]) {
      const position = id ? positions.get(id) : undefined
      if (!position) continue
      const world = personWorldCentre(position)
      const screen = toScreen(view, world)
      if (id === focusedId || (screen.x >= 0 && screen.y >= 0 && screen.x <= client.width && screen.y <= client.height)) {
        anchor = { world, screen: { x: Math.min(Math.max(screen.x, 0), client.width), y: Math.min(Math.max(screen.y, 0), client.height) } }
        break
      }
    }
    if (!anchor) { const screen = stageCentre(client); anchor = { world: toWorld(view, screen), screen } }
    requestPin(next, anchor.world, anchor.screen)
  }

  const fit = (): void => { touched.current = true; const view = fitView(area, client); requestPin(view.zoom, view.focus, stageCentre(client)) }
  const home = (): void => { touched.current = false; const view = defaultView(area, lobby, client); requestPin(view.zoom, view.focus, stageCentre(client)) }

  /** Content-space rectangle of a person plus plate, for reveal maths. */
  const personRect = (id: string, above = 0): Rect | null => {
    const position = positions.get(id)
    if (!position) return null
    const origin = toContent({ area, zoom }, position)
    const plateWidth = Math.max(PLATE_MIN_WIDTH, 4 * OFFICE_TILE_PX * zoom - 4)
    const centre = origin.x + (SPRITE.width * zoom) / 2
    const left = Math.min(origin.x, centre - plateWidth / 2)
    const right = Math.max(origin.x + SPRITE.width * zoom, centre + plateWidth / 2)
    const top = origin.y - 16 * zoom - above
    return { x: left, y: Math.max(0, top), width: right - left, height: origin.y + SPRITE.height * zoom + PLATE_RESERVE - Math.max(0, top) }
  }

  const reveal = (id: string): void => {
    const rect = personRect(id)
    if (!rect) return
    scrollTo(revealScroll(viewNow(), rect), 'auto')
  }

  const show = (id: string): void => {
    // Show and Find usually follow a message: leave room for a three-line bubble above the head too.
    const rect = personRect(id, BUBBLE_RESERVE)
    if (!rect) return
    touched.current = true
    const instant = motionOff
    scrollTo(revealScroll(viewNow(), rect), instant ? 'auto' : 'smooth')
    window.clearTimeout(findTimer.current)
    setFoundId(id)
    findTimer.current = window.setTimeout(() => setFoundId(null), tokenMs('--office-find-duration') || FIND_RING_MS)
    const text = describe(id)
    if (text) announce?.(text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (target === event.currentTarget) {
      const step = panBy(event.key, event.shiftKey)
      if (step) {
        event.preventDefault()
        touched.current = true
        const current = scrollOf()
        scrollTo(clampScroll({ area, zoom, client }, { x: current.x + step.x, y: current.y + step.y }), 'auto')
        return
      }
    }
    // Keyboard zoom is announced once per change (the buttons' readout carries it for pointer users).
    const keyZoom = (next: Zoom): void => { if (next !== zoom) announce?.(zoomName(next)); changeZoom(next) }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); keyZoom(stepZoom(zoom, 1)) }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); keyZoom(stepZoom(zoom, -1)) }
    else if (event.key === '0') { event.preventDefault(); const next = fitView(area, client).zoom; fit(); announce?.(`Fit, ${zoomName(next)}`) }
    else if (event.key === 'Home' && target === event.currentTarget) { event.preventDefault(); home() }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.pointerType === 'touch') return
    if ((event.target as HTMLElement).closest('.office-person, button, a, input, summary')) return
    const element = event.currentTarget
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    touched.current = true
    element.setPointerCapture(event.pointerId)
    element.dataset.dragging = 'true'
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    const element = event.currentTarget
    element.scrollLeft = state.left - (event.clientX - state.startX)
    element.scrollTop = state.top - (event.clientY - state.startY)
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    drag.current = null
    delete event.currentTarget.dataset.dragging
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return {
    zoom, zoomLabel: zoomLabel(zoom), client, foundId,
    zoomIn: () => changeZoom(stepZoom(zoom, 1)),
    zoomOut: () => changeZoom(stepZoom(zoom, -1)),
    fit, home, show, reveal,
    stageProps: {
      onKeyDown, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag,
      onScroll: () => { lastScroll.current = scrollOf() },
      onWheel: () => { touched.current = true }
    }
  }
}

