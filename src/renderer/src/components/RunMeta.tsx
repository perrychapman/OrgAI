import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Bot, ClipboardList, Clock, Database, Folder, ShieldAlert } from 'lucide-react'
import type { Project } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { folderName } from '../lib/paths'
import { breakdownKey, breakdownTotal, EMPTY_BREAKDOWN, parseBreakdownKey, parseBreakdownPartial, recordedBreakdown, recordedBreakdownText, recordedLabel, recordedTitle } from '../lib/knowledgeRun'
import { isRunWindow, revealKnowledgeTab } from '../lib/runKnowledge'
import { PROPOSAL_NEXT_COPY, proposalNextLead } from '../lib/proposalNext'
import { APP_SETTINGS_PANES, requestAppSettingsSection, requestSkillLibrary } from '../lib/settingsTarget'
import { useAppStore, useProjectSummaries, type RunState } from '../store/useAppStore'
import { planProgress } from '../lib/layout'
import { agentCostInput, formatDuration, runCostInput, sumCosts, costView } from '../lib/cost'
import { Cost } from './ui/Cost'
import { chainOf, relativeTime } from '../lib/runChains'
import { shortPrompt } from '../lib/runLabels'
import { autoContinueState } from '../lib/runStatus'
import { Icon } from './ui/Icon'
import TeamFilesPointer from './team/TeamFilesPointer'
import { quickFolderLabel } from '../lib/assistants'
import { CHAT_ACCESS_ANNOUNCEMENT, CHAT_ACCESS_LABEL, CHAT_ACCESS_TITLE, chatAccessState } from '../lib/chatPermissions'
import { useFrameAnnounce } from './layout/CanvasFrame'
import { isOrgChangeRun, ORG_CHANGE_KIND_LABEL } from '../lib/orgChange'

/**
 * The run's quiet metadata line at the start of the canvas toolbar (12 px, tertiary): the run it continues, agents,
 * plan steps (opens the Plan tab), cost, start time and "unattended". Items drop from the end in a narrow frame
 * (container queries in run.css); the status is not here, the active tab carries it.
 */
