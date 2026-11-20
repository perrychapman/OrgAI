import type { ReactElement, ReactNode, Ref } from 'react'
import type { TeamFilesStatus } from '@shared/types'
import TeamFilesLine from './TeamFilesLine'
import type { TeamFilesBusy } from './useTeamFilesActions'

/**
 * STUB (UI Lead, phase 2 interface): the Team files chip and its popover in the Team header (spec
 * docs/design/team-tab-overhaul.md 1.4). The engineer who owns this file replaces the body; the props are the contract
 * TeamView mounts against. Until then it renders the old line.
 */
export interface TeamFilesChipProps {
  status: TeamFilesStatus | undefined
  busy: TeamFilesBusy
  /** The last action's outcome in words (useTeamFilesActions.message), shown inside the popover. */
  message: string | null
  /** The chip button. TeamView focuses it after a commit, after an approval-card decision and on a Needs-you request without a card. */
  chipRef: Ref<HTMLButtonElement>
  /** Header width below 880 px: icon only, the label in `title` and `aria-label`. */
  compact?: boolean
  /** Called after the user confirmed the commit dialog (the chip owns the confirm). TeamView commits and posts the notice. */
  onCommit: () => void
  onEnable: () => void
  /** Closes the popover and opens the approval card (TeamView). */
  onReview: () => void
  /** The applied-at-once Undo notice (TeamFilesAppliedNotice), shown inside the popover. */
  applied?: ReactNode
}

export default function TeamFilesChip({ status, busy, message, onCommit, onEnable, onReview, applied }: TeamFilesChipProps): ReactElement | null {
  return (
    <TeamFilesLine status={status} busy={busy} message={message} lineRef={null} onCommit={onCommit} onEnable={onEnable} onReview={onReview}>
      {applied}
    </TeamFilesLine>
  )
}
