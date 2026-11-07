import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { svgDataUrl } from '../../lib/outputPreview'
import { svgNaturalSize } from '../../lib/outputZoom'
import { ZoomBar, useZoom } from './ZoomControl'

/** One attribute of the root <svg> tag of a text, read with a plain regex (the text is only measured, never parsed or inserted). */
function rootAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? null) : null
}

/** The drawing's size from the root tag's viewBox or width and height; null when it names neither. */
export function svgTextSize(text: string): { w: number; h: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text.slice(0, 4096))?.[0]
  if (!tag) return null
  return svgNaturalSize(rootAttr(tag, 'viewBox'), rootAttr(tag, 'width'), rootAttr(tag, 'height'))
}

/** An SVG file as an <img> from a data URL (no script runs, nothing loads), with the same zoom as the diagram. */
export default function SvgPreview({ text, title }: { text: string; title: string }): ReactElement {
  const fromText = useMemo(() => svgTextSize(text), [text])
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null)
  const zoom = useZoom(fromText ?? loaded)
  const src = useMemo(() => svgDataUrl(text), [text])
  const sized = zoom.size
  return (
    <div className="output-svg-wrap">
      <div className="output-toolbar">
        <ZoomBar zoom={zoom} />
      </div>
      <div ref={zoom.regionRef} className="output-scroll output-svg-stage" role="region" aria-label={`${title} drawing`} aria-keyshortcuts="+ - 0" tabIndex={0} onKeyDown={zoom.onKeyDown}>
        <img
          className="output-image output-svg-img"
          data-testid="output-svg-img"
          src={src}
          alt={title}
          style={sized ? { width: sized.w, height: sized.h, maxWidth: 'none' } : undefined}
          onLoad={(e) => {
            const i = e.currentTarget
            if (!fromText && i.naturalWidth > 0 && i.naturalHeight > 0) setLoaded({ w: i.naturalWidth, h: i.naturalHeight })
          }}
        />
      </div>
    </div>
  )
}
