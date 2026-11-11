/**
 * The run detail tabs, one implementation for both places they appear: the run side panel (TranscriptPanel, first tab
 * "Transcript") and the strip above an assistant session's conversation (RunStageTabs, first tab "Conversation"; that
 * session has no side panel, see hasRunSidePanel). The tab list and fallback rule are lib/runTabs.ts; the selection is
 * `sideTabByRun` in the store either way, so Plan buttons, navigation targets and the Usage return land in both.
 */
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, CircleDot, MinusCircle, type LucideIcon } from 'lucide-react'
import type { AgentInstance, PlanStep, RunPlan, RunStaffing } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { selectedProject, useAppStore, useProjectSummaries, type LogLine, type SideTab } from '../store/useAppStore'
import { chainOf } from '../lib/runChains'
import { outputsCountLabel, outputsOfRuns } from '../lib/outputs'
import { planProgress } from '../lib/layout'
import { planHasGraph, stepViews, waitingOnText } from '../lib/planGraph'
import { stepRanLabel } from '../lib/runStaffing'
import { autoContinueLine } from '../lib/transcriptRows'
import { countReplies, replyArrived, resolveRunTab, runTabIds, showsKnowledgeTab, showsOutputsTab, showsPlanTab, type ReplyMark } from '../lib/runTabs'
import RunKnowledge from './knowledge/RunKnowledge'
import RunOutputs from './outputs/RunOutputs'
import UsagePanel from './UsagePanel'
import { Markdown } from './Markdown'
import { Badge } from './ui/Badge'
import { Checkbox } from './ui/Checkbox'
import { Icon } from './ui/Icon'
import { TabPanel, Tabs, panelDomId, tabDomId, type TabItem } from './ui/Tabs'

const STEP_ICONS: Record<PlanStep['status'], LucideIcon> = {
  pending: Circle,
  in_progress: CircleDot,
  done: CheckCircle2,
  blocked: AlertTriangle,
  skipped: MinusCircle
}

const STEP_LABELS: Record<PlanStep['status'], string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
  skipped: 'Skipped'
}

/** The orchestrator's plan: goal, steps with status, and how the automatic continuation stands. */
function PlanView({ plan, staffing }: { plan: RunPlan | undefined; staffing?: RunStaffing }): ReactElement {
  const project = useAppStore(selectedProject)
  if (!plan) {
    return (
      <div className="plan-view">
        <p className="panel-note">No plan yet. On work runs the orchestrator writes a plan first; it appears here, and OrgAI keeps the run going until every step is done.</p>
      </div>
    )
  }
  const { done, total } = planProgress(plan)
  const max = project?.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES
  const auto = project?.autoContinue !== false
  const cont = autoContinueLine(auto, plan.autoContinues, max)
  const status = plan.status === 'active' ? 'In progress' : plan.status === 'done' ? 'Done' : 'Blocked'
  // Ready / waiting lines only for a plan that uses the graph (after, paths or staff); older plans look as they always did.
  const views = planHasGraph(plan) ? stepViews(plan) : null
  return (
    <div className="plan-view">
      <div className="plan-head">
        <div className="plan-goal">{plan.goal}</div>
        <div className="row plan-pills">
          <Badge tone={plan.status === 'done' ? 'success' : plan.status === 'blocked' ? 'attention' : 'info'}>{status}</Badge>
          <Badge>
            {done} of {total} steps done
          </Badge>
          <Badge title={cont.explain}>{cont.pill}</Badge>
        </div>
        <p className="panel-note">{cont.explain}</p>
      </div>
      {plan.status === 'blocked' && plan.blockedReason && <div className="plan-blocked">Blocked: {plan.blockedReason}</div>}
      <ol className="plan-steps">
        {plan.steps.map((s, i) => {
          const view = views?.[i]
          const stateText =
            view?.state === 'running' ? 'Running now' : view?.state === 'ready' ? 'Ready to start' : view?.state === 'waiting' ? waitingOnText(plan, view.waitingOn) : ''
          return (
          <li key={s.id} className={`plan-step ${s.status}`}>
            <span className="plan-icon" title={STEP_LABELS[s.status]} role="img" aria-label={STEP_LABELS[s.status]}>
              <Icon icon={STEP_ICONS[s.status]} size="sm" />
            </span>
            <div className="plan-body">
              <div className="plan-title">
                {s.title}
                {s.owner && <span className="plan-owner">{s.owner}</span>}
              </div>
              {s.note && <div className="plan-note">{s.note}</div>}
              {stateText && (
                <div className="plan-state" data-testid="plan-step-state" data-state={view?.state} title={view?.state === 'waiting' ? stateText : undefined}>
                  {stateText}
                </div>
              )}
              {s.staff && (
                <div className="plan-staff" data-testid="plan-step-staff">
                  {stepRanLabel(s.staff, staffing, s.id)}
                </div>
              )}
            </div>
          </li>
          )
        })}
      </ol>
      {plan.summary && (
        <div className="plan-summary">
          <Markdown text={plan.summary} />
        </div>
      )}
    </div>
  )
}

