// Add note (`output-note-add`, Ctrl/Cmd+Shift+M), the region tool (`output-note-region`) and the reason line
// (`output-note-hint`), plus the composer (docs/design/outputs-2.md 11.2). The shell mounts this in the action toolbar.
// For kinds with a region tool, Add note is a menu button: "Note on the selection" and the "Mark an area" choices
// (Off / Box / Circle) live in its menu, so the Off / Box / Circle row no longer sits in the toolbar at rest.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, MessageSquarePlus } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { hasRegionTool, noteHint, noteStyleOf } from '../../lib/outputNotes'
import type { RegionTool } from './outputDetailContext'
import { useOutputDetail } from './outputDetailContext'
import { onMenuKey } from './OutputActions'
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
  // In the panel the button is icon-only (the toolbar shares a row with the tabs); the Larger view has room for the words.
  const iconOnly = ctx.surface === 'detail'
  const region = hasRegionTool(kind)
  const marking = region ? TOOLS.find((t) => t.value === ctx.regionTool && t.value !== 'off') : undefined
  const markingId = `${id}-marking`
  const hintId = `${id}-hint`
  const describedBy = [marking ? markingId : '', selection ? '' : hintId].filter(Boolean).join(' ') || undefined
  const title = marking ? `Marking: ${marking.label}. Press Esc to turn it off.` : selection ? 'Add note (Ctrl+Shift+M)' : hint
  const triggerAnchor = (): HTMLElement | null => wrap.current?.querySelector<HTMLElement>('[data-testid="output-note-add"]') ?? null

  const chooseTool = (t: { value: RegionTool; label: string }, close: () => void): void => {
    ctx.setRegionTool(t.value)
    ctx.announce(t.value === 'off' ? 'Area tool off.' : `Area tool on: ${t.label.toLowerCase()}. Drag on the drawing, or press Enter in the viewer to place one.`)
    close()
  }

  return (
    <span ref={wrap} className="output-note-tools" data-testid="output-note-tools">
      {region ? (
        <Popover
          trigger={
            <>
              <Icon icon={MessageSquarePlus} size="sm" />
              {marking ? `Marking: ${marking.label}` : iconOnly ? null : 'Add note'}
            </>
          }
          triggerClassName={`btn sm${marking ? ' output-note-marking' : iconOnly ? ' output-icon-only' : ''}`}
          triggerLabel={marking ? `Add note, Marking: ${marking.label}` : 'Add note'}
          triggerTitle={title}
          triggerTestId="output-note-add"
          triggerDescribedBy={describedBy}
          label="Add note"
          role="menu"
          placement="bottom-end"
          testId="output-note-menu"
          onOpenChange={(o) => {
            // Opened with nothing selected: say how to select, as clicking the plain button does.
            if (o && !ctx.selection) ctx.announce(hint)
          }}
        >
          {({ close }) => (
            <div className="output-menu" role="presentation" onKeyDown={onMenuKey}>
              <button
                type="button"
                role="menuitem"
                className="output-menuitem"
                data-testid="output-note-selection"
                aria-disabled={canAdd ? undefined : 'true'}
                title={canAdd ? 'Note on the selection (Ctrl+Shift+M)' : `${hint} (Ctrl+Shift+M)`}
                onClick={() => {
                  if (!canAdd) {
                    ctx.announce(hint)
                    return
                  }
                  triggerAnchor()?.focus({ preventScroll: true })
                  close()
                  setOpen(true)
                }}
              >
                <Icon icon={MessageSquarePlus} size="sm" />
                Note on the selection
              </button>
              <div className="output-menu-sep" role="separator" />
              <div className="output-note-region" role="group" aria-label="Mark an area" data-testid="output-note-region">
                <span className="output-note-region-label" aria-hidden="true">
                  Mark an area
                </span>
                {TOOLS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={ctx.regionTool === t.value}
                    className="output-menuitem"
                    data-testid={`output-note-region-${t.value}`}
                    onClick={() => chooseTool(t, close)}
                  >
                    <span className="output-menu-check" aria-hidden="true">
                      {ctx.regionTool === t.value && <Icon icon={Check} size="sm" />}
                    </span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Popover>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon={MessageSquarePlus}
          testId="output-note-add"
          className={iconOnly ? 'output-icon-only' : undefined}
          ariaLabel={iconOnly ? 'Add note' : undefined}
          inert={!canAdd}
          ariaDescribedBy={selection ? undefined : hintId}
          title={title}
          onClick={begin}
        >
          {iconOnly ? null : 'Add note'}
        </Button>
      )}
      {marking && (
        <span id={markingId} className="sr-only">
          Marking an area: {marking.label.toLowerCase()}. Drag on the drawing to place it. Press Escape to turn the tool off.
        </span>
      )}
      {!selection && (
        <span id={hintId} className="sr-only output-note-hint" data-testid="output-note-hint">
          {hint}
        </span>
      )}
      <NoteComposer open={open} selection={selection} anchorEl={open ? triggerAnchor() : null} onClose={() => setOpen(false)} />
    </span>
  )
}
