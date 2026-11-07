// STUB (Phase C seam): the deck viewer (strip + stage, docs/design/outputs-2.md 13.1). Owned by the slides engineer; keep
// the export and props. OutputPreview renders it for a 'slides' preview.
import type { ReactElement } from 'react'
import type { SlidePreview } from '@shared/types'

export interface SlideViewerProps {
  size: { w: number; h: number }
  slides: SlidePreview[]
  truncatedSlides?: number
  title: string
}

export default function SlideViewer({ slides }: SlideViewerProps): ReactElement {
  return <p className="output-preview-note">{slides.length} slides</p>
}
