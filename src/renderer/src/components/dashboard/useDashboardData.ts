import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isVirtualProjectId, type Project, type RunSummary } from '@shared/types'
import { isRunLive, useAppStore, waitingRuns, type RunState } from '../../store/useAppStore'
import { projectKindOf } from '@shared/defaults'
import { combinedDecisionCount, waitingItems } from '../../lib/needsYou'
import { useTeamAttentionItems } from '../../lib/menuActions'
import { BAND_RECOMPUTE_MS, bandSignature, type BandRunIn } from '../../lib/dashboardBand'

/**
 * Every run summary the renderer holds, history merged with the live store (live wins), team-surface runs left out,
 * newest start first. The Dashboard's Since, Paused and cost figures read this.
 */
export function useAllSummaries(): RunSummary[] {
  const history = useAppStore((s) => s.historyByProject)
  // Only the live runs' summaries (shallow-compared), not the run objects: an event that leaves every summary alone (a
  // streamed token, an agent update) renders nothing.
  const live = useAppStore(useShallow((s) => Object.values(s.runs).map((r) => r.summary)))
  const projects = useAppStore((s) => s.projects)
  return useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    const byId = new Map<string, RunSummary>()
    for (const list of Object.values(history)) for (const h of list) byId.set(h.id, h)
    for (const summary of live) byId.set(summary.id, summary)
    // H2: a late event for a deleted project must not bring its run back.
    return [...byId.values()]
      .filter((s) => (known.has(s.projectId) || isVirtualProjectId(s.projectId)))
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
  }, [history, live, projects])
}

/**
 * What the page's arrival depends on: the open decisions, the ids of the open runs, the newest end time and the number of
 * projects, as one string. Selected with shallow-compared pieces so a run event that changes none of them renders nothing
 * (the Dashboard subscribes to this, not to the run map).
 */
export function useArrivalSignature(): string {
  const decisions = useDecisionTotal()
  const liveIds = useAppStore(
    useShallow((s) =>
      Object.values(s.runs)
        .filter((r) => isRunLive(r) && (isVirtualProjectId(r.summary.projectId) || s.projects.some((p) => p.id === r.summary.projectId)))
        .map((r) => r.summary.id)
        .sort()
    )
  )
  const newestEnd = useAppStore((s) => {
    let m = 0
    for (const list of Object.values(s.historyByProject)) for (const h of list) if ((h.endedAt ?? 0) > m) m = h.endedAt ?? 0
    for (const r of Object.values(s.runs)) if ((r.summary.endedAt ?? 0) > m) m = r.summary.endedAt ?? 0
    return m
  })
  const projectCount = useAppStore((s) => s.projects.length)
  return [decisions, liveIds.join(','), newestEnd, projectCount].join('|')
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

/** The bell's count: open decisions of runs plus team-files items (lib/needsYou.ts). */
export function useDecisionTotal(): number {
  const waiting = useWaitingRuns()
  const teamItems = useTeamAttentionItems()
  return useMemo(() => combinedDecisionCount(waiting, teamItems), [waiting, teamItems])
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
        ...(r.roster ? { roster: r.roster } : {}),
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
