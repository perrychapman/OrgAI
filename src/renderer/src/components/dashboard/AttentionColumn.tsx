import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { isVirtualProjectId, type Project, type RunSummary } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { AttentionSection, focusAfterRemoval, headingAfter } from './AttentionSection'
import type { DashCaps } from './dashCaps'
import { NeedsRow, needsItemKey, useNewDecisionAnnouncer, type NeedsItem } from './NeedsInline'
import { useAllSummaries, useNow, useWaitingRuns } from './useDashboardData'
import { runCostInput } from '../../lib/cost'
import { errorFirstLine, pausedRuns, sinceLastSeen } from '../../lib/dashboard'
import { locationLabel } from '../../lib/assistants'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { waitingItems } from '../../lib/needsYou'
import { hideUserEnded, pausedCaption } from '../../lib/needsInline'
import { openTeamFilesDecision, useTeamAttentionItems } from '../../lib/menuActions'
import { canContinue, relativeTime } from '../../lib/runChains'
import { runName } from '../../lib/runLabels'
import { statusOfRun, statusText } from '../../lib/runStatus'

export { useLastSeen } from './useLastSeen'

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

function NeedsYouSection({ cap, onAnnounce }: { cap: number; onAnnounce: (text: string) => void }): ReactElement {
  const waiting = useWaitingRuns()
  const projects = useAppStore((s) => s.projects)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const teamItems = useTeamAttentionItems()
  // Every project's history is in: the first data load is over, and the baseline of seen decisions is taken then.
  const ready = useAppStore((s) => s.projects.length > 0 && s.projects.every((p) => p.id in s.historyByProject))
  const items = useMemo<NeedsItem[]>(
    () => [
      ...waiting.flatMap((run) =>
        waitingItems(run, projectKindOf(projects.find((p) => p.id === run.summary.projectId))).map((it): NeedsItem => ({ ...it, projectId: run.summary.projectId, run }))
      ),
      ...teamItems.map((t): NeedsItem => ({ kind: 'team', key: t.key, projectId: t.projectId, label: t.label, projectName: t.projectName }))
    ],
    [waiting, projects, teamItems]
  )
  const announced = useMemo(
    () => items.map((it) => ({ key: needsItemKey(it), project: it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects), label: it.label })),
    [items, projects]
  )
  useNewDecisionAnnouncer(announced, ready, onAnnounce)
  return (
    <AttentionSection
      testId="dash-needs-you"
      moreTestId="dash-needs-more"
      title="Needs you"
      count={items.length}
      items={items}
      cap={cap}
      itemKey={needsItemKey}
      quiet
      renderItem={(it) => (
        <NeedsRow
          key={needsItemKey(it)}
          item={it}
          projectName={it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects)}
          runName={it.kind === 'team' ? undefined : runName(it.run.summary)}
          onAnnounce={onAnnounce}
          onOpen={() => (it.kind === 'team' ? openTeamFilesDecision(it.projectId) : void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key))}
        />
      )}
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
  cap,
  lastSeen,
  clearedAt,
  onMarkAllSeen,
  now,
  summaries
}: {
  cap: number
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
  // L5: a run the user ended in this window's lifetime is left out, they just did it.
  const items = useMemo(
    () => hideUserEnded(sinceLastSeen(summaries, lastSeen, now, { cap: Number.MAX_SAFE_INTEGER, clearedAt }).items, performance.timeOrigin),
    [summaries, lastSeen, clearedAt, now]
  )
  const openRow = (projectId: string, runId: string): void => {
    void focusRun(projectId, runId).then(settleFocus)
  }

  const clear = (): void => {
    // The section disappears: hand focus to the next visible section heading after it (else the previous, else the
    // topbar h1) once React has removed it (spec 12.2).
    const target = headingAfter(document.querySelector('[data-testid=dash-since]'))
    onMarkAllSeen()
    focusAfterRemoval(target)
  }

  return (
    <AttentionSection
      testId="dash-since"
      title="Recently ended"
      count={items.length}
      items={items}
      cap={cap}
      itemKey={(it) => it.run.id}
      action={
        <Button variant="ghost" size="sm" testId="dash-since-clear" ariaLabel="Clear recently ended runs" onClick={clear}>
          Clear
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
                  <Cost value={runCostInput(s)} hideEmpty compact className="dash-num" />
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

function PausedSection({ cap, summaries }: { cap: number; summaries: RunSummary[] }): ReactElement | null {
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
      cap={cap}
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

/** Needs you (docs/design/dashboard-2.md section 5), its own grid area. */
export function NeedsYouRegion({ caps, onAnnounce }: { caps: DashCaps; onAnnounce: (text: string) => void }): ReactElement {
  return <NeedsYouSection cap={caps.needs} onAnnounce={onAnnounce} />
}

/** Paused (section 9.1), its own grid area; renders nothing without paused runs. */
export function PausedRegion({ caps }: { caps: DashCaps }): ReactElement | null {
  const summaries = useAllSummaries()
  return <PausedSection cap={caps.paused} summaries={summaries} />
}

/** Recently ended (section 9.2), its own grid area; renders nothing when empty. */
export function EndedRegion({ caps, lastSeen, clearedAt, onMarkAllSeen }: { caps: DashCaps; lastSeen: number; clearedAt: number; onMarkAllSeen: () => void }): ReactElement | null {
  const now = useNow()
  const summaries = useAllSummaries()
  return <SinceSection cap={caps.ended} lastSeen={lastSeen} clearedAt={clearedAt} onMarkAllSeen={onMarkAllSeen} now={now} summaries={summaries} />
}
