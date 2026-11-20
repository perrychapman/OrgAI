import type { ReactElement } from 'react'
import { DashSection } from './DashboardContext'

/** STUB (UI Lead contract): Your week (section 7.7), slice 6 of docs/design/dashboard-overhaul.md. Renders through DashSection with id 'week'. */
export function WeekSection(): ReactElement | null {
  return <DashSection id="week" testId="dash-week" empty />
}
