import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { EngagementNote, EngagementNoteContent, Project } from '@shared/types'
import { ENGAGEMENT_NOTES_MAX, ENGAGEMENT_NOTE_MAX_CHARS, ENGAGEMENT_NOTE_TITLE_MAX_CHARS } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { cleanIpcError } from '../../lib/ipcError'
import { idAfterNoteRemoval, noteEditedLabel, noteSizeLabel, notesCountLine, sortNotes } from '../../lib/engagementContext'
import { projectNoun } from '../../lib/projectKindCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useConfirm } from '../ui/ConfirmDialog'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { SettingsSection } from './SettingsSection'

function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()))
}

/** The add / edit dialog. Mounted only while open, so its fields start fresh each time. */
function NoteDialog({
  projectId,
  note,
  onClose,
  onSaved
}: {
  projectId: string
  /** The note being edited (with its text), or null for a new one. */
  note: EngagementNoteContent | null
  onClose: () => void
  onSaved: () => void
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
      await window.orgai.engagement.saveNote({ projectId, ...(note ? { noteId: note.id } : {}), title: title.trim(), text })
      onSaved()
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

/** Project settings > General > Context notes (engagements only; engagement-2 spec 5). */
export function ContextNotesSection({ project }: { project: Project }): ReactElement {
  const { confirm, dialog } = useConfirm()
  const noun = projectNoun(projectKindOf(project))
  const [notes, setNotes] = useState<EngagementNote[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogNote, setDialogNote] = useState<{ note: EngagementNoteContent | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const addButton = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid=context-note-add]')

  const load = useCallback(async (): Promise<void> => {
    try {
      setNotes(sortNotes(await window.orgai.engagement.listNotes(project.id)))
      setError(null)
    } catch (e) {
      setError(cleanIpcError(e))
      setNotes((n) => n ?? [])
    }
  }, [project.id])

  useEffect(() => {
    setNotes(null)
    setStatus('')
    setDialogNote(null)
    void load()
    return window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId === project.id && ev.what === 'notes') void load()
    })
  }, [project.id, load])

  const full = (notes?.length ?? 0) >= ENGAGEMENT_NOTES_MAX
  const fullId = `${project.id}-notes-full`

  const edit = async (n: EngagementNote): Promise<void> => {
    setBusy(n.id)
    setError(null)
    try {
      setDialogNote({ note: await window.orgai.engagement.getNote({ projectId: project.id, noteId: n.id }) })
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (n: EngagementNote): Promise<void> => {
    const ok = await confirm({ title: `Remove the note ${n.title}?`, body: 'Agents can no longer read it. This cannot be undone.', confirmLabel: 'Remove note', danger: true })
    if (!ok) return
    const ids = (notes ?? []).map((x) => x.id)
    try {
      const next = sortNotes(await window.orgai.engagement.removeNote({ projectId: project.id, noteId: n.id }))
      setNotes(next)
      setStatus('Note removed.')
      const after = idAfterNoteRemoval(ids, n.id)
      focusLater(() => (after ? document.querySelector<HTMLElement>(`[data-testid=context-note-row][data-note="${CSS.escape(after)}"] [data-testid=context-note-edit]`) : null) ?? addButton())
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }

  return (
    <SettingsSection
      id={PROJECT_SETTINGS_SECTIONS.contextNotes}
      title="Context notes"
      testId="context-notes-section"
      description="Background the team can look up when it needs it: meeting notes, client preferences, terms. Agents read these notes; do not put passwords or keys here."
      actions={
        <div className="notes-add">
          <Button icon={Plus} disabled={full} ariaDescribedBy={full ? fullId : undefined} testId="context-note-add" onClick={() => setDialogNote({ note: null })}>
            Add a note
          </Button>
          {full && (
            <span id={fullId} className="settings-quiet">
              {ENGAGEMENT_NOTES_MAX} notes is the most {noun === 'engagement' ? 'an' : 'a'} {noun} can keep. Remove one to add another.
            </span>
          )}
        </div>
      }
    >
      {error && (
        <Banner tone="danger" title="Context notes" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notes === null ? (
        <p className="settings-quiet">Looking…</p>
      ) : notes.length === 0 ? (
        <p className="settings-card-note notes-empty" data-testid="context-notes-empty">
          No notes yet. Add what the team should know but would not find in your folders.
        </p>
      ) : (
        <>
          <ul className="notes-list" aria-label="Context notes">
            {notes.map((n) => (
              <li key={n.id} className="notes-row" data-testid="context-note-row" data-note={n.id}>
                <div className="notes-row-main">
                  <span className="notes-row-title" title={n.title}>
                    {n.title}
                  </span>
                  <span className="notes-row-meta">
                    {noteSizeLabel(n.chars)} · {noteEditedLabel(n.updatedAt)}
                  </span>
                </div>
                <div className="notes-row-actions">
                  <Button size="sm" disabled={busy === n.id} testId="context-note-edit" ariaLabel={`Edit ${n.title}`} onClick={() => void edit(n)}>
                    Edit
                  </Button>
                  <IconButton icon={Trash2} size="sm" label={`Remove note ${n.title}`} testId="context-note-remove" onClick={() => void remove(n)} />
                </div>
              </li>
            ))}
          </ul>
          <p className="settings-quiet">{notesCountLine(notes.length, ENGAGEMENT_NOTES_MAX)}</p>
        </>
      )}
      <p role="status" className="sr-only" data-testid="context-notes-status">
        {status}
      </p>
      {dialogNote && (
        <NoteDialog
          key={dialogNote.note?.id ?? 'new'}
          projectId={project.id}
          note={dialogNote.note}
          onClose={() => setDialogNote(null)}
          onSaved={() => {
            const wasNew = dialogNote.note === null
            setDialogNote(null)
            setStatus('Note saved.')
            void load().then(() => {
              if (wasNew) focusLater(addButton)
            })
          }}
        />
      )}
      {dialog}
    </SettingsSection>
  )
}
