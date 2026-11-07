// Add note (`output-note-add`, Ctrl/Cmd+Shift+M), the region tool (`output-note-region`) and the reason line
// (`output-note-hint`), plus the composer (docs/design/outputs-2.md 11.2). The shell mounts this in the action toolbar.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '../ui/Button'
import { hasRegionTool, noteHint, noteStyleOf } from '../../lib/outputNotes'
import type { RegionTool } from './outputDetailContext'
import { useOutputDetail } from './outputDetailContext'
import NoteComposer from './NoteComposer'
import { NOTE_COMPOSE_EVENT } from './RegionLayer'
import '../../styles/outputs-notes.css'

const TOOLS: { value: RegionTool; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'box', label: 'Box' },
  { value: 'ellipse', label: 'Circle' }
]

export default function NoteTools(): ReactElement | null {
  const ctx = useOutputDetail()
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [wantOpen, setWantOpen] = useState(false)
  const selection = ctx?.selection ?? null
  const canAdd = selection !== null && !open

  const begin = useCallback((): void => {
    if (!ctx) return
    if (!ctx.selection) {
      ctx.announce(noteHint(ctx.output.kind))
      return
    }
    setOpen(true)
  }, [ctx])

  // A confirmed region (keyboard Enter) asks for the composer; the selection lands a render later.
  useEffect(() => {
    const on = (): void => setWantOpen(true)
    window.addEventListener(NOTE_COMPOSE_EVENT, on)
    return () => window.removeEventListener(NOTE_COMPOSE_EVENT, on)
  }, [])
  useEffect(() => {
    if (wantOpen && selection) {
      setWantOpen(false)
      setOpen(true)
    }
  }, [wantOpen, selection])

  // Ctrl/Cmd+Shift+M while focus is inside this tool's own detail or viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'm') return
      const host = wrap.current?.closest('[data-testid="output-detail"], [data-testid="output-dialog"]') ?? document.body
      if (!(e.target instanceof Node) || !host.contains(e.target)) return
      e.preventDefault()
      begin()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [begin])

  if (!ctx || ctx.mode !== 'preview' || noteStyleOf(ctx.output.kind) === 'none') return null
  const kind = ctx.output.kind
  const hint = noteHint(kind)

  return (
    <span ref={wrap} className="output-note-tools" data-testid="output-note-tools">
      {hasRegionTool(kind) && (
        <span className="output-note-region" role="group" aria-label="Mark an area" data-testid="output-note-region">
          <span className="output-note-region-label" aria-hidden="true">
            Mark an area
          </span>
          <span className="output-note-region-group">
            {TOOLS.map((t) => (
              <button
                key={t.value}
                type="button"
                className="btn ghost sm"
                aria-pressed={ctx.regionTool === t.value}
                data-testid={`output-note-region-${t.value}`}
                onClick={() => {
                  ctx.setRegionTool(t.value)
                  ctx.announce(t.value === 'off' ? 'Area tool off.' : `Area tool on: ${t.label.toLowerCase()}. Drag on the drawing, or press Enter in the viewer to place one.`)
                }}
              >
                {t.label}
              </button>
            ))}
          </span>
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        icon={MessageSquarePlus}
        testId="output-note-add"
        inert={!canAdd}
        ariaDescribedBy={selection ? undefined : `${id}-hint`}
        title={selection ? 'Add note (Ctrl+Shift+M)' : hint}
        onClick={begin}
      >
        Add note
      </Button>
      {!selection && (
        <span id={`${id}-hint`} className="output-note-hint" data-testid="output-note-hint">
          {hint}
        </span>
      )}
      <NoteComposer
        open={open}
        selection={selection}
        anchorEl={open ? (wrap.current?.querySelector<HTMLElement>('[data-testid="output-note-add"]') ?? null) : null}
        onClose={() => setOpen(false)}
      />
    </span>
  )
}
