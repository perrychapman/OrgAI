import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { isVirtualProjectId, type Project, type RunSummary } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { useShallow } from 'zustand/react/shallow'
import { pendingDecisionCount, useAppStore, type RunState } from '../../store/useAppStore'
import { Cost } from '../ui/Cost'
import { AttentionRows, useArrivalSettle, useAttentionList, useRowExits, rowMotionProps, type RowMotion } from './AttentionSection'
import { DashSection, useDashboard } from './DashboardContext'
import { RunMark, markOfTone } from './RunMark'
import { useAllSummaries, useNow } from './useDashboardData'
import { RESUME_MAX } from './dashCaps'
import { costView, runCostInput } from '../../lib/cost'
import { readLastSeen } from '../../lib/dashboard'
import { locationLabel } from '../../lib/assistants'
import { clientOf } from '../../lib/clientGroups'
import { displayRunName } from '../../lib/orgChange'
import { relativeTime } from '../../lib/runChains'
import { isStoppedRun, statusOfRun } from '../../lib/runStatus'
import { NOT_PRICED, endedSinceLastVisit, isUnpricedRun, pickUpAction, pickUpRows, resumeActionLabel, resumeActionName, resumeCaption, resumeRows, showsRunCost, type ResumeAction, type ResumeRow } from '../../lib/resumeRows'

type Row = ResumeRow<RunSummary>

/** From this page width Pick up lists six rows before "Show more"; under it four. */
export const PICKUP_WIDE_PX = 1280
const CAP_NARROW = 4
const CAP_WIDE = 6

/**
 * What a row reads of the live run behind it, as one string so the store selector can be shallow-compared: open decisions,
 * the plan's status and auto-continue count, and whether the root agent says Stopped (old records). Empty for a run that is
 * not in the store (it is read from its summary alone).
 */
function liveFactsOf(state: RunState | undefined): string {
  if (!state) return ''
  return [pendingDecisionCount(state), state.plan?.status ?? '', state.plan?.autoContinues ?? 0, isStoppedRun(state.agents) ? 1 : 0].join('|')
}

/** The run's status view from its summary and `liveFactsOf`: the same result `statusOfRun` gives for the whole store entry. */
function viewOfRun(summary: RunSummary, facts: string, project: Project | undefined): ReturnType<typeof statusOfRun> {
  if (!facts) return statusOfRun({ summary }, project, false)
  const [pending, planStatus, autoContinues, stopped] = facts.split('|')
  return statusOfRun(
    {
      summary,
      ...(planStatus ? { plan: { status: planStatus, autoContinues: Number(autoContinues) } } : {}),
      ...(stopped === '1' ? { agents: { root: { parentId: null, activity: 'Stopped' } } } : {})
    },
    project,
    Number(pending) > 0
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

/** The width of the Dashboard page the section sits in, kept current by a ResizeObserver (0 until measured). */
function usePageWidth(sectionRef: { current: HTMLElement | null }, ready: boolean): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const page = sectionRef.current?.closest<HTMLElement>('.dash-page')
    if (!page) return undefined
    const measure = (): void => setWidth(page.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(page)
    return () => ro.disconnect()
    // The section mounts once it has rows; `ready` re-runs the lookup when it first can.
  }, [sectionRef, ready])
  return width
}

/**
 * Pick up (section id `pickup`, docs/design/dashboard-usage-redesign dashboard.md): the paused and recently ended runs
 * that can be continued, newest first, as one unboxed list (it replaces the separate Paused and Recently ended lists and
 * the tile grid of Pick up where you left off). Each row leads with a state mark and its fixed status word, then the
 * title, when it ended or when it resumes, the project, the cost only when something was spent and the stop reason when
 * one is known; it ends with one small button, Continue or Open, named with the run's title. A run that ended after the
 * last visit carries a marker. Four rows (six from a 1280 px page), then "Show N more". `lastSeen` is the time the person
 * last left the Dashboard (DashboardView passes `useLastSeen().lastSeen`); without it the stored value is read once.
 */
