import type { ReactElement } from 'react'
import type { Project } from '@shared/types'

/**
 * STUB (UI Lead, phase 2 interface): the header's "Start from" menu (spec docs/design/team-tab-overhaul.md 1.3). The
 * engineer who owns this file replaces the body; the props are the contract TeamView mounts against.
 */
export interface StartFromMenuProps {
  project: Project
  /** Agent files found and not imported (sum of agentCount over importSourcesFor): null while the scan runs, 'error' when it failed. */
  found: number | null | 'error'
  /** The accent dot on the button (found > 0 and the banner memory is not 'dismissed'). */
  dot: boolean
  /** Opening the menu while found > 0 counts as seeing it: TeamView writes the banner memory 'dismissed'. */
  onOpened: () => void
  /** Saved templates (store `templates`); undefined while loading. */
  templateCount: number | undefined
  roleCount: number
  /** Header width below 880 px: icon only, label in `title` and `aria-label`. */
  compact?: boolean
  onTemplate: () => void
  onImport: () => void
  onArchitect: () => void
  onSave: () => void
}

export default function StartFromMenu(_props: StartFromMenuProps): ReactElement | null {
  return null
}
