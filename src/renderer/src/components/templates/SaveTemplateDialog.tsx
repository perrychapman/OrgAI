import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { ORG_TEMPLATE_DESCRIPTION_MAX_CHARS, ORG_TEMPLATE_NAME_MAX_CHARS } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { defaultTemplateName, duplicateTemplate, isNameTakenError, localItemsLine, whatGoesIn } from '../../lib/templates'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

/**
 * Team tab: "Save this team as a template" (engagement-2 section 3). Saving closes the dialog through onSaved(name);
 * a taken name shows a field error and a secondary "Replace it" beside the primary "Save template".
 */
export default function SaveTemplateDialog({
  project,
  onClose,
  onSaved
}: {
  project: Project
  onClose: () => void
  onSaved: (name: string) => void
}): ReactElement {
  const uid = useId()
  const templates = useAppStore((s) => s.templates)
  const saveTemplate = useAppStore((s) => s.saveTemplate)
  const removeTemplate = useAppStore((s) => s.removeTemplate)
  const [name, setName] = useState(() => defaultTemplateName(project.name, ORG_TEMPLATE_NAME_MAX_CHARS))
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    if (useAppStore.getState().templates === null) void useAppStore.getState().loadTemplates()
  }, [])

  const trimmed = name.trim()
  const taken = duplicateTemplate(templates, trimmed)
  // Main may refuse a name the list did not show (another window saved it): the same field error, found by its words.
  const takenByMain = !taken && refusal !== null && isNameTakenError(refusal)
  const nameTaken = !!taken || takenByMain
  const goes = whatGoesIn(project)
  const localLine = localItemsLine(project)
  const nameErrorId = `${uid}-name-err`
  const otherError = refusal && !takenByMain ? refusal : null

  const save = async (replace: boolean): Promise<void> => {
    if (busy || !trimmed) return
    if (taken && !replace) {
      document.getElementById(`${uid}-name`)?.focus()
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      if (replace && taken) await removeTemplate(taken.id)
      await saveTemplate({ projectId: project.id, name: trimmed, ...(description.trim() ? { description: description.trim() } : {}) })
      onSaved(trimmed)
    } catch (e) {
      const message = cleanIpcError(e)
      setRefusal(message)
      // The list was stale: reload it so "Replace it" can find the template that holds the name.
      if (isNameTakenError(message)) void useAppStore.getState().loadTemplates()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      testId="template-save-dialog"
      title="Save this team as a template"
      description="Start new projects with this team. You can remove templates in App settings."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {nameTaken && (
            <Button testId="template-replace" onClick={() => void save(true)} disabled={busy || !trimmed || !taken}>
              Replace it
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={!trimmed} testId="template-save-confirm" onClick={() => void save(false)}>
            Save template
          </Button>
        </>
      }
    >
      <div className="template-form">
        <div className="field">
          <label htmlFor={`${uid}-name`}>Name</label>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={ORG_TEMPLATE_NAME_MAX_CHARS}
            required
            onChange={(v) => {
              setName(v)
              setRefusal(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save(false)
              }
            }}
            invalid={nameTaken}
            aria-describedby={nameTaken ? nameErrorId : undefined}
            data-autofocus=""
            data-testid="template-name"
          />
          {nameTaken && (
            <span id={nameErrorId} className="field-msg error" role="alert">
              You already have a template named {trimmed}.
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-description`}>Description (optional)</label>
          <Textarea
            id={`${uid}-description`}
            rows={2}
            value={description}
            maxLength={ORG_TEMPLATE_DESCRIPTION_MAX_CHARS}
            onChange={setDescription}
            data-testid="template-description"
          />
        </div>
        <div className="template-goes-in">
          <h3 className="template-goes-in-title">What goes in</h3>
          <ul>
            {goes.included.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="muted">{goes.excluded}</p>
        </div>
        {localLine && (
          <Banner tone="warning" testId="template-local-items">
            {localLine}
          </Banner>
        )}
        {otherError && (
          <p className="field-msg error" role="alert" data-testid="template-save-error">
            {otherError}
          </p>
        )}
      </div>
    </Dialog>
  )
}
