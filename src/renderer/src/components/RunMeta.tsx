import type { ReactElement } from 'react'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Bot, CalendarClock, ClipboardList, Clock, Cpu, Database, Ellipsis, Files, Folder, Shield, ShieldAlert, ShieldOff } from 'lucide-react'
import { metaPermission, modeInForce, modeInForceLabel, permissionModeHelp, permissionModeName, permissionSessionEnded, permissionTone } from '../lib/runSettings'
import '../styles/run-settings.css'
import '../styles/run-header.css'
import { outputsCountLabel, outputsOfRuns } from '../lib/outputs'
import { useOutputAnnouncements } from './outputs/useOutputAnnouncements'
import { chipLabel } from '../lib/outputRevise'
import { showHidden } from '../lib/hiddenChars'
import { clampLabel } from '../lib/clampLabel'
import { revealOutputsTab } from './outputs/revealOutputsTab'
import '../styles/outputs.css'
import '../styles/outputs-revise.css'
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
import { staffingCounts } from '../lib/planGraph'
import { isWorkingAgent } from '../lib/agentActivity'
import { agentCostInput, formatDuration, runCostInput, sumCosts, costView } from '../lib/cost'
import { Cost } from './ui/Cost'
import { chainOf, needsYou, relativeTime } from '../lib/runChains'
import { shortPrompt } from '../lib/runLabels'
import { autoContinueState, statusOfRun, statusText, type RunTone } from '../lib/runStatus'
import { connectionLabel } from '../lib/connectionLabel'
import { Popover } from './ui/Popover'
import { Icon } from './ui/Icon'
import TeamFilesPointer from './team/TeamFilesPointer'
import { quickFolderLabel } from '../lib/assistants'
import { CHAT_ACCESS_ANNOUNCEMENT, CHAT_ACCESS_LABEL, CHAT_ACCESS_TITLE, chatAccessState } from '../lib/chatPermissions'
import { useFrameAnnounce } from './layout/CanvasFrame'
import { isOrgChangeRun, ORG_CHANGE_KIND_LABEL } from '../lib/orgChange'

/** Status chip colour by the shared tone (run-header.css reads data-tone). Words always come with the dot. */
const STATUS_TONE: Record<RunTone, 'working' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped'> = {
  'is-running': 'working',
  warn: 'waiting',
  paused: 'waiting',
  idle: 'idle',
  ok: 'done',
  danger: 'failed',
  stopped: 'stopped'
}

interface FoldedItem {
  /** Index among the line's children; the original element is re-found by it. */
  idx: number
  label: string
  interactive: boolean
}

/** Plain text of a chip without its screen reader additions. */
function chipText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove())
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Folds the chips that do not fit into one "more" menu instead of cutting them: the chip with the highest data-prio
 * number goes first (ties: the later one); data-prio 0 never folds. Runs after every render and when the line resizes.
 * A folded chip stays in the DOM (display none) so its button can still be activated from the menu.
 */
