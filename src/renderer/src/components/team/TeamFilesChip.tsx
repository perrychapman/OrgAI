import { useLayoutEffect } from 'react'
import type { ReactElement, ReactNode, Ref } from 'react'
import { FileCheck, FileText, FileWarning, FileX, TriangleAlert, type LucideIcon } from 'lucide-react'
import { TEAM_FILES_LIST_MAX, type TeamFilesStatus } from '@shared/types'
import {
  COMMIT_CONFIRM_LIST_MAX,
  COMMIT_CONFIRM_NOTE,
  commitConfirmText,
  teamFilesChip,
  teamFilesLine,
  teamFilesPopoverSentence,
  type TeamFilesChipIcon
} from '../../lib/teamFiles'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { useConfirm } from '../ui/ConfirmDialog'
import { useTriggerAttrs } from '../runSettings/triggerAttrs'
import type { TeamFilesBusy } from './useTeamFilesActions'

/**
 * The Team files chip and its popover in the Team header (spec docs/design/team-tab-overhaul.md 1.4). The chip is the
 * Popover's own trigger button (testid `team-files-chip`; the wrapper keeps `team-files-line` with the state and tone,
 * the name the e2e scripts know). Text from the files is shown as text only, hidden characters escaped. Commit writes
 * to the user's repository, so it asks first and names the files (D7a); the chip owns that confirmation.
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

const ICONS: Record<TeamFilesChipIcon, LucideIcon> = {
  'file-check': FileCheck,
  'file-text': FileText,
  'file-warning': FileWarning,
  'file-x': FileX,
  alert: TriangleAlert
}

/** Files named one per line (mono, hidden characters shown), then "and N more". */
function FileList({ files, className }: { files: readonly string[]; className?: string }): ReactElement | null {
  if (files.length === 0) return null
  const shown = files.slice(0, COMMIT_CONFIRM_LIST_MAX)
  return (
    <ul className={`team-files-commit-list mono${className ? ` ${className}` : ''}`}>
      {shown.map((f) => (
        <li key={f} title={showHidden(f)}>
          {showHidden(f)}
        </li>
      ))}
      {files.length > shown.length && <li className="muted">and {files.length - shown.length} more</li>}
    </ul>
  )
}

export default function TeamFilesChip({ status, busy, message, chipRef, compact, onCommit, onEnable, onReview, applied }: TeamFilesChipProps): ReactElement | null {
  const { confirm, dialog } = useConfirm()
  const chip = teamFilesChip(status)
  const line = status ? teamFilesLine(status) : null
  const wrapRef = useTriggerAttrs({})

  // Hand the Popover's trigger button to the caller (the Popover renders it and keeps no outside ref).
  useLayoutEffect(() => {
    const button = wrapRef.current?.querySelector<HTMLButtonElement>('.popover-wrap > button') ?? null
    if (typeof chipRef === 'function') chipRef(button)
    else if (chipRef) (chipRef as { current: HTMLButtonElement | null }).current = button
    return () => {
      if (typeof chipRef === 'function') chipRef(null)
      else if (chipRef) (chipRef as { current: HTMLButtonElement | null }).current = null
    }
  }, [chipRef, wrapRef, chip === null])

  if (!status || !chip || !line) return null

  const act = line.action
  const sentence = teamFilesPopoverSentence(status)
  const warnings = status.warnings
  const files = status.uncommitted ? status.uncommittedFiles : []

  const askCommit = async (): Promise<void> => {
    const c = commitConfirmText(status, TEAM_FILES_LIST_MAX)
    const ok = await confirm({
      title: c.title,
      body: (
        <div className="stack-2" data-testid="team-files-commit-confirm">
          <p>{c.lead}</p>
          <FileList files={c.files} />
          {c.more > 0 && <p className="muted team-files-commit-more">and {c.more} more</p>}
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
    <span className="team-files-chip-wrap" ref={wrapRef} data-testid="team-files-line" data-state={status.state} data-tone={chip.tone}>
      <Popover
        trigger={
          <>
            <Icon icon={ICONS[chip.icon]} size="sm" />
            {!compact && <span className="team-files-chip-text">{chip.text}</span>}
          </>
        }
        triggerClassName="btn ghost sm team-files-chip"
        triggerLabel={compact ? chip.text : undefined}
        triggerTitle={compact ? chip.text : undefined}
        triggerTestId="team-files-chip"
        label="Team files"
        className="team-files-popover"
        testId="team-files-popover"
        placement="bottom-end"
      >
        {({ close }) => (
          <div className="team-files-pop stack-2">
            <h2 className="team-files-pop-title">Team files</h2>
            <p className="muted team-files-pop-explainer">OrgAI keeps this team as plain files in .orgai/ in your repository, so it can be reviewed and shared.</p>
            <div className="team-files-pop-status stack-1" role="status" aria-live="polite" data-tone={chip.tone}>
              {sentence ? (
                <p className="team-files-pop-sentence">{sentence}</p>
              ) : (
                <>
                  <p className="team-files-pop-sentence">{showHidden(line.text)}</p>
                  {line.detail && <p className="muted">{showHidden(line.detail)}</p>}
                </>
              )}
            </div>
            <FileList files={files} />
            {act === 'review' && (
              <Button
                size="sm"
                variant="secondary"
                testId="team-files-review"
                onClick={() => {
                  close()
                  onReview()
                }}
              >
                {line.actionLabel ?? 'Review changes'}
              </Button>
            )}
            {act === 'commit' && (
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'commit'}
                disabled={busy !== null}
                testId="team-files-commit"
                onClick={() => {
                  close()
                  void askCommit()
                }}
              >
                {line.actionLabel ?? 'Commit team files'}
              </Button>
            )}
            {act === 'enable' && (
              <Button size="sm" variant="secondary" loading={busy === 'enable'} disabled={busy !== null} testId="team-files-enable" onClick={onEnable}>
                {line.actionLabel ?? 'Turn team files on'}
              </Button>
            )}
            {message && (
              <p className="team-files-pop-message" data-testid="team-files-message">
                {showHidden(message)}
              </p>
            )}
            {applied}
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
        )}
      </Popover>
      {dialog}
    </span>
  )
}
