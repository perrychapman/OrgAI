import type { ReactElement } from 'react'
import type { UsagePanelProps } from './panelProps'

/** STUB from the UI Lead (docs/design/usage-app.md section 6); the charts engineer replaces it. */
export default function RolesPanel(_props: UsagePanelProps): ReactElement {
  return (
    <section className="usage-panel" aria-labelledby="usage-roles-h" data-testid="usage-roles">
      <h2 id="usage-roles-h">By role</h2>
    </section>
  )
}
