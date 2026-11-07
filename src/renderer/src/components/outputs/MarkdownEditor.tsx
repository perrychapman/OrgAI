// Markdown: source on one side, the rendered text on the other (stacked under 700 px of container), redrawn 250 ms after typing
// stops (docs/design/outputs-2.md section 9). The rendered side is the app's read-only Markdown component: no HTML, no images.
import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Markdown } from '../Markdown'
import { TextAreaEditor } from './TextEditor'

export const MARKDOWN_PREVIEW_DELAY_MS = 250

export default function MarkdownEditor({ value, onChange, title }: { value: string; onChange(text: string): void; title: string }): ReactElement {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (shown === value) return undefined
    const t = setTimeout(() => setShown(value), MARKDOWN_PREVIEW_DELAY_MS)
    return () => clearTimeout(t)
  }, [value, shown])
  return (
    <div className="output-edit-split" data-testid="output-md-split">
      <div className="output-edit-pane">
        <TextAreaEditor value={value} onChange={onChange} label={`${title} Markdown source`} testId="output-edit-area" autoFocus />
      </div>
      <section className="output-edit-pane output-edit-rendered" aria-label="Rendered text" data-testid="output-edit-rendered" tabIndex={0}>
        {shown.trim() === '' ? <p className="output-preview-note">Nothing to show yet.</p> : <Markdown text={shown} />}
      </section>
    </div>
  )
}
