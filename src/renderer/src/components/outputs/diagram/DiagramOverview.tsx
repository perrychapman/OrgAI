import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useRef } from 'react'
import { overviewRects } from '../../../lib/diagramView'
import { ShadowSvg } from './PanZoomSurface'
import type { PanZoom } from './usePanZoom'

/**
 * The overview (docs/design/outputs-2.md 8.4): the whole drawing in a corner with a rectangle for what the viewport shows.
 * Pointer only (aria-hidden, no tab stop; keyboard users pan with the arrows). A click or drag centres the view there.
 */
export function DiagramOverview({ pz, root }: { pz: PanZoom; root: Element }): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null)
  const { natural } = pz
  if (!natural || pz.box.w <= 0) return null
  const o = overviewRects(pz.view, pz.box, natural)
  const at = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = panel.current?.getBoundingClientRect()
    if (r) pz.centerOnPanel({ x: e.clientX - r.left, y: e.clientY - r.top })
  }
  return (
    <div
      ref={panel}
      className="diagram-overview"
      data-testid="diagram-overview"
      aria-hidden="true"
      style={{ width: o.panel.w, height: o.panel.h }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        at(e)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e)
      }}
    >
      <ShadowSvg root={root} className="diagram-overview-svg" />
      <div className="diagram-overview-rect" style={{ left: o.rect.x, top: o.rect.y, width: o.rect.w, height: o.rect.h }} />
    </div>
  )
}
