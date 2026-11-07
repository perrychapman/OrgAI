// The shown output (docs/design/outputs.md section 4): heading, meta, provenance with the run link, description,
// toolbar (Open, More actions) and the preview. Shared by the run side tab and the project tab.
import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import type { RunOutput } from '@shared/types'
import { useAppStore, useRunIndexes } from '../../store/useAppStore'
import { canOpenOutput, outputMetaLine, provenanceLine } from '../../lib/outputs'
import { cleanIpcError } from '../../lib/ipcError'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { HIDDEN_SHOWN_TITLE } from '../../lib/teamFound'
import { runTag } from '../../lib/runLabels'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ClampText } from '../proposals/ClampText'
import OutputActions from './OutputActions'
import OutputPreview from './OutputPreview'
import '../../styles/outputs.css'

export interface OutputDetailProps {
  output: RunOutput
  /** Called after Remove from list / Delete file succeeded (the surface moves focus to the next row). */
  onRemoved?: (id: string) => void
  /** Notice line text (open / reveal refusals, save, remove); the surface renders it in its polite region. */
  onNotice?: (text: string) => void
  /** Focus the heading on mount (the default). */
  autoFocus?: boolean
}

/** After a run link opened the run (the surface may unmount): land focus on the composer, else the selected run tab, else the topbar h1. */
export function settleRunFocus(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
      if (composer && !composer.disabled) {
        composer.focus({ preventScroll: true })
        return
      }
      const tab = document.querySelector<HTMLElement>('.run-tab[aria-selected=true]')
      if (tab) {
        tab.focus({ preventScroll: true })
        return
      }
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

export default function OutputDetail({ output, onRemoved, onNotice, autoFocus }: OutputDetailProps): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null)
  const index = useRunIndexes().get(output.runId)
  useEffect(() => {
    if (autoFocus !== false) heading.current?.focus({ preventScroll: true })
    // Focus once per shown output, never on a refresh of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.id])
  const missing = output.missing === true
  const tag = index !== undefined ? runTag(index) : undefined
  // provenanceLine puts the run tag between the role and the date; split around it so the tag can be the link.
  const marker = '\u0000'
  const [before, after] = provenanceLine(output, marker).split(marker)
  const openRun = (): void => {
    void useAppStore
      .getState()
      .focusRun(output.projectId, output.runId)
      .then(settleRunFocus)
      .catch((e) => onNotice?.(cleanIpcError(e)))
  }
  const open = async (): Promise<void> => {
    try {
      const answer = await window.orgai.outputs.open({ projectId: output.projectId, outputId: output.id })
      if (answer) onNotice?.(answer)
    } catch (e) {
      onNotice?.(cleanIpcError(e))
    }
  }
  return (
    <section className="output-detail" data-testid="output-detail" data-id={output.id} data-kind={output.kind} aria-labelledby="output-detail-heading">
      <h3 id="output-detail-heading" ref={heading} data-testid="output-detail-heading" tabIndex={-1} className="output-detail-heading">
        {showHidden(output.title)}
        {hasHidden(output.title) && (
          <Badge tone="attention" title={HIDDEN_SHOWN_TITLE}>
            Hidden characters shown
          </Badge>
        )}
      </h3>
      <p className="output-detail-meta" data-testid="output-detail-meta">
        {outputMetaLine(output)}
      </p>
      <p className="output-detail-prov" data-testid="output-detail-prov">
        {tag ? (
          <>
            {before}
            <button type="button" className="link-btn" data-testid="output-run-link" aria-label={`Open run ${tag}`} onClick={openRun}>
              {tag}
            </button>
            {after}
          </>
        ) : (
          provenanceLine(output)
        )}
      </p>
      {output.description && <ClampText text={output.description} label={output.title} />}
      {missing && (
        <p className="output-missing" data-testid="output-missing">
          The file is gone from {output.relPath}. It was moved or deleted outside OrgAI.
        </p>
      )}
      <div className="output-detail-toolbar" role="group" aria-label="Output actions">
        {canOpenOutput(output) && (
          <Button variant="secondary" size="sm" testId="output-detail-open" title="Opens in the app your computer uses for this kind of file" onClick={() => void open()}>
            Open
          </Button>
        )}
        <OutputActions output={output} onRemoved={onRemoved} onNotice={onNotice} />
      </div>
      {!missing && <OutputPreview output={output} labelledBy="output-detail-heading" />}
    </section>
  )
}
