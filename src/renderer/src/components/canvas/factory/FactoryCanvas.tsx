// The only React file that loads three (with engine/): FactoryScene imports it dynamically, so three and the engine
// land in their own chunk. Mounts the canvas, creates one FactoryEngine and wires resize, theme, visibility and
// context-loss events (docs/design/factory-floor.md sections 8 and 9.2).
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { FactoryEngine, type FactoryEngineStats, type FactoryTheme } from './engine/FactoryEngine'
import type { FactoryQuality } from '../../../lib/factory/snapshot'

export interface FactoryCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
}

export interface FactoryCanvasProps {
  quality: FactoryQuality
  /** The run has a current-session root: show the booth. */
  booth: boolean
  /** performance.now() when the scene mounted. */
  mountedAt: number
  onStats(stats: FactoryEngineStats): void
  /** The renderer could not be created (no context after all). */
  onFailed(): void
  onContextLost(): void
  onContextRestored(): void
  handleRef?: Ref<FactoryCanvasHandle>
}

const ZOOM_STEP = 1.25

/** The resolved app theme: data-theme on <html> (lib/theme.ts writes dark or light), else the OS scheme. */
function readTheme(): FactoryTheme {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'light' || t === 'dark') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function FactoryCanvas(props: FactoryCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<FactoryEngine | null>(null)
  const latest = useRef(props)
  latest.current = props

  useImperativeHandle(props.handleRef, () => ({
    zoomIn: () => engineRef.current?.zoomBy(ZOOM_STEP),
    zoomOut: () => engineRef.current?.zoomBy(1 / ZOOM_STEP),
    fit: () => engineRef.current?.fit()
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
        mountedAt: latest.current.mountedAt,
        onChange: () => latest.current.onStats(engine.stats())
      })
    } catch {
      canvas.remove()
      latest.current.onFailed()
      return
    }
    engineRef.current = engine
    engine.setBooth(latest.current.booth)
    const rect = host.getBoundingClientRect()
    engine.setSize(rect.width, rect.height)

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
    engineRef.current?.setBooth(props.booth)
  }, [props.booth])

  return <div ref={hostRef} className="factory-canvas-host" />
}
