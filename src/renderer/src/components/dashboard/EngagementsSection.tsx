import type { ReactElement } from 'react'
import { Briefcase } from 'lucide-react'
import { DashSection } from './DashboardContext'

/** Engagements (docs/design/dashboard-overhaul.md "Visual pass"): arrangeable tile; stub until built. */
export function EngagementsSection(): ReactElement | null {
  return <DashSection id="engagements" testId="dash-engagements" icon={Briefcase} empty />
}
