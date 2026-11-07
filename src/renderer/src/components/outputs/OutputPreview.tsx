import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { OutputPreview as OutputPreviewData, RunOutput } from '@shared/types'
import { previewCacheFor, previewKey } from '../../lib/outputs'
import { Button } from '../ui/Button'
import { PreviewStatusContext } from './previewStatus'
import DocumentView from './DocumentView'
import SheetView from './SheetView'
import TextPreview from './TextPreview'
import ImagePreview from './ImagePreview'
import SvgPreview from './SvgPreview'
import '../../styles/outputs-preview.css'

export interface OutputPreviewProps {
  output: RunOutput
  /** The detail's heading id, for naming scroll regions. */
  labelledBy?: string
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; preview: OutputPreviewData }

/** The in-window preview of one output, fetched on demand and cached per project. Renders nothing for a missing file. */
export default function OutputPreview({ output }: OutputPreviewProps): ReactElement | null {
  const { projectId, id } = output
  const key = previewKey(output)
  const [state, setState] = useState<State>(() => {
    const hit = output.missing ? undefined : previewCacheFor(projectId).get(key)
    return hit ? { status: 'ready', preview: hit } : { status: 'loading' }
  })
  const [attempt, setAttempt] = useState(0)
  const [bodyStatus, setBodyStatus] = useState('')
  const seq = useRef(0)
  const missing = output.missing === true

  useEffect(() => {
    if (missing) return
    const mine = ++seq.current
    const cache = previewCacheFor(projectId)
    const hit = attempt === 0 ? cache.get(key) : undefined
    if (hit) {
      setState({ status: 'ready', preview: hit })
      return
    }
    setState({ status: 'loading' })
    let p: Promise<OutputPreviewData>
    try {
      p = window.orgai.outputs.preview({ projectId, outputId: id })
    } catch {
      setState({ status: 'error' })
      return
    }
    p.then(
      (preview) => {
        if (seq.current !== mine) return
        cache.set(key, preview)
        setState({ status: 'ready', preview })
      },
      () => {
        if (seq.current === mine) setState({ status: 'error' })
      }
    )
    return () => {
      seq.current++
    }
  }, [projectId, id, key, attempt, missing])

  if (missing) return null

  // One polite region stays mounted through loading, error and ready, so a change of state is spoken.
  const status = state.status === 'loading' ? 'Loading preview…' : state.status === 'error' ? 'Could not load the preview.' : bodyStatus
  const statusRegion = (
    <p className="sr-only" role="status" data-testid="output-preview-status">
      {status}
    </p>
  )

  if (state.status === 'loading') {
    return (
      <PreviewStatusContext.Provider value={setBodyStatus}>
        {statusRegion}
        <div className="output-preview" data-testid="output-preview" data-state="loading">
          <p className="output-preview-note">Loading preview…</p>
        </div>
      </PreviewStatusContext.Provider>
    )
  }
  if (state.status === 'error') {
    return (
      <PreviewStatusContext.Provider value={setBodyStatus}>
        {statusRegion}
        <div className="output-preview" data-testid="output-preview" data-state="error">
          <p className="output-preview-note output-preview-problem" data-testid="output-preview-error">
            Could not load the preview.
          </p>
          <div>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)} testId="output-preview-retry">
              Try again
            </Button>
          </div>
        </div>
      </PreviewStatusContext.Provider>
    )
  }

  const p = state.preview
  let body: ReactElement
  switch (p.kind) {
    case 'document':
      body = <DocumentView blocks={p.blocks} truncated={p.truncated} title={output.title} />
      break
    case 'sheets':
      body = <SheetView sheets={p.sheets} truncatedSheets={p.truncatedSheets} />
      break
    case 'text':
      body = <TextPreview kind={output.kind} text={p.text} truncated={p.truncated} title={output.title} />
      break
    case 'svg':
      // An <img> with a data URL runs no script and loads nothing; never inlined.
      body = <SvgPreview text={p.text} title={output.title} />

      break
    case 'image':
      body = <ImagePreview dataUrl={p.dataUrl} title={output.title} />
      break
    default:
      body = (
        <p className="output-preview-note" data-testid="output-preview-none">
          {p.reason}
        </p>
      )
  }
  return (
    <PreviewStatusContext.Provider value={setBodyStatus}>
      {statusRegion}
      <div className="output-preview" data-testid="output-preview" data-state="ready" data-kind={p.kind}>
        {body}
      </div>
    </PreviewStatusContext.Provider>
  )
}
