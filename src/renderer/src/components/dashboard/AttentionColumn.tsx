import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { CircleAlert, FileDiff, GitMerge, ListChecks, MessageCircleQuestion, Plug, ShieldQuestion, Users, type LucideIcon } from 'lucide-react'
import { isVirtualProjectId, type Project, type RunSummary } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { useAppStore, type RunState } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { AttentionSection } from './AttentionSection'
import { useAllSummaries, useLiveRuns, useNow, useWaitingRuns } from './useDashboardData'
import { runCostInput } from '../../lib/cost'
import { NEEDS_CAP, PAUSED_CAP, RUNNING_CAP, SINCE_LAST_SEEN_CAP, elapsedLabel, errorFirstLine, pausedRuns, planStepLabel, sinceLastSeen } from '../../lib/dashboard'
import { locationLabel, runKindLabel } from '../../lib/assistants'
import { waitingItems, type WaitingItem, type WaitingKind } from '../../lib/needsYou'
import { openTeamFilesDecision, useTeamAttentionItems } from '../../lib/menuActions'
import { canContinue, relativeTime } from '../../lib/runChains'
import { runName } from '../../lib/runLabels'
import { statusOfRun, statusText } from '../../lib/runStatus'

export { useLastSeen } from './useLastSeen'

const KIND_ICON: Record<WaitingKind, LucideIcon> = {
  permission: ShieldQuestion,
  question: MessageCircleQuestion,
  rules: ListChecks,
  proposal: FileDiff,
  merge: GitMerge,
  install: Plug,
  plan: CircleAlert
}

/** The status dot: colour always sits beside the status word. */
function Dot({ tone, live }: { tone: string; live?: boolean }): ReactElement {
  return <span className="dash-dot" data-tone={tone} data-live={live ? 'true' : undefined} aria-hidden="true" />
}

/** The project a run belongs to (real or virtual), for the autoContinue facts statusOfRun reads. */
function useProjectLookup(): (id: string) => Project | undefined {
  const projects = useAppStore((s) => s.projects)
  const virtual = useAppStore((s) => s.virtualProjects)
  return useMemo(() => {
    const byId = new Map<string, Project>(projects.map((p) => [p.id, p]))
    return (id: string) => byId.get(id) ?? (isVirtualProjectId(id) ? virtual[id] : undefined)
  }, [projects, virtual])
}

interface RunNeedsItem extends WaitingItem {
  projectId: string
  run: RunState
}
/** A team-files approval: no run behind it (lib/teamFiles.ts). */
interface TeamNeedsItem {
  kind: 'team'
  key: string
  runId?: undefined
  projectId: string
  label: string
  projectName: string
}
type NeedsItem = RunNeedsItem | TeamNeedsItem

function NeedsYouSection(): ReactElement {
  const waiting = useWaitingRuns()
  const projects = useAppStore((s) => s.projects)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const teamItems = useTeamAttentionItems()
  const items = useMemo<NeedsItem[]>(
    () => [
      ...waiting.flatMap((run) =>
        waitingItems(run, projectKindOf(projects.find((p) => p.id === run.summary.projectId))).map((it): NeedsItem => ({ ...it, projectId: run.summary.projectId, run }))
      ),
      ...teamItems.map((t): NeedsItem => ({ kind: 'team', key: t.key, projectId: t.projectId, label: t.label, projectName: t.projectName }))
    ],
    [waiting, projects, teamItems]
  )
  return (
    <AttentionSection
      testId="dash-needs-you"
      title="Needs you"
      count={items.length}
      items={items}
      cap={NEEDS_CAP}
      itemKey={(it) => (it.kind === 'team' ? it.key : `${it.runId}/${it.key}`)}
      empty="Nothing needs you."
      renderItem={(it) => {
        const rowKey = it.kind === 'team' ? it.key : `${it.runId}/${it.key}`
        return (
          <li key={rowKey} className="dash-row dash-row-needs" data-testid="dash-needs-row" data-kind={it.kind} data-row-key={rowKey}>
            <button
              type="button"
              className="dash-row-main"
              data-row-main=""
              onClick={() => (it.kind === 'team' ? openTeamFilesDecision(it.projectId) : void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key))}
            >
              <span className="dash-row-icon">
                <Icon icon={it.kind === 'team' ? Users : KIND_ICON[it.kind]} />
              </span>
              <span className="dash-row-text">
                <span className="dash-row-line">{it.label}</span>
                <span className="dash-row-cap">{it.kind === 'team' ? `${it.projectName} · Team` : `${locationLabel(it.projectId, projects)} · ${runName(it.run.summary)}`}</span>
              </span>
            </button>
          </li>
        )
      }}
    />
  )
}

