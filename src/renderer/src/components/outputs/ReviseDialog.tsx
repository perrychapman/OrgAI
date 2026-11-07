// STUB (Phase C seam): "Ask the team to revise <title>" (docs/design/outputs-2.md 11.4). Owned by the revise engineer, who
// replaces this body; keep the export and props. Usable outside a detail (transcript row, project row menu, diagram error).
import type { ReactElement } from 'react'
import type { OutputReviseResult, RunOutput } from '@shared/types'
import type { ReviseInit } from './outputDetailContext'

export interface ReviseDialogProps {
  output: RunOutput
  /** The version the user is looking at (default: current). */
  version?: number
  init?: ReviseInit
  /** Unsaved editor changes block Send and offer "Save your edits first" through onSaveFirst. */
  dirty?: boolean
  onSaveFirst?: () => Promise<boolean>
  /** Closed; `result` is the successful answer (the dialog shows refusals itself and stays open). */
  onClose(result: OutputReviseResult | null): void
}

export default function ReviseDialog(_props: ReviseDialogProps): ReactElement | null {
  return null
}
