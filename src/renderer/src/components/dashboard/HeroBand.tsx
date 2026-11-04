import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Cost } from '../ui/Cost'
import { costView, runCostInput, sumCosts } from '../../lib/cost'
import { isDevBuild } from '../../lib/buildChannel'
import { decisionCount } from '../../lib/needsYou'
import { FIRST_LAUNCH_LINE, WEEK_MS, heroFigure, heroSublineParts, pausedRuns, sinceLastSeen } from '../../lib/dashboard'
import { useAllSummaries, useLiveRuns, useNow, useWaitingRuns } from './useDashboardData'

/**
 * The Dashboard's hero (spec 3): one figure, one subline, quiet app facts. No buttons. The figure is always visible;
 * the polite live region `dashboard-live` is a visually hidden sibling that stays empty on mount and speaks only when
 * the figure changes afterwards, or when `announce` changes to a new message.
 */
/** A message for the page's one live region; `seq` rises with every message so a repeated text still speaks. */
export interface DashboardAnnouncement {
  text: string
  seq: number
}

const TOGETHER_MS = 1500

export function HeroBand({
  firstLaunch,
  announce,
  lastSeen,
  clearedAt
}: {
  firstLaunch: boolean
  announce: DashboardAnnouncement | null
  lastSeen: number
  clearedAt: number
}): ReactElement {
  const projectCount = useAppStore((s) => s.projects.length)
  const appInfo = useAppStore((s) => s.appInfo)
  const waiting = useWaitingRuns()
  const live = useLiveRuns()
  const summaries = useAllSummaries()
  const now = useNow()

  const decisions = decisionCount(waiting)
  const paused = useMemo(() => pausedRuns(summaries).length, [summaries])
  const { figure } = heroFigure({ decisions, running: live.length, paused, projects: projectCount })
  const closedWaiting = useMemo(
    () => sinceLastSeen(summaries, lastSeen, now, { cap: Number.MAX_SAFE_INTEGER, clearedAt }).items.filter((it) => it.kind === 'closed-waiting').length,
    [summaries, lastSeen, clearedAt, now]
  )

  const cost = useMemo(() => {
    const from = now - WEEK_MS
    return sumCosts(summaries.filter((s) => s.startedAt >= from).map(runCostInput))
  }, [summaries, now])
  const showCost = !firstLaunch && costView(cost).kind !== 'none'
  const parts = heroSublineParts({ projects: projectCount, openRuns: live.length, closedWaiting, quiet: figure === 'All quiet' })

  const [spoken, setSpoken] = useState('')
  const lastFigure = useRef(figure)
  const lastAnnounce = useRef(announce)
  // M4: a message and a figure change within one beat are spoken as one sentence, so neither overwrites the other.
  const figureAt = useRef(0)
  const announceAt = useRef(0)
  useEffect(() => {
    if (lastFigure.current === figure) return
    lastFigure.current = figure
    const t = Date.now()
    figureAt.current = t
    const msg = lastAnnounce.current
    setSpoken(msg && t - announceAt.current < TOGETHER_MS ? `${msg.text} ${figure}.` : figure)
  }, [figure])
  useEffect(() => {
    if (lastAnnounce.current?.seq === announce?.seq) return
    lastAnnounce.current = announce
    if (!announce) return
    const t = Date.now()
    announceAt.current = t
    setSpoken(t - figureAt.current < TOGETHER_MS ? `${announce.text} ${lastFigure.current}.` : announce.text)
  }, [announce])

  const version = appInfo?.version
  return (
    <section className="dash-hero" data-testid="dashboard-hero" aria-label="Overview">
      <span className="dash-hero-mark" aria-hidden="true" />
      <div className="dash-hero-main">
        <p className="dash-hero-figure" data-testid="dashboard-figure">
          {firstLaunch ? 'Welcome to OrgAI' : figure}
        </p>
        <p className="dash-hero-sub">
          {firstLaunch ? (
            FIRST_LAUNCH_LINE
          ) : (
            <>
              {parts.map((p, i) => (
                <span key={p}>
                  {i > 0 && <span className="dash-sep"> · </span>}
                  <span className="dash-num">{p}</span>
                </span>
              ))}
              {showCost && (
                <span>
                  {parts.length > 0 && <span className="dash-sep"> · </span>}
                  <Cost value={cost} className="dash-num" /> in the last 7 days
                </span>
              )}
            </>
          )}
        </p>
      </div>
      <div className="dash-hero-facts" data-testid="dashboard-app-facts">
        {version && <span className="dash-num">OrgAI {version}</span>}
        {isDevBuild(version) && <Badge tone="info">Dev</Badge>}
        {appInfo?.mockAdapter && <Badge tone="warning">Mock adapter</Badge>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="dashboard-live">
        {spoken}
      </div>
    </section>
  )
}
