import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { TeamFileChange, TeamFilesStatus } from '@shared/types'
import {
  APPROVE_UNLOCKED_TEXT,
  CHANGE_ACTION_LABEL,
  CHANGE_KIND_LABEL,
  approveBlockedReason,
  cardLead,
  cardTitle,
  changeHasHidden,
  elevatedLine,
  PROBLEM_NEXT,
  READ_FIRST_COMPACT_TEXT,
  READ_FIRST_TEXT,
  reachLine,
  secretsLine,
  toolsAddedLine
} from '../../lib/teamFiles'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { useAnnounceOnce, useFrameCompact } from '../layout/CanvasFrame'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { Icon } from '../ui/Icon'
import { ClampText } from '../proposals/ClampText'
import type { TeamFilesBusy } from './useTeamFilesActions'

const ACTION_TONE = { added: 'success', changed: 'info', removed: 'attention' } as const

function PromptDetails({ summary, text, name }: { summary: string; text: string; name: string }): ReactElement {
  return (
    <details className="team-files-prompt">
      <summary>{summary}</summary>
      {text ? <ClampText text={text} label={`${showHidden(name)} ${summary.toLowerCase()}`} /> : <p className="team-files-empty">Empty.</p>}
    </details>
  )
}

function ChangeRow({ c }: { c: TeamFileChange }): ReactElement {
  const hidden = changeHasHidden(c, hasHidden)
  const lines = [toolsAddedLine(c), elevatedLine(c), c.scripts && c.scripts.length > 0 ? `Includes scripts: ${c.scripts.join(', ')}.` : null, secretsLine(c), reachLine(c)].filter(
    (x): x is string => !!x
  )
  return (
    <li className="team-files-change" data-testid="team-files-change" data-kind={c.kind} data-action={c.action} data-needs-approval={c.needsApproval ? 'true' : 'false'}>
      <div className="team-files-change-head">
        <Badge tone={ACTION_TONE[c.action]}>{CHANGE_ACTION_LABEL[c.action]}</Badge>
        <Badge tone="neutral">{CHANGE_KIND_LABEL[c.kind]}</Badge>
        <strong className="team-files-change-name">{showHidden(c.name)}</strong>
        {hidden && (
          <Badge tone="danger" icon={TriangleAlert} testId="team-files-hidden">
            Contains hidden characters
          </Badge>
        )}
      </div>
      <p className="team-files-change-summary">{showHidden(c.summary)}</p>
      {c.reason && <p className="team-files-change-reason">Why it asks: {showHidden(c.reason)}</p>}
      {lines.length > 0 && (
        <ul className="team-files-facts">
          {lines.map((l, i) => (
            <li key={i}>{showHidden(l)}</li>
          ))}
        </ul>
      )}
      {c.kind === 'mcp' && c.target && (
        <div className="team-files-target-row">
          <div className="team-files-target mono" data-testid="team-files-target">
            {showHidden(c.target)}
          </div>
          <CopyButton text={showHidden(c.target)} label={`Copy what ${showHidden(c.name)} would run${hidden ? ' (hidden characters escaped)' : ''}`} />
        </div>
      )}
      {c.usesStoredSignIn && <p className="team-files-fact">Uses the sign-in stored on this computer.</p>}
      {c.kind === 'role' && c.after !== undefined && <PromptDetails summary={c.action === 'added' ? 'Show prompt' : 'Show new prompt'} text={c.after} name={c.name} />}
      {c.kind === 'role' && c.before !== undefined && c.action !== 'added' && <PromptDetails summary="Show previous prompt" text={c.before} name={c.name} />}
      {c.kind === 'skill' && c.after !== undefined && <PromptDetails summary="Show skill text" text={c.after} name={c.name} />}
      {c.kind === 'role' && c.toolsBefore && c.toolsAfter && (
        <details className="team-files-prompt">
          <summary>Show all tools</summary>
          <p className="team-files-fact">Before: {c.toolsBefore.length > 0 ? c.toolsBefore.map(showHidden).join(', ') : 'none'}.</p>
          <p className="team-files-fact">After: {c.toolsAfter.length > 0 ? c.toolsAfter.map(showHidden).join(', ') : 'none'}.</p>
        </details>
      )}
      <p className="team-files-change-file">{showHidden(c.file)}</p>
    </li>
  )
}

/**
 * The approval card for team-files changes, in the Team tab's tray. It follows the DecisionCard shell (head, scrolling
 * body, footer that stays visible) but has no run to name. Nothing focuses Approve on its own; `focusSignal` (a count)
 * opens the card and lands focus on it. Text from the repository is untrusted: text only, hidden characters escaped.
 */
