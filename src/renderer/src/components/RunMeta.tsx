import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Bot, ClipboardList, Clock, Folder, ShieldAlert } from 'lucide-react'
import type { Project } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { folderName } from '../lib/paths'
import { PROPOSAL_NEXT_COPY, proposalNextLead } from '../lib/proposalNext'
import { APP_SETTINGS_PANES, requestAppSettingsSection, requestSkillLibrary } from '../lib/settingsTarget'
import { useAppStore, useProjectSummaries, useRunIndexes, type RunState } from '../store/useAppStore'
import { planProgress } from '../lib/layout'
import { agentCostInput, formatDuration, runCostInput, sumCosts, costView } from '../lib/cost'
import { Cost } from './ui/Cost'
import { predecessorOf, relativeTime } from '../lib/runChains'
import { runName, runTag, shortPrompt } from '../lib/runLabels'
import { autoContinueState } from '../lib/runStatus'
import { Icon } from './ui/Icon'
import { quickAccessLabel, quickFolderLabel } from '../lib/assistants'

/**
 * The run's quiet metadata line at the start of the canvas toolbar (12 px, tertiary): the run it continues, agents,
 * plan steps (opens the Plan tab), cost, start time and "unattended". Items drop from the end in a narrow frame
 * (container queries in run.css); the status is not here, the active tab carries it.
 */
export default function RunMeta({ run, project, agentCount }: { run: RunState; project: Project; agentCount: number }): ReactElement {
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const setSideTab = useAppStore((s) => s.setSideTab)
  const openRun = useAppStore((s) => s.openRun)
  const { summary } = run
  // Wall time ticks each second while the run is live; "Started" refreshes every 30 s either way.
  const live = !summary.endedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), live ? 1000 : 30_000)
    return () => clearInterval(t)
  }, [live])
  const wallMs = (summary.endedAt ?? now) - summary.startedAt
  // The host's run usage is the truth; before the first run.usage event the strip total can lag the agent costs.
  const agentCosts = sumCosts(Object.values(run.agents).map(agentCostInput))
  const cost =
    summary.usage ?? (agentCosts.costUsd !== null && agentCosts.costUsd > summary.totalCostUsd ? agentCosts : runCostInput(summary))
  const showCost = !costView(cost).empty
  const before = summary.resumedFrom ? predecessorOf(summaries, summary.id) : undefined
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
      {summary.resumedFrom && (
        <span className="run-meta-item run-meta-chain">
          Continues{' '}
          {before ? (
            <button type="button" className="link-btn" onClick={() => void openRun(before.id)} title={shortPrompt(before.prompt, 300)}>
              {runTag(indexes.get(before.id))}: {runName(before)}
            </button>
          ) : (
            'an earlier run'
          )}
        </span>
      )}
      {summary.kind === 'setup' && <span className="run-meta-item">Setup session</span>}
      {summary.quick && (
        <>
          <span className="run-meta-item run-meta-folder" title={summary.quick.scratch ? 'A private scratch folder' : summary.quick.folder}>
            <Icon icon={Folder} size="xs" />
            {quickFolderLabel(summary.quick)}
          </span>
          <span className="run-meta-item run-meta-access">{quickAccessLabel(summary.quick)}</span>
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
      {project.permissionMode === 'auto' && !summary.quick && summary.kind === 'work' && !isVirtualProjectId(summary.projectId) && (
        <span
          className="run-meta-item run-meta-unattended"
          title="Permission mode is auto: Claude approves or denies each call and asks only when unsure. Saved rules never ask."
        >
          <Icon icon={ShieldAlert} size="xs" />
          unattended
        </span>
      )}
    </div>
  )
}
