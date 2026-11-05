import type { ReactElement } from 'react'
import { useRef, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import type { TeamFilesStatus } from '@shared/types'
import {
  appliedSummaries,
  dismissedUndoAt,
  rememberDismissedUndo,
  undoIsApplied,
  undoNoticeLead,
  undoRewritesLine,
  undoneLine
} from '../../lib/teamFiles'
import { showHidden } from '../../lib/hiddenChars'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import type { TeamFilesBusy } from './useTeamFilesActions'

/**
 * Changes the team files made at once (no approval needed) and the Undo for them, or the result of the last Undo. It
 * sits in the status line's row (a notice stacked above the chart took 97 px of a 592 px frame) and shares its width.
 * Dismissal is remembered per project and per change time, so a later status push does not bring it back.
 */
export default function TeamFilesAppliedNotice({
  status,
  busy,
  onUndo
}: {
  status: TeamFilesStatus
  busy: TeamFilesBusy
  onUndo: () => void
}): ReactElement | null {
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  const appliedAt = status.undo?.at
  const doneAt = status.lastUndo?.at
  const appliedGone = !appliedAt || dismissed[`a:${appliedAt}`] || dismissedUndoAt(window.localStorage, status.projectId) === appliedAt
  // An Undo from an earlier visit is not news: only one that happened since this notice mounted shows.
  const firstDone = useRef(doneAt)
  const doneGone = !doneAt || doneAt === firstDone.current || dismissed[`u:${doneAt}`] || dismissedUndoAt(window.localStorage, `${status.projectId}:undone`) === doneAt
  // The applied batch's summaries only describe an Undo that reverts that batch; after an Approve the lead speaks for it.
  const showApplied = !appliedGone && !!status.undo && status.applied.length > 0
  // A fresh undo replaces the applied notice (there is nothing left to undo).
  const showDone = !doneGone && !showApplied && !!status.lastUndo
  if (!showApplied && !showDone) return null
  if (showApplied && status.undo) {
    const at = status.undo.at
    const summaries = undoIsApplied(status) ? appliedSummaries(status, 2).map(showHidden).join(' ') : ''
    return (
      <span className="team-files-notice" role="group" aria-label="Team files applied" data-testid="team-files-applied" data-tone="info">
        <span className="team-files-notice-text" role="status">
          <strong>{showHidden(undoNoticeLead(status))}</strong>
          {summaries ? ` ${summaries}` : ''}{' '}
          <span data-testid="team-files-undo-files">{showHidden(undoRewritesLine(status.undo.files))}</span>
        </span>
        <Button size="sm" icon={Undo2} loading={busy === 'undo'} onClick={onUndo} testId="team-files-undo">
          Undo
        </Button>
        <IconButton
          icon={X}
          label="Dismiss the applied notice"
          size="sm"
          onClick={() => {
            rememberDismissedUndo(window.localStorage, status.projectId, at)
            setDismissed((d) => ({ ...d, [`a:${at}`]: true }))
          }}
        />
      </span>
    )
  }
  const last = status.lastUndo
  if (!last) return null
  return (
    <span className="team-files-notice" role="group" aria-label="Team files undone" data-testid="team-files-undone" data-tone="success">
      <span className="team-files-notice-text" role="status">
        {showHidden(undoneLine(last.files))}
      </span>
      <IconButton
        icon={X}
        label="Dismiss the undone notice"
        size="sm"
        onClick={() => {
          rememberDismissedUndo(window.localStorage, `${status.projectId}:undone`, last.at)
          setDismissed((d) => ({ ...d, [`u:${last.at}`]: true }))
        }}
      />
    </span>
  )
}
