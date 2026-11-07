// Delete one or many outputs with the confirm of docs/design/outputs-2.md 12.4: deletePreview first, the wording follows
// what main reports, expectedVersionCount is the preview's count, and main's refusal is shown, never swallowed.
import type { ReactElement } from 'react'
import { useCallback } from 'react'
import type { OutputDeletePreview, RunOutput } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'
import { HIDDEN_OR_CONTROL_RUN, showHidden } from '../../lib/hiddenChars'
import { bulkDeleteCopy, deleteCopy } from '../../lib/outputVersions'
import { useConfirm } from '../ui/ConfirmDialog'
import '../../styles/outputs-versions.css'

export interface DeleteOutcome {
  /** Ids deleted. */
  deleted: string[]
  /** One plain sentence per refusal. */
  problems: string[]
  /** The list afterwards (main's last answer), for setOutputs. */
  list: RunOutput[] | null
}

const plainTitle = (s: string): string => s.replace(HIDDEN_OR_CONTROL_RUN, '').trim() || 'this output'

export function useDeleteOutputs(): {
  /** Confirms, then deletes. Resolves null when the user cancelled. */
  deleteOutputs(outputs: RunOutput[]): Promise<DeleteOutcome | null>
  /** Render once (the confirm dialog). */
  dialog: ReactElement | null
} {
  const { confirm, dialog } = useConfirm()

  const deleteOutputs = useCallback(
    async (outputs: RunOutput[]): Promise<DeleteOutcome | null> => {
      if (outputs.length === 0) return null
      const api = window.orgai.outputs
      const problems: string[] = []
      const previews: { output: RunOutput; preview: OutputDeletePreview }[] = []
      for (const output of outputs) {
        try {
          previews.push({ output, preview: await api.deletePreview({ projectId: output.projectId, outputId: output.id }) })
        } catch (e) {
          problems.push(`${plainTitle(output.title)}: ${cleanIpcError(e)}`)
        }
      }
      if (previews.length === 0) return { deleted: [], problems, list: null }

      let ok: boolean
      if (previews.length === 1) {
        const { output, preview } = previews[0]
        const c = deleteCopy(plainTitle(output.title), output, preview)
        ok = await confirm({
          title: c.title,
          body: (
            <p className="output-delete-body">
              {c.lead}
              {c.path !== undefined && (
                <>
                  {' '}
                  <code className="output-delete-path" data-testid="output-delete-path">
                    {showHidden(c.path)}
                  </code>
                </>
              )}
              {c.tail}
            </p>
          ),
          confirmLabel: c.confirmLabel,
          danger: true,
          confirmTestId: 'output-delete-confirm'
        })
      } else {
        const c = bulkDeleteCopy(previews.map((p) => p.preview))
        ok = await confirm({
          title: c.title,
          body: (
            <div className="output-delete-body">
              <p>{c.lead}</p>
              <ul className="output-delete-list" tabIndex={0} aria-label="Files to delete" data-testid="output-delete-list">
                {previews.map(({ output, preview }) => (
                  <li key={output.id}>
                    <span className="output-delete-name">{showHidden(output.title)}</span>
                    <code className="output-delete-path">{showHidden(preview.missing ? preview.relPath : preview.path)}</code>
                    {preview.outsideOutputsFolder && !preview.missing && <span className="output-delete-outside"> outside the outputs folder</span>}
                    {preview.missing && <span className="output-delete-outside"> file already gone</span>}
                  </li>
                ))}
              </ul>
            </div>
          ),
          confirmLabel: 'Delete',
          danger: true,
          confirmTestId: 'output-delete-confirm'
        })
      }
      if (!ok) return null

      const deleted: string[] = []
      let list: RunOutput[] | null = null
      for (const { output, preview } of previews) {
        try {
          list = await api.delete({ projectId: output.projectId, outputId: output.id, expectedVersionCount: preview.versions })
          deleted.push(output.id)
        } catch (e) {
          problems.push(`${plainTitle(output.title)}: ${cleanIpcError(e)}`)
        }
      }
      return { deleted, problems, list }
    },
    [confirm]
  )

  return { deleteOutputs, dialog }
}
