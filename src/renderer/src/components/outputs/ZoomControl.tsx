import type { ReactElement } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { percentLabel, zoomDataValue } from '../../lib/diagramView'
import { BUTTON_ZOOM_IN, BUTTON_ZOOM_OUT, type PanZoom } from './diagram/usePanZoom'

/**
 * The zoom group of a pan/zoom surface (docs/design/outputs-2.md 8.1): out, the readout, in, then Fit and Actual size as their own
 * labelled buttons. `data-value` is "fit" or the scale (1 = 100%). What a key or button zoom says aloud is spoken by the viewer's
 * one `output-live` region, so the readout here is plain text.
 */
export function ZoomBar({ pz }: { pz: PanZoom }): ReactElement {
  const fit = pz.mode === 'fit'
  const k = pz.view.k
  return (
    <div className="diagram-zoom" role="group" aria-label="Zoom" data-testid="output-mermaid-zoom" data-value={zoomDataValue(k, fit)}>
      <IconButton icon={Minus} size="sm" label="Zoom out" testId="output-zoom-out" inert={pz.atMin} onClick={() => pz.zoomBy(BUTTON_ZOOM_OUT)} />
      <span className="diagram-zoom-readout" data-testid="output-zoom-readout">
        {percentLabel(k)}
      </span>
      <IconButton icon={Plus} size="sm" label="Zoom in" testId="output-zoom-in" inert={pz.atMax} onClick={() => pz.zoomBy(BUTTON_ZOOM_IN)} />
      <Button size="sm" variant={fit ? 'secondary' : 'ghost'} testId="output-zoom-fit" ariaLabel="Fit to window" title="Fit the drawing to the window" icon={Maximize} onClick={() => pz.fit()}>
        Fit
      </Button>
      <Button size="sm" variant={!fit && Math.abs(k - 1) < 0.005 ? 'secondary' : 'ghost'} testId="output-zoom-actual" title="Show the drawing at its own size (100%)" onClick={() => pz.actual()}>
        Actual size
      </Button>
    </div>
  )
}
