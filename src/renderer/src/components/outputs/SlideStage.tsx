// STUB (Phase C seam): one slide drawn from SlidePreview as React elements, never HTML (docs/design/outputs-2.md 13.2).
// Owned by the slides engineer; keep the export and props. Used by the viewer, the strip, compare and thumbnails.
import type { ReactElement, ReactNode } from 'react'
import type { SlidePreview } from '@shared/types'

export interface SlideStageProps {
  slide: SlidePreview
  /** Slide size in points (preview.size). */
  size: { w: number; h: number }
  /** A miniature: contents aria-hidden, no region layer. */
  thumbnail?: boolean
  /** Extra layer drawn over the slide in slide coordinates (the viewer passes the RegionLayer). */
  children?: ReactNode
}

export default function SlideStage(_props: SlideStageProps): ReactElement {
  return <div className="slide-paper" aria-hidden="true" />
}
