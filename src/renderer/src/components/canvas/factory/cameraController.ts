// The Factory Floor's camera input and tween clock (docs/design/factory-floor.md section 2). DOM only, no three: the
// same controller drives the 3D view and the floor plan. The maths lives in lib/factory/camera.ts; this file wires
// pointer, wheel and resize events, owns the view, tweens handle and menu commands over --dur-slow (0 under reduced
// motion), and hands every new view to `onView` in the same task, so the canvas and the DOM mirror move together.
// Deviation from section 10.2, which puts camera input in FactoryCanvas.tsx (that component exists only on the 3D path).
import {
  DRAG_THRESHOLD_PX,
  ZOOM_STEP,
  clampPpm,
  clampTarget,
  easeOut,
  fitView,
  lerpView,
  panByMetres,
  panByScreen,
  panIntoView,
  sameView,
  wheelFactor,
  zoomAbout,
  type Box3,
  type CameraView,
  type FloorBounds,
  type Projection,
  type Stage
} from '../../../lib/factory/camera'

export interface CameraControllerOptions {
  projection: Projection
  /** What fit frames (section 2: booth, dock, board and stations, with heights). */
  fitBoxes(): readonly Box3[]
  /** The hall: the target is clamped to it plus 8 m. */
  hall(): FloorBounds
  /** Tween length in ms for handle, menu, key and focus moves; 0 means instant (reduced motion). */
  tweenMs(): number
  /** True when a pointer press on this target must not start a pan (the scene's own controls, inputs, links). */
  isControl(target: EventTarget | null): boolean
  /** Every view change, synchronously. */
  onView(view: CameraView, stage: Stage): void
}

export class CameraController {
  private readonly opts: CameraControllerOptions
  private stage: Stage
  private current: CameraView = { ppm: 20, targetX: 15, targetZ: -4 }
  /** The user panned or zoomed since the last fit: a resize keeps the view instead of refitting. */
  private moved = false
  private sized = false
  private tween: { from: CameraView; to: CameraView; start: number; ms: number; raf: number } | null = null
  private element: HTMLElement | null = null
  private detach: (() => void) | null = null
  private drag: { id: number; x: number; y: number; lastX: number; lastY: number; panning: boolean } | null = null
  private suppressClick = false

  constructor(opts: CameraControllerOptions) {
    this.opts = opts
    this.stage = { width: 0, height: 0, projection: opts.projection }
  }

  get view(): CameraView {
    return { ...this.current }
  }
  get stageInfo(): Stage {
    return { ...this.stage }
  }
  get userMoved(): boolean {
    return this.moved
  }