export default function TeamFilesCard({
  status,
  busy,
  error,
  focusSignal,
  assistantOpen,
  onToggleAssistant,
  onApprove,
  onReject
}: {
  status: TeamFilesStatus
  busy: TeamFilesBusy
  error: string | null
  focusSignal: number
  assistantOpen: boolean
  onToggleAssistant: () => void
  onApprove: () => void
  onReject: () => void
}): ReactElement {
  const ref = useRef<HTMLElement>(null)
  const bodyId = useId()
  const reasonId = useId()
  const compact = useFrameCompact()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!compact) setExpanded(false)
  }, [compact])
  useEffect(() => {
    if (!focusSignal) return undefined
    if (compact) setExpanded(true)
    const id = window.requestAnimationFrame(() => ref.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [focusSignal, compact])
  // Nobody approves what they have not been shown: Approve waits until the change list has been scrolled to its end
  // (or fits without scrolling). A body hidden behind Details in a compact frame has not been shown at all.
  const bodyRef = useRef<HTMLDivElement>(null)
  // `scrolls` is live (null: not measured yet or hidden; a layout that settles later can turn it on); `reachedEnd` is kept
  // once the reader got to the bottom of this digest's list.
  const digest = status.digest
  const readKey = `${status.projectId}:${digest ?? ''}`
  const [readFor, setReadFor] = useState<string | null>(null)
  const [scrolls, setScrolls] = useState<boolean | null>(null)
  const reviewed = scrolls === false || readFor === readKey
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return undefined
    const measure = (): void => {
      if (el.clientHeight === 0) {
        setScrolls(null)
        return
      }
      const over = el.scrollHeight - el.clientHeight > 4
      setScrolls(over)
      if (over && el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setReadFor(readKey)
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [digest, readKey, expanded, compact])
  const blocked = approveBlockedReason(status) ?? (reviewed ? null : compact && !expanded ? READ_FIRST_COMPACT_TEXT : READ_FIRST_TEXT)
  const title = cardTitle(status)
  const omitted = status.omittedChanges ?? 0
  useAnnounceOnce(`team-files:${status.projectId}`, `${title}. They need your approval in the tray below the chart.`)
  // Approve unlocking after the list was scrolled to its end is said once (a list that fits never locked it).
  useAnnounceOnce(`team-files-read:${readKey}`, readFor === readKey ? APPROVE_UNLOCKED_TEXT : null)
  const problem = status.state === 'problem' ? status.problems[0] : undefined
  return (
    <article
      ref={ref}
      tabIndex={-1}
      className="decision-card kind-proposal team-files-card"
      aria-label={title}
      data-kind="proposal"
      data-expanded={expanded ? 'true' : 'false'}
      data-testid="team-files-card"
    >
      <header className="decision-head">
        <div className="decision-meta">
          <Badge tone="accent">Team files</Badge>
          {status.firstSeen && <Badge tone="info">First time seen here</Badge>}
          {/* Not a decision: a way to ask the Team assistant about these files, kept in the head, away from Approve and Reject. */}
          <button type="button" className="link-btn team-files-assistant-link" data-testid="team-files-assistant-toggle" aria-expanded={assistantOpen} onClick={onToggleAssistant}>
            {assistantOpen ? 'Hide Team assistant' : 'Ask the Team assistant'}
          </button>
        </div>
        <div className="decision-titlebar">
          <span className="decision-title">{title}</span>
          <button type="button" className="decision-details" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)}>
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
            Details
          </button>
        </div>
        <p className="decision-summary">{cardLead(status)}</p>
      </header>
      <div
        className="decision-body"
        id={bodyId}
        ref={bodyRef}
        data-testid="team-files-body"
        // A scrolling region must be reachable by keyboard so the end of the list can be read before Approve.
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? 'Changes to review' : undefined}
      >
        {problem && (
          <p className="team-files-problem" data-testid="team-files-card-problem">
            <Icon icon={TriangleAlert} size="sm" /> {showHidden(problem.file)}: {showHidden(problem.message)} {PROBLEM_NEXT}
          </p>
        )}
        <ul className="team-files-changes" aria-label="Changes in the team files">
          {status.changes.map((c) => (
            <ChangeRow key={c.id} c={c} />
          ))}
        </ul>
        {omitted > 0 && (
          <p className="team-files-omitted" data-testid="team-files-omitted">
            {omitted} more {omitted === 1 ? 'change is' : 'changes are'} not listed. Too many changes to review at once.
          </p>
        )}
        {status.notes.length > 0 && (
          <ul className="team-files-notes" aria-label="Notes">
            {status.notes.slice(0, 5).map((n, i) => (
              <li key={i}>{showHidden(n)}</li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="team-files-error" role="alert" data-testid="team-files-error">
          {error}
        </p>
      )}
      <footer className="decision-footer">
        <Button
          variant="primary"
          testId="team-files-approve"
          loading={busy === 'approve'}
          inert={blocked !== null}
          ariaDescribedBy={blocked ? reasonId : undefined}
          disabled={busy === 'reject'}
          onClick={onApprove}
        >
          Approve
        </Button>
        <div className="decision-deny">
          <Button testId="team-files-reject" loading={busy === 'reject'} disabled={busy === 'approve'} inert={!status.digest} onClick={onReject}>
            Reject
          </Button>
        </div>
        {blocked && (
          <p id={reasonId} className="team-files-blocked" data-testid="team-files-blocked">
            {blocked}
          </p>
        )}
      </footer>
    </article>
  )
}
