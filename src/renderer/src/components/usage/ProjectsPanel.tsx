import type { ReactElement } from 'react'
import type { UsagePanelProps } from './panelProps'

/** STUB from the UI Lead (docs/design/usage-app.md section 6); the charts engineer replaces it. */
export default function ProjectsPanel(_props: UsagePanelProps): ReactElement {
  return (
    <section className="usage-panel" aria-labelledby="usage-projects-panel-h" data-testid="usage-projects-panel">
      <h2 id="usage-projects-panel-h">By project</h2>
    </section>
  )
}