  /** Listens on the stage element: pointer drag, wheel and size. Returns nothing; call dispose() to stop. */
  attach(element: HTMLElement): void {
    this.detach?.()
    this.element = element
    const down = (e: PointerEvent): void => this.onPointerDown(e)
    const move = (e: PointerEvent): void => this.onPointerMove(e)
    const up = (e: PointerEvent): void => this.onPointerUp(e)
    const wheel = (e: WheelEvent): void => this.onWheel(e)
    const click = (e: MouseEvent): void => {
      // A press that became a pan never clicks the worker it started on.
      if (!this.suppressClick) return
      this.suppressClick = false
      e.preventDefault()
      e.stopPropagation()
    }
    const aux = (e: MouseEvent): void => {
      if (e.button === 1) e.preventDefault()
    }
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('click', click, true)
    element.addEventListener('mousedown', aux)
    const resize = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (box) this.setSize(box.width, box.height)
    })
    resize.observe(element)
    const rect = element.getBoundingClientRect()
    this.setSize(rect.width, rect.height)
    this.detach = () => {
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('click', click, true)
      element.removeEventListener('mousedown', aux)
      resize.disconnect()
    }
  }

  dispose(): void {
    this.cancelTween()
    this.detach?.()
    this.detach = null
    this.element = null
    this.drag = null
  }

  /** The floor plan and the 3D view use different projections; switching refits unless the user moved. */
  setProjection(projection: Projection): void {
    if (projection === this.stage.projection) return
    this.stage = { ...this.stage, projection }
    this.cancelTween()
    this.current = this.moved ? this.clamp({ ...this.current, ppm: clampPpm(this.current.ppm, projection) }) : this.fitted()
    this.emit()
  }

  setSize(width: number, height: number): void {
    const w = Math.max(0, Math.round(width))
    const h = Math.max(0, Math.round(height))
    if (w === this.stage.width && h === this.stage.height && this.sized) return
    this.stage = { ...this.stage, width: w, height: h }
    if (w < 2 || h < 2) return
    this.sized = true
    // Section 2: refit on resize only if the user has not panned or zoomed since the last fit.
    if (!this.moved) {
      this.cancelTween()
      this.current = this.fitted()
    }
    this.emit()
  }

  /** The fit boxes changed (real kit heights arrived): refit only while the user has not moved. New stations never move the camera. */
  refitIfUntouched(): void {
    if (this.moved || !this.sized) return
    this.cancelTween()
    this.current = this.fitted()
    this.emit()
  }

  /** Re-sends the current view (after the DOM mirror re-rendered). */
  reapply(): void {
    if (this.sized) this.emit()
  }

  fit(): void {
    this.moved = false
    this.animateTo(this.fitted())
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP)
  }
  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP)
  }

  /** Zoom about the stage centre (buttons, menu, keys), tweened. */
  zoomBy(factor: number): void {
    const base = this.tween ? this.tween.to : this.current
    const next = zoomAbout(base, factor, { x: this.stage.width / 2, y: this.stage.height / 2 }, this.stage)
    this.moved = true
    this.animateTo(this.clamp(next))
  }

  /** Shift+Arrow: pan by metres, tweened. */
  panMetres(dx: number, dz: number): void {
    const base = this.tween ? this.tween.to : this.current
    this.moved = true
    this.animateTo(this.clamp(panByMetres(base, dx, dz)))
  }

  /** Focus into view (section 2): pan (never zoom) so the box sits 96 px inside, tweened; false when no pan was needed. */
  panIntoView(box: Box3): boolean {
    const base = this.tween ? this.tween.to : this.current
    const next = panIntoView(base, box, this.stage)
    if (!next) return false
    this.moved = true
    this.animateTo(this.clamp(next))
    return true
  }

  // ---- internals ----

  private fitted(): CameraView {
    return this.clamp(fitView(this.opts.fitBoxes(), this.stage))
  }

  private clamp(view: CameraView): CameraView {
    return clampTarget({ ...view, ppm: clampPpm(view.ppm, this.stage.projection) }, this.opts.hall())
  }

  private emit(): void {
    if (this.stage.width < 2 || this.stage.height < 2) return
    this.opts.onView(this.view, this.stageInfo)
  }

  private set(view: CameraView): void {
    this.current = view
    this.emit()
  }

  private cancelTween(): void {
    if (this.tween?.raf) cancelAnimationFrame(this.tween.raf)
    this.tween = null
  }

  private animateTo(to: CameraView): void {
    this.cancelTween()
    const ms = this.opts.tweenMs()
    if (ms <= 0 || sameView(to, this.current)) {
      this.set(to)
      return
    }
    const tween = { from: this.view, to, start: performance.now(), ms, raf: 0 }
    const step = (now: number): void => {
      if (this.tween !== tween) return
      const t = Math.min(1, (now - tween.start) / tween.ms)
      this.set(t >= 1 ? tween.to : lerpView(tween.from, tween.to, easeOut(t)))
      if (t < 1) tween.raf = requestAnimationFrame(step)
      else this.tween = null
    }
    this.tween = tween
    tween.raf = requestAnimationFrame(step)
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.element?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  private onPointerDown(e: PointerEvent): void {
    this.suppressClick = false
    if (e.button !== 0 && e.button !== 1) return
    if (this.opts.isControl(e.target)) return
    if (e.button === 1) e.preventDefault()
    const p = this.local(e)
    this.drag = { id: e.pointerId, x: p.x, y: p.y, lastX: p.x, lastY: p.y, panning: false }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    const p = this.local(e)
    if (!d.panning) {
      if (Math.hypot(p.x - d.x, p.y - d.y) <= DRAG_THRESHOLD_PX) return
      d.panning = true
      this.cancelTween()
      try {
        this.element?.setPointerCapture(e.pointerId)
      } catch {
        // The pointer may already be gone.
      }
      this.element?.setAttribute('data-panning', 'true')
    }
    // Direct manipulation: never tweened. The floor under the pointer follows it.
    const next = panByScreen(this.current, this.stage, p.x - d.lastX, p.y - d.lastY, { x: d.lastX, y: d.lastY })
    d.lastX = p.x
    d.lastY = p.y
    this.moved = true
    this.set(this.clamp(next))
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    if (d.panning) {
      this.suppressClick = e.type === 'pointerup'
      this.element?.removeAttribute('data-panning')
      try {
        this.element?.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    if (this.opts.isControl(e.target)) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.stage.height : 1
    const factor = wheelFactor(e.deltaY * unit)
    if (!Number.isFinite(factor) || factor === 1) return
    this.cancelTween()
    this.moved = true
    this.set(this.clamp(zoomAbout(this.current, factor, this.local(e), this.stage)))
  }
}