export function PickUpSection({ lastSeen }: { lastSeen?: number }): ReactElement | null {
  const { layout, announce, arriving, still } = useDashboard()
  const summaries = useAllSummaries()
  const now = useNow()
  const projects = useAppStore((s) => s.projects)
  const virtual = useAppStore((s) => s.virtualProjects)
  const focusRun = useAppStore((s) => s.focusRun)
  const resumeNow = useAppStore((s) => s.resumeNow)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
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
      pickUpRows(
        resumeRows({
          summaries,
          lastSeen: since,
          now,
          workingHidden: false,
          pinned: layout.pinned,
          projectIds: projects.map((p) => p.id),
          max: RESUME_MAX
        }),
        now
      ),
    [summaries, since, now, layout.pinned, projects]
  )

  // Only the listed runs' status facts (shallow-compared strings), not the run map: an agent or transcript event renders nothing here.
  const liveFacts = useAppStore(useShallow((s) => rows.map((r) => liveFactsOf(r.run ? s.runs[r.run.id] : undefined))))
  const factsOf = useMemo(() => new Map(rows.map((r, i) => [r.key, liveFacts[i] ?? ''])), [rows, liveFacts])

  const pageWidth = usePageWidth(sectionRef, rows.length > 0)
  const cap = pageWidth >= PICKUP_WIDE_PX ? CAP_WIDE : CAP_NARROW
  const model = useAttentionList<Row>({ items: rows, cap, itemKey: (r) => r.key, arrive: settled, exits, headingRef, sectionRef })

  const open = (projectId: string, runId: string): void => {
    void focusRun(projectId, runId).then(settleFocus)
  }

  const act = (row: Row, action: ResumeAction): void => {
    const run = row.run
    if (!run) return
    switch (action) {
      case 'resume':
        exits.mark([row.key])
        resumeNow(run.id).catch((e: unknown) => {
          exits.unmark(row.key)
          console.debug('resume now', e)
          announce(`Could not continue ${displayRunName(run)}. Try again.`)
        })
        return
      case 'continue':
        void continueFromHistory(run.id, run.projectId).then(settleFocus)
        return
      case 'open':
        open(run.projectId, run.id)
        return
    }
  }

  const renderRow = (row: Row, motion: RowMotion, index: number): ReactElement | null => {
    const run = row.run
    if (!run) return null
    const project = projectOf(row.projectId)
    const projectName = locationLabel(row.projectId, projects)
    const client = project && projectKindOf(project) === 'engagement' ? clientOf(project) : ''
    const view = viewOfRun(run, factsOf.get(row.key) ?? '', project)
    const name = displayRunName(run)
    const action = pickUpAction(row)
    const caption = resumeCaption(row, { project: projectName, client, age: relativeTime(run.endedAt ?? run.startedAt, now), now })
    const cost = runCostInput(run)
    // The stop reason when known: why it failed or closed, the pause reason; else a status note ("Ended when OrgAI closed").
    const reason = row.detail || (view.note && view.note !== view.word ? view.note : '')
    const motionProps = rowMotionProps(motion, 'dash-pick-row')
    const arrivingClass = arriving && !still && !motion.arrived && !motion.leaving ? ' motion-enter' : ''
    const style = motionProps.style ?? (arrivingClass ? ({ '--i': index } as CSSProperties) : undefined)
    const sinceVisit = endedSinceLastVisit(row)
    return (
      <li
        key={row.key}
        {...motionProps}
        className={`${motionProps.className}${arrivingClass}`}
        {...(style ? { style } : {})}
        data-testid="dash-resume-row"
        data-kind={row.kind}
        data-run={run.id}
        data-project={row.projectId}
        data-status={view.word}
        data-since={sinceVisit ? '' : undefined}
        data-row-key={row.key}
        data-has-action="true"
      >
        <button
          type="button"
          className="dash-pick-main"
          data-row-main=""
          data-testid="dash-resume-main"
          title={reason ? `${name}. ${reason}` : name}
          onClick={() => open(run.projectId, run.id)}
        >
          <span className="dash-pick-state" data-tone={view.tone}>
            <RunMark state={markOfTone(view.tone)} />
            <span className="dash-pick-word">{view.word}</span>
          </span>
          <span className="dash-pick-text">
            <span className="dash-pick-title" title={name}>
              {sinceVisit && (
                <span className="dash-pick-new" data-testid="dash-resume-new" title="Ended since you were last here">
                  <span className="sr-only">Since your last visit: </span>
                </span>
              )}
              {name}
            </span>
            <span className="dash-pick-sub">
              <span className="dash-clip" title={caption}>
                {caption}
              </span>
              {showsRunCost(cost) && <Cost value={cost} compact className="dash-num dash-pick-cost" />}
              {isUnpricedRun(cost) && (
                <span className="cost cost-unknown dash-pick-cost" data-testid="dash-resume-unpriced" title={costView(cost).title}>
                  {NOT_PRICED}
                </span>
              )}
              {reason && (
                <span className="dash-clip dash-pick-reason" title={reason}>
                  {reason}
                </span>
              )}
            </span>
          </span>
        </button>
        <span className="dash-pick-foot">
          <button
            type="button"
            className="btn sm"
            data-testid="dash-resume-action"
            data-action={action}
            aria-label={resumeActionName(action, { runName: name })}
            onClick={() => act(row, action)}
          >
            {resumeActionLabel(action)}
          </button>
        </span>
      </li>
    )
  }

  let order = 0
  return (
    <DashSection id="pickup" testId="dash-resume" icon={History} empty={rows.length === 0} count={rows.length} sectionRef={sectionRef} headingRef={headingRef}>
      <AttentionRows model={model} renderItem={(row, motion) => renderRow(row, motion, order++)} moreTestId="dash-resume-more" className="dash-pick-list" />
    </DashSection>
  )
}