export default function RunMeta({ run, project, agentCount }: { run: RunState; project: Project; agentCount: number }): ReactElement {
  const summaries = useProjectSummaries()
  const setSideTab = useAppStore((s) => s.setSideTab)
  const { summary } = run
  // Wall time ticks each second while the run is live; "Started" refreshes every 30 s either way.
  const live = !summary.endedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), live ? 1000 : 30_000)
    return () => clearInterval(t)
  }, [live])
  const wallMs = (summary.endedAt ?? now) - summary.startedAt
  // The Chat access chip. Turning to 'session' is announced once, never on mount.
  const announce = useFrameAnnounce()
  const accessState = summary.quick ? chatAccessState(summary.quick, !!run.sessionChanges) : null
  // Keyed by run: RunMeta is not remounted on a tab switch, so another run's state must never count as a change.
  const lastAccess = useRef({ runId: summary.id, state: accessState })
  useEffect(() => {
    const prev = lastAccess.current
    if (prev.runId === summary.id && accessState === 'session' && prev.state !== 'session') announce?.(CHAT_ACCESS_ANNOUNCEMENT)
    lastAccess.current = { runId: summary.id, state: accessState }
  }, [summary.id, accessState, announce])
  // The host's run usage is the truth; before the first run.usage event the strip total can lag the agent costs.
  const agentCosts = sumCosts(Object.values(run.agents).map(agentCostInput))
  const own =
    summary.usage ?? (agentCosts.costUsd !== null && agentCosts.costUsd > summary.totalCostUsd ? agentCosts : runCostInput(summary))
  // One conversation per session chain: the figure covers every session, like the root node on the canvas.
  const chain = chainOf(summaries, summary.id)
  const earlier = chain.filter((m) => m.id !== summary.id && m.startedAt <= summary.startedAt)
  const cost = earlier.length > 0 ? sumCosts([...earlier.map(runCostInput), own]) : own
  const showCost = !costView(cost).empty
  const sessions = chain.length
  // Section 8: what the conversation recorded on the Knowledge tab (every member's harness write rows), engagements only.
  const engagement = projectKindOf(project) === 'engagement'
  // A joined string keeps the selector's result a stable primitive.
  const recordedKey = useAppStore((s) => {
    if (!engagement) return ''
    const sum = { ...EMPTY_BREAKDOWN }
    let partial = false
    for (const m of chain) {
      if (!s.runs[m.id]) partial = true
      const b = recordedBreakdown(s.runs[m.id]?.transcript ?? [])
      sum.items += b.items
      sum.updates += b.updates
      sum.relations += b.relations
      sum.notes += b.notes
      sum.retired += b.retired
    }
    return breakdownKey(sum, partial)
  })
  const breakdown = parseBreakdownKey(recordedKey)
  const recordedPartial = parseBreakdownPartial(recordedKey)
  const recorded = breakdownTotal(breakdown)
  const recordedText = recordedBreakdownText(breakdown)
  // A run window cannot reach the project's Knowledge tab: the run's own Knowledge side tab opens instead (spec 3.3).
  const openRecorded = (runId: string): void => {
    if (isRunWindow()) {
      useAppStore.getState().openRunKnowledge(runId)
      revealKnowledgeTab()
    } else useAppStore.getState().openKnowledgeItem({ projectId: project.id })
  }
  const progress = run.plan ? planProgress(run.plan) : undefined
  const auto = autoContinueState({
    status: summary.status,
    plan: run.plan,
    autoContinue: project.autoContinue,
    maxAutoContinues: project.maxAutoContinues,
    kind: summary.kind
  })
  const next = useAppStore((s) => s.proposalNextByRun[summary.id])
  const nextCopy = next ? PROPOSAL_NEXT_COPY[next.kind] : null
  const goNext = (): void => {
    if (!next) return
    const st = useAppStore.getState()
    if (next.kind === 'skillsLibrary') {
      requestSkillLibrary()
      st.setView('appSettings')
    } else if (next.kind === 'connectors') {
      requestAppSettingsSection(APP_SETTINGS_PANES.mcpLibrary)
      st.setView('appSettings')
    } else if (next.kind === 'mcpProject' || next.kind === 'mcpSecrets') {
      st.openProjectMcp(next.projectId)
    } else {
      if (st.selectedProjectId !== next.projectId) st.selectProject(next.projectId)
      st.setView('team')
    }
  }
  return (
    <div className="run-meta" data-testid="run-meta">
      {next && nextCopy && (
        <span className="run-meta-item run-meta-next">
          {next ? proposalNextLead(next) : nextCopy.lead}{' '}
          <button type="button" className="link-btn" data-testid={nextCopy.testId} onClick={goNext}>
            {nextCopy.action}
          </button>
          <button type="button" className="link-btn" onClick={() => useAppStore.getState().noteProposalNext(summary.id, null)} aria-label="Dismiss this note">
            Dismiss
          </button>
        </span>
      )}
      {!isVirtualProjectId(project.id) && <TeamFilesPointer projectId={project.id} />}
      {summary.kind === 'setup' && (
        <span className="run-meta-item" data-testid="run-meta-kind">
          {isOrgChangeRun(summary) ? `${ORG_CHANGE_KIND_LABEL} session` : 'Setup session'}
        </span>
      )}
      {summary.quick && (
        <>
          <span className="run-meta-item run-meta-folder" title={summary.quick.scratch ? 'A private scratch folder' : summary.quick.folder}>
            <Icon icon={Folder} size="xs" />
            {quickFolderLabel(summary.quick)}
          </span>
          {accessState && (
            <span className="run-meta-item run-meta-access" data-testid="run-meta-access" data-state={accessState} title={CHAT_ACCESS_TITLE[accessState]}>
              {CHAT_ACCESS_LABEL[accessState]}
              <span className="sr-only">. {CHAT_ACCESS_TITLE[accessState]}</span>
            </span>
          )}
        </>
      )}
      {summary.kind === 'mcp-assist' && summary.buildWorkspace && (
        <span className="run-meta-item run-meta-folder" title={summary.buildWorkspace} data-testid="run-meta-workspace">
          <Icon icon={Folder} size="xs" />
          {folderName(summary.buildWorkspace)}
        </span>
      )}
      <span className="run-meta-item run-meta-agents">
        <Icon icon={Bot} size="xs" />
        {agentCount} agent{agentCount === 1 ? '' : 's'}
      </span>
      {recorded > 0 && (
        <button type="button" className="run-meta-item run-meta-recorded" data-testid="run-meta-recorded" title={recordedTitle(recordedText, sessions, recordedPartial)} onClick={() => openRecorded(summary.id)}>
          <Icon icon={Database} size="xs" />
          {recordedLabel(recorded, recordedPartial)}
          <span className="sr-only"> ({recordedText}{recordedPartial ? ', at least; some sessions are not loaded' : ''}; opens Knowledge)</span>
        </button>
      )}
      {sessions > 1 && (
        <span className="run-meta-item run-meta-sessions" data-testid="run-meta-sessions" title="This conversation has been continued; the figures cover every session.">
          {sessions} sessions
        </span>
      )}
      {run.plan && progress && (
        <button
          type="button"
          className={`run-meta-item run-meta-steps ${run.plan.status}`}
          title={`Plan ${run.plan.status === 'active' ? 'in progress' : run.plan.status}: ${shortPrompt(run.plan.goal, 300)}. Click to open the plan.`}
          onClick={() => setSideTab('plan')}
        >
          <Icon icon={ClipboardList} size="xs" />
          {progress.done}/{progress.total} steps
          {run.plan.status === 'done' && <span className="sr-only"> (plan done)</span>}
          {run.plan.status === 'blocked' && <span className="sr-only"> (plan blocked)</span>}
        </button>
      )}
      {wallMs >= 0 && (
        <span className="run-meta-item run-meta-wall" title={live ? 'Wall time so far' : 'Wall time'}>
          <Icon icon={Clock} size="xs" />
          {formatDuration(wallMs)}
        </span>
      )}
      {showCost && (
        <span className="run-meta-item run-meta-cost">
          <Cost value={cost} labelled />
        </span>
      )}
      <span className="run-meta-item run-meta-started" title={new Date(summary.startedAt).toLocaleString()}>
        Started {relativeTime(summary.startedAt, now)}
      </span>
      {auto.active && auto.count > 0 && (
        <span className="run-meta-item run-meta-auto">
          {auto.count} of {auto.max} auto-continues
        </span>
      )}
      {summary.team === 'single' && !summary.quick && !isVirtualProjectId(summary.projectId) && (
        <span className="run-meta-item" data-testid="run-meta-ask">
          Ask · one assistant
        </span>
      )}
      {project.permissionMode === 'auto' && !summary.quick && summary.kind === 'work' && summary.team !== 'single' && !isVirtualProjectId(summary.projectId) && (
        <span
          className="run-meta-item run-meta-unattended"
          title="Permission mode is auto: the model's safety check approves or denies each call and asks only when unsure. Saved rules never ask."
        >
          <Icon icon={ShieldAlert} size="xs" />
          unattended
        </span>
      )}
    </div>
  )
}
