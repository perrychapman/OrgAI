import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { RunSummary } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { cleanIpcError } from '../../lib/ipcError'
import { SAVE_AS_PROJECT_PERMISSIONS_NOTE } from '../../lib/chatPermissions'
import { PROMOTE_NAME_LIMIT, promoteName, promoteNameError } from '../../lib/assistants'

/**
 * Save a Chat as a project. Mount it only while open (state starts fresh). A rejection stays inline; an existing
 * project for the folder swaps the body to an "Open <name>" offer.
 */
export default function SaveAsProjectDialog({ summary, onClose }: { summary: RunSummary; onClose: () => void }): ReactElement {
  const promoteQuick = useAppStore((s) => s.promoteQuick)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const [name, setName] = useState(() => promoteName(summary))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState<{ projectId: string; name: string } | null>(null)
  const nameId = useId()
  const errId = useId()
  const nameError = promoteNameError(name)

  const save = async (): Promise<void> => {
    if (nameError || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await promoteQuick(summary.id, name.trim())
      if (res.kind === 'created') onClose()
      else setExisting({ projectId: res.projectId, name: res.name })
    } catch (e) {
      setError(cleanIpcError(e, 'Could not save this chat as a project.'))
    } finally {
      setBusy(false)
    }
  }
  const openExisting = async (): Promise<void> => {
    if (!existing) return
    onClose()
    await openProject(existing.projectId)
    setView('run')
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as project"
      size="sm"
      testId="save-as-project-dialog"
      footer={
        existing ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" autoFocusDialog onClick={() => void openExisting()}>
              {`Open ${existing.name}`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!!nameError} onClick={() => void save()} testId="save-as-project-confirm">
              Save as project
            </Button>
          </>
        )
      }
    >
      {existing ? (
        <p>
          This folder is already the project <strong>{existing.name}</strong>.
        </p>
      ) : (
        <form
          className="save-project"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="field">
            <label htmlFor={nameId}>Project name</label>
            <Input id={nameId} value={name} onChange={setName} maxLength={PROMOTE_NAME_LIMIT} required autoFocus invalid={!!error} aria-describedby={error ? errId : undefined} />
          </div>
          {summary.quick && (
            <div className="field">
              <span className="field-label">Folder</span>
              <div className="mono-dim save-project-folder" title={summary.quick.folder}>
                {summary.quick.folder}
              </div>
            </div>
          )}
          <p className="muted">Creates a project with the default team and moves this chat and its earlier turns into it.</p>
          <p className="muted" data-testid="save-as-project-permissions-note">
            {SAVE_AS_PROJECT_PERMISSIONS_NOTE}
          </p>
          {error && (
            <p id={errId} role="alert" className="field-error">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  )
}
