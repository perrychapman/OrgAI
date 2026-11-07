// STUB (UI Lead foundation): replaced by the run-surfaces engineer. Signature is fixed: docs/design/outputs.md section 4.
import type { ReactElement } from 'react'
import type { RunOutput } from '@shared/types'
import OutputPreview from './OutputPreview'

export interface OutputDetailProps {
  output: RunOutput
  /** Called after Remove from list / Delete file succeeded (the surface moves focus to the next row). */
  onRemoved?: (id: string) => void
  /** Notice line text (open / reveal refusals, save, remove); the surface renders it in its polite region. */
  onNotice?: (text: string) => void
  /** Focus the heading on mount (the default). */
  autoFocus?: boolean
}

export default function OutputDetail({ output }: OutputDetailProps): ReactElement {
  return (
    <section className="output-detail" data-testid="output-detail" data-id={output.id} data-kind={output.kind} aria-labelledby="output-detail-heading">
      <h3 id="output-detail-heading" data-testid="output-detail-heading" tabIndex={-1}>
        {output.title}
      </h3>
      <OutputPreview output={output} labelledBy="output-detail-heading" />
    </section>
  )
}