function useMetaFold(ref: RefObject<HTMLDivElement | null>): FoldedItem[] {
  const [folded, setFolded] = useState<FoldedItem[]>([])
  const measure = (): void => {
    const el = ref.current
    if (!el) return
    const kids = Array.from(el.children) as HTMLElement[]
    const chips = kids.filter((k) => k.hasAttribute('data-prio'))
    const more = kids.find((k) => k.hasAttribute('data-more'))
    chips.forEach((c) => c.removeAttribute('data-folded'))
    el.removeAttribute('data-squeeze')
    more?.setAttribute('hidden', '')
    const out: HTMLElement[] = []
    if (el.scrollWidth > el.clientWidth + 1) {
      more?.removeAttribute('hidden')
      const order = chips
        .map((c, i) => ({ c, i, p: Number(c.getAttribute('data-prio')) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p || b.i - a.i)
      let squeezed = false
      for (const x of order) {
        if (el.scrollWidth <= el.clientWidth + 1) break
        // Cost and status are the last two to go: before cost folds, a long status word shortens to an ellipsis.
        if (x.p <= 1 && !squeezed) {
          squeezed = true
          el.setAttribute('data-squeeze', '')
          if (el.scrollWidth <= el.clientWidth + 1) break
        }
        x.c.setAttribute('data-folded', 'true')
        out.push(x.c)
      }
      if (out.length === 0) more?.setAttribute('hidden', '')
    }
    const next = out
      .sort((a, b) => kids.indexOf(a) - kids.indexOf(b))
      .map((c) => ({ idx: kids.indexOf(c), label: chipText(c), interactive: c.tagName === 'BUTTON' || !!c.querySelector('button') }))
      .filter((f) => f.label)
    const sig = (l: FoldedItem[]): string => l.map((f) => `${f.idx}:${f.label}`).join('|')
    setFolded((prev) => (sig(prev) === sig(next) ? prev : next))
  }
  useLayoutEffect(measure)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return folded
}

/**
 * The run's metadata line in the canvas toolbar, drawn as chips (UI overhaul Run board): status (dot and word), model,
 * cost, wall time, files, then the permission mode, plan steps, agents and the rest. Chips that do not fit fold into a
 * "more" menu from the least useful end (data-prio, see useMetaFold); none is cut silently.
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
  // An org chart the run took live: said once when the note appears.
  const rosterNote = useAppStore((s) => {
    const n = s.proposalNextByRun[summary.id]
    return n?.kind === 'orgRoster' ? [proposalNextLead(n), ...(n.roster?.deferred ?? []).map((d) => `${clampLabel(showHidden(d.name), 40)}: ${clampLabel(showHidden(d.reason), 200)}`)].join(' ') : ''
  })
  // Keyed by run like the chip above: a note already spoken for a run stays quiet when its tab is shown again.
  const lastRoster = useRef({ runId: summary.id, note: rosterNote })
  useEffect(() => {
    const prev = lastRoster.current
    if (prev.runId === summary.id && rosterNote && prev.note !== rosterNote) announce?.(rosterNote)
    lastRoster.current = { runId: summary.id, note: rosterNote }
  }, [summary.id, rosterNote, announce])
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
  // What the conversation produced (docs/design/outputs.md section 6): every member run, every agent.
  const outputCount = useAppStore((s) => (run.summary.kind === 'work' && !summary.quick ? outputsOfRuns(s.outputsByProject[project.id], chain.map((m) => m.id)).length : 0))
  useOutputAnnouncements(summary.id)
  // A revise request this window sent to any run of the chain, still waiting for the team's version (outputs-2 7).
  const revising = useAppStore((s) => {
    for (const m of chain) {
      const p = s.pendingRevisionsByRun[m.id]
      if (p && p.length > 0) return p[p.length - 1]
    }
    return undefined
  })
  // Agents working now and steps ready to start; both 0 (nothing shown) for runs without staffing data or a plan graph.
  const counts = staffingCounts({ agents: Object.values(run.agents), isWorking: isWorkingAgent, plan: run.plan, hasAssignments: (run.staffing?.assignments.length ?? 0) > 0 })
  const progress = run.plan ? planProgress(run.plan) : undefined
  const auto = autoContinueState({
    status: summary.status,
    plan: run.plan,
    autoContinue: project.autoContinue,
    maxAutoContinues: project.maxAutoContinues,
    kind: summary.kind
  })
  // An ended run shows what its next message uses, as the composer's chip does ("Next message: Plan only").
  const metaPerm = metaPermission(summary, project)
  const metaMode = metaPerm?.mode ?? null
  const metaNext = metaPerm?.next ?? false
  const metaPrefix = metaNext ? 'Next message: ' : ''
  // A session grant only exists while the session is live; an ended run shows the chip's value as it is.
  const metaEnded = permissionSessionEnded(summary.status)
  const metaTone = metaMode ? permissionTone(metaEnded ? metaMode : modeInForce(summary, metaMode)) : null
  const metaLabel = metaMode ? (metaEnded ? permissionModeName(metaMode) : modeInForceLabel(summary, metaMode)) : ''
  const scheduleName = showHidden(summary.scheduleName ?? '').trim() || 'Scheduled run'
  const next = useAppStore((s) => s.proposalNextByRun[summary.id])
  const nextCopy = next ? PROPOSAL_NEXT_COPY[next.kind] : null
  // Status (dot and word, never colour alone) and the model with its exact id in the title.
  const status = statusOfRun(run, project, needsYou(run))
  const statusWord = statusText(status)
  const modelId = summary.modelSelection?.model ?? ''
  const modelCatalog = useAppStore((s) => (summary.modelSelection ? s.models[summary.modelSelection.connection] : undefined))
  const modelLabel = (modelId && modelCatalog?.find((m) => m.id === modelId)?.label) || modelId
  const lineRef = useRef<HTMLDivElement>(null)
  const folded = useMetaFold(lineRef)
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
    <div className="run-meta" data-testid="run-meta" ref={lineRef}>
      <span className="run-meta-item run-meta-status" data-prio="0" data-testid="run-meta-status" data-tone={STATUS_TONE[status.tone]} title={status.note && status.note !== statusWord ? `${statusWord}: ${status.note}` : statusWord}>
        <span className={`run-status-dot${status.tone === 'is-running' ? ' motion-pulse' : status.tone === 'warn' ? ' motion-breathe' : ''}`} aria-hidden="true" />
        <span className="run-meta-status-word">{statusWord}</span>
      </span>
      {modelId && (
        <span className="run-meta-item run-meta-model" data-prio="5" data-testid="run-meta-model" title={`Model ${modelId} via ${connectionLabel(summary.modelSelection?.connection)}${modelLabel !== modelId ? ` (${modelLabel})` : ''}`}>
          <Icon icon={Cpu} size="xs" />
          <span className="run-meta-model-name">{modelLabel}</span>
          {modelLabel !== modelId && <span className="sr-only"> ({modelId})</span>}
        </span>
      )}
      {wallMs >= 0 && (
        <span className="run-meta-item run-meta-wall" data-prio="3" title={live ? 'Wall time so far' : 'Wall time'}>
          <Icon icon={Clock} size="xs" />
          {formatDuration(wallMs)}
        </span>
      )}
      {showCost && (
        <span className="run-meta-item run-meta-cost" data-prio="1">
          <Cost value={cost} labelled />
        </span>
      )}
      {next && nextCopy && (
        <div className="run-meta-item run-meta-next" data-prio="9">
          <span data-testid="proposal-next-lead">{proposalNextLead(next)}</span>
          {next.roster && next.roster.deferred.length > 0 && (
            <ul className="run-meta-next-list" data-testid="proposal-next-deferred">
              {next.roster.deferred.map((d, i) => (
                <li key={i}>
                  {clampLabel(showHidden(d.name), 40)}: {clampLabel(showHidden(d.reason), 200)}
                </li>
              ))}
            </ul>
          )}{' '}
          <button type="button" className="link-btn" data-testid={nextCopy.testId} onClick={goNext}>
            {nextCopy.action}
          </button>
          <button type="button" className="link-btn" onClick={() => useAppStore.getState().noteProposalNext(summary.id, null)} aria-label="Dismiss this note">
            Dismiss
          </button>
        </div>
      )}
      {!isVirtualProjectId(project.id) && (
        <span className="run-meta-wrap" data-prio="9">
          <TeamFilesPointer projectId={project.id} />
        </span>
      )}
      {summary.kind === 'setup' && (
        <span className="run-meta-item" data-prio="5" data-testid="run-meta-kind">
          {isOrgChangeRun(summary) ? `${ORG_CHANGE_KIND_LABEL} session` : 'Setup session'}
        </span>
      )}
      {summary.scheduleId && (
        <button
          type="button"
          className="run-meta-item run-meta-scheduled"
          data-prio="6"
          data-testid="run-meta-scheduled"
          title={`Started by the schedule ${scheduleName}. Opens Schedules.`}
          onClick={() => useAppStore.getState().openSchedules({ scheduleId: summary.scheduleId })}
        >
          <Icon icon={CalendarClock} size="xs" />
          <span className="run-meta-scheduled-text">Scheduled: {clampLabel(scheduleName, 40)}</span>
          <span className="sr-only">; opens Schedules</span>
        </button>
      )}
      {summary.quick && (
        <>
          <span className="run-meta-item run-meta-folder" data-prio="6" title={summary.quick.scratch ? 'A private scratch folder' : summary.quick.folder}>
            <Icon icon={Folder} size="xs" />
            {quickFolderLabel(summary.quick)}
          </span>
          {accessState && (
            <span className="run-meta-item run-meta-access" data-prio="2" data-testid="run-meta-access" data-state={accessState} title={CHAT_ACCESS_TITLE[accessState]}>
              {CHAT_ACCESS_LABEL[accessState]}
              <span className="sr-only">. {CHAT_ACCESS_TITLE[accessState]}</span>
            </span>
          )}
        </>
      )}
      {summary.kind === 'mcp-assist' && summary.buildWorkspace && (
        <span className="run-meta-item run-meta-folder" data-prio="6" title={summary.buildWorkspace} data-testid="run-meta-workspace">
          <Icon icon={Folder} size="xs" />
          {folderName(summary.buildWorkspace)}
        </span>
      )}
      <span className="run-meta-item run-meta-agents" data-prio="2">
        <Icon icon={Bot} size="xs" />
        {agentCount} agent{agentCount === 1 ? '' : 's'}
      </span>
      {metaMode && (
        // Early in the line: the items at the end are the first to be cut in a narrow frame, and this one is a safety cue.
        <span
          className={`run-meta-item run-meta-permission${metaMode === 'auto' ? ' run-meta-unattended' : ''}`}
          data-prio="4"
          data-testid="run-meta-permission"
          data-mode={metaMode}
          data-next={metaNext ? 'true' : undefined}
          data-tone={metaTone ?? undefined}
          title={`${metaPrefix}${metaLabel}${summary.permissionModeChosen ? ' (this run)' : ''}: ${
            metaMode === 'auto'
              ? "the model's safety check approves or denies each call and asks only when unsure. Saved rules never ask."
              : permissionModeHelp(metaMode)
          }`}
        >
          <Icon icon={metaTone === 'danger' ? ShieldOff : metaTone ? ShieldAlert : Shield} size="xs" />
          {metaPrefix}
          {metaLabel}
          <span className="sr-only">
            {' '}
            (permission mode{summary.permissionModeChosen ? ', this run' : ''})
          </span>
        </span>
      )}
      {(counts.working > 0 || counts.ready > 0) && (
        <span className="run-meta-item run-meta-staffing" data-prio="7" data-testid="run-meta-staffing" title="Agents working now and plan steps ready to start">
          {counts.working > 0 && <span data-testid="run-meta-working">{counts.working} working</span>}
          {counts.ready > 0 && <span data-testid="run-meta-ready">{counts.ready} ready</span>}
        </span>
      )}
      {recorded > 0 && (
        <button type="button" className="run-meta-item run-meta-recorded" data-prio="8" data-testid="run-meta-recorded" title={recordedTitle(recordedText, sessions, recordedPartial)} onClick={() => openRecorded(summary.id)}>
          <Icon icon={Database} size="xs" />
          {recordedLabel(recorded, recordedPartial)}
          <span className="sr-only"> ({recordedText}{recordedPartial ? ', at least; some sessions are not loaded' : ''}; opens Knowledge)</span>
        </button>
      )}
      {outputCount > 0 && (
        <button
          type="button"
          className="run-meta-item run-meta-outputs"
          data-prio="4"
          data-testid="run-meta-outputs"
          title={outputsCountLabel(outputCount)}
          onClick={() => {
            useAppStore.getState().openRunOutput(summary.id, null)
            revealOutputsTab()
          }}
        >
          <Icon icon={Files} size="xs" />
          <span className="run-meta-outputs-count">{outputCount}</span>
          <span className="run-meta-outputs-label">{outputCount === 1 ? 'file' : 'files'}</span>
          <span className="sr-only">; opens the Outputs tab</span>
        </button>
      )}
      {revising && (
        <button
          type="button"
          className="run-meta-item run-meta-revision"
          data-prio="5"
          data-testid="run-meta-revision"
          title={chipLabel(showHidden(revising.title))}
          onClick={() => {
            useAppStore.getState().openRunOutput(summary.id, revising.outputId)
            revealOutputsTab()
          }}
        >
          <Icon icon={Files} size="xs" />
          <span className="run-meta-revision-text">{chipLabel(showHidden(revising.title))}</span>
          <span className="sr-only">; opens it in the Outputs tab</span>
        </button>
      )}
      {sessions > 1 && (
        <span className="run-meta-item run-meta-sessions" data-prio="8" data-testid="run-meta-sessions" title="This conversation has been continued; the figures cover every session.">
          {sessions} sessions
        </span>
      )}
      {run.plan && progress && (
        <button
          type="button"
          className={`run-meta-item run-meta-steps ${run.plan.status}`}
          data-prio="5"
          title={`Plan ${run.plan.status === 'active' ? 'in progress' : run.plan.status}: ${shortPrompt(run.plan.goal, 300)}. Click to open the plan.`}
          onClick={() => setSideTab('plan')}
        >
          <Icon icon={ClipboardList} size="xs" />
          {progress.done}/{progress.total} steps
          {run.plan.status === 'done' && <span className="sr-only"> (plan done)</span>}
          {run.plan.status === 'blocked' && <span className="sr-only"> (plan blocked)</span>}
        </button>
      )}
      <span className="run-meta-item run-meta-started" data-prio="10" title={new Date(summary.startedAt).toLocaleString()}>
        Started {relativeTime(summary.startedAt, now)}
      </span>
      {auto.active && auto.count > 0 && (
        <span className="run-meta-item run-meta-auto" data-prio="9">
          {auto.count} of {auto.max} auto-continues
        </span>
      )}
      {summary.team === 'single' && !summary.quick && !isVirtualProjectId(summary.projectId) && (
        <span className="run-meta-item" data-prio="6" data-testid="run-meta-ask">
          Ask · one assistant
        </span>
      )}
      <span className="run-meta-more" data-more="">
        <Popover
          trigger={
            <>
              <Icon icon={Ellipsis} size="xs" />
              <span className="run-meta-more-count">{folded.length}</span>
            </>
          }
          triggerLabel={`${folded.length} more detail${folded.length === 1 ? '' : 's'} about this run`}
          triggerTitle="More about this run"
          triggerClassName="run-meta-more-btn"
          label="More about this run"
          role="group"
          placement="bottom-start"
          testId="run-meta-more-panel"
          triggerTestId="run-meta-more"
        >
          {({ close }) => (
            <ul className="run-meta-more-list">
              {folded.map((f) => (
                <li key={f.idx}>
                  {f.interactive ? (
                    <button
                      type="button"
                      className="run-meta-more-item"
                      onClick={() => {
                        close()
                        const target = lineRef.current?.children[f.idx] as HTMLElement | undefined
                        const btn = target?.tagName === 'BUTTON' ? target : target?.querySelector('button')
                        btn?.click()
                      }}
                    >
                      {f.label}
                    </button>
                  ) : (
                    <span className="run-meta-more-text">{f.label}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Popover>
      </span>
    </div>
  )
}
