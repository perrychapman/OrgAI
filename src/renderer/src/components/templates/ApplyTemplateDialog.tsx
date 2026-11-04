import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { OrgTemplateInfo, Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { groupTemplatesByKind, kindNote, roleNamesLine, templateKindLabel } from '../../lib/templates'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

/**
 * Team tab: "Replace the team with a template" (engagement-2 section 3). A radio list, this kind's templates first,
 * then "Other kinds". The store applies it (mode 'replace') and records the Undo notice; the Team tab fits the chart.
 */
export default function ApplyTemplateDialog({
  project,
  onClose,
  onApplied
}: {
  project: Project
  onClose: () => void
  onApplied: () => void
}): ReactElement {
  const uid = useId()
  const projectKind = project.kind ?? 'code'
  const templates = useAppStore((s) => s.templates)
  const applyTemplate = useAppStore((s) => s.applyTemplate)
  const list = templates ?? []
  const groups = groupTemplatesByKind(list, projectKind)
  const [chosen, setChosen] = useState<string>(() => (groups.same[0] ?? groups.other[0])?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (useAppStore.getState().templates === null) void useAppStore.getState().loadTemplates()
  }, [])

  const selected = list.find((t) => t.id === chosen)
  const note = selected ? kindNote(selected.kind, projectKind) : null
  const noteId = `${uid}-note`

  const apply = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      await applyTemplate(project.id, { id: selected.id, name: selected.name })
      onApplied()
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  const option = (t: OrgTemplateInfo): ReactElement => (
    <label key={t.id} className="template-option" data-testid="template-option" data-template={t.id}>
      <input
        type="radio"
        name={`${uid}-template`}
        value={t.id}
        checked={chosen === t.id}
        onChange={() => {
          setChosen(t.id)
          setError(null)
        }}
        aria-describedby={chosen === t.id && note ? noteId : undefined}
        data-autofocus={chosen === t.id ? '' : undefined}
      />
      <span className="template-option-name">{t.name}</span>
      {t.description && <span className="template-option-desc muted">{t.description}</span>}
      <span className="template-option-meta muted">
        {roleNamesLine(t)} · {templateKindLabel(t.kind)}
      </span>
    </label>
  )

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      testId="template-apply-dialog"
      title="Replace the team with a template"
      description="The current roles are replaced. You can undo until you edit the chart."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!selected} testId="template-apply-confirm" onClick={() => void apply()}>
            Replace team
          </Button>
        </>
      }
    >
      <div className="template-form">
        <fieldset className="template-options">
          <legend>Templates</legend>
          {groups.same.map(option)}
          {groups.other.length > 0 && groups.same.length > 0 && <p className="template-divider muted">Other kinds</p>}
          {groups.other.map(option)}
        </fieldset>
        {note && (
          <p id={noteId} className="hint" data-testid="template-kind-note">
            {note}
          </p>
        )}
        {error && (
          <p className="field-msg error" role="alert" data-testid="template-apply-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
