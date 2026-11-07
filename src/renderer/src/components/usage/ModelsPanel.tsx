import type { ReactElement } from 'react'
import type { UsagePanelProps } from './panelProps'

/** STUB from the UI Lead (docs/design/usage-app.md section 6); the charts engineer replaces it. */
export default function ModelsPanel(_props: UsagePanelProps): ReactElement {
  return (
    <section className="usage-panel" aria-labelledby="usage-models-h" data-testid="usage-models">
      <h2 id="usage-models-h">By model</h2>
    </section>
  )
}
