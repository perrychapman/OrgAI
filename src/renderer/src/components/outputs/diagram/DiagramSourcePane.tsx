import type { ReactElement, Ref } from 'react'
import { useId, useImperativeHandle, useRef, useState } from 'react'
import { lineRange, sourceStatus } from '../../../lib/diagramView'

export interface SourceHandle {
  focus: () => void
  /** Focuses the editor and selects the 1-based line. */
  selectLine: (line: number) => void
}

export const SCRATCH_TEXT = 'Changes here are not saved yet. Copy the source to keep them.'

/**
 * The diagram's source as a native textarea (docs/design/outputs-2.md 8.6): monospace, no wrap, no spellcheck, Tab moves focus.
 * In this phase an edit is a scratch copy: it redraws the preview but never writes the file.
 */
export function DiagramSourcePane({ value, original, onChange, ref }: { value: string; original: string; onChange: (text: string) => void; ref?: Ref<SourceHandle> }): ReactElement {
  const area = useRef<HTMLTextAreaElement>(null)
  const statusId = useId()
  const [caret, setCaret] = useState(0)
  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    selectLine: (line) => {
      const el = area.current
      if (!el) return
      const r = lineRange(el.value, line)
      el.focus()
      el.setSelectionRange(r.start, r.end)
      setCaret(r.start)
      // Bring the line into view without moving the page.
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 18
      el.scrollTop = Math.max(0, (line - 3) * lh)
    }
  }))
  const sync = (): void => setCaret(area.current?.selectionStart ?? 0)
  return (
    <div className="diagram-source-pane">
      <textarea
        ref={area}
        className="diagram-source"
        data-testid="diagram-source"
        aria-label="Diagram source"
        aria-describedby={statusId}
        spellCheck={false}
        wrap="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
        }}
        onSelect={sync}
        onKeyUp={sync}
        onClick={sync}
      />
      <p id={statusId} className="diagram-source-status" data-testid="diagram-source-status">
        {sourceStatus(value, caret)}
      </p>
      {value !== original && (
        <p className="diagram-scratch-note" data-testid="diagram-scratch-note">
          {SCRATCH_TEXT}
        </p>
      )}
    </div>
  )
}
