import type { ReactElement, ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import PermissionCard from '../PermissionCard'
import QuestionCard from '../QuestionCard'
import ProposalCard from '../ProposalCard'
import RuleRequestCard from '../RuleRequestCard'
import MergeReviewCard from '../MergeReviewCard'
import McpInstallCard from '../McpInstallCard'
import { openTeamFilesDecision } from '../../lib/menuActions'
import { errorFirstLine } from '../../lib/dashboard'
import { formatDateTime } from '../../lib/dates'
import { relativeAgo, type InboxItem } from '../../lib/inbox'
import { money } from '../../lib/usage'
import { showHidden } from '../../lib/hiddenChars'
import { oneLine } from '../../lib/decisionTitle'

/** The waiting run's own card for this item, or the way to answer it in the run when the run holds no such card. */
function WaitingCard({ item, onOpenRun }: { item: InboxItem; onOpenRun: (item: InboxItem) => void }): ReactElement {
  const run = useAppStore((s) => (item.runId ? s.runs[item.runId] : undefined))
  const project = useAppStore((s) => s.projects.find((p) => p.id === item.projectId))
  if (!run || !item.runId || !item.key) return <AnswerInRun item={item} onOpenRun={onOpenRun} />
  // Enter and "Answer in order" move focus to `.inbox-main` (the panels below) or the card's own primary button.
  const runId = item.runId
  const key = item.key
  const isSetup = run.summary.kind === 'setup'
  const who = (agentId: string): string => run.agents[agentId]?.name ?? 'An agent'
  const st = useAppStore.getState

  if (item.kind === 'permission') {
    const p = run.permissions.find((x) => x.id === key)
    if (p) return <PermissionCard runId={runId} request={p} who={who(p.agentId)} onDecide={(d) => st().decideIn(runId, p.id, d)} />
  } else if (item.kind === 'question') {
    const q = (run.questions ?? []).find((x) => x.id === key)
    if (q) return <QuestionCard runId={runId} question={q} who={isSetup ? 'The Architect' : who(q.agentId)} onAnswer={(a) => st().answerQuestionIn(runId, q.id, a)} />
  } else if (item.kind === 'rules') {
    const r = (run.ruleRequests ?? []).find((x) => x.id === key)
    if (r) return <RuleRequestCard runId={runId} request={r} who={who(r.agentId)} onDecide={(d) => window.orgai.permissions.decideRequest({ runId, requestId: r.id, decision: d })} />
  } else if (item.kind === 'proposal') {
    const p = run.proposals.find((x) => x.id === key)
    if (p)
      return (
        <ProposalCard
          runId={runId}
          who={isSetup ? 'The Architect' : who(p.agentId)}
          agentId={isSetup ? undefined : p.agentId}
          proposal={p}
          currentRoles={project?.roles ?? []}
          onDecide={(d) => window.orgai.setup.decide({ runId, proposalId: p.id, decision: d })}
        />
      )
  } else if (item.kind === 'merge') {
    const m = (run.mergeReviews ?? []).find((x) => x.id === key)
    if (m) return <MergeReviewCard runId={runId} review={m} onDecide={(d) => window.orgai.runs.decideMerge({ runId, reviewId: m.id, decision: d })} />
  } else if (item.kind === 'install') {
    const i = (run.mcpInstalls ?? []).find((x) => x.id === key)
    if (i) return <McpInstallCard runId={runId} request={i} agentName={who(i.agentId)} />
  }
  return <AnswerInRun item={item} onOpenRun={onOpenRun} />
}

/** The frame every selected item shares: where it comes from on one line, and the way to the run. */
function Frame({ item, children, open }: { item: InboxItem; children: ReactNode; open?: ReactNode }): ReactElement {
  return (
    <div className="inbox-detail-body">
      <div className="inbox-detail-head">
        <span className="inbox-detail-where">
          <span className="inbox-detail-project" title={item.projectName}>
            {oneLine(showHidden(item.projectName), 80)}
          </span>
        </span>
        {open}
      </div>
      {children}
    </div>
  )
}

/**
 * The selected item. A waiting decision shows the same card the run view shows (so the answer, the scopes and the
 * errors are the card's own); a team-files approval and a finished run get their own small panel. Nothing here sends
 * an answer on its own: every answer is a visible button in the card.
 */
export default function InboxDetail({
  item,
  upNext,
  now,
  onOpenRun,
  onClear
}: {
  item: InboxItem
  /** The item after this one, for the "Up next" line. */
  upNext: InboxItem | null
  now: number
  /** Open the run (or the team tab) for this item. Finished runs are marked read first. */
  onOpenRun: (item: InboxItem) => void
  onClear: (item: InboxItem) => void
}): ReactElement {
  const summary = useAppStore((s) => (item.group === 'finished' && item.runId ? (s.runs[item.runId]?.summary ?? Object.values(s.historyByProject).flat().find((h) => h.id === item.runId)) : undefined))
  const openLink = (label: string): ReactNode => (
    <Button size="sm" variant="ghost" testId="inbox-open-run" onClick={() => onOpenRun(item)}>
      <Icon icon={ExternalLink} size="xs" />
      {label}
    </Button>
  )
  const next = upNext ? (
    <div className="inbox-upnext" data-testid="inbox-upnext">
      <span className="inbox-upnext-label">Up next</span>
      <span className="inbox-upnext-text">
        {upNext.title} · {upNext.projectName}
      </span>
    </div>
  ) : null

  if (item.group === 'waiting' && item.kind !== 'team') {
    return (
      <div className="inbox-detail" data-testid="inbox-detail" data-kind={item.kind} data-group="waiting">
        <Frame item={item} open={openLink('Open in run')}>
          <WaitingCard item={item} onOpenRun={onOpenRun} />
        </Frame>
        {next}
      </div>
    )
  }

  if (item.kind === 'team') {
    return (
      <div className="inbox-detail" data-testid="inbox-detail" data-kind="team" data-group="waiting">
        <Frame item={item}>
          <article className="glass inbox-panel inbox-panel-waiting" aria-label={`${item.kindLabel}: ${item.title}`}>
            <div className="inbox-panel-meta">
              <Badge tone="attention">{item.kindLabel}</Badge>
              <span>{oneLine(showHidden(item.projectName), 80)}</span>
            </div>
            <h2 className="inbox-panel-title">{item.title}</h2>
            <p className="inbox-panel-note">The team files in this project changed on disk. Review them on the Team tab, where you can approve or refuse each change.</p>
            <div className="inbox-panel-actions">
              <Button variant="primary" size="sm" testId="inbox-team-open" onClick={() => openTeamFilesDecision(item.projectId)} className="inbox-main">
                Review team changes
              </Button>
            </div>
          </article>
        </Frame>
        {next}
      </div>
    )
  }

  // A finished or failed run.
  const failed = item.kind === 'failed'
  const ended = summary?.endedAt ?? item.at
  const started = summary?.startedAt
  const minutes = started ? Math.max(1, Math.round((ended - started) / 60_000)) : null
  const cost = summary && summary.totalCostUsd > 0 ? money(summary.totalCostUsd) : null
  const error = failed ? errorFirstLine(summary?.error, 240) : ''
  return (
    <div className="inbox-detail" data-testid="inbox-detail" data-kind={item.kind} data-group="finished">
      <Frame item={item}>
        <article className="glass inbox-panel" aria-label={`${item.kindLabel}: ${item.title}`}>
          <div className="inbox-panel-meta">
            <Badge tone={failed ? 'danger' : 'success'}>{item.kindLabel}</Badge>
            <span>{oneLine(showHidden(item.projectName), 80)}</span>
            <span className="inbox-panel-when" title={formatDateTime(ended)}>
              {relativeAgo(ended, now) === 'just now' ? 'just now' : `${relativeAgo(ended, now)} ago`}
            </span>
          </div>
          <h2 className="inbox-panel-title">{item.title}</h2>
          <p className="inbox-panel-note">{failed ? 'The run stopped with an error. Nothing is waiting on you, but you may want to look.' : 'The run finished. Nothing is waiting on you.'}</p>
          {(error || minutes !== null || cost) && (
            <ul className="inbox-facts" aria-label="Run facts">
              {error && (
                <li>
                  <span className="inbox-fact-dot" data-tone="danger" aria-hidden="true" />
                  {error}
                </li>
              )}
              {minutes !== null && (
                <li>
                  <span className="inbox-fact-dot" aria-hidden="true" />
                  {minutes} min
                </li>
              )}
              {cost && (
                <li>
                  <span className="inbox-fact-dot" aria-hidden="true" />
                  {cost}
                </li>
              )}
            </ul>
          )}
          <div className="inbox-panel-actions">
            <Button variant="primary" size="sm" testId="inbox-finished-open" onClick={() => onOpenRun(item)} className="inbox-main">
              Open run
            </Button>
            <Button variant="ghost" size="sm" testId="inbox-finished-clear" onClick={() => onClear(item)}>
              Clear
            </Button>
          </div>
        </article>
      </Frame>
      {next}
    </div>
  )
}

/** A plain panel with the way to the run, for an ask the run holds no card for (a blocked plan, or a card that just went). */
function AnswerInRun({ item, onOpenRun }: { item: InboxItem; onOpenRun: (item: InboxItem) => void }): ReactElement {
  return (
    <article className="glass inbox-panel inbox-panel-waiting" aria-label={`${item.kindLabel}: ${item.title}`}>
      <div className="inbox-panel-meta">
        <Badge tone="attention">{item.kindLabel}</Badge>
        <span>{oneLine(showHidden(item.projectName), 80)}</span>
      </div>
      <h2 className="inbox-panel-title">{item.title}</h2>
      <p className="inbox-panel-note">This one is answered in the run.</p>
      <div className="inbox-panel-actions">
        <Button variant="primary" size="sm" testId="inbox-answer-in-run" onClick={() => onOpenRun(item)} className="inbox-main">
          Answer in run
        </Button>
      </div>
    </article>
  )
}
