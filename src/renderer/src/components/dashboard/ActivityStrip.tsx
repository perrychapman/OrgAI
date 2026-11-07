import type { ReactElement } from 'react'

/** The Last 14 days strip (docs/design/dashboard-2.md section 7). Shell placeholder; engineer B builds it. */
export function ActivityStrip({ size }: { size: 'compact' | 'tall' }): ReactElement {
  return (
    <section className="dash-section dash-strip" data-testid="dash-strip" data-size={size} aria-label="Last 14 days">
      <h2>Last 14 days</h2>
    </section>
  )
}
