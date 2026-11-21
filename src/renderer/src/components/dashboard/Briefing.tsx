import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, Play, Plus } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { DashboardLive } from './DashboardLive'
import { useDashboard, type DashboardAnnouncement } from './DashboardContext'
import { NameControl, useDisplayName } from './NameControl'
import { SetupGaps } from './SetupGaps'
import { TeamPulse } from './TeamPulse'
import { PlanGauges } from '../limits/PlanGauge'
import { useLimitEntries } from '../limits/useLimitEntries'
import { useAllSummaries, useBandSnapshot, useDecisionTotal, useNow } from './useDashboardData'
import { useAppStore, openNewChat } from '../../store/useAppStore'
import { clockLabel, pausedRuns } from '../../lib/dashboard'
import { bandWorkFacts } from '../../lib/dashboardBand'
import { continueProjectId, salutation, statusParts } from '../../lib/dashboardBrief'
import { sinceSentence, sinceSummary, outcomeText, type SincePart } from '../../lib/sinceSummary'
import { useCountUp } from '../../lib/useCountUp'

/**
 * The Briefing (docs/design/dashboard-usage-redesign/project/components/Briefing, dashboard.md): the page's hero card.
 * The greeting is the page's one large line; under it the status sentence (drawn as text, the one place a count of
 * decisions is written outside Needs you itself), what changed since the last visit, the quick actions (Continue the
 * pinned or most recent project, New chat, New project, Customise last and quiet) and the one "things to set up" line. On
 * the right Team pulse, the Pause motion toggle and the plan gauges. Props are the contract with DashboardView:
 * - `firstLaunch`: no projects ("Welcome to OrgAI" and its line; "Welcome to OrgAI, Sam" once a name is saved).
 * - `announce` / `onAnnounce`: the page's one live region `dashboard-live` is rendered here.
 * - `customise`: the Customise button, owned by DashboardView, last in the quick actions (absent on first launch).
 * - `onNewProject`: open the New project dialog.
 * - `motionPaused` / `onMotionPaused`: Pause motion (saved in the layout).
 * - `lastSeen` / `firstVisit`: from `useLastSeen()` in DashboardView.
 *
 * The person's name is shown only here and in the edit fields: it never goes into a log, an error string or an
 * announcement.
 */
export interface BriefingProps {
  firstLaunch: boolean
  announce: DashboardAnnouncement | null
  onAnnounce: (text: string) => void
  customise?: ReactNode
  onNewProject: () => void
  motionPaused: boolean
  onMotionPaused: (paused: boolean) => void
  lastSeen: number
  firstVisit: boolean
}

/** One figure of the "Since" line: counts up from zero on arrival, shows its final value under reduced motion. */
function SincePartView({ part, arriving, still }: { part: SincePart; arriving: boolean; still: boolean }): ReactElement {
  const shown = useCountUp(part.count, { arriving, still })
  const text = outcomeText(part)
  const rest = text.slice(String(part.count).length)
  return (
    <span className="dash-since-part" data-outcome={part.outcome}>
      <b className="dash-since-figure">{Math.round(shown ?? part.count)}</b>
      {rest}
    </span>
  )
}

