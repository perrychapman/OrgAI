import type { ReactElement } from 'react'
import { useRef, useState } from 'react'
import { Undo2 } from 'lucide-react'
import type { TeamFilesStatus } from '@shared/types'
import { appliedSummaries, appliedTitle, dismissedUndoAt, rememberDismissedUndo, undoRewritesLine, undoneLine } from '../../lib/teamFiles'
import { showHidden } from '../../lib/hiddenChars'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import type { TeamFilesBusy } from './useTeamFilesActions'

/**
 * Changes the team files made at once (no approval needed) and the Undo for them, or the result of the last Undo.
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
  const showApplied = !appliedGone && status.applied.length > 0 && !!status.undo
  // A fresh undo replaces the applied notice (there is nothing left to undo).
  const showDone = !doneGone && !showApplied && !!status.lastUndo
  if (!showApplied && !showDone) return null
  if (showApplied && status.undo) {
    const at = status.undo.at
    return (
      <Banner
        tone="info"
        label="Team files applied"
        title={appliedTitle(status)}
        testId="team-files-applied"
        onDismiss={() => {
          rememberDismissedUndo(window.localStorage, status.projectId, at)
          setDismissed((d) => ({ ...d, [`a:${at}`]: true }))
        }}
        actions={
          <Button size="sm" icon={Undo2} loading={busy === 'undo'} onClick={onUndo} testId="team-files-undo">
            Undo
          </Button>
        }
      >
        <span data-testid="team-files-applied-summaries">{appliedSummaries(status).map(showHidden).join(' ')}</span>{' '}
        <span data-testid="team-files-undo-files">{showHidden(undoRewritesLine(status.undo.files))}</span>
      </Banner>
    )
  }
  const last = status.lastUndo
  if (!last) return null
  return (
    <Banner
      tone="success"
      label="Team files undone"
      title={showHidden(undoneLine(last.files))}
      testId="team-files-undone"
      onDismiss={() => {
        rememberDismissedUndo(window.localStorage, `${status.projectId}:undone`, last.at)
        setDismissed((d) => ({ ...d, [`u:${last.at}`]: true }))
      }}
    />
  )
}
