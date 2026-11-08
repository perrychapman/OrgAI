import type { ReactElement } from 'react'
import { useState } from 'react'
import { isSafeImageDataUrl } from '../../lib/outputPreview'
import { hintText } from '../../lib/diagramView'
import { PanZoomSurface } from './diagram/PanZoomSurface'
import { SurfaceToolbar } from './diagram/DiagramToolbar'
import { usePanZoom } from './diagram/usePanZoom'
import { useSurfaceNotes } from './diagram/useSurfaceNotes'
import { useOutputView } from './previewStatus'
import '../../styles/outputs-diagram.css'

/** A raster image from a checked data URL on the pan/zoom surface: fits at first, drag to move, zoom bar and keys. */
export default function ImagePreview({ dataUrl, title }: { dataUrl: string; title: string }): ReactElement {
  const { context } = useOutputView()
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const notes = useSurfaceNotes()
  const pz = usePanZoom(natural, { wheel: context === 'dialog' ? 'zoom' : 'modifier', onSpeak: notes.speak })
  if (!isSafeImageDataUrl(dataUrl)) {
    return (
      <p className="output-preview-none" data-testid="output-preview-none">
        This image could not be shown. Open the file instead.
      </p>
    )
  }
  return (
    <div className="diagram-viewer output-image-wrap" data-testid="output-image-viewer" data-context={context}>
      <SurfaceToolbar pz={pz} label="Image controls" />
      <div className="diagram-body" data-layout="column" data-view="diagram">
        <div className="diagram-pane diagram-pane-view">
          <PanZoomSurface pz={pz} title={title} kind="image" hint={hintText(context)}>
            <img
              className="pz-img output-image"
              data-testid="output-image"
              src={dataUrl}
              alt={title}
              draggable={false}
              onLoad={(e) => {
                const i = e.currentTarget
                if (i.naturalWidth > 0 && i.naturalHeight > 0) setNatural({ w: i.naturalWidth, h: i.naturalHeight })
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
