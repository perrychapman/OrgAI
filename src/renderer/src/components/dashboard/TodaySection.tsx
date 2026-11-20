import type { ReactElement } from 'react'
import { DashSection } from './DashboardContext'

/** STUB (UI Lead contract): Today (section 7.5), slice 7 of docs/design/dashboard-overhaul.md. Renders through DashSection with id 'today'. */
export function TodaySection(): ReactElement | null {
  return <DashSection id="today" testId="dash-today" empty />
}
