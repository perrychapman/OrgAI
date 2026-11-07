// STUB (Phase C seam): drawn note regions and the region tool (docs/design/outputs-2.md 11.2). Owned by the notes
// engineer, who replaces the bodies; keep the exports and signatures. Hosts (PanZoomSurface for diagram / svg / image,
// the slide viewer's stage) render <RegionLayer> inside their transformed content box, sized to the drawing's natural
// size, so regions follow pan and zoom, and call the key handler from the viewport's onKeyDown first.
import type { KeyboardEvent, ReactElement } from 'react'
import type { SlideBox } from '@shared/types'

export interface RegionLayerProps {
  /** 1-based slide number on a deck, absent for image / svg / diagram. */
  slide?: number
  /** The drawing's natural size in its own units (viewBox or pixels); regions are stored as fractions of it. */
  naturalW: number
  naturalH: number
  /** Texts of shapes whose bounds intersect a box (fractions); diagrams and slides supply it, images do not. */
  labelsIn?: (box: SlideBox) => string[]
}

export default function RegionLayer(_props: RegionLayerProps): ReactElement | null {
  return null
}

/**
 * The region tool's keyboard path for a focused viewport: Enter places a default box in `visible` (fractions), arrows
 * move it, Shift+arrows resize, Enter confirms, Esc cancels. Returns true when it handled the key (the host then does
 * nothing more with it).
 */
export function useRegionKeys(_opts: { slide?: number; labelsIn?: (box: SlideBox) => string[] }): (e: KeyboardEvent, visible: SlideBox) => boolean {
  return () => false
}
