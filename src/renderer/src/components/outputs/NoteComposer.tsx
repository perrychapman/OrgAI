// The note composer (docs/design/outputs-2.md 11.2): a native popover near its opener, a bottom sheet under 560 px.
// One label "Note", a 2,000-character field, a quote chip, Add note (Ctrl+Enter) and Cancel (Esc). Focus goes back to the
// control that opened it. It is shared by the toolbar (selection) and the Notes panel (whole output).
import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { OutputNoteAnchor } from '@shared/types'
import { OUTPUT_NOTE_TEXT_MAX } from '@shared/types'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'
import { NOTE_COUNTER_FROM, clip, noteTextProblem } from '../../lib/outputNotes'
import { useOutputDetail, type OutputSelection } from './outputDetailContext'
import '../../styles/outputs-notes.css'

export interface NoteComposerProps {
  open: boolean
  selection: OutputSelection | null
  /** The opener: the panel is placed beside it and focus returns to it. */
  anchorEl: HTMLElement | null
  onClose(saved: boolean): void
}

function quoteFor(a: OutputNoteAnchor, description: string): string {
  switch (a.type) {
    case 'text':
    case 'block':
      return a.quote ? `“${clip(a.quote, 120)}”` : description
    case 'cells':
      return a.quote ? `${description}: ${clip(a.quote, 60)}` : description
    case 'region':
      return a.labels?.length ? `${description}: ${clip(a.labels.join(', '), 120)}` : description
    default:
      return description
  }
}

export default function NoteComposer({ open, selection, anchorEl, onClose }: NoteComposerProps): ReactElement {
  const panel = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const closing = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const place = useCallback((): void => {
    const p = panel.current
    if (!p) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (vw <= 560) {
      p.style.left = '0px'
      p.style.top = `${Math.max(8, vh - p.offsetHeight)}px`
      return
    }
    const r = (anchorEl ?? document.body).getBoundingClientRect()
    const w = p.offsetWidth
    const h = p.offsetHeight
    let top = r.bottom + 6
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6)
    const left = Math.max(8, Math.min(r.left, vw - w - 8))
    p.style.top = `${Math.round(top)}px`
    p.style.left = `${Math.round(left)}px`
  }, [anchorEl])

  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    if (open) {
      opener.current = (document.activeElement as HTMLElement | null) ?? anchorEl
      closing.current = false
      try {
        if (!el.matches(':popover-open')) el.showPopover()
      } catch {
        // Already open or not connected.
      }
      place()
    } else if (el.matches(':popover-open')) {
      closing.current = true
      try {
        el.hidePopover()
      } catch {
        // Already closed.
      }
    }
  }, [open, place, anchorEl])

  // Native Esc and light dismiss close the popover without React.
  useEffect(() => {
    const el = panel.current
    if (!el) return undefined
    const onToggle = (e: Event): void => {
      if ((e as ToggleEvent).newState !== 'closed') return
      const back = opener.current ?? anchorEl
      if (openRef.current && !closing.current) onCloseRef.current(false)
      closing.current = false
      window.setTimeout(() => back?.focus(), 0)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [anchorEl])

  return (
    <div ref={panel} popover="auto" role="dialog" aria-label="Add a note" tabIndex={-1} className="popover-panel output-note-composer" data-testid={open ? 'output-note-composer' : undefined}>
      {open && selection && <ComposerForm key={JSON.stringify(selection.anchor)} selection={selection} onClose={onClose} />}
    </div>
  )
}

function ComposerForm({ selection, onClose }: { selection: OutputSelection; onClose: (saved: boolean) => void }): ReactElement {
  const ctx = useOutputDetail()
  const id = useId()
  const area = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [wholeSlide, setWholeSlide] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = noteTextProblem(text)
  const empty = !text.trim()
  const a = selection.anchor
  const slideOption = ctx?.output.kind === 'pptx' && a.type === 'region' && a.slide !== undefined

  useEffect(() => {
    area.current?.querySelector('textarea')?.focus()
  }, [])

  const save = async (): Promise<void> => {
    if (!ctx || busy || empty || problem) return
    const api = window.orgai?.outputs
    if (!api) return
    setBusy(true)
    setError('')
    const anchor: OutputNoteAnchor = slideOption && wholeSlide && a.type === 'region' && a.slide !== undefined ? { type: 'slide', slide: a.slide } : a
    try {
      await api.noteAdd({ projectId: ctx.output.projectId, outputId: ctx.output.id, version: ctx.version, anchor, text: text.trim() })
      ctx.reloadNotes()
      ctx.announce('Note added.')
      ctx.setSelection(null)
      onClose(true)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'The note could not be added.')
      setBusy(false)
    }
  }

  return (
    <form
      className="output-note-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void save()
        }
      }}
    >
      <p className="output-note-quote" data-testid="output-note-quote" title={selection.description}>
        {quoteFor(a, selection.description)}
      </p>
      <label className="output-note-label" htmlFor={`${id}-text`}>
        Note
      </label>
      <div ref={area}>
        <Textarea id={`${id}-text`} value={text} onChange={setText} rows={4} maxLength={OUTPUT_NOTE_TEXT_MAX + 200} invalid={Boolean(problem)} aria-describedby={`${id}-help`} data-testid="output-note-text" />
      </div>
      <p id={`${id}-help`} className="output-note-help" data-testid="output-note-help">
        {problem ? <span className="output-note-problem">{problem}</span> : text.length >= NOTE_COUNTER_FROM ? `${text.length.toLocaleString('en-US')} of ${OUTPUT_NOTE_TEXT_MAX.toLocaleString('en-US')}` : 'Ctrl+Enter adds the note.'}
        {error && (
          <span className="output-note-problem" role="alert">
            {' '}
            {error}
          </span>
        )}
      </p>
      {slideOption && (
        <label className="output-note-whole-slide">
          <input type="checkbox" checked={wholeSlide} onChange={(e) => setWholeSlide(e.target.checked)} data-testid="output-note-whole-slide" />
          <span>This slide, not just the marked area</span>
        </label>
      )}
      <div className="output-note-actions">
        <Button variant="ghost" size="sm" onClick={() => onClose(false)} testId="output-note-cancel">
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={busy} inert={empty || Boolean(problem)} testId="output-note-save">
          Add note
        </Button>
      </div>
    </form>
  )
}
