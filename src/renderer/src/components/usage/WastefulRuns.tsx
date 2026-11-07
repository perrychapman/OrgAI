import type { ReactElement } from 'react'
import type { UsagePanelProps, WastefulSort } from './panelProps'

export interface WastefulRunsProps extends UsagePanelProps {
  sort: WastefulSort
  onSort: (sort: WastefulSort) => void
  /** Bumped when an efficiency instrument picked the sort: focus the section heading (h2, tabindex -1). */
  focusSeq: number
}

/** STUB from the UI Lead (docs/design/usage-app.md 6.6); the efficiency engineer replaces it. */
export default function WastefulRuns(_props: WastefulRunsProps): ReactElement {
  return (
    <section className="usage-panel" aria-labelledby="usage-wasteful-h" data-testid="usage-wasteful">
      <h2 id="usage-wasteful-h">Runs worth a look</h2>
    </section>
  )
}
