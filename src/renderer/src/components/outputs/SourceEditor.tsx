// SVG: source on the left, the drawing on the right as an <img> from a data URL (docs/design/outputs-2.md section 9). The text is
// checked by the same gate as every drawing (lib/outputSvg.ts); active content shows the refusal instead of a picture and Save is off.
import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { svgDataUrl } from '../../lib/outputPreview'
import { safeMermaidSvg } from '../../lib/outputSvg'
import { SVG_REFUSED_TEXT, svgCheckOf, type SvgCheck } from '../../lib/outputEdit'
import { TextAreaEditor } from './TextEditor'

export const SVG_PREVIEW_DELAY_MS = 250

/** The gate's verdict on an SVG source. */
export function checkSvgText(text: string): SvgCheck {
  if (text.trim() === '') return { state: 'invalid' }
  return svgCheckOf(safeMermaidSvg(text))
}

export default function SourceEditor({ value, onChange, title, check }: { value: string; onChange(text: string): void; title: string; check: SvgCheck }): ReactElement {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (shown === value) return undefined
    const t = setTimeout(() => setShown(value), SVG_PREVIEW_DELAY_MS)
    return () => clearTimeout(t)
  }, [value, shown])
  // Only a text the gate passed is ever drawn.
  const drawable = useMemo(() => (shown === value && check.state === 'ok' ? svgDataUrl(shown) : null), [shown, value, check.state])
  const [last, setLast] = useState<string | null>(null)
  useEffect(() => {
    if (drawable) setLast(drawable)
  }, [drawable])
  const picture = drawable ?? (check.state === 'ok' ? last : null)
  return (
    <div className="output-edit-split" data-testid="output-svg-split">
      <div className="output-edit-pane">
        <TextAreaEditor value={value} onChange={onChange} label={`${title} SVG source`} autoFocus />
      </div>
      <section className="output-edit-pane output-edit-drawing" aria-label="Drawing" data-testid="output-edit-drawing">
        {check.state === 'refused' && (
          <p className="output-edit-refusal" role="alert" data-testid="output-svg-refused">
            {SVG_REFUSED_TEXT}
          </p>
        )}
        {check.state === 'invalid' && <p className="output-preview-note">This is not a complete SVG drawing yet.</p>}
        {picture && <img className="output-edit-img" data-testid="output-edit-img" src={picture} alt={title} draggable={false} />}
      </section>
    </div>
  )
}
