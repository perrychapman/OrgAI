import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { useOrgChange } from './useOrgChange'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Textarea } from '../ui/Textarea'
import { useConfirm } from '../ui/ConfirmDialog'

/**
 * "Redesign with the Architect" dialog (spec docs/design/team-tab-overhaul.md 1.3). TeamView mounts it while open;
 * `onClose` returns focus to the Start from button (TeamView does that). The form logic lives in `useArchitectForm`
 * and `ArchitectFields`, which the tray's Design pane (DraftPanel) reuses, so there is one implementation.
 */
export interface ArchitectDialogProps {
  project: Project
  onClose: () => void
}

export interface ArchitectForm {
  liveRunId: string | null
  engagement: boolean
  cost: string
  revision: string
  setRevision: (v: string) => void
  busy: boolean
  error: string | null
  /** Starts the session (or sends into the open one). Resolves true when the run opened on Live. */
  submit: () => Promise<boolean>
  /** The confirm dialog for the empty full-review case; render it once. */
  confirmDialog: ReactNode
  primaryLabel: string
}

export function useArchitectForm(project: Project): ArchitectForm {
  const { liveRunId, revise } = useOrgChange(project)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const cost = mock ? '(mock, no tokens)' : '(spends tokens)'
  const engagement = projectKindOf(project) === 'engagement'
  const { confirm, dialog } = useConfirm()
  const [revision, setRevision] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<boolean> => {
    if (busy) return false
    const text = revision.trim()
    if (!text && !liveRunId) {
      const ok = await confirm({
        title: 'Review the whole project?',
        body: `With nothing written, the Architect reviews the ${engagement ? 'engagement' : 'repository'} and revises the ${engagement ? 'plan' : 'architecture document'}, org chart and settings. Starts an org change session ${cost}.`,
        confirmLabel: 'Start full review'
      })
      if (!ok) return false
    }
    setBusy(true)
    setError(null)
    try {
      // An ordinary setup run on Live (or, while one is open, a message to it); focus and the announcement follow there.
      await revise(text)
      setRevision('')
      return true
    } catch (e) {
      setError(cleanIpcError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    liveRunId,
    engagement,
    cost,
    revision,
    setRevision,
    busy,
    error,
    submit,
    confirmDialog: dialog,
    primaryLabel: busy ? (liveRunId ? 'Sending...' : 'Starting...') : liveRunId ? 'Send to the open session' : 'Start the Architect'
  }
}

/** The explanation, the textarea, the cost hint and the error line. */
export function ArchitectFields({ project, form, autoFocus }: { project: Project; form: ArchitectForm; autoFocus?: boolean }): ReactElement {
  const { liveRunId, engagement, cost } = form
  return (
    <div className="stack-2 architect-fields">
      <p className="rationale">
        Say what should change. The Architect reads the {engagement ? 'engagement' : 'repository'} and the current chart, then proposes the revised team. The
        session opens on Live and nothing changes until you approve.
        {liveRunId ? ' A session is open, so this goes to it.' : ' Leave it empty for a full review.'}
        {project.setup?.architecturePath ? ` The architecture document at ${project.setup.architecturePath} is revised too.` : ''}
      </p>
      <Textarea
        aria-label="What should change"
        rows={4}
        value={form.revision}
        onChange={form.setRevision}
        data-autofocus={autoFocus ? '' : undefined}
        placeholder='e.g. "Add a database specialist under the orchestrator, make the reviewer check accessibility, and move the researcher to the fast tier."'
      />
      <span className="hint">{liveRunId ? 'Empty opens the session.' : `Starts an org change session ${cost}.`}</span>
      {form.error && (
        <p className="capability-warn" role="alert">
          {form.error}
        </p>
      )}
    </div>
  )
}

export default function ArchitectDialog({ project, onClose }: ArchitectDialogProps): ReactElement {
  const form = useArchitectForm(project)
  const start = async (): Promise<void> => {
    if (await form.submit()) onClose()
  }
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="md"
        testId="architect-dialog"
        title="Redesign with the Architect"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={form.busy} testId="org-change-start" onClick={() => void start()}>
              {form.primaryLabel}
            </Button>
          </>
        }
      >
        <ArchitectFields project={project} form={form} autoFocus />
      </Dialog>
      {form.confirmDialog}
    </>
  )
}
