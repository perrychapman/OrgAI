import type { ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { svgDataUrl } from '../../lib/outputPreview'
import { svgNaturalSize } from '../../lib/outputZoom'
import { COPY_FAILED, SOURCE_COPIED } from '../../lib/diagramExport'
import { hintText } from '../../lib/diagramView'
import { PanZoomSurface } from './diagram/PanZoomSurface'
import { SurfaceToolbar } from './diagram/DiagramToolbar'
import { useDiagramExport } from './diagram/DiagramExport'
import { usePanZoom } from './diagram/usePanZoom'
import { useSurfaceNotes } from './diagram/useSurfaceNotes'
import { useOutputView } from './previewStatus'
import '../../styles/outputs-diagram.css'

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

/**
 * An SVG file as an <img> from a data URL (no script runs, nothing loads; never inlined), on the same pan/zoom surface as a
 * diagram. Export saves the file's own text or a PNG drawn from it.
 */
export default function SvgPreview({ text, title }: { text: string; title: string }): ReactElement {
  const { context } = useOutputView()
  const fromText = useMemo(() => svgTextSize(text), [text])
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null)
  const natural = fromText ?? loaded
  const notes = useSurfaceNotes()
  const pz = usePanZoom(natural, { wheel: context === 'dialog' ? 'zoom' : 'modifier', onSpeak: notes.speak })
  const src = useMemo(() => svgDataUrl(text), [text])
  const build = useCallback(async () => (natural ? { svg: text, natural } : null), [natural, text])
  const exportApi = useDiagramExport({ title, build, notify: notes.notify, showTheme: false, svgSource: text })
  const copySource = useCallback((): void => {
    navigator.clipboard.writeText(text).then(
      () => notes.notify(SOURCE_COPIED),
      () => notes.notify(COPY_FAILED)
    )
  }, [text, notes])
  return (
    <div className="diagram-viewer output-svg-wrap" data-testid="output-svg" data-context={context}>
      <SurfaceToolbar pz={pz} label="Drawing controls" exportApi={exportApi} onCopySource={copySource} />
      {notes.notice && (
        <p className="diagram-notice" data-testid="diagram-notice">
          {notes.notice}
        </p>
      )}
      <div className="diagram-body" data-layout="column" data-view="diagram">
        <div className="diagram-pane diagram-pane-view">
          <PanZoomSurface pz={pz} title={title} kind="image" hint={hintText(context)}>
            <img
              className="pz-img output-svg-img"
              data-testid="output-svg-img"
              src={src}
              alt={title}
              draggable={false}
              onLoad={(e) => {
                const i = e.currentTarget
                if (!fromText && i.naturalWidth > 0 && i.naturalHeight > 0) setLoaded({ w: i.naturalWidth, h: i.naturalHeight })
              }}
            />
          </PanZoomSurface>
        </div>
      </div>
      {!notes.routed && (
        <p className="sr-only" role="status" data-testid="output-live">
          {notes.live}
        </p>
      )}
    </div>
  )
}
