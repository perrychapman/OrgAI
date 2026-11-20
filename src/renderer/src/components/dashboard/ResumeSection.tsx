import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { isVirtualProjectId, type Project, type RunOutput, type RunSummary } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { pendingDecisionCount, useAppStore } from '../../store/useAppStore'
import { Cost } from '../ui/Cost'
import { revealOutputsTab } from '../outputs/revealOutputsTab'
import { AttentionRows, useArrivalSettle, useAttentionList, useRowExits, rowMotionProps, type RowMotion } from './AttentionSection'
import { DashSection, useDashboard } from './DashboardContext'
import { ProjectBadge } from './ProjectBadge'
import { RESUME_MAX } from './dashCaps'
import { afterFirstPaint, projectQueue } from './projectQueue'
import { useAllSummaries, useNow } from './useDashboardData'
import { runCostInput } from '../../lib/cost'
import { readLastSeen } from '../../lib/dashboard'
import { locationLabel } from '../../lib/assistants'
import { clientOf } from '../../lib/clientGroups'
import { displayRunName } from '../../lib/orgChange'
import { projectHue } from '../../lib/projectIdentity'
import { relativeTime } from '../../lib/runChains'
import { statusOfRun, statusText } from '../../lib/runStatus'
import {
  NO_RUNS_DETAIL,
  chainOutputs,
  outputProjects,
  resumeAction,
  resumeActionLabel,
  resumeActionName,
  resumeCaption,
  resumeRows,
  showsRunCost,
  wantsOutputs,
  type ResumeAction,
  type ResumeRow
} from '../../lib/resumeRows'

type Row = ResumeRow<RunSummary>