function RunningSection({ now }: { now: number }): ReactElement {
  const live = useLiveRuns()
  const projects = useAppStore((s) => s.projects)
  const projectOf = useProjectLookup()
  const focusRun = useAppStore((s) => s.focusRun)
  return (
    <AttentionSection
      testId="dash-running"
      title="Running now"
      count={live.length}
      items={live}
      cap={RUNNING_CAP}
      itemKey={(r) => r.summary.id}
      empty="Nothing is running."
      renderItem={(run) => {
        const s = run.summary
        const waiting = waitingItems(run).length > 0
        const view = statusOfRun(run, projectOf(s.projectId), waiting)
        const plan = planStepLabel(run.plan)
        const elapsed = elapsedLabel(s.startedAt, now)
        const chip = isVirtualProjectId(s.projectId) || s.quick ? runKindLabel(s) : null
        return (
          <li key={s.id} className="dash-row dash-row-running" data-testid="dash-running-row" data-status={view.word} data-row-key={s.id}>
            <button type="button" className="dash-row-main" data-row-main="" onClick={() => void focusRun(s.projectId, s.id).then(settleFocus)}>
              <Dot tone={view.tone} live />
              <span className="dash-row-text">
                <span className="dash-row-line">
                  <span className="dash-status">{statusText(view)}</span>
                  <span className="dash-row-name">{runName(s)}</span>
                </span>
                <span className="dash-row-cap">
                  <span className="dash-clip">
                    {locationLabel(s.projectId, projects)} · {elapsed === 'just started' ? elapsed : `for ${elapsed}`}
                  </span>
                  {plan && <span className="dash-num dash-plan">{plan}</span>}
                  {chip && <Badge>{chip}</Badge>}
                </span>
              </span>
            </button>
          </li>
        )
      }}
    />
  )
}

