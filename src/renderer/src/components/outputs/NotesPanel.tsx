// The Notes tab / drawer (docs/design/outputs-2.md 11.3): the viewed version's notes first, a collapsed group for the other
// versions, Show in output / Resolve / Edit / Delete per note, a checkbox per open note and "Revise with N notes".
import type { ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import type { OutputNote } from '@shared/types'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Textarea } from '../ui/Textarea'
import { useConfirm } from '../ui/ConfirmDialog'
import { useRunIndexes } from '../../store/useAppStore'
import { runTag } from '../../lib/runLabels'
import { NOTE_COUNTER_FROM, anchorDescription, countsLine, emptyNotesText, filterNotes, noteStamp, noteStyleOf, noteTextProblem, pinNumbers, reviseLabel, type NoteFilter } from '../../lib/outputNotes'
import { OUTPUT_NOTE_TEXT_MAX } from '@shared/types'
import { notesOfVersion, useOutputDetail, type OutputDetailValue } from './outputDetailContext'
import { useOutputRevisions } from './useOutputData'
import NoteComposer from './NoteComposer'
import '../../styles/outputs-notes.css'

export interface NotesPanelProps {
  /** 'tab' inside the detail (S3), 'drawer' in the Larger view (S4). */
  variant: 'tab' | 'drawer'
}

const FILTERS: { value: NoteFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' }
]

function plainError(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : fallback
}

export default function NotesPanel({ variant }: NotesPanelProps): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx) return null
  return <Panel ctx={ctx} variant={variant} />
}