export function Briefing({ firstLaunch, announce, onAnnounce, customise, onNewProject, motionPaused, onMotionPaused, lastSeen, firstVisit }: BriefingProps): ReactElement {
  const { arriving, still, layout } = useDashboard()
  const now = useNow()
  const summaries = useAllSummaries()
  const snapshot = useBandSnapshot()
  const decisions = useDecisionTotal()
  const projects = useAppStore((s) => s.projects)
  const history = useAppStore((s) => s.historyByProject)
  const openProject = useAppStore((s) => s.openProject)
  const limits = useLimitEntries()
  const [name, setName] = useDisplayName()
  // After a save the control may change (Add becomes Edit and back): focus whichever exists now.
  const [focusSeq, setFocusSeq] = useState(0)

  const ready = projects.every((p) => p.id in history)
  const status = useMemo(() => {
    const work = bandWorkFacts(snapshot.runs, snapshot.projects, snapshot.virtualProjects)
    const paused = pausedRuns(summaries)
    const resumes = paused.flatMap((r) => (r.autoResume && typeof r.pausedUntil === 'number' ? [r.pausedUntil] : []))
    const until = resumes.length > 0 ? clockLabel(Math.min(...resumes)) : ''
    return statusParts({
      firstLaunch,
      ready,
      anyRunEver: summaries.length > 0,
      decisions,
      awaitingReply: work.awaitingReply,
      workingAgents: work.workingAgents,
      workingRuns: work.counts.working,
      paused: paused.length,
      ...(until ? { pausedUntilLabel: until } : {})
    })
  }, [snapshot, summaries, decisions, firstLaunch, ready])
  const since = useMemo(() => (firstLaunch ? null : sinceSummary({ summaries, lastSeen, now, firstVisit, ready })), [summaries, lastSeen, now, firstVisit, ready, firstLaunch])

  const continueId = useMemo(() => continueProjectId(layout.pinned, projects, summaries), [layout.pinned, projects, summaries])
  const continueName = continueId ? projects.find((p) => p.id === continueId)?.name : undefined

  const text = salutation(new Date(now).getHours(), name, firstLaunch)
  const saved = useCallback(
    (next: string | undefined): void => {
      setName(next)
      setFocusSeq((n) => n + 1)
      onAnnounce(next ? 'Name saved.' : 'Name removed.')
    },
    [onAnnounce, setName]
  )
  useEffect(() => {
    if (focusSeq === 0) return
    const frame = requestAnimationFrame(() => {
      const testId = name ? 'dash-name-edit' : 'dash-name-add'
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Only a save moves focus; a later settings:changed must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq])

  const showSide = !firstLaunch
  return (
    <section className={arriving ? 'hero-card dash-briefing motion-arrive-hero' : 'hero-card dash-briefing'} data-testid="dashboard-hero" aria-label="Briefing" data-side={showSide ? '' : undefined}>
      <div className="dash-brief-main">
        <div className="dash-greeting-row">
          <h2 className="dash-salutation" data-testid="dash-greeting-salutation" title={name ? text : undefined}>
            {text}
          </h2>
          {name && <NameControl name={name} onSaved={saved} />}
        </div>
        <p className="dash-brief-status" data-testid="dash-greeting-brief">
          {status.map((p, i) => (
            <span key={i}>
              {i > 0 && ' '}
              {p.attention ? <b className="dash-brief-attn">{p.text}</b> : p.text}
            </span>
          ))}
        </p>
        {since && (
          <p className="dash-since" data-testid="dash-since">
            <span className="sr-only">{sinceSentence(since)}</span>
            <span aria-hidden="true" className="dash-since-visual">
              <span className="dash-since-label">{since.label}:</span>
              {since.parts.map((p) => (
                <SincePartView key={p.outcome} part={p} arriving={arriving} still={still} />
              ))}
              {since.spent && <span className="dash-since-part">{since.spent}</span>}
            </span>
          </p>
        )}
        {!name && (
          <div className="dash-name-add-row">
            <NameControl name={name} onSaved={saved} />
          </div>
        )}
        {!firstLaunch && (
          <div className="dash-brief-actions" data-testid="dash-quick-actions">
            {continueId && continueName && (
              <Button variant="primary" onClick={() => void openProject(continueId)} testId="dash-continue" ariaLabel={`Continue ${continueName}`} title={`Continue ${continueName}`}>
                <Icon icon={Play} size="sm" />
                <span className="dash-continue-name">Continue {continueName}</span>
              </Button>
            )}
            <Button variant="secondary" icon={MessageSquare} onClick={() => void openNewChat()} testId="projects-new-chat">
              New chat
            </Button>
            <Button variant="secondary" icon={Plus} onClick={onNewProject} testId="new-project">
              New project
            </Button>
            {customise}
          </div>
        )}
        {!firstLaunch && <SetupGaps />}
      </div>
      {showSide && (
        <div className="dash-brief-side">
          <div className="dash-pulse-wrap">
            <TeamPulse arriving={arriving} paused={still} restProjectId={continueId} />
            <button
              type="button"
              className="dash-pause-toggle"
              data-testid="dash-pause-motion"
              aria-pressed={motionPaused}
              onClick={() => onMotionPaused(!motionPaused)}
              style={{ '--pause-weight': motionPaused ? 'var(--weight-semibold)' : 'var(--weight-regular)' } as CSSProperties}
            >
              {motionPaused ? 'Motion paused' : 'Pause motion'}
            </button>
          </div>
          <PlanGauges entries={limits} arrive={arriving} className="dash-brief-gauges" />
        </div>
      )}
      <DashboardLive announce={announce} />
    </section>
  )
}
