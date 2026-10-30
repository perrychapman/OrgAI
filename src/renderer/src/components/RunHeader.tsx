import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { Check, ClipboardList, Pause, RotateCcw, Square, TriangleAlert } from 'lucide-react'
import type { Project } from '@shared/types'
import { useAppStore, useProjectSummaries, useRunIndexes, type RunState } from '../store/useAppStore'
import { costLabel, planProgress } from '../lib/layout'
import { needsYou, predecessorOf, relativeTime } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { autoContinueState, isStoppedRun, runStatus, statusText } from '../lib/runStatus'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Switch } from './ui/Switch'

/** Wraps one control and points its aria-describedby at a helper text; the primitives take no such prop. */
function Described({ text, visible, children }: { text: string; visible?: boolean; children: ReactNode }): ReactElement {
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.setAttribute('aria-describedby', id)
  })
  return (
    <span className="run-act" ref={ref}>
      {children}
      <span id={id} className={visible ? 'run-act-help' : 'sr-only'}>
        {text}
      </span>
    </span>
  )
}

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
  const mock = useAppStore((s) => !!s.appInfo?.mockAdapter)
  const startRetro = useAppStore((s) => s.startRetro)
  const setSideTab = useAppStore((s) => s.setSideTab)
  const openRun = useAppStore((s) => s.openRun)

  const { summary } = run
  const waiting = needsYou(run)
  const auto = autoContinueState({
    status: summary.status,
    plan: run.plan,
    autoContinue: project.autoContinue,
    maxAutoContinues: project.maxAutoContinues,
    kind: summary.kind
  })
  const status = runStatus(summary.status, {
    waiting,
    endedWithApp: !!summary.endedWithApp,
    stopped: isStoppedRun(run.agents),
    autoContinuing: auto.active
  })
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
          <span className="dot" aria-hidden="true" /> {statusText(status)}
        </span>
        {summary.resumedFrom && (
          <span className="run-header-chain">
            Continues{' '}
            {before ? (
              <button type="button" className="link-btn" onClick={() => void openRun(before.id)} title={promptLine(before.prompt)}>
                {runTag(indexes.get(before.id))}: {shortPrompt(before.prompt, 48)}
              </button>
            ) : (
              'an earlier run'
            )}
          </span>
        )}
        <span className="run-header-prompt" title={full}>
          {full}
        </span>
        {auto.active && auto.count > 0 && (
          <span className="run-header-auto">
            {auto.count} of {auto.max} auto-continues
          </span>
        )}
        <span className="run-header-meta">
          <span title={new Date(summary.startedAt).toLocaleString()}>Started {relativeTime(summary.startedAt)}</span>
          <span aria-hidden="true"> · </span>
          <span title={cost.title}>{cost.text}</span>
        </span>
      </div>
      <div className="run-header-actions">
        {summary.kind === 'setup' && (
          <span className="pill">
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
            {run.plan.status === 'done' && <Icon icon={Check} size="xs" label="Plan done" />}
            {run.plan.status === 'blocked' && <Icon icon={TriangleAlert} size="xs" label="Plan blocked" />}
          </button>
        )}
        {agentCount > 1 && (
          <span className="run-act run-fold" title="Folds finished reports into one node per parent on the chart. Turn off to show every agent.">
            <Switch checked={collapseFinished} onChange={onToggleCollapse} label="Hide finished agents" />
            <span className="fold-label" aria-hidden="true">
              Hide finished agents{collapseFinished && finishedCount ? ` (${finishedCount})` : ''}
            </span>
          </span>
        )}
        {sessionOpen && (
          <>
            <Described text="Stops the current turn. The session stays open.">
              <Button size="sm" icon={Pause} onClick={() => void interrupt()} disabled={summary.status !== 'running'} title="Stops the current turn. The session stays open.">
                Interrupt turn
              </Button>
            </Described>
            <Described text="Ends the session and stops all of its agents.">
              <Button size="sm" variant="danger" icon={Square} onClick={() => void stopRun()} title="Ends the session and stops all of its agents.">
                End session
              </Button>
            </Described>
            {summary.status === 'idle' && !waiting && <span className="run-header-note">Waiting for your next message</span>}
          </>
        )}
        {!sessionOpen && summary.error && (
          <span className="pill danger" title={summary.error}>
            {summary.error.slice(0, 60)}
          </span>
        )}
        {!sessionOpen && summary.kind === 'work' && (summary.status === 'finished' || summary.status === 'error') && (
          <Described visible text={mock ? 'Starts a session (mock, no tokens)' : 'Starts a session (spends tokens)'}>
            <Button
              size="sm"
              icon={RotateCcw}
              title="Have the Architect review this run and revise the org chart where roles struggled"
              onClick={() => void startRetro(summary.id)}
            >
              Org retrospective
            </Button>
          </Described>
        )}
      </div>
    </header>
  )
}
