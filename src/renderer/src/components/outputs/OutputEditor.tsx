// STUB (Phase C seam): the in-app editor host (S5, docs/design/outputs-2.md 9) for markdown, text, csv, json, mermaid and
// svg. Owned by the editors engineer; keep the export and props. Reads useOutputDetail() (setDirty, registerSave, guard,
// announce, setMode) and the store's outputDrafts.
import type { ReactElement } from 'react'

export interface OutputEditorProps {
  /** Close the editor (the host returns to the preview; the editor asks first when dirty). */
  onClose(): void
}

export default function OutputEditor(_props: OutputEditorProps): ReactElement | null {
  return null
}
