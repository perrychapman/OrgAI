import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isVirtualProjectId, type RunSummary } from '@shared/types'
import { isRunLive, useAppStore, waitingRuns, type RunState } from '../../store/useAppStore'

/**
 * Every run summary the renderer holds, history merged with the live store (live wins), newest start first. The Dashboard's Since, Paused and cost figures read this.
 */
export function useAllSummaries(): RunSummary[] {
  const history = useAppStore((s) => s.historyByProject)
  const runs = useAppStore((s) => s.runs)
  const projects = useAppStore((s) => s.projects)
  return useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    const byId = new Map<string, RunSummary>()
    for (const list of Object.values(history)) for (const h of list) byId.set(h.id, h)
    for (const r of Object.values(runs)) byId.set(r.summary.id, r.summary)
    // H2: a late event for a deleted project must not bring its run back.
    return [...byId.values()]
      .filter((s) => known.has(s.projectId) || isVirtualProjectId(s.projectId))
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
  }, [history, runs, projects])
}

/** Runs with at least one open decision (the same set the bell counts), in start order. */
export function useWaitingRuns(): RunState[] {
  const list = useAppStore(useShallow(waitingRuns))
  const projects = useAppStore((s) => s.projects)
  return useMemo(
    () =>
      list
        .filter((r) => isVirtualProjectId(r.summary.projectId) || projects.some((p) => p.id === r.summary.projectId))
        .sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id)),
    [list, projects]
  )
}

/** Live runs (starting, running, idle, stopping), every project, assistants included, in start order. */
export function useLiveRuns(): RunState[] {
  const runs = useAppStore((s) => s.runs)
  const projects = useAppStore((s) => s.projects)
  return useMemo(
    () =>
      Object.values(runs)
        .filter((r) => isRunLive(r) && (isVirtualProjectId(r.summary.projectId) || projects.some((p) => p.id === r.summary.projectId)))
        .sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id)),
    [runs, projects]
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
