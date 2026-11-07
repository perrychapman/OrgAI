import type { ReactElement } from 'react'
import type { UsagePanelProps } from './panelProps'

export interface AllRunsProps extends UsagePanelProps {
  /** The disclosure is open (a project drilldown or a deep link opens it, 4.8). */
  open: boolean
  onToggle: (open: boolean) => void
}

/** STUB from the UI Lead (docs/design/usage-app.md 7.3); the efficiency engineer replaces it. */
export default function AllRuns({ data, open, onToggle }: AllRunsProps): ReactElement {
  return (
    <section className="usage-panel" id="usage-runs" aria-labelledby="usage-runs-h" data-testid="usage-runs">
      <details open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <h2 id="usage-runs-h">All runs, {data.rows.length}</h2>
        </summary>
      </details>
    </section>
  )
}
