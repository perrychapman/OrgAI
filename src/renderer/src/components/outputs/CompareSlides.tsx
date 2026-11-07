// STUB (Phase C seam): Compare for decks (filmstrip of aligned pairs + two-up stage, docs/design/outputs-2.md 12.2). Owned
// by the slides engineer; keep the export and props. ComparePanel renders it for a 'slides' diff; it fetches the two
// versions' previews itself (outputs:preview with `version`).
import type { ReactElement } from 'react'
import type { OutputDiff, RunOutput } from '@shared/types'

export interface CompareSlidesProps {
  output: RunOutput
  a: number
  b: number
  diff: Extract<OutputDiff, { kind: 'slides' }>
  /** Speak a summary once through the surface's output-live. */
  announce(text: string): void
}

export default function CompareSlides(_props: CompareSlidesProps): ReactElement | null {
  return null
}
