import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { ProjectChanges } from '../../lib/remap'
import { Banner } from './Banner'
import { Button } from './Button'
import { Icon } from './Icon'

export interface RemapProjectEntry extends ProjectChanges {
  undo?: 'available' | 'busy' | 'reverted' | 'error' | 'gone'
  undoError?: string
}

/** Role rows: role name, then from -> to. */
export function RemapRoleRows({ changes }: { changes: ProjectChanges['changes'] }): ReactElement {
  return (
    <ul className="remap-roles">
      {changes.map((c) => (
        <li key={c.roleId}>
          <span className="remap-role">{c.roleName}</span>
          <span className="remap-from mono">{c.from}</span>
          <span className="remap-arrow">
            <Icon icon={ArrowRight} size="xs" />
          </span>
          {c.unmapped ? (
            <span className="remap-to mono warn" title={c.reason}>
              <Icon icon={TriangleAlert} size="xs" /> Inherit
            </span>
          ) : (
            <span className="remap-to mono">{c.to}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function ProjectEntry({
  entry,
  expanded,
  onUndo,
  readOnly
}: {
  entry: RemapProjectEntry
  expanded: boolean
  onUndo?: () => void
  readOnly?: boolean
}): ReactElement {
  const [open, setOpen] = useState(expanded)
  const n = entry.changes.length
  return (
    <div className="remap-project">
      <div className="remap-project-head">
        <button type="button" className="remap-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
          <strong>{entry.projectName}</strong>
          <span className="muted">
            {n} role{n === 1 ? '' : 's'}
          </span>
        </button>
        {!readOnly && entry.undo === 'reverted' && (
          <span className="remap-reverted">
            <Icon icon={Check} size="sm" /> Reverted
          </span>
        )}
        {!readOnly && entry.undo && entry.undo !== 'reverted' && entry.undo !== 'gone' && (
          <Button
            size="sm"
            variant="ghost"
            loading={entry.undo === 'busy'}
            onClick={onUndo}
            testId="remap-undo"
            title={`Restore the previous models for ${entry.projectName}`}
          >
            {entry.undo === 'error' ? 'Retry undo' : 'Undo'}
          </Button>
        )}
      </div>
      {entry.undo === 'error' && <p className="invalid-text remap-error">{entry.undoError}</p>}
      {open && entry.undo !== 'reverted' && <RemapRoleRows changes={entry.changes} />}
    </div>
  )
}

/** The model-change Banner (spec 2.1). Without onUndo/onDismiss it is the read-only list used in the preview dialog. */
export function RemapNotice({
  title,
  projects,
  onUndo,
  onDismiss,
  readOnly,
  children
}: {
  title: string
  projects: RemapProjectEntry[]
  onUndo?: (projectId: string) => void
  onDismiss?: () => void
  readOnly?: boolean
  children?: ReactNode
}): ReactElement {
  const hasUnmapped = projects.some((p) => p.changes.some((c) => c.unmapped))
  const body = (
    <div className="remap-list">
      {projects.map((p) => (
        <span key={p.projectId} data-project={p.projectId} style={{ display: 'contents' }}>
          <ProjectEntry entry={p} expanded={projects.length <= 2 || !!readOnly} onUndo={() => onUndo?.(p.projectId)} readOnly={readOnly} />
        </span>
      ))}
      {children}
    </div>
  )
  if (readOnly) return <div className="remap-readonly">{body}</div>
  return (
    <Banner tone={hasUnmapped ? 'warning' : 'info'} title={title} label="Model changes" onDismiss={onDismiss} testId="remap-notice">
      {body}
    </Banner>
  )
}
