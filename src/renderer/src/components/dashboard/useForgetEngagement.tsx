import type { ReactElement } from 'react'
import { useCallback } from 'react'
import type { Project, ProjectRemoveResult } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { forgetConfirmText, forgetNoticeText, removeConfirmLabel } from '../../lib/dashboard'
import { folderName } from '../../lib/paths'
import { useConfirm } from '../ui/ConfirmDialog'

/** The forget confirm's body: what goes (from the dry-run counts), what stays, and that it cannot be undone. */
export function ForgetConfirmBody({ preview, openRuns, folder }: { preview: ProjectRemoveResult | null; openRuns: number; folder: string }): ReactElement {
  const text = forgetConfirmText(preview, openRuns, folder)
  return (
    <div className="forget-confirm-body" data-testid="forget-confirm">
      {text.uncounted ? (
        <>
          <p>Deletes {text.uncounted}.</p>
          <p className="forget-confirm-quiet">OrgAI could not count them first.</p>
        </>
      ) : text.lines.length > 0 ? (
        <>
          <p>Deletes:</p>
          <ul>
            {text.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>Nothing else is kept for it.</p>
      )}
      <p>{text.stays}</p>
      <p>This cannot be undone.</p>
    </div>
  )
}

export type ForgetOutcome = { status: 'cancelled' } | { status: 'done'; result: ProjectRemoveResult; notice: string } | { status: 'error'; message: string }

/**
 * Forget an engagement: a dry-run count, the danger confirm, the delete and the Dashboard notice (store
 * `forgetNotice`). The caller moves focus and announces; a failure navigates nowhere.
 */
export function useForgetEngagement(): { forget: (project: Project, openRuns: number) => Promise<ForgetOutcome>; dialog: ReactElement } {
  const { confirm, dialog } = useConfirm()
  const removeProject = useAppStore((s) => s.removeProject)
  const setForgetNotice = useAppStore((s) => s.setForgetNotice)
  const forget = useCallback(
    async (project: Project, openRuns: number): Promise<ForgetOutcome> => {
      let preview: ProjectRemoveResult | null = null
      try {
        preview = await window.orgai.projectRemoval.preview(project.id)
      } catch {
        preview = null
      }
      const ok = await confirm({
        title: `Forget ${project.name}?`,
        body: <ForgetConfirmBody preview={preview} openRuns={openRuns} folder={folderName(project.path)} />,
        confirmLabel: removeConfirmLabel('engagement'),
        danger: true
      })
      if (!ok) return { status: 'cancelled' }
      try {
        const result = await removeProject(project.id)
        const notice = forgetNoticeText(project.name, result)
        setForgetNotice({ name: project.name, result })
        return { status: 'done', result, notice }
      } catch (err) {
        return { status: 'error', message: cleanIpcError(err) }
      }
    },
    [confirm, removeProject, setForgetNotice]
  )
  return { forget, dialog }
}
