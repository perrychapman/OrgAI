import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isVirtualProjectId, type Project, type RunSummary } from '@shared/types'
import { isRunLive, useAppStore, waitingRuns, type RunState } from '../../store/useAppStore'
import { projectKindOf } from '@shared/defaults'
import { waitingItems } from '../../lib/needsYou'
import { BAND_RECOMPUTE_MS, bandSignature, type BandRunIn } from '../../lib/dashboardBand'

/**
 * Every run summary the renderer holds, history merged with the live store (live wins), team-surface runs left out,
 * newest start first. The Dashboard's Since, Paused and cost figures read this.
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
      .filter((s) => (known.has(s.projectId) || isVirtualProjectId(s.projectId)))
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

/** What the Right now band draws from: open runs reduced to what it reads, plus the projects (spec 6.8). */
export interface BandSnapshot {
  runs: BandRunIn[]
  projects: Project[]
  virtualProjects: Partial<Record<string, Project>>
}

type StoreState = ReturnType<typeof useAppStore.getState>

function bandSnapshotOf(s: StoreState): BandSnapshot {
  const known = new Set(s.projects.map((p) => p.id))
  const runs: BandRunIn[] = Object.values(s.runs)
    .filter((r) => isRunLive(r) && (isVirtualProjectId(r.summary.projectId) || known.has(r.summary.projectId)))
    .map((r) => {
      const items = waitingItems(r, projectKindOf(s.projects.find((p) => p.id === r.summary.projectId)))
      return {
        summary: r.summary,
        ...(r.plan ? { plan: r.plan } : {}),
        agents: r.agents,
        decisions: items.length,
        ...(items[0] ? { firstDecision: items[0].label } : {})
      }
    })
  return { runs, projects: s.projects, virtualProjects: s.virtualProjects }
}

/**
 * The band's snapshot, recomputed at most every `BAND_RECOMPUTE_MS` (trailing) and published only when what the band
 * draws changed, so a burst of `agent.upsert` events renders once and an unrelated event renders nothing.
 */
export function useBandSnapshot(): BandSnapshot {
  const [snap, setSnap] = useState<BandSnapshot>(() => bandSnapshotOf(useAppStore.getState()))
  useEffect(() => {
    let timer: number | undefined
    let last = ''
    const flush = (): void => {
      timer = undefined
      const next = bandSnapshotOf(useAppStore.getState())
      const sig = bandSignature(next.runs, next.projects, next.virtualProjects)
      if (sig === last) return
      last = sig
      setSnap(next)
    }
    flush()
    const unsub = useAppStore.subscribe(() => {
      if (timer === undefined) timer = window.setTimeout(flush, BAND_RECOMPUTE_MS)
    })
    return () => {
      unsub()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])
  return snap
}