/**
 * The run's tabs and the one shown. `first` names the first tab: the side panel's "Transcript" or the stage's
 * "Conversation". A stored tab the run no longer has shows as the first tab (resolveRunTab).
 */
export function useRunTabs(
  runId: string,
  logs: readonly LogLine[],
  first: { label: string; testId: string },
  opts: { stage?: boolean; newReply?: boolean } = {}
): { tabs: TabItem[]; tab: SideTab; setTab: (tab: SideTab) => void } {
  const { stage, newReply } = opts
  const selected = useAppStore((s) => s.sideTabByRun[runId])
  const setTab = useAppStore((s) => s.setSideTab)
  const projectId = useAppStore((s) => s.runs[runId]?.summary.projectId)
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const showPlan = useAppStore((s) => {
    const run = s.runs[runId]
    return !!run && showsPlanTab({ kind: run.summary.kind, hasPlan: !!run.plan, stage })
  })
  const showOutputs = useAppStore((s) => showsOutputsTab(s.runs[runId]?.summary))
  const showKnowledge = useAppStore((s) => {
    const run = s.runs[runId]?.summary
    const project = run ? s.projects.find((p) => p.id === run.projectId) : undefined
    return showsKnowledgeTab(run, project ? projectKindOf(project) : undefined)
  })
  // The Outputs tab's count: the same list RunOutputs shows (every member run of the chain).
  const outputsAll = useAppStore((s) => (projectId && showOutputs ? s.outputsByProject[projectId] : undefined))
  const chainSummaries = useProjectSummaries()
  const outputsCount = useMemo(() => outputsOfRuns(outputsAll, chainOf(chainSummaries, runId).map((m) => m.id)).length, [outputsAll, chainSummaries, runId])
  const errorCount = logs.filter((l) => l.level === 'error').length
  const ids = runTabIds({ plan: showPlan, outputs: showOutputs, knowledge: showKnowledge })
  const item: Record<SideTab, TabItem> = {
    transcript: { id: 'transcript', label: first.label, testId: first.testId, dot: newReply, dotLabel: newReply ? 'new reply' : undefined },
    plan: { id: 'plan', label: 'Plan', icon: plan?.status === 'blocked' ? AlertTriangle : undefined, testId: 'side-tab-plan' },
    usage: { id: 'usage', label: 'Usage', testId: 'side-tab-usage' },
    outputs: { id: 'outputs', label: 'Outputs', count: outputsCount, countLabel: outputsCountLabel(outputsCount), countTestId: 'side-tab-outputs-count', testId: 'side-tab-outputs' },
    knowledge: { id: 'knowledge', label: 'Knowledge', testId: 'side-tab-knowledge' },
    logs: { id: 'logs', label: 'Logs', count: errorCount, testId: 'side-tab-logs' }
  }
  return { tabs: ids.map((id) => item[id]), tab: resolveRunTab(selected, ids), setTab }
}

