import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RunSummary } from '@shared/types'
import { isRunLive, useAppStore, waitingRuns, type RunState } from '../../store/useAppStore'
import { isTeamSurfaceRun } from '../../lib/runSurface'

/**
 * Every run summary the renderer holds, history merged with the live store (live wins), team-surface runs left out,
 * newest start first. The Dashboard's Since, Paused and cost figures read this.
 */
export function useAllSummaries(): RunSummary[] {
  const history = useAppStore((s) => s.historyByProject)
  const runs = useAppStore((s) => s.runs)
  return useMemo(() => {
    const byId = new Map<string, RunSummary>()
    for (const list of Object.values(history)) for (const h of list) byId.set(h.id, h)
    for (const r of Object.values(runs)) byId.set(r.summary.id, r.summary)
    return [...byId.values()].filter((s) => !isTeamSurfaceRun(s)).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
  }, [history, runs])
}

/** Runs with at least one open decision (the same set the bell counts), in start order. */
export function useWaitingRuns(): RunState[] {
  const list = useAppStore(useShallow(waitingRuns))
  return useMemo(() => [...list].sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id)), [list])
}

/** Live runs (starting, running, idle, stopping), every project, assistants included, in start order. */
export function useLiveRuns(): RunState[] {
  const runs = useAppStore((s) => s.runs)
  return useMemo(
    () => Object.values(runs).filter((r) => isRunLive(r) && !isTeamSurfaceRun(r.summary)).sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id)),
    [runs]
  )
}

/** Date.now(), refreshed every `ms` (default 30 s). Used for elapsed times, which are never announced. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
