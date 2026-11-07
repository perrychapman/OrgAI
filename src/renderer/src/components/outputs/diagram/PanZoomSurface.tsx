import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { PanZoom } from './usePanZoom'

/**
 * Puts a CHECKED svg root (lib/outputSvg.ts safeMermaidSvg) on screen: the tree is imported as nodes into a shadow root, never
 * re-parsed from text, and Mermaid's own <style> and ids stay out of the app. `size` fixes the drawing's px size (the viewer's
 * natural size, scaled by the surface's transform); without it the drawing fills its box (the overview).
 */
export function ShadowSvg({ root, size, testId, label, className }: { root: Element; size?: { w: number; h: number } | null; testId?: string; label?: string; className?: string }): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    // !important: Mermaid writes its own inline max-width on the root svg, which would otherwise cap an enlarged drawing.
    style.textContent = size
      ? `svg { display: block !important; max-width: none !important; width: ${Math.round(size.w)}px !important; height: ${Math.round(size.h)}px !important; }`
      : 'svg { display: block !important; max-width: none !important; width: 100% !important; height: 100% !important; }'
    shadow.replaceChildren(style, document.importNode(root, true))
  }, [root, size?.w, size?.h]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} className={className} data-testid={testId} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

export interface PanZoomSurfaceProps {
  pz: PanZoom
  /** Names the viewport. */
  title: string
  kind: 'diagram' | 'image'
  /** The hint sentence for this context (visible once focus enters, and read after the name). */
  hint: string
  /** Ids of more descriptions (the diagram's hidden text). */
  describedBy?: string
  /** The drawing (a ShadowSvg or an img). It is sized to the natural size and moved by the surface. */
  children: ReactNode
  /** Pointer-only extras over the viewport (the overview). They sit beside it, so a drag on them never pans. */
  overlay?: ReactNode
  /** The last good drawing is shown stale: dimmed to 60%. */
  stale?: boolean
  /** The drawing sits on white paper (Light drawing). */
  paper?: boolean
  /** Extra data attributes for e2e (data-shapes). */
  data?: Record<string, string | number | undefined>
  testId?: string
}

/**
 * A viewport that holds one drawing at `translate(x, y) scale(k)`. No scroll bars: the surface pans by drag and keys and zooms by
 * wheel (see usePanZoom). Tab always leaves it.
 */
export function PanZoomSurface({ pz, title, kind, hint, describedBy, children, overlay, stale, paper, data, testId = 'diagram-viewport' }: PanZoomSurfaceProps): ReactElement {
  const uid = useId()
  const hintId = `${uid}-hint`
  const [focused, setFocused] = useState(false)
  const { view, natural } = pz
  const ready = natural !== null && pz.box.w > 0
  const dataAttrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined) dataAttrs[`data-${k}`] = String(v)
  return (
    <div className="pz-stage" data-paper={paper ? 'true' : undefined}>
      <div
        ref={pz.viewportRef}
        className="pz-viewport"
        data-testid={testId}
        role="group"
        aria-roledescription={kind === 'diagram' ? 'diagram viewer' : 'image viewer'}
        aria-label={title}
        aria-describedby={[describedBy, hintId].filter(Boolean).join(' ')}
        tabIndex={0}
        data-mode={pz.mode}
        data-k={view.k.toFixed(4)}
        data-x={view.x.toFixed(1)}
        data-y={view.y.toFixed(1)}
        data-natural-w={natural ? Math.round(natural.w) : undefined}
        data-natural-h={natural ? Math.round(natural.h) : undefined}
        data-dragging={pz.dragging ? 'true' : undefined}
        data-stale={stale ? 'true' : undefined}
        {...dataAttrs}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...pz.bind}
      >
        <div
          className="pz-content"
          style={{
            width: natural ? natural.w : undefined,
            height: natural ? natural.h : undefined,
            transform: ready ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined,
            visibility: ready || !natural ? undefined : 'hidden'
          }}
        >
          {children}
        </div>
      </div>
      <p id={hintId} className="sr-only">
        {hint}
      </p>
      {focused && (
        <p className="pz-hint" data-testid="diagram-hint" aria-hidden="true">
          {hint}
        </p>
      )}
      {overlay}
    </div>
  )
}
