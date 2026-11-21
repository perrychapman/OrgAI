import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { BarChart3 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { activityMap } from '../../lib/activityMap'
import { isWorkRun, statCards, weekRecap, type StatCard } from '../../lib/weekRecap'
import { DashSection, useDashboard } from './DashboardContext'
import { StatCards } from './StatCards'
import { ActivityMap } from './ActivityMap'
import { useAllSummaries, useNow } from './useDashboardData'

/**
 * Your week (docs/design/dashboard-usage-redesign dashboard.md): the four stat cards for the last 7 local days including
 * today and the activity map of the last 14. Every figure derives from stored run summaries; nothing here can fail.
 * Figures hold their place with a dash until every project's history is loaded, so a quiet-looking week is never a
 * loading one. With no run in the last 14 days the section is not drawn.
 *
 * Each stat card opens Usage on the same 7 days (Spend with the cost metric pressed, Runs with the runs metric, Agent
 * time and Decisions on the period alone). The map's heading link opens Usage on 30 days: there is no 14-day period yet.
 */
export function WeekSection(): ReactElement | null {
  const { layout, arriving, still } = useDashboard()
  const projects = useAppStore((s) => s.projects)
  const historyByProject = useAppStore((s) => s.historyByProject)
  const openUsage = useAppStore((s) => s.openUsage)
  const summaries = useAllSummaries()
  const now = useNow(60_000)

  const ready = projects.every((p) => p.id in historyByProject)
  const recap = useMemo(() => weekRecap(summaries, projects, now), [summaries, projects, now])
  const cards = useMemo(() => statCards(recap, layout.focus), [recap, layout.focus])
  const map = useMemo(() => activityMap(summaries.filter(isWorkRun), now), [summaries, now])
  const empty = ready && map.total === 0 && recap.runs === 0 && recap.previous.runs === 0

  const open = (card: StatCard): void => openUsage({ period: { kind: 'days', days: 7 }, ...(card.metric ? { metric: card.metric } : {}) })

  return (
    <DashSection id="week" testId="dash-week" empty={empty} icon={BarChart3} className="dash-week" headExtra={<span className="dash-week-range">Last 7 days</span>}>
      <StatCards cards={cards} arriving={arriving && ready} still={still} pending={!ready} onOpen={open} />
      <ActivityMap map={map} draw={arriving && !still} pending={!ready} onOpenUsage={() => openUsage({ period: { kind: 'days', days: 30 } })} />
    </DashSection>
  )
}
