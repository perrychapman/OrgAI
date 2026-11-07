// STUB (Phase C seam): the Notes tab / drawer (docs/design/outputs-2.md 11.3). Owned by the notes engineer, who replaces
// this body; keep the export and props. Reads everything from useOutputDetail().
import type { ReactElement } from 'react'

export interface NotesPanelProps {
  /** 'tab' inside the detail (S3), 'drawer' in the Larger view (S4). */
  variant: 'tab' | 'drawer'
}

export default function NotesPanel(_props: NotesPanelProps): ReactElement | null {
  return null
}
