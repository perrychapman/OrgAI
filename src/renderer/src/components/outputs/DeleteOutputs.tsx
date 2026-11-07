// STUB (Phase C seam): delete one or many outputs with the confirm of docs/design/outputs-2.md 12.4 (deletePreview,
// expectedVersionCount). Owned by the versions engineer; keep the export and its result shape.
import type { ReactElement } from 'react'
import type { RunOutput } from '@shared/types'

export interface DeleteOutcome {
  /** Ids deleted. */
  deleted: string[]
  /** One plain sentence per refusal. */
  problems: string[]
  /** The list afterwards (main's last answer), for setOutputs. */
  list: RunOutput[] | null
}

export function useDeleteOutputs(): {
  /** Confirms, then deletes. Resolves null when the user cancelled. */
  deleteOutputs(outputs: RunOutput[]): Promise<DeleteOutcome | null>
  /** Render once (the confirm dialog). */
  dialog: ReactElement | null
} {
  return { deleteOutputs: async () => null, dialog: null }
}
