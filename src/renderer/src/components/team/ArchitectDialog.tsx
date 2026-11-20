import type { ReactElement } from 'react'
import type { Project } from '@shared/types'

/**
 * STUB (UI Lead, phase 2 interface): "Redesign with the Architect" dialog (spec docs/design/team-tab-overhaul.md 1.3).
 * The engineer who owns this file replaces the body. TeamView mounts it while open; `onClose` returns focus to the
 * Start from button (TeamView does that).
 */
export interface ArchitectDialogProps {
  project: Project
  onClose: () => void
}

export default function ArchitectDialog(_props: ArchitectDialogProps): ReactElement | null {
  return null
}