/** After a row opens a run, focus the topbar heading unless focus already moved somewhere real (the composer). */
function settleFocus(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

function SinceSection({
  lastSeen,
  clearedAt,
  onMarkAllSeen,
  now,
  summaries
}: {
  lastSeen: number
  clearedAt: number
  onMarkAllSeen: () => void
  now: number
  summaries: RunSummary[]
}): ReactElement | null {
  const projects = useAppStore((s) => s.projects)
  const projectOf = useProjectLookup()
  const focusRun = useAppStore((s) => s.focusRun)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const result = useMemo(() => sinceLastSeen(summaries, lastSeen, now, { cap: Number.MAX_SAFE_INTEGER, clearedAt }), [summaries, lastSeen, clearedAt, now])
  const openRow = (projectId: string, runId: string): void => {
    void focusRun(projectId, runId).then(settleFocus)
  }
  const items = result.items

  const markAllSeen = (): void => {
    // The section disappears: hand focus to the next section's heading (else the previous one) first.
    const section = document.querySelector('[data-testid=dash-since]')
    const next = (section?.nextElementSibling ?? section?.previousElementSibling)?.querySelector<HTMLElement>('[data-section-heading]')
    onMarkAllSeen()
    next?.focus({ preventScroll: true })
  }

  return (
    <AttentionSection
      testId="dash-since"
      title="Since you were last here"
      count={items.length}
      items={items}
      cap={SINCE_LAST_SEEN_CAP}
      itemKey={(it) => it.run.id}
      action={
        <Button variant="ghost" size="sm" testId="dash-since-clear" onClick={markAllSeen}>
          Mark all seen
        </Button>
      }
      renderItem={(it) => {
        const s = it.run
        const view = statusOfRun({ summary: s }, projectOf(s.projectId), false)
        const word = statusText(view)
        const error = it.kind === 'failed' ? errorFirstLine(s.error) : ''
        const closedWaiting = it.kind === 'closed-waiting'
        const canGo = closedWaiting && canContinue(summaries, s.id)
        return (
          <li key={s.id} className="dash-row dash-row-since" data-testid="dash-since-row" data-status={view.word} data-row-key={s.id} data-has-action={canGo ? 'true' : undefined}>
            <button type="button" className="dash-row-main" data-row-main="" onClick={() => openRow(s.projectId, s.id)}>
              <Dot tone={view.tone} />
              <span className="dash-row-text">
                <span className="dash-row-line">
                  <span className="dash-status">{word}</span>
                  <span className="dash-row-name">{runName(s)}</span>
                </span>
                <span className="dash-row-cap">
                  <span className="dash-clip">
                    {locationLabel(s.projectId, projects)} · {relativeTime(it.endedAt, now)}
                  </span>
                  <Cost value={runCostInput(s)} hideEmpty className="dash-num" />
                </span>
                {error && <span className="dash-row-cap dash-row-detail">{error}</span>}
                {closedWaiting && <span className="dash-row-cap dash-row-detail">Was waiting on you when OrgAI closed.</span>}
              </span>
            </button>
            {canGo && (
              <span className="dash-row-side">
                <Button variant="secondary" size="sm" testId="dash-since-continue" ariaLabel={`Continue ${runName(s)}`} onClick={() => void continueFromHistory(s.id, s.projectId)}>
                  Continue
                </Button>
              </span>
            )}
          </li>
        )
      }}
    />
  )
}

function pausedCaption(s: RunSummary): string {
  if (s.autoResume && s.pausedUntil) {
    return `resumes at ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return 'waits for you to continue'
}

function PausedSection({ summaries }: { summaries: RunSummary[] }): ReactElement | null {
  const projects = useAppStore((s) => s.projects)
  const projectOf = useProjectLookup()
  const focusRun = useAppStore((s) => s.focusRun)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const paused = useMemo(() => pausedRuns(summaries), [summaries])
  return (
    <AttentionSection
      testId="dash-paused"
      title="Paused"
      count={paused.length}
      items={paused}
      cap={PAUSED_CAP}
      itemKey={(s) => s.id}
      renderItem={(s) => (
        <li key={s.id} className="dash-row dash-row-paused" data-testid="dash-paused-row" data-row-key={s.id} data-has-action="true">
          <button type="button" className="dash-row-main" data-row-main="" onClick={() => void focusRun(s.projectId, s.id).then(settleFocus)}>
            <Dot tone="paused" />
            <span className="dash-row-text">
              <span className="dash-row-line">
                <span className="dash-status">{statusText(statusOfRun({ summary: s }, projectOf(s.projectId), false))}</span>
                <span className="dash-row-name">{runName(s)}</span>
              </span>
              <span className="dash-row-cap">
                <span className="dash-clip">
                  {locationLabel(s.projectId, projects)} · {pausedCaption(s)}
                </span>
              </span>
              {s.pauseReason && <span className="dash-row-cap dash-row-detail">{errorFirstLine(s.pauseReason)}</span>}
            </span>
          </button>
          <span className="dash-row-side">
            <Button variant="secondary" size="sm" testId="dash-paused-resume" ariaLabel={`Resume ${runName(s)} now`} onClick={() => void resumeNow(s.id)}>
              Resume now
            </Button>
          </span>
        </li>
      )}
    />
  )
}

/**
 * The Dashboard's attention column (spec 4): Needs you, Running now, Since you were last here, Paused, in that order.
 * Elapsed times re-render every 30 s and are never announced.
 */
export function AttentionColumn({ lastSeen, clearedAt, onMarkAllSeen }: { lastSeen: number; clearedAt: number; onMarkAllSeen: () => void }): ReactElement {
  const now = useNow()
  const summaries = useAllSummaries()
  return (
    <div className="dash-attention">
      <NeedsYouSection />
      <RunningSection now={now} />
      <SinceSection lastSeen={lastSeen} clearedAt={clearedAt} onMarkAllSeen={onMarkAllSeen} now={now} summaries={summaries} />
      <PausedSection summaries={summaries} />
    </div>
  )
}
