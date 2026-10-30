import type { ReactElement } from 'react'
import { ClipboardList, Eye, EyeOff, Pause, RotateCcw, Square } from 'lucide-react'
import type { Project } from '@shared/types'
import { useAppStore, useProjectSummaries, useRunIndexes, type RunState } from '../store/useAppStore'
import { costLabel, planProgress } from '../lib/layout'
import { needsYou, predecessorOf, relativeTime } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { runStatus } from '../lib/runStatus'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'

interface Props {
  run: RunState
  project: Project
  agentCount: number
  /** Whether finished reports fold into one node per parent, and how many are folded now. */
  collapseFinished: boolean
  finishedCount: number
  onToggleCollapse: () => void
}

/**
 * The run's identity and controls, in normal flow under the tabs: index, status, full prompt (one line, full text
 * in the tooltip), start time, cost, and the actions that used to float over the canvas.
 */
export default function RunHeader({ run, project, agentCount, collapseFinished, finishedCount, onToggleCollapse }: Props): ReactElement {
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const interrupt = useAppStore((s) => s.interrupt)
  const stopRun = useAppStore((s) => s.stopRun)
  const startRetro = useAppStore((s) => s.startRetro)
  const setSideTab = useAppStore((s) => s.setSideTab)
  const openRun = useAppStore((s) => s.openRun)

  const { summary } = run
  const waiting = needsYou(run)
  const status = runStatus(summary.status, { waiting, endedWithApp: !!summary.endedWithApp })
  const sessionOpen = summary.status === 'running' || summary.status === 'idle' || summary.status === 'starting'
  const cost = costLabel(summary.totalCostUsd, authMode)
  const tag = runTag(indexes.get(summary.id))
  const full = promptLine(summary.prompt)
  const before = predecessorOf(summaries, summary.id)
  const progress = run.plan ? planProgress(run.plan) : undefined

  return (
    <header className="run-header" aria-label={`${tag}: ${shortPrompt(summary.prompt, 60)}`}>
      <div className="run-header-id">
        <span className="run-index">{tag}</span>
        <span className={`pill run-status ${status.tone}`} title={status.note}>
          <span className="dot" aria-hidden="true" /> {status.word}
        </span>
        <span className="run-header-prompt" title={full}>
          {full}
        </span>
        <span className="run-header-meta">
          <span title={new Date(summary.startedAt).toLocaleString()}>Started {relativeTime(summary.startedAt)}</span>
          <span aria-hidden="true"> · </span>
          <span title={cost.title}>{cost.text}</span>
        </span>
      </div>
      {summary.resumedFrom && (
        <div className="run-header-chain">
          Continues{' '}
          {before ? (
            <button type="button" className="link-btn" onClick={() => void openRun(before.id)} title={promptLine(before.prompt)}>
              {runTag(indexes.get(before.id))}: {shortPrompt(before.prompt, 48)}
            </button>
          ) : (
            'an earlier run'
          )}
        </div>
      )}
      <div className="run-header-actions">
        {summary.kind === 'setup' && (
          <span className="pill warn">
            <span className="dot" aria-hidden="true" /> Setup session
          </span>
        )}
        {project.permissionMode === 'auto' && (
          <span className="pill unattended" title="Permission mode is auto: Claude approves or denies each call and asks only when unsure. Saved rules never ask.">
            unattended
          </span>
        )}
        <span className="pill run-agents">
          {agentCount} agent{agentCount === 1 ? '' : 's'}
        </span>
        {run.plan && progress && (
          <button
            type="button"
            className={`pill plan-pill ${run.plan.status}`}
            title={`Plan ${run.plan.status === 'active' ? 'in progress' : run.plan.status}: ${run.plan.goal}. Click to open the plan.`}
            onClick={() => setSideTab('plan')}
          >
            <Icon icon={ClipboardList} size="xs" />
            {progress.done}/{progress.total} steps
            {run.plan.status === 'done' ? ' ✓' : run.plan.status === 'blocked' ? ' !' : ''}
          </button>
        )}
        {agentCount > 1 && (
          <Button
            size="sm"
            variant={collapseFinished ? 'secondary' : 'ghost'}
            icon={collapseFinished ? EyeOff : Eye}
            onClick={onToggleCollapse}
            title={collapseFinished ? 'Finished reports fold into one node per parent. Click to show them all.' : 'Click to fold finished reports into one node per parent.'}
          >
            <span className="fold-label">{collapseFinished ? `Folding finished${finishedCount ? ` (${finishedCount})` : ''}` : 'Showing all'}</span>
          </Button>
        )}
        {sessionOpen && (
          <>
            <Button size="sm" icon={Pause} onClick={() => void interrupt()} disabled={summary.status !== 'running'}>
              Interrupt turn
            </Button>
            <Button size="sm" variant="danger" icon={Square} onClick={() => void stopRun()}>
              End session
            </Button>
          </>
        )}
        {!sessionOpen && summary.error && (
          <span className="pill danger" title={summary.error}>
            {summary.error.slice(0, 60)}
          </span>
        )}
        {!sessionOpen && summary.kind === 'work' && (summary.status === 'finished' || summary.status === 'error') && (
          <Button
            size="sm"
            icon={RotateCcw}
            title="Have the Architect review this run and revise the org chart where roles struggled"
            onClick={() => void startRetro(summary.id)}
          >
            Org retrospective
          </Button>
        )}
      </div>
    </header>
  )
}
