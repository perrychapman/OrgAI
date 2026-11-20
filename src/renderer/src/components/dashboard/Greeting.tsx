import type { ReactElement, ReactNode } from 'react'
import { DashboardLive } from './DashboardLive'
import type { DashboardAnnouncement } from './DashboardContext'

/**
 * STUB (UI Lead contract, to be built by the greeting slice): the greeting `dashboard-hero` of
 * docs/design/dashboard-overhaul.md section 5. Props are the contract with DashboardView:
 * - `firstLaunch`: no projects ("Welcome to OrgAI." and its line, no name in the salutation).
 * - `announce`: the message for the page's one live region, rendered here through `DashboardLive`.
 * - `onAnnounce`: speak a message (name saved / removed).
 * - `customise`: the Customise button, owned by DashboardView, placed at the end of the greeting row (absent on first launch).
 * - `lastSeen` / `firstVisit`: from `useLastSeen()` in DashboardView.
 */
export interface GreetingProps {
  firstLaunch: boolean
  announce: DashboardAnnouncement | null
  onAnnounce: (text: string) => void
  customise?: ReactNode
  lastSeen: number
  firstVisit: boolean
}

export function Greeting({ firstLaunch, announce, customise }: GreetingProps): ReactElement {
  return (
    <section className="dash-greeting" data-testid="dashboard-hero" aria-label="Overview">
      <div className="dash-greeting-row">
        <p className="dash-salutation" data-testid="dash-greeting-salutation">
          {firstLaunch ? 'Welcome to OrgAI.' : 'Hello.'}
        </p>
        {customise}
      </div>
      <p className="dash-brief" data-testid="dash-greeting-brief" />
      <DashboardLive announce={announce} />
    </section>
  )
}
