import type { ReactElement } from 'react'
import type { UsagePanelProps } from './panelProps'

/** STUB from the UI Lead (docs/design/usage-app.md section 6); the charts engineer replaces it. */
export default function SpendPanel(_props: UsagePanelProps): ReactElement {
  return (
    <section className="usage-panel" aria-labelledby="usage-spend-h" data-testid="usage-spend">
      <h2 id="usage-spend-h">Spend over time</h2>
    </section>
  )
}