function Panel({ ctx, variant }: { ctx: OutputDetailValue; variant: 'tab' | 'drawer' }): ReactElement {
  const uid = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const wholeBtn = useRef<HTMLDivElement>(null)
  const { confirm, dialog } = useConfirm()
  const indexes = useRunIndexes()
  const revisions = useOutputRevisions({ projectId: ctx.output.projectId, outputId: ctx.output.id }).data
  const [filter, setFilter] = useState<NoteFilter>('open')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [wholeOpen, setWholeOpen] = useState(false)
  const [error, setError] = useState('')

  const all = ctx.notes
  const viewed = useMemo(() => notesOfVersion(all, ctx.version), [all, ctx.version])
  const others = useMemo(() => (all ?? []).filter((n) => n.version !== ctx.version), [all, ctx.version])
  const pins = useMemo(() => pinNumbers(viewed, ctx.version), [viewed, ctx.version])
  const shown = filterNotes(viewed, filter)
  const otherShown = filterNotes(others, filter)
  const openIds = viewed.filter((n) => n.status === 'open').map((n) => n.id)
  const selIds = openIds.filter((id) => picked.has(id))
  const kind = ctx.output.kind
  const canNote = noteStyleOf(kind) !== 'none'
  const otherOpen = others.filter((n) => n.status !== 'resolved').length

  const call = async (what: () => Promise<unknown>, said: string, failed: string): Promise<boolean> => {
    setError('')
    try {
      await what()
      ctx.reloadNotes()
      if (said) ctx.announce(said)
      return true
    } catch (e) {
      setError(plainError(e, failed))
      return false
    }
  }
  const api = window.orgai?.outputs
  const ref = { projectId: ctx.output.projectId, outputId: ctx.output.id }

  const toggle = (id: string): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const show = (n: OutputNote, btn: HTMLElement | null): void => {
    if (n.version !== ctx.version) ctx.setVersion(n.version === ctx.currentVersion ? null : n.version)
    if (variant === 'tab') ctx.setTab('preview')
    ctx.showNote(null)
    window.requestAnimationFrame(() => {
      ctx.showNote(n.id)
      if (variant === 'drawer') window.setTimeout(() => btn?.focus(), 0)
    })
  }

  const sentLabel = (n: OutputNote): string | null => {
    if (!n.sentIn) return n.status === 'sent' ? 'Sent to the team' : null
    const answered = ctx.versions?.find((v) => v.answers === n.sentIn)
    if (answered) return `Sent · answered in version ${answered.n}`
    const rev = revisions?.find((r) => r.id === n.sentIn)
    return rev ? `Sent in ${runTag(indexes.get(rev.runId))}` : 'Sent to the team'
  }

  const row = (n: OutputNote, mine: boolean): ReactElement => {
    const isEditing = editing === n.id
    const problem = isEditing ? noteTextProblem(draftText) : null
    const sent = sentLabel(n)
    const resolved = n.status === 'resolved'
    return (
      <li key={n.id} className="output-note" data-testid="output-note" data-id={n.id} data-status={n.status} data-version={n.version} aria-current={ctx.shownNote === n.id ? 'true' : undefined}>
        <span className="output-note-pin" aria-hidden="true">
          {mine ? pins.get(n.id) : `v${n.version}`}
        </span>
        <p className="output-note-where">
          {mine && <span className="sr-only">Note {pins.get(n.id)}: </span>}
          {anchorDescription(n.anchor)}
          {!mine && <span className="output-note-meta"> on version {n.version}</span>}
        </p>
        {isEditing ? (
          <div className="output-note-edit" onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setEditing(null)
              window.setTimeout(() => document.querySelector<HTMLElement>(`[data-id="${n.id}"] [data-testid="output-note-edit"]`)?.focus(), 0)
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void saveEdit(n)
            }
          }}>
            <label className="sr-only" htmlFor={`${uid}-${n.id}`}>
              Note text
            </label>
            <Textarea id={`${uid}-${n.id}`} value={draftText} onChange={setDraftText} rows={3} invalid={Boolean(problem)} data-testid="output-note-edit-text" autoFocus />
            {(problem || draftText.length >= NOTE_COUNTER_FROM) && (
              <p className="output-note-help">{problem ?? `${draftText.length.toLocaleString('en-US')} of ${OUTPUT_NOTE_TEXT_MAX.toLocaleString('en-US')}`}</p>
            )}
            <div className="output-note-actions">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" testId="output-note-edit-save" inert={!draftText.trim() || Boolean(problem)} onClick={() => void saveEdit(n)}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="output-note-body output-note-text">{n.text}</p>
        )}
        <p className="output-note-meta">
          <span>You · {noteStamp(n.createdAt)}</span>
          {resolved && <span>Resolved</span>}
          {sent && (
            <span className="badge" data-testid="output-note-sent">
              {sent}
            </span>
          )}
        </p>
        {mine && n.status === 'open' && openIds.length > 0 && (
          <label className="output-note-select">
            <input type="checkbox" checked={picked.has(n.id)} onChange={() => toggle(n.id)} data-testid="output-note-select" />
            <span>Include in the revision</span>
          </label>
        )}
        {!isEditing && (
          <div className="output-note-btns">
            <Button size="sm" variant="ghost" testId="output-note-show" onClick={() => show(n, document.querySelector<HTMLElement>(`[data-id="${n.id}"] [data-testid="output-note-show"]`))}>
              {mine ? 'Show in output' : `Show on version ${n.version}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              testId="output-note-resolve"
              onClick={() => void call(() => api!.noteUpdate({ ...ref, noteId: n.id, status: resolved ? 'open' : 'resolved' }), resolved ? 'Note reopened.' : 'Note resolved.', 'The note could not be changed.')}
            >
              {resolved ? 'Reopen' : 'Resolve'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              testId="output-note-edit"
              onClick={() => {
                setEditing(n.id)
                setDraftText(n.text)
              }}
            >
              Edit
            </Button>
            <Button size="sm" variant="ghost" testId="output-note-delete" onClick={() => void remove(n)}>
              Delete
            </Button>
          </div>
        )}
      </li>
    )
  }

  const saveEdit = async (n: OutputNote): Promise<void> => {
    if (!api || !draftText.trim() || noteTextProblem(draftText)) return
    const ok = await call(() => api.noteUpdate({ ...ref, noteId: n.id, text: draftText.trim() }), 'Note updated.', 'The note could not be saved.')
    if (ok) {
      setEditing(null)
      window.setTimeout(() => document.querySelector<HTMLElement>(`[data-id="${n.id}"] [data-testid="output-note-edit"]`)?.focus(), 0)
    }
  }
  const remove = async (n: OutputNote): Promise<void> => {
    if (!api) return
    const yes = await confirm({ title: 'Delete this note?', body: 'The note is removed from this version. This cannot be undone.', confirmLabel: 'Delete note', danger: true, confirmTestId: 'output-note-delete-confirm' })
    if (!yes) return
    const ok = await call(() => api.noteRemove({ ...ref, noteId: n.id }), 'Note deleted.', 'The note could not be deleted.')
    if (ok) {
      setPicked((s) => {
        const next = new Set(s)
        next.delete(n.id)
        return next
      })
      window.setTimeout(() => heading.current?.focus(), 0)
    }
  }

  const rootProps = variant === 'drawer' ? { 'data-testid': 'output-notes-drawer' } : { 'data-testid': 'output-notes' }
  const empty = viewed.length === 0
  return (
    <section className="output-notes" data-variant={variant} aria-labelledby={`${uid}-h`} {...rootProps}>
      <div className="output-notes-head">
        <h3 id={`${uid}-h`} ref={heading} tabIndex={-1} className={variant === 'tab' ? 'output-notes-heading sr-only' : 'output-notes-heading'} data-testid="output-notes-heading">
          Notes
        </h3>
        <p className="output-notes-count" data-testid="output-notes-count">
          {all === null ? 'Loading notes…' : countsLine(viewed)}
          {ctx.isCurrent ? '' : ` on version ${ctx.version}`}
        </p>
      </div>
      {error && (
        <p className="output-note-problem" role="alert" data-testid="output-notes-error">
          {error}
        </p>
      )}
      {canNote && (
        <div className="output-notes-bar">
          {!empty || others.length > 0 ? <span data-testid="output-notes-filter"><SegmentedControl<NoteFilter> label="Show notes" value={filter} onChange={setFilter} options={FILTERS} /></span> : null}
          <div ref={wholeBtn}>
            <Button size="sm" variant="secondary" icon={MessageSquarePlus} testId="output-note-whole" onClick={() => setWholeOpen(true)}>
              Add a note on the whole output
            </Button>
          </div>
        </div>
      )}
      {all !== null && empty && others.length === 0 && (
        <p className="output-notes-empty" data-testid="output-notes-empty">
          {emptyNotesText(kind)}
        </p>
      )}
      {all !== null && !empty && shown.length === 0 && (
        <p className="output-notes-empty" data-testid="output-notes-none">
          {filter === 'open' ? 'No open notes.' : filter === 'resolved' ? 'No resolved notes.' : 'No notes.'}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="output-notes-list" data-testid="output-notes-list" aria-label="Notes on this version">
          {shown.map((n) => row(n, true))}
        </ul>
      )}
      {openIds.length > 1 && (
        <Button
          size="sm"
          variant="ghost"
          testId="output-notes-select-all"
          onClick={() => setPicked(selIds.length === openIds.length ? new Set() : new Set(openIds))}
        >
          {selIds.length === openIds.length ? 'Clear selection' : 'Select all open'}
        </Button>
      )}
      {others.length > 0 && (
        <details className="output-notes-earlier" data-testid="output-notes-earlier">
          <summary>
            {others.every((n) => n.version < ctx.version) ? 'Earlier versions' : 'Other versions'} ({otherOpen} open)
          </summary>
          {otherShown.length > 0 ? (
            <ul className="output-notes-list" aria-label="Notes on other versions">
              {otherShown.map((n) => row(n, false))}
            </ul>
          ) : (
            <p className="output-notes-empty">{filter === 'resolved' ? 'No resolved notes.' : 'No open notes.'}</p>
          )}
        </details>
      )}
      {canNote && (
        <div className="output-notes-foot">
          <Button
            variant="primary"
            testId="output-notes-revise"
            inert={selIds.length === 0}
            title={selIds.length === 0 ? 'Select open notes to include.' : undefined}
            onClick={() => ctx.openRevise({ scope: 'notes', noteIds: selIds })}
          >
            {reviseLabel(selIds.length)}
          </Button>
        </div>
      )}
      <NoteComposer
        open={wholeOpen}
        selection={{ anchor: { type: 'whole' }, description: 'Whole output' }}
        anchorEl={wholeOpen ? (wholeBtn.current?.querySelector<HTMLElement>('button') ?? null) : null}
        onClose={() => setWholeOpen(false)}
      />
      {dialog}
    </section>
  )
}
