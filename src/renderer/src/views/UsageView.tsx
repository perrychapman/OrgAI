import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UsageOverview } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import AppNavigateBanner from '../components/AppNavigateBanner'
import { connectionLabel } from '../lib/connectionLabel'
import { cleanIpcError } from '../lib/ipcError'
import { assignSeries, type SeriesState } from '../lib/usageCharts'
import { effectiveBucket, narrowFilters, overviewQuery, periodSpan, queryKey, usageData, type UsageNarrowing } from '../lib/usageOverview'
import type { WastefulSort } from '../components/usage/panelProps'
import SpendPanel from '../components/usage/SpendPanel'
import ProjectsPanel from '../components/usage/ProjectsPanel'
import ModelsPanel from '../components/usage/ModelsPanel'
import RolesPanel from '../components/usage/RolesPanel'
import EfficiencyPanel from '../components/usage/EfficiencyPanel'
import WastefulRuns from '../components/usage/WastefulRuns'
import AllRuns from '../components/usage/AllRuns'

/**
 * The app-wide Usage page (docs/design/usage-app.md). SKELETON from the UI Lead: the shell engineer owns this file and
 * builds the header, filter bar, chips, summary, states, live refetch and announcements around the panels below.
 */
export default function UsageView(): ReactElement {
  const filters = useAppStore((s) => s.usageFilters)
  const setFilters = useAppStore((s) => s.setUsageFilters)
  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wastefulSort, setWastefulSort] = useState<WastefulSort>('no-result')
  const [wastefulFocus, setWastefulFocus] = useState(0)
  const [runsOpen, setRunsOpen] = useState(filters.projectIds.length > 0)
  const seriesRef = useRef<SeriesState | null>(null)
  const now = Date.now()
  const key = queryKey(filters, now)

  useEffect(() => {
    let live = true
    window.orgai.runs
      .usageOverview(overviewQuery(filters, Date.now()))
      .then((o) => {
        if (live) {
          setOverview(o)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (live) setError(cleanIpcError(e))
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const connectionName = useCallback((id: string | null) => (id ? connectionLabel(id) : 'Unknown connection'), [])
  const data = useMemo(() => (overview ? usageData(overview, filters, connectionName) : null), [overview, filters, connectionName])
  const span = periodSpan(filters.period, now)
  const bucket = effectiveBucket(filters, now)
  const series = useMemo(() => {
    if (!overview) return new Map<string, number>()
    seriesRef.current = assignSeries(seriesRef.current, overview.projects, JSON.stringify(filters.period))
    return seriesRef.current.map
  }, [overview, filters.period])

  const onNarrow = useCallback(
    (n: UsageNarrowing) => {
      setFilters(narrowFilters(useAppStore.getState().usageFilters, n))
      if (n.projectId) setRunsOpen(true)
    },
    [setFilters]
  )
  const announce = useCallback((_text: string) => undefined, [])

  return (
    <div className="usage-view" data-testid="usage-view">
      <div className="topbar">
        <h1>Usage</h1>
      </div>
      <AppNavigateBanner />
      <div className="usage-scroll">
        {error && <p role="alert">{error}</p>}
        {overview && data && (
          <>
            <SpendPanel {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} />
            <ProjectsPanel {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} />
            <ModelsPanel {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} />
            <RolesPanel {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} />
            <EfficiencyPanel
              {...{ data, overview, filters, bucket, span, series, onNarrow, announce }}
              onPickSignal={(s) => {
                setWastefulSort(s)
                setWastefulFocus((n) => n + 1)
              }}
            />
            <WastefulRuns {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} sort={wastefulSort} onSort={setWastefulSort} focusSeq={wastefulFocus} />
            <AllRuns {...{ data, overview, filters, bucket, span, series, onNarrow, announce }} open={runsOpen} onToggle={setRunsOpen} />
          </>
        )}
      </div>
    </div>
  )
}
