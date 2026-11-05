import type { ReactElement, Ref } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { TeamFilesStatus } from '@shared/types'
import { teamFilesLine } from '../../lib/teamFiles'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import type { TeamFilesBusy } from './useTeamFilesActions'

/**
 * The quiet, persistent team-files status: one polite region in the Team tab's footer row. Text from the files is shown
 * as text only, hidden characters escaped. The region itself takes focus after a decision (tabIndex -1).
 */
export default function TeamFilesLine({
  status,
  busy,
  message,
  lineRef,
  onCommit,
  onEnable,
  onReview
}: {
  status: TeamFilesStatus | undefined
  busy: TeamFilesBusy
  message: string | null
  lineRef: Ref<HTMLDivElement>
  onCommit: () => void
  onEnable: () => void
  onReview: () => void
}): ReactElement | null {
  const line = status ? teamFilesLine(status) : null
  if (!status || !line) return null
  const warnings = status.warnings
  const act = line.action
  return (
    <div className="team-files-line" data-testid="team-files-line" data-state={status.state} data-tone={line.tone} ref={lineRef} tabIndex={-1} data-wrap={line.detail || message ? 'true' : 'false'}>
      <div className="team-files-line-main" role="status" aria-live="polite" title={line.title}>
        {line.tone === 'danger' && <Icon icon={TriangleAlert} size="sm" />}
        <span className="team-files-line-text">{showHidden(line.text)}</span>
        {line.detail && <span className="team-files-line-detail"> {showHidden(line.detail)}</span>}
        {message && (
          <span className="team-files-line-message" data-testid="team-files-message">
            {' '}
            {showHidden(message)}
          </span>
        )}
      </div>
      {act && (
        <Button
          size="sm"
          variant={act === 'review' ? 'secondary' : 'ghost'}
          loading={(act === 'commit' && busy === 'commit') || (act === 'enable' && busy === 'enable')}
          disabled={busy !== null && !(act === 'review')}
          onClick={act === 'commit' ? onCommit : act === 'enable' ? onEnable : onReview}
          testId={act === 'commit' ? 'team-files-commit' : act === 'enable' ? 'team-files-enable' : 'team-files-review'}
        >
          {line.actionLabel ?? 'Open'}
        </Button>
      )}
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
    </div>
  )
}
