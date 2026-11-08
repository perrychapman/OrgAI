import type { ReactElement } from 'react'
import { useMemo } from 'react'
import type { OutputKind, OutputThumb as Thumb } from '@shared/types'
import { svgDataUrl } from '../../lib/outputPreview'
import { openNotesLabel } from '../../lib/outputsList'
import { safeImageDataUrl } from '../../lib/outputThumbs'
import { Badge } from '../ui/Badge'
import OutputKindIcon from './OutputKindIcon'
import SlideStage from './SlideStage'
import '../../styles/outputs-view.css'

/** Largest text a thumbnail draws (main caps it; this is the renderer's own bound). */
const LINE_CHARS = 240
const CELL_ROWS = 6
const CELL_COLS = 4

/**
 * What a thumbnail draws (docs/design/outputs-2.md section 6): a slide through SlideStage, an image or checked SVG as an
 * `<img>` data URL (never inlined), text as dimmed lines, a sheet as a tiny grid; anything else, a failure or no answer
 * yet is the kind icon. Always decorative: aria-hidden, `alt=""`, no text of its own for a failure. A diagram shows its
 * source lines in this pass (the grid does not draw a small diagram yet).
 */
export function OutputThumb({ thumb, kind, size }: { thumb: Thumb | null; kind: OutputKind; size: 'row' | 'card' | 'run' }): ReactElement {
  const drawn = thumb && thumb.kind !== 'none' ? <Drawn thumb={thumb} /> : null
  return (
    <span className="output-thumb" data-testid="output-thumb" data-size={size} data-kind={thumb?.kind ?? 'pending'} aria-hidden="true">
      {drawn ?? (
        <span className="output-thumb-icon">
          <OutputKindIcon kind={kind} size={size === 'card' ? 'lg' : 'md'} />
        </span>
      )}
    </span>
  )
}

/** The trailing badges of a row or card: open notes and "New" (a version the user has not seen). */
export function OutputBadges({ openNotes, isNew }: { openNotes: number; isNew: boolean }): ReactElement | null {
  if (openNotes <= 0 && !isNew) return null
  return (
    <>
      {openNotes > 0 && (
        <Badge tone="accent" testId="output-open-notes">
          {openNotesLabel(openNotes)}
        </Badge>
      )}
      {isNew && (
        <Badge tone="success" testId="output-new-version">
          New
        </Badge>
      )}
    </>
  )
}

function Drawn({ thumb }: { thumb: Thumb }): ReactElement | null {
  const svgSrc = useMemo(() => (thumb.kind === 'svg' ? svgDataUrl(thumb.text) : ''), [thumb])
  switch (thumb.kind) {
    case 'slide':
      return (
        <span className="output-thumb-slide">
          <SlideStage slide={thumb.slide} size={thumb.size} thumbnail />
        </span>
      )
    case 'image':
      return safeImageDataUrl(thumb.dataUrl) ? <img className="output-thumb-img" src={thumb.dataUrl} alt="" draggable={false} /> : null
    case 'svg':
      return <img className="output-thumb-img" src={svgSrc} alt="" draggable={false} />
    case 'lines':
      return (
        <span className="output-thumb-lines">
          {thumb.lines.slice(0, 4).map((l, i) => (
            <span key={i} className="output-thumb-line">
              {String(l).slice(0, LINE_CHARS)}
            </span>
          ))}
        </span>
      )
    case 'cells':
      return (
        <span className="output-thumb-cells">
          {thumb.rows.slice(0, CELL_ROWS).map((r, i) => (
            <span key={i} className="output-thumb-cellrow">
              {r.slice(0, CELL_COLS).map((c, j) => (
                <span key={j} className="output-thumb-cell">
                  {c === null ? '' : String(c)}
                </span>
              ))}
            </span>
          ))}
        </span>
      )
    default:
      return null
  }
}
