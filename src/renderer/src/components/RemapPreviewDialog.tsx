import type { ReactElement, ReactNode } from 'react'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { RemapNotice } from './ui/RemapNotice'
import { Banner } from './ui/Banner'
import type { ProjectChanges } from '../lib/remap'

/**
 * Preview before a connection switch or tier mapping change (spec 2.2). Rows are an estimate from the
 * renderer (the contract has no dry run); the real result follows as a notice with Undo.
 */
export default function RemapPreviewDialog({
  open,
  projects,
  busy,
  error,
  extra,
  confirmLabel = 'Apply and update roles',
  confirmDisabled,
  disabledReason,
  onCancel,
  onConfirm
}: {
  open: boolean
  projects: ProjectChanges[]
  busy?: boolean
  error?: string | null
  extra?: ReactNode
  confirmLabel?: string
  confirmDisabled?: boolean
  disabledReason?: string
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  const withChanges = projects.filter((p) => p.changes.length > 0)
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Apply this mapping?"
      size="md"
      testId="remap-preview"
      footer={
        <>
          <Button autoFocusDialog onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={confirmDisabled} title={disabledReason} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmDisabled && disabledReason && (
        <Banner tone="warning" title="Not available yet">
          {disabledReason}
        </Banner>
      )}
      {error && (
        <Banner tone="danger" title="Could not apply">
          {error}
        </Banner>
      )}
      {withChanges.length > 0 ? (
        <>
          <p>These roles will use different models:</p>
          <RemapNotice title="" projects={withChanges} readOnly />
        </>
      ) : (
        <p>No role changes models.</p>
      )}
      {extra}
      <p className="muted">This preview is computed from your current settings. The result is shown after applying, with Undo.</p>
    </Dialog>
  )
}