/** The body of every tab but the first: Plan, Usage, Outputs, Knowledge and Logs. Renders nothing for 'transcript'. */
export function RunTabBody({ runId, tab, idPrefix, agent, logs, className }: { runId: string; tab: SideTab; idPrefix: string; agent: AgentInstance | undefined; logs: readonly LogLine[]; className?: string }): ReactElement | null {
  const projectId = useAppStore((s) => s.runs[runId]?.summary.projectId)
  const plan = useAppStore((s) => s.runs[runId]?.plan)
  const staffing = useAppStore((s) => s.runs[runId]?.staffing)
  const bottom = useRef<HTMLDivElement>(null)
  // The log list follows its end; only the tab panel scrolls (scrollIntoView would also scroll every ancestor).
  useEffect(() => {
    const body = bottom.current?.parentElement
    if (body) body.scrollTop = body.scrollHeight
  }, [logs.length, tab])
  const cls = (own?: string): string | undefined => [own, className].filter(Boolean).join(' ') || undefined
  switch (tab) {
    case 'plan':
      return (
        <TabPanel idPrefix={idPrefix} id="plan" value={tab} className={cls()}>
          <PlanView plan={plan} staffing={staffing} />
        </TabPanel>
      )
    case 'usage':
      return (
        <TabPanel idPrefix={idPrefix} id="usage" value={tab} className={cls()}>
          <UsagePanel runId={runId} agent={agent} />
        </TabPanel>
      )
    case 'outputs':
      return projectId ? (
        <TabPanel idPrefix={idPrefix} id="outputs" value={tab} className={cls('run-outputs-panel')}>
          <RunOutputs runId={runId} projectId={projectId} />
        </TabPanel>
      ) : null
    case 'knowledge':
      return projectId ? (
        <TabPanel idPrefix={idPrefix} id="knowledge" value={tab} className={cls('run-knowledge-panel')}>
          <RunKnowledge runId={runId} projectId={projectId} />
        </TabPanel>
      ) : null
    case 'logs':
      return (
        <TabPanel idPrefix={idPrefix} id="logs" value={tab} className={cls('logs')}>
          {logs.length === 0 && <span>No log lines yet.</span>}
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              <span className="log-time">{new Date(l.at).toLocaleTimeString()} </span>
              {l.message}
            </div>
          ))}
          <div ref={bottom} />
        </TabPanel>
      )
    default:
      return null
  }
}

/**
 * An assistant session's stage without a side panel (hasRunSidePanel): one tab strip above the conversation.
 * "Conversation" shows `conversation` (the stage's own transcript, which has its own focusable scroll area, so its tab
 * panel is not a tab stop); every other tab replaces it with the same body the side panel shows.
 */
export function RunStageTabs({
  runId,
  agent,
  logs,
  conversation,
  thinking,
  onReply
}: {
  runId: string
  agent: AgentInstance | undefined
  logs: readonly LogLine[]
  conversation: ReactNode
  /** The root agent's "Show thinking" control, shown at the right end of the strip while Conversation is selected. */
  thinking?: { checked: boolean; onChange: (next: boolean) => void }
  /** Called once per new-reply cue, for the view's polite announcement. */
  onReply?: () => void
}): ReactElement {
  const [cue, setCue] = useState(false)
  const selected = useAppStore((s) => s.sideTabByRun[runId])
  const replies = useAppStore((s) => countReplies(s.runs[runId]?.transcript ?? []))
  const idle = useAppStore((s) => s.runs[runId]?.summary.status === 'idle')
  const { tabs, tab, setTab } = useRunTabs(runId, logs, { label: 'Conversation', testId: 'run-tab-conversation' }, { stage: true, newReply: cue })
  // A reply that lands (or "your turn") while another tab is open marks Conversation; selecting it clears the mark.
  const prev = useRef<{ runId: string } & ReplyMark>({ runId, replies, idle })
  const tabNow = useRef(tab)
  tabNow.current = tab
  const onReplyRef = useRef(onReply)
  onReplyRef.current = onReply
  useEffect(() => {
    const before = prev.current
    prev.current = { runId, replies, idle }
    if (before.runId !== runId) {
      setCue(false)
      return
    }
    if (replyArrived(before, { replies, idle }) && tabNow.current !== 'transcript') {
      setCue(true)
      onReplyRef.current?.()
    }
  }, [runId, replies, idle])
  useEffect(() => {
    if (tab === 'transcript') setCue(false)
  }, [tab, selected])
  const idPrefix = `stage-${runId}`
  return (
    <div className="run-stage-tabs" data-testid="run-stage-tabs">
      <div className="run-stage-tabs-bar">
        <div className="run-stage-tabs-row">
          <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as SideTab)} label="Session details" idPrefix={idPrefix} compact />
          {thinking && tab === 'transcript' && (
            <div className="run-stage-thinking">
              <Checkbox checked={thinking.checked} onChange={thinking.onChange} label="Show thinking" testId="run-stage-show-thinking" />
            </div>
          )}
        </div>
      </div>
      {/* The conversation stays mounted (hidden) under the other tabs: its scroll position and follow state survive. */}
      <div role="tabpanel" id={panelDomId(idPrefix, 'transcript')} aria-labelledby={tabDomId(idPrefix, 'transcript')} className="run-stage-conversation" hidden={tab !== 'transcript'}>
        {conversation}
      </div>
      {tab !== 'transcript' && <RunTabBody runId={runId} tab={tab} idPrefix={idPrefix} agent={agent} logs={logs} className="run-stage-panel" />}
    </div>
  )
}
