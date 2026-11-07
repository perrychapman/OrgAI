import type { ReactElement } from 'react'
import type { UsagePanelProps, WastefulSort } from './panelProps'

export interface EfficiencyPanelProps extends UsagePanelProps {
  /** An instrument's value was pressed: sort "Runs worth a look" by `sort` and move focus to its heading (6.5). */
  onPickSignal: (sort: WastefulSort) => void
}

/** STUB from the UI Lead (docs/design/usage-app.md 6.5); the efficiency engineer replaces it. */
export default function EfficiencyPanel(_props: EfficiencyPanelProps): ReactElement {
  return (
    <section className="usage-panel" id="usage-efficiency" aria-labelledby="usage-efficiency-h" data-testid="usage-efficiency">
      <h2 id="usage-efficiency-h">Efficiency</h2>
    </section>
  )
}
