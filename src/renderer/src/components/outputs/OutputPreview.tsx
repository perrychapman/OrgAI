// STUB (UI Lead foundation): replaced by the previews engineer. Signature is fixed: docs/design/outputs.md section 4.
import type { ReactElement } from 'react'
import type { RunOutput } from '@shared/types'

export interface OutputPreviewProps {
  output: RunOutput
  /** The detail's heading id, for naming scroll regions. */
  labelledBy?: string
}

export default function OutputPreview({ output }: OutputPreviewProps): ReactElement {
  return (
    <div className="output-preview" data-testid="output-preview" data-kind="none">
      <p className="output-preview-none" data-testid="output-preview-none">
        Preview of {output.title} is not built yet.
      </p>
    </div>
  )
}