/** The status dot: colour always sits beside the status word. */
function Dot({ tone }: { tone: string }): ReactElement {
  return <span className="dash-dot" data-tone={tone} aria-hidden="true" />
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

/** The empty-row's run-less opening: select the project and show its run view, as the tile does. */
function settleFocusIfIdle(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !active.closest('[data-testid=dashboard]')) return
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

/**
 * Pick up where you left off (docs/design/dashboard-overhaul.md 7.4): one row per conversation, one action each.
 * `lastSeen` is the time the person last left the Dashboard (DashboardView passes `useLastSeen().lastSeen`); without it
 * the stored value is read once at mount.
 */
export function ResumeSection({ lastSeen }: { lastSeen?: number }): ReactElement | null {
  const { layout, caps, announce } = useDashboard()
  const summaries = useAllSummaries()
  const now = useNow()
  const projects = useAppStore((s) => s.projects)
  const virtual = useAppStore((s) => s.virtualProjects)
  const runs = useAppStore((s) => s.runs)
  const outputsByProject = useAppStore((s) => s.outputsByProject)
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const focusRun = useAppStore((s) => s.focusRun)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const selectProject = useAppStore((s) => s.selectProject)
  const openDraft = useAppStore((s) => s.openDraft)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const ready = useAppStore((s) => s.projects.length > 0 && s.projects.every((p) => p.id in s.historyByProject))
  const [mountSeen] = useState(() => readLastSeen(window.localStorage) ?? Date.now())
  const since = lastSeen ?? mountSeen
  const settled = useArrivalSettle(ready)
  const exits = useRowExits()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLElement>(null)

  const projectOf = useMemo(() => {
    const byId = new Map<string, Project>(projects.map((p) => [p.id, p]))
    return (id: string): Project | undefined => byId.get(id) ?? (isVirtualProjectId(id) ? virtual[id] : undefined)
  }, [projects, virtual])

  const rows = useMemo(
    () =>
      resumeRows({
        summaries,
        lastSeen: since,
        now,
        workingHidden: layout.hidden.includes('working'),
        pinned: layout.pinned,
        projectIds: projects.map((p) => p.id),
        max: RESUME_MAX
      }),
    [summaries, since, now, layout.hidden, layout.pinned, projects]
  )

  const model = useAttentionList<Row>({ items: rows, cap: caps.resume, itemKey: (r) => r.key, arrive: settled, exits, headingRef, sectionRef })

  // Outputs for the projects of the rows shown, at most 6, after first paint and three calls at a time (the shared queue).
  const shown = model.rows.filter((r) => !r.leaving).map((r) => r.item)
  const wanted = outputProjects(shown, (id) => !isVirtualProjectId(id) && projects.some((p) => p.id === id)).filter((id) => outputsByProject[id] === undefined)
  const wantedKey = wanted.join('\u0000')
  useEffect(() => {
    if (wanted.length === 0) return undefined
    return afterFirstPaint(() => {
      for (const id of wanted) {
        if (useAppStore.getState().outputsByProject[id] !== undefined) continue
        void projectQueue.enqueue('outputs', id, () => loadOutputs(id))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, loadOutputs])

  const open = (projectId: string, runId: string): void => {
    void focusRun(projectId, runId).then(settleFocus)
  }

  const act = (row: Row, action: ResumeAction, outs: readonly RunOutput[]): void => {
    const run = row.run
    switch (action) {
      case 'resume':
        if (!run) return
        exits.mark([row.key])
        resumeNow(run.id).catch((e: unknown) => {
          exits.unmark(row.key)
          console.debug('resume now', e)
          announce(`Could not resume ${displayRunName(run)}. Try again.`)
        })
        return
      case 'continue':
        if (run) void continueFromHistory(run.id, run.projectId).then(settleFocus)
        return
      case 'output':
        if (!run) return
        void focusRun(run.projectId, run.id)
          .then(() => {
            useAppStore.getState().openRunOutput(run.id, outs.length === 1 ? outs[0].id : null)
            revealOutputsTab()
          })
          .catch(() => undefined)
        return
      case 'open':
        if (run) open(run.projectId, run.id)
        return
      case 'new-run':
        selectProject(row.projectId)
        openDraft()
        focusComposer()
        settleFocusIfIdle()
        return
    }
  }

  const renderRow = (row: Row, motion: RowMotion): ReactElement => {
    const run = row.run
    const project = projectOf(row.projectId)
    const projectName = locationLabel(row.projectId, projects)
    const client = project && projectKindOf(project) === 'engagement' ? clientOf(project) : ''
    const liveState = run ? runs[run.id] : undefined
    const view = run ? statusOfRun(liveState ? { ...liveState } : { summary: run }, project, liveState ? pendingDecisionCount(liveState) > 0 : false) : undefined
    const word = view ? statusText(view) : ''
    const name = run ? displayRunName(run) : projectName
    const outs = chainOutputs(outputsByProject[row.projectId], row.chainIds)
    const action = resumeAction(row, outs.length)
    // The action slot keeps its width while the project's outputs are still on the way, so a late "Open output" shifts nothing.
    const reserve = action !== null || (wantsOutputs(row) && outputsByProject[row.projectId] === undefined && !isVirtualProjectId(row.projectId))
    const line2 = run ? resumeCaption(row, { project: projectName, client, age: relativeTime(run.endedAt ?? run.startedAt, now), now }) : NO_RUNS_DETAIL
    const motionProps = rowMotionProps(motion, 'dash-tile dash-resume-tile')
    // The detail (why it stopped, the pause reason, the closed note) is not drawn: it is the button's tooltip and description.
    // A pinned project with no runs says "No runs yet." as its one meta line instead.
    const detail = run ? row.detail : ''
    const detailId = `dash-resume-detail-${row.key}`
    const badgeProject = isVirtualProjectId(row.projectId) ? '' : row.projectId
    return (
      <li
        key={row.key}
        {...motionProps}
        data-testid="dash-resume-row"
        data-kind={row.kind}
        data-run={run?.id}
        data-project={row.projectId}
        data-hue={projectHue(badgeProject)}
        data-status={view?.word}
        data-row-key={row.key}
        data-has-action={reserve ? 'true' : undefined}
      >
        <button
          type="button"
          className="dash-tile-main"
          data-row-main=""
          data-testid="dash-resume-main"
          title={detail ? `${name}. ${detail}` : name}
          aria-label={run ? undefined : `${projectName}, no runs yet`}
          aria-describedby={detail ? detailId : undefined}
          onClick={() => (run ? open(run.projectId, run.id) : (void openProject(row.projectId), setView('run'), settleFocusIfIdle()))}
        >
          <span className="dash-tile-head">
            <ProjectBadge projectId={badgeProject} name={projectName} size="md" />
            {word && (
              <span className="dash-tile-status" data-tone={view?.tone ?? 'idle'}>
                <Dot tone={view?.tone ?? 'idle'} />
                {word}
              </span>
            )}
          </span>
          <span className="dash-tile-title" title={name}>
            {name}
          </span>
          <span className="dash-tile-meta">
            <span className="dash-clip" title={line2}>
              {line2}
            </span>
            {run && showsRunCost(runCostInput(run)) && <Cost value={runCostInput(run)} compact className="dash-num" />}
          </span>
        </button>
        {detail && (
          <span id={detailId} className="sr-only">
            {detail}
          </span>
        )}
        {reserve && (
          <span className="dash-tile-foot">
            {action && (
              // The shared Button carries no data-* hook; the spec's test id needs data-action, so this is the Button's markup.
              <button
                type="button"
                className="btn sm"
                data-testid="dash-resume-action"
                data-action={action}
                aria-label={resumeActionName(action, { runName: name, project: projectName, outputs: outs.length })}
                onClick={() => act(row, action, outs)}
              >
                {resumeActionLabel(action, outs.length)}
              </button>
            )}
          </span>
        )}
      </li>
    )
  }

  return (
    <DashSection id="resume" testId="dash-resume" icon={History} empty={rows.length === 0} count={rows.length} sectionRef={sectionRef} headingRef={headingRef}>
      <AttentionRows model={model} renderItem={(row, motion) => renderRow(row, motion)} moreTestId="dash-resume-more" className="dash-resume-grid" />
    </DashSection>
  )
}
