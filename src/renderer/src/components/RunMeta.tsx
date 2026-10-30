import type { ReactElement } from 'react'
import { Bot, ClipboardList, ShieldAlert } from 'lucide-react'
import type { Project } from '@shared/types'
import { useAppStore, useProjectSummaries, useRunIndexes, type RunState } from '../store/useAppStore'
import { costLabel, planProgress } from '../lib/layout'
import { predecessorOf, relativeTime } from '../lib/runChains'
import { runName, runTag, shortPrompt } from '../lib/runLabels'
import { autoContinueState } from '../lib/runStatus'
import { Icon } from './ui/Icon'

/**
 * The run's quiet metadata line at the start of the canvas toolbar (12 px, tertiary): the run it continues, agents,
 * plan steps (opens the Plan tab), cost, start time and "unattended". Items drop from the end in a narrow frame
 * (container queries in run.css); the status is not here, the active tab carries it.
 */
export default function RunMeta({ run, project, agentCount }: { run: RunState; project: Project; agentCount: number }): ReactElement {
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const setSideTab = useAppStore((s) => s.setSideTab)
  const openRun = useAppStore((s) => s.openRun)
  const { summary } = run
  const cost = costLabel(summary.totalCostUsd, authMode)
  const before = summary.resumedFrom ? predecessorOf(summaries, summary.id) : undefined
  const progress = run.plan ? planProgress(run.plan) : undefined
  const auto = autoContinueState({
    status: summary.status,
    plan: run.plan,
    autoContinue: project.autoContinue,
    maxAutoContinues: project.maxAutoContinues,
    kind: summary.kind
  })
  return (
    <div className="run-meta" data-testid="run-meta">
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
      <span className="run-meta-item run-meta-cost" title={cost.title}>
        {cost.text}
      </span>
      <span className="run-meta-item run-meta-started" title={new Date(summary.startedAt).toLocaleString()}>
        Started {relativeTime(summary.startedAt)}
      </span>
      {auto.active && auto.count > 0 && (
        <span className="run-meta-item run-meta-auto">
          {auto.count} of {auto.max} auto-continues
        </span>
      )}
      {project.permissionMode === 'auto' && (
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
