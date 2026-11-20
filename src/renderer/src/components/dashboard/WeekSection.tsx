import type { ReactElement } from 'react'
import { useId, useMemo, useRef } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { trackHeight } from '../../lib/activityStrip'
import { useArrival } from '../../lib/useArrival'
import { TIME_WORKING_TOOLTIP, topProjectText, weekRecap } from '../../lib/weekRecap'
import { DashSection, useDashboard } from './DashboardContext'
import { WeekLedger } from './WeekLedger'
import { WeekLimits, useLimitEntries } from './WeekLimits'
import { useAllSummaries, useNow } from './useDashboardData'

/** About what the ledger adds around its track (ring room, two label rows, readout): the placeholder reserves it while history loads. */
const LEDGER_CHROME_PX = 72

/** The section never animates in during the page's first moments (history arrives right after first paint). */
const SETTLE_MS = 1500

/**
 * Your week (docs/design/dashboard-overhaul.md 7.7): the shutdown recap. Runs, time working and spend over the last 7 local
 * days including today, the most active project, the 7-day ledger, the plan limits and a link to Usage. No comparison,
 * no target, no streak. Derived from stored facts only; nothing here can fail. Figures read "-" until every project's
 * history is loaded; with no runs in the window and no limit entries the section is not rendered.
 */
export function WeekSection(): ReactElement | null {
  const { caps } = useDashboard()
  const projects = useAppStore((s) => s.projects)
  const historyByProject = useAppStore((s) => s.historyByProject)
  const openProject = useAppStore((s) => s.openProject)
  const openUsage = useAppStore((s) => s.openUsage)
  const summaries = useAllSummaries()
  const now = useNow(60_000)
  const entries = useLimitEntries()
  const tipId = useId()
  const mountedAt = useRef(Date.now())

  const recap = useMemo(() => weekRecap(summaries, projects, now), [summaries, projects, now])
  const ready = projects.every((p) => p.id in historyByProject)
  const hasRuns = recap.runs > 0
  const empty = !hasRuns && entries.length === 0

  const arrived = useArrival(empty ? [] : ['week'], 'week')('week') && Date.now() - mountedAt.current > SETTLE_MS

  return (
    <DashSection id="week" testId="dash-week" empty={empty} className={arrived ? 'dash-week motion-enter' : 'dash-week'}>
      {(hasRuns || !ready) && (
        <div className="dash-week-body">
          <dl className="dash-week-figures">
            <div className="dash-week-figure">
              <dt>Runs</dt>
              <dd data-testid="dash-week-runs">{ready ? recap.runs : '-'}</dd>
            </div>
            <div className="dash-week-figure">
              <dt title={TIME_WORKING_TOOLTIP}>Time working</dt>
              <dd data-testid="dash-week-time" aria-describedby={tipId}>
                {ready && recap.workPartial ? <span role="img" aria-label={recap.workLabel}>{recap.workText}</span> : ready ? recap.workText : '-'}
              </dd>
            </div>
            {(!ready || recap.costShown) && (
              <div className="dash-week-figure">
                <dt>Spend</dt>
                <dd data-testid="dash-week-cost">{ready ? <Cost value={recap.cost} compact /> : '-'}</dd>
              </div>
            )}
          </dl>
          <span id={tipId} className="sr-only">
            {TIME_WORKING_TOOLTIP}
          </span>
          {ready ? <WeekLedger days={recap.days} wide={caps.wide} /> : <div className="dash-ledger-pending" style={{ height: trackHeight(caps.wide) + LEDGER_CHROME_PX }} aria-hidden="true" />}
        </div>
      )}
      {ready && recap.top && (
        <Button variant="ghost" size="sm" className="dash-week-top" testId="dash-week-top-project" title={`Open ${recap.top.name}`} onClick={() => void openProject(recap.top!.id)}>
          <span className="dash-clip">{topProjectText(recap.top)}</span>
        </Button>
      )}
      <WeekLimits entries={entries} />
      <Button variant="ghost" size="sm" icon={ArrowUpRight} testId="dash-week-usage" onClick={() => openUsage({ period: { kind: 'days', days: 30 } })}>
        See usage
      </Button>
    </DashSection>
  )
}
