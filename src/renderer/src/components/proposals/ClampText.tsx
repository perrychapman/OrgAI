import type { ReactElement } from 'react'
import { useState } from 'react'
import { Button } from '../ui/Button'

/** Agent text is untrusted: plain text, clamped, never a link or Markdown. */
export function ClampText({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const long = text.length > 240 || text.split('\n').length > 4
  return (
    <>
      <p className={`mcp-prop-text${long && !open ? ' clamped' : ''}`}>{text}</p>
      {long && (
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  )
}
