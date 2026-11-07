// In-window preview of an output (docs/design/outputs.md section 4). Fetches outputs:preview on demand with a
// sequence guard and a per-project cache; builds React elements from the answer, never inserts HTML.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputPreview as Preview, RunOutput } from '@shared/types'
import { previewCacheFor, previewKey } from '../../lib/outputs'
import { Button } from '../ui/Button'
import DocumentView from './DocumentView'
import SheetView from './SheetView'
import TextView from './TextView'
import ImageView from './ImageView'
import '../../styles/outputs-preview.css'

export interface OutputPreviewProps {
  output: RunOutput
  /** The detail's heading id, for naming scroll regions. */
  labelledBy?: string
}

type State = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; preview: Preview }

export default function OutputPreview({ output, labelledBy }: OutputPreviewProps): ReactElement {
  const key = previewKey(output)
  const cached = previewCacheFor(output.projectId).get(key)
  const [state, setState] = useState<State>(cached ? { phase: 'ready', preview: cached } : { phase: 'loading' })
  const seq = useRef(0)
  const shownKey = useRef(cached ? key : '')

  const load = useCallback(
    (force: boolean) => {
      const cache = previewCacheFor(output.projectId)
      const hit = force ? undefined : cache.get(key)
      const my = ++seq.current
      if (hit) {
        shownKey.current = key
        setState({ phase: 'ready', preview: hit })
        return
      }
      shownKey.current = ''
      setState({ phase: 'loading' })
      window.orgai.outputs
        .preview({ projectId: output.projectId, outputId: output.id })
        .then((p) => {
          if (my !== seq.current) return
          cache.set(key, p)
          shownKey.current = key
          setState({ phase: 'ready', preview: p })
        })
        .catch(() => {
          if (my !== seq.current) return
          setState({ phase: 'error' })
        })
    },
    [output.projectId, output.id, key]
  )

  useEffect(() => {
    load(false)
    return () => {
      seq.current++
    }
  }, [load])

  // A render for a newer output must not show the older one's answer for a frame.
  const stale = state.phase === 'ready' && shownKey.current !== key

  if (state.phase === 'loading' || stale) {
    return (
      <div className="output-preview" data-testid="output-preview" data-state="loading" data-kind="none" role="status">
        <p className="output-preview-note">Loading preview…</p>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="output-preview" data-testid="output-preview" data-state="error" data-kind="none">
        <p className="output-preview-note" data-testid="output-preview-error" role="alert">
          Could not load the preview.
        </p>
        <div>
          <Button size="sm" onClick={() => load(true)} testId="output-preview-retry">
            Try again
          </Button>
        </div>
      </div>
    )
  }
  const p = state.preview
  const kindAttr = p.kind === 'document' ? 'document' : p.kind
  return (
    <div className="output-preview" data-testid="output-preview" data-state="ready" data-kind={kindAttr}>
      {p.kind === 'document' && <DocumentView preview={p} />}
      {p.kind === 'sheets' && <SheetView preview={p} output={output} />}
      {p.kind === 'text' && <TextView text={p.text} truncated={p.truncated === true} output={output} labelledBy={labelledBy} />}
      {p.kind === 'svg' && <ImageView svgText={p.text} output={output} labelledBy={labelledBy} />}
      {p.kind === 'image' && <ImageView dataUrl={p.dataUrl} output={output} labelledBy={labelledBy} />}
      {p.kind === 'none' && (
        <p className="output-preview-note" data-testid="output-preview-none">
          {p.reason}
        </p>
      )}
    </div>
  )
}
