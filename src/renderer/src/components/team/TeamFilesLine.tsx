import type { ReactElement, ReactNode, Ref } from 'react'
import { TriangleAlert } from 'lucide-react'
import { TEAM_FILES_LIST_MAX, type TeamFilesStatus } from '@shared/types'
import { COMMIT_CONFIRM_NOTE, commitConfirmText, teamFilesLine } from '../../lib/teamFiles'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useConfirm } from '../ui/ConfirmDialog'
import type { TeamFilesBusy } from './useTeamFilesActions'

/** A visual separator between the line's parts (each part is its own phrase; the dot is not read out). */
function Sep(): ReactElement {
  return (
    <span className="team-files-line-sep" aria-hidden="true">
      ·
    </span>
  )
}

/**
 * The quiet, persistent team-files status: one polite region in the Team tab's footer row. Text from the files is shown
 * as text only, hidden characters escaped. The region itself takes focus after a decision (tabIndex -1).
 * Commit writes to the user's repository, so it asks first and names the files (Team tab phase 1, D7a).
 */
export default function TeamFilesLine({
  status,
  busy,
  message,
  lineRef,
  onCommit,
  onEnable,
  onReview,
  children
}: {
  /** The applied / undone notice: it shares this row instead of stacking a banner above the chart. */
  children?: ReactNode
  status: TeamFilesStatus | undefined
  busy: TeamFilesBusy
  message: string | null
  lineRef: Ref<HTMLDivElement>
  onCommit: () => void
  onEnable: () => void
  onReview: () => void
}): ReactElement | null {
  const { confirm, dialog } = useConfirm()
  const line = status ? teamFilesLine(status) : null
  if (!status || !line) return null
  const warnings = status.warnings
  const act = line.action
  const askCommit = async (): Promise<void> => {
    const c = commitConfirmText(status, TEAM_FILES_LIST_MAX)
    const ok = await confirm({
      title: 'Commit the team files?',
      body: (
        <div className="stack-2" data-testid="team-files-commit-confirm">
          <p>{c.lead}</p>
          {c.files.length > 0 && (
            <ul className="team-files-commit-list mono">
              {c.files.map((f) => (
                <li key={f} title={showHidden(f)}>
                  {showHidden(f)}
                </li>
              ))}
              {c.more > 0 && <li className="muted">and {c.more} more</li>}
            </ul>
          )}
          {c.warnings.length > 0 && (
            <Banner tone="warning" label="Team files warnings" testId="team-files-commit-warnings">
              <ul className="team-files-commit-list">
                {c.warnings.map((w, i) => (
                  <li key={i}>
                    <span className="mono">{showHidden(w.file)}</span>: {showHidden(w.message)}
                    {hasHidden(w.file + w.message) && <span className="sr-only"> (hidden characters shown)</span>}
                  </li>
                ))}
                {c.moreWarnings > 0 && <li>and {c.moreWarnings} more warnings</li>}
              </ul>
            </Banner>
          )}
          <p className="muted">{COMMIT_CONFIRM_NOTE}</p>
        </div>
      ),
      confirmLabel: c.confirmLabel,
      confirmTestId: 'team-files-commit-confirm-button'
    })
    if (ok) onCommit()
  }
  return (
    <div className="team-files-line" data-testid="team-files-line" data-state={status.state} data-tone={line.tone} ref={lineRef} tabIndex={-1} role="group" aria-label="Team files status" data-wrap={line.detail || message ? 'true' : 'false'}>
      <div className="team-files-line-main" role="status" aria-live="polite" title={line.title ? showHidden(line.title) : undefined}>
        {line.tone === 'danger' && <Icon icon={TriangleAlert} size="sm" />}
        <span className="team-files-line-text">{showHidden(line.text)}</span>
        {line.detail && (
          <>
            <Sep />
            <span className="team-files-line-detail">{showHidden(line.detail)}</span>
          </>
        )}
        {message && (
          <>
            <Sep />
            <span className="team-files-line-message" data-testid="team-files-message">
              {showHidden(message)}
            </span>
          </>
        )}
      </div>
      {act && (
        <Button
          size="sm"
          variant={act === 'review' ? 'secondary' : 'ghost'}
          loading={(act === 'commit' && busy === 'commit') || (act === 'enable' && busy === 'enable')}
          disabled={busy !== null && !(act === 'review')}
          onClick={act === 'commit' ? () => void askCommit() : act === 'enable' ? onEnable : onReview}
          testId={act === 'commit' ? 'team-files-commit' : act === 'enable' ? 'team-files-enable' : 'team-files-review'}
        >
          {line.actionLabel ?? 'Open'}
        </Button>
      )}
      {children}
      {warnings.length > 0 && (
        <ul className="team-files-warnings" data-testid="team-files-warnings" aria-label="Team files warnings">
          {warnings.slice(0, 3).map((w, i) => (
            <li key={i}>
              <Icon icon={TriangleAlert} size="sm" /> {showHidden(w.file)}: {showHidden(w.message)}
              {hasHidden(w.file + w.message) && <span className="sr-only"> (hidden characters shown)</span>}
            </li>
          ))}
          {warnings.length > 3 && <li>and {warnings.length - 3} more warnings.</li>}
        </ul>
      )}
      {dialog}
    </div>
  )
}
