import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { EngagementNote, EngagementNoteContent } from '@shared/types'
import { ENGAGEMENT_NOTE_MAX_CHARS, ENGAGEMENT_NOTE_TITLE_MAX_CHARS } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useConfirm } from '../ui/ConfirmDialog'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

/**
 * The context note add / edit dialog (docs/design/knowledge.md section 4; moved out of ContextNotesSection with its
 * behaviour and testIds). Mounted only while open, so its fields start fresh each time. `saveNote` is called with
 * `retired` untouched; `onSaved` gets the saved note so the caller can focus its row.
 */
export default function NoteDialog({
  projectId,
  note,
  onClose,
  onSaved
}: {
  projectId: string
  /** The note being edited (with its text), or null for a new one. */
  note: EngagementNoteContent | null
  onClose: () => void
  onSaved: (saved: EngagementNote) => void
}): ReactElement {
  const uid = useId()
  const { confirm, dialog } = useConfirm()
  const [title, setTitle] = useState(note?.title ?? '')
  const [text, setText] = useState(note?.text ?? '')
  const [saving, setSaving] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [textError, setTextError] = useState<string | null>(null)
  const focusText = (): void => document.getElementById(`${uid}-text`)?.focus()
  const dirty = title !== (note?.title ?? '') || text !== (note?.text ?? '')
  const over = text.length > ENGAGEMENT_NOTE_MAX_CHARS

  const close = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: 'Discard this note?', body: 'What you typed is not saved.', confirmLabel: 'Discard', danger: true }))) return
    onClose()
  }

  const save = async (): Promise<void> => {
    setTitleError(null)
    setTextError(null)
    if (title.trim() === '') {
      setTitleError('Give the note a title.')
      document.getElementById(`${uid}-title`)?.focus()
      return
    }
    if (over) {
      setTextError(`Too long: ${text.length.toLocaleString()} of ${ENGAGEMENT_NOTE_MAX_CHARS.toLocaleString()} characters.`)
      focusText()
      return
    }
    setSaving(true)
    try {
      const saved = await window.orgai.engagement.saveNote({ projectId, ...(note ? { noteId: note.id } : {}), title: title.trim(), text })
      onSaved(saved)
    } catch (e) {
      setSaving(false)
      setTextError(cleanIpcError(e))
      requestAnimationFrame(focusText)
    }
  }

  return (
    <>
      <Dialog
        open
        size="lg"
        onClose={() => void close()}
        title={note ? `Edit ${note.title}` : 'Add a note'}
        testId="context-note-dialog"
        footer={
          <>
            <Button onClick={() => void close()}>Cancel</Button>
            <Button variant="primary" loading={saving} testId="context-note-save" onClick={() => void save()}>
              Save note
            </Button>
          </>
        }
      >
        <div className="note-form">
          <div className="field">
            <label htmlFor={`${uid}-title`}>Title</label>
            <Input
              id={`${uid}-title`}
              data-autofocus=""
              value={title}
              maxLength={ENGAGEMENT_NOTE_TITLE_MAX_CHARS}
              required
              invalid={!!titleError}
              aria-describedby={titleError ? `${uid}-title-msg` : undefined}
              data-testid="context-note-title"
              onChange={(v) => {
                setTitle(v)
                setTitleError(null)
              }}
            />
            {titleError && (
              <span id={`${uid}-title-msg`} className="field-msg error" role="alert">
                {titleError}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${uid}-text`}>Text</label>
            <Textarea
              id={`${uid}-text`}
              rows={14}
              value={text}
              invalid={over || !!textError}
              aria-describedby={`${uid}-text-msg`}
              data-testid="context-note-text"
              onChange={(v) => {
                setText(v)
                setTextError(null)
              }}
            />
            <span id={`${uid}-text-msg`} className={`field-msg${over || textError ? ' error' : ''}`} role={textError ? 'alert' : undefined}>
              {textError ?? `${text.length.toLocaleString()} of ${ENGAGEMENT_NOTE_MAX_CHARS.toLocaleString()} characters`}
            </span>
          </div>
        </div>
      </Dialog>
      {dialog}
    </>
  )
}
