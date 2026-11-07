import type { ReactElement } from 'react'
import type { DashCaps } from './dashCaps'

/** The Right now band (docs/design/dashboard-2.md section 6). Shell placeholder; engineer A builds it. */
export function RightNowBand(_props: { caps: DashCaps; onAnnounce: (text: string) => void }): ReactElement {
  return (
    <section className="dash-section dash-now" data-testid="dash-now" aria-label="Right now">
      <h2>Right now</h2>
    </section>
  )
}
