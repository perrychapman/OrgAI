// The only React file that loads three (with engine/ and builders/): FactoryScene imports it dynamically, so three and
// the engine land in their own chunk. Mounts the canvas, creates one FactoryEngine with the kit source, and wires
// resize, theme, visibility and context-loss events (docs/design/factory-floor.md sections 8 and 9.2). The camera view
// comes from the scene's camera controller (cameraController.ts) through the handle; this component never owns it.
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { FactoryEngine, type EngineFloor, type FactoryEngineStats, type FactoryTheme, type KitHeights } from './engine/FactoryEngine'
// Kit source: the procedural builders (docs/design/factory-floor.md section 4.6).
import { factoryKits as kits } from './builders'
import type { FactoryTokenColours } from './builders/types'
import type { FactoryQuality } from '../../../lib/factory/snapshot'
import type { CameraView } from '../../../lib/factory/camera'
import type { CueFeed } from '../../../lib/factory/types'

export interface FactoryCanvasHandle {
  /**
   * Applies a camera view and renders it at once (the mirror moves in the same frame). `tween`: a frame of a camera
   * tween, which counts as animation for the quality steps (section 9.2).
   */
  setView(view: CameraView, tween?: boolean): void
  /** Slice 4: cues were pushed or the motion state changed: render (the loop runs on while the feed is busy). */
  invalidate(): void
}

export interface FactoryCanvasProps {
  quality: FactoryQuality
  floor: EngineFloor
  /** Slice 4: cues and ambient loops (the scene's CueScheduler behind it). Read once at mount; it reads refs itself. */
  feed: CueFeed
  /** The view to start with (the controller's current one). */
  initialView: CameraView
  /** performance.now() when the scene mounted. */
  mountedAt: number
  onStats(stats: FactoryEngineStats): void
  /** Real heights of the kits (camera fit and mirror boxes). */
  onHeights(heights: KitHeights): void
  /** The renderer could not be created (no context after all). */
  onFailed(): void
  onContextLost(): void
  onContextRestored(): void
  handleRef?: Ref<FactoryCanvasHandle>
}

/** The resolved app theme: data-theme on <html> (lib/theme.ts writes dark or light), else the OS scheme. */
function readTheme(): FactoryTheme {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'light' || t === 'dark') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Status token colours for lamps and the selection ring (section 4.3), read from the theme's custom properties. */
function readTokens(): FactoryTokenColours {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback
  return { success: v('--success', '#22c58b'), warning: v('--warning', '#f5a524'), danger: v('--danger', '#ff6b6b'), accentText: v('--accent-text', '#a592ff') }
}

export function FactoryCanvas(props: FactoryCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<FactoryEngine | null>(null)
  const latest = useRef(props)
  latest.current = props

  useImperativeHandle(props.handleRef, () => ({
    setView: (view: CameraView, tween?: boolean) => {
      const engine = engineRef.current
      if (!engine) return
      engine.setView(view, tween === true)
      engine.flush()
    },
    invalidate: () => engineRef.current?.requestFrame()
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A fresh canvas per engine: a canvas whose context was force-lost cannot give a new one (StrictMode remounts).
    const canvas = document.createElement('canvas')
    canvas.className = 'factory-canvas'
    canvas.setAttribute('data-testid', 'factory-canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.tabIndex = -1
    host.appendChild(canvas)

    let engine: FactoryEngine
    try {
      engine = new FactoryEngine(canvas, {
        quality: latest.current.quality,
        theme: readTheme(),
        kits,
        tokens: readTokens,
        mountedAt: latest.current.mountedAt,
        onChange: () => latest.current.onStats(engine.stats())
      })
    } catch {
      canvas.remove()
      latest.current.onFailed()
      return
    }
    engineRef.current = engine
    const rect = host.getBoundingClientRect()
    engine.setSize(rect.width, rect.height)
    engine.setFloor(latest.current.floor)
    engine.setFeed(latest.current.feed)
    engine.setView(latest.current.initialView)
    latest.current.onHeights(engine.heights())

    const onLost = (e: Event): void => {
      // Without preventDefault the browser never restores the context.
      e.preventDefault()
      host.setAttribute('data-lost', 'true')
      engine.setContextLost()
      latest.current.onContextLost()
    }
    const onRestored = (): void => {
      host.removeAttribute('data-lost')
      engine.rebuild()
      latest.current.onContextRestored()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    const resize = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (box) engine.setSize(box.width, box.height)
    })
    resize.observe(host)

    let onScreen = true
    const updateVisible = (): void => engine.setVisible(onScreen && document.visibilityState !== 'hidden')
    const intersect = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (!last) return
      onScreen = last.isIntersecting
      updateVisible()
    })
    intersect.observe(host)
    document.addEventListener('visibilitychange', updateVisible)
    updateVisible()

    const theme = new MutationObserver(() => engine.setTheme(readTheme()))
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: light)')
    const onScheme = (): void => engine.setTheme(readTheme())
    scheme.addEventListener('change', onScheme)

    engine.requestFrame()

    return () => {
      // Listeners first: forceContextLoss in dispose() fires webglcontextlost, which is not a real loss.
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      resize.disconnect()
      intersect.disconnect()
      document.removeEventListener('visibilitychange', updateVisible)
      theme.disconnect()
      scheme.removeEventListener('change', onScheme)
      engineRef.current = null
      engine.dispose()
      canvas.remove()
      latest.current.onStats(engine.stats())
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setFloor(props.floor)
  }, [props.floor])

  return <div ref={hostRef} className="factory-canvas-host" />
}
