// A plain text area for a text output (docs/design/outputs-2.md section 9). Also the base of the markdown, JSON and SVG editors.
import type { ReactElement, Ref } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { caretPosition, byteLength } from '../../lib/outputEdit'
import { formatBytes } from '../../lib/outputs'

export interface TextAreaEditorProps {
  value: string
  onChange(text: string): void
  /** The accessible name ("Markdown source", "<title> text"). */
  label: string
  testId?: string
  /** Extra text for aria-describedby (a validity line). */
  describedBy?: string
  /** Focus the area when it mounts. */
  autoFocus?: boolean
  /** Monospace and no wrap (source), else a reading font with wrapping. */
  code?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

/** The shared textarea with a "Line 4, column 12 · 2.7 KB" status under it (not announced). */
export function TextAreaEditor({ value, onChange, label, testId = 'output-edit-area', describedBy, autoFocus, code = true, ref }: TextAreaEditorProps): ReactElement {
  const own = useRef<HTMLTextAreaElement | null>(null)
  const statusId = useId()
  const [caret, setCaret] = useState(0)
  useEffect(() => {
    if (autoFocus) own.current?.focus()
  }, [autoFocus])
  const pos = caretPosition(value, caret)
  const setRef = (el: HTMLTextAreaElement | null): void => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el
  }
  const sync = (): void => setCaret(own.current?.selectionStart ?? 0)
  return (
    <div className="output-edit-field">
      <textarea
        ref={setRef}
        className="output-edit-area"
        data-code={code ? 'true' : 'false'}
        data-testid={testId}
        aria-label={label}
        aria-describedby={[statusId, describedBy].filter(Boolean).join(' ')}
        spellCheck={false}
        wrap={code ? 'off' : 'soft'}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
        }}
        onSelect={sync}
        onKeyUp={sync}
        onClick={sync}
      />
      <p id={statusId} className="output-edit-status" data-testid="output-edit-status">
        {`Line ${pos.line}, column ${pos.column} · ${formatBytes(byteLength(value))}`}
      </p>
    </div>
  )
}

export default function TextEditor({ value, onChange, title }: { value: string; onChange(text: string): void; title: string }): ReactElement {
  return <TextAreaEditor value={value} onChange={onChange} label={`${title} text`} autoFocus code={false} />
}
