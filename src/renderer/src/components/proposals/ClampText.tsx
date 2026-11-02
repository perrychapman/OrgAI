import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { clampLabel } from '../../lib/clampLabel'
import { showHidden } from '../../lib/hiddenChars'

/** Agent text is untrusted: plain text, clamped, never a link or Markdown. `label` names the row for the toggle's accessible name. */
export function ClampText({ text: raw, label }: { text: string; label?: string }): ReactElement {
  const text = showHidden(raw)
  const [open, setOpen] = useState(false)
  const id = useId()
  const long = text.length > 240 || text.split('\n').length > 4
  return (
    <>
      <p id={id} className={`mcp-prop-text${long && !open ? ' clamped' : ''}`}>
        {text}
      </p>
      {long && (
        <button type="button" className="btn ghost sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
          {label && <span className="sr-only"> of {clampLabel(label, 60)}</span>}
        </button>
      )}
    </>
  )
}
