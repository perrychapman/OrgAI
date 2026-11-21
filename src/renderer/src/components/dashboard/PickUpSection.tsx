import type { ReactElement } from 'react'
import { ResumeSection } from './ResumeSection'

/** Interface stub (UI Lead): Pick up replaces ResumeSection. */
export function PickUpSection({ lastSeen }: { lastSeen?: number }): ReactElement | null {
  return <ResumeSection {...(lastSeen !== undefined ? { lastSeen } : {})} />
}
