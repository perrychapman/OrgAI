import type { ReactElement } from 'react'
import { DashSection } from './DashboardContext'

/** STUB (UI Lead contract): Pick up where you left off (section 7.4), slice 4 of docs/design/dashboard-overhaul.md. Renders through DashSection with id 'resume'. */
export function ResumeSection(): ReactElement | null {
  return <DashSection id="resume" testId="dash-resume" empty />
}
