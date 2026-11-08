// The in-app editor host (S5, docs/design/outputs-2.md section 9) for markdown, text, csv, json, mermaid and svg. It reads the
// source of the shown version, hands it to the editor of the kind and puts the sticky bar under it. Reads useOutputDetail()
// (setDirty, registerSave, guard, announce, setMode) and the store's outputDrafts through useEditSession.
import type { ReactElement } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { OUTPUT_EDIT_MAX_BYTES, type RunOutput } from '@shared/types'
import { Button } from '../ui/Button'
import { jsonStatus, readOnlyReason, DRAFT_KEPT_TEXT, TOO_LARGE_TEXT } from '../../lib/outputEdit'
import { EditorBar, useEditSession } from './EditorBar'
import { useOutputDetail } from './outputDetailContext'
import CsvEditor from './CsvGridEditor'
import JsonEditor from './JsonEditor'
import MarkdownEditor from './MarkdownEditor'
import SourceEditor, { checkSvgText } from './SourceEditor'
import TextEditor from './TextEditor'
import '../../styles/outputs-edit.css'

const DiagramViewer = lazy(() => import('./diagram/DiagramViewer'))

export interface OutputEditorProps {
  /** Close the editor (the host returns to the preview; the editor asks first when dirty). */
  onClose(): void
}

type Loaded = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'refused'; text: string }

export default function OutputEditor({ onClose }: OutputEditorProps): ReactElement | null {
  const ctx = useOutputDetail()
  const output = ctx?.output
  const version = ctx?.version
  const projectId = output?.projectId
  const outputId = output?.id
  const bytes = output?.bytes ?? 0
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const reason = ctx && output ? readOnlyReason({ output, isCurrent: ctx.isCurrent }) : null
  const tooLarge = bytes > OUTPUT_EDIT_MAX_BYTES

  useEffect(() => {
    if (!projectId || !outputId || version === undefined || reason || tooLarge) return undefined
    const api = window.orgai?.outputs
    if (!api) {
      setLoaded({ state: 'refused', text: 'Editing is not available here.' })
      return undefined
    }
    let live = true
    setLoaded({ state: 'loading' })
    api.readSource({ projectId, outputId, version }).then(
      (r) => {
        if (!live) return
        setLoaded('text' in r ? { state: 'ready', text: r.text } : { state: 'refused', text: r.refused })
      },
      () => live && setLoaded({ state: 'refused', text: 'OrgAI could not read this file to edit it.' })
    )
    return () => {
      live = false
    }
  }, [projectId, outputId, version, reason, tooLarge])

  if (!ctx || !output) return null
  const kindOf = output.kind
  const unavailable = reason ?? (tooLarge ? TOO_LARGE_TEXT : loaded.state === 'refused' ? loaded.text : null)
  if (unavailable) return <ReadOnly output={output} text={unavailable} showOpen={tooLarge || loaded.state === 'refused'} onClose={onClose} />
  if (loaded.state === 'loading') {
    return (
      <div className="output-editor" data-testid="output-editor" data-kind={kindOf} data-state="loading">
        <p className="output-preview-note">
          Opening the editor…
        </p>
      </div>
    )
  }
  return <LoadedEditor key={`${output.id}:${version}`} output={output} baseText={loaded.text} onClose={onClose} />
}

function ReadOnly({ output, text, showOpen, onClose }: { output: RunOutput; text: string; showOpen: boolean; onClose(): void }): ReactElement {
  return (
    <div className="output-editor" data-testid="output-editor" data-kind={output.kind} data-state="readonly">
      <p className="output-edit-readonly" data-testid="output-edit-readonly">
        {text}
      </p>
      <div className="output-edit-row">
        {showOpen && !output.missing && (
          <Button size="sm" testId="output-edit-open" onClick={() => void window.orgai?.outputs?.open({ projectId: output.projectId, outputId: output.id })}>
            Open
          </Button>
        )}
        <Button size="sm" testId="output-edit-close" onClick={onClose}>
          Close editor
        </Button>
      </div>
    </div>
  )
}

function LoadedEditor({ output, baseText, onClose }: { output: RunOutput; baseText: string; onClose(): void }): ReactElement {
  const kind = output.kind
  const title = output.title
  const session = useEditSession({
    output,
    baseText,
    onClose,
    block: (t) => {
      if (kind === 'json') return { jsonOk: jsonStatus(t).ok }
      if (kind === 'svg') {
        const c = checkSvgText(t)
        return { svgRefused: c.state === 'refused', svgInvalid: c.state === 'invalid' }
      }
      return {}
    }
  })
  const { text, setText } = session
  const change = setText

  let body: ReactElement
  switch (kind) {
    case 'markdown':
      body = <MarkdownEditor key={session.resetKey} value={text} onChange={change} title={title} />
      break
    case 'json':
      body = <JsonEditor key={session.resetKey} value={text} onChange={change} title={title} status={jsonStatus(text)} />
      break
    case 'csv':
      body = <CsvEditor key={session.resetKey} value={text} onChange={change} title={title} />
      break
    case 'svg':
      body = <SourceEditor key={session.resetKey} value={text} onChange={change} title={title} check={checkSvgText(text)} />
      break
    case 'mermaid':
      body = (
        <Suspense fallback={<p className="output-preview-note">Opening the editor…</p>}>
          <DiagramViewer key={session.resetKey} text={baseText} title={title} editing={{ value: text, onChange: change }} />
        </Suspense>
      )
      break
    default:
      body = <TextEditor key={session.resetKey} value={text} onChange={change} title={title} />
  }

  return (
    <div className="output-editor" data-testid="output-editor" data-kind={kind} data-state="ready" onKeyDown={session.onKeyDown}>
      {session.restored && (
        <p className="output-edit-restored" data-testid="output-edit-restored">
          {DRAFT_KEPT_TEXT}
        </p>
      )}
      <div className="output-edit-body">{body}</div>
      <EditorBar session={session} title={title} />
      {session.dialog}
    </div>
  )
}
