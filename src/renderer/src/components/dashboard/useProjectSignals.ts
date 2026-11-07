import { useEffect, useMemo, useRef, useState } from 'react'
import type { PendingWorktree, Project } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { seedTeamReview, useTeamAssistantStore } from '../../store/teamAssistant'
import { afterFirstPaint, projectQueue } from './projectQueue'
import { branchesWaiting, worktreeTargets } from './dashboardProjects'

/** What a tile's chips read for one project (docs/design/dashboard-2.md 10.3). */
export interface ProjectSignal {
  /** Branches waiting; undefined until the call returns, 0 after a failure. */
  branches?: number
  /** Team suggestions waiting. */
  suggestions: number
}

/**
 * The calls one Dashboard mount makes, in tile order: a worktree list for every real code project and a team review
 * seed for every real project. Pure; `done` holds the "kind:id" pairs already requested this mount.
 */
export function signalPlan(projects: readonly Pick<Project, 'id' | 'kind'>[], done: ReadonlySet<string>): { worktrees: string[]; teamReview: string[] } {
  const code = new Set(worktreeTargets(projects))
  const worktrees: string[] = []
  const teamReview: string[] = []
  for (const p of projects) {
    if (code.has(p.id) && !done.has(`worktrees:${p.id}`)) worktrees.push(p.id)
    if (!done.has(`teamReview:${p.id}`)) teamReview.push(p.id)
  }
  return { worktrees, teamReview }
}

/** The branches count of a cached or fresh worktree list; a failed call (null) counts as none. */
export function branchCount(list: readonly Pick<PendingWorktree, 'commitsAhead' | 'uncommittedFiles'>[] | null | undefined): number {
  return branchesWaiting(list)
}

/**
 * Per-project signals for the tiles. Calls start after first paint when the page mounts (and for a project that
 * appears later), go through the shared project queue (3 at a time, session cache), and never repeat on a timer or on
 * a run event. A failure shows nothing. `projects` should be in tile order so visible tiles fill first.
 */
export function useProjectSignals(projects: readonly Project[]): Record<string, ProjectSignal> {
  const summaries = useTeamAssistantStore(useShallow((s) => s.summaries))
  const [branches, setBranches] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {}
    for (const p of projects) {
      const hit = projectQueue.cached<PendingWorktree[]>('worktrees', p.id)
      if (hit !== undefined) seed[p.id] = branchCount(hit)
    }
    return seed
  })
  const done = useRef(new Set<string>())
  const alive = useRef(true)
  const latest = useRef(projects)
  latest.current = projects
  const signature = projects.map((p) => `${p.id}:${p.kind ?? ''}`).join('|')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const plan = signalPlan(latest.current, done.current)
    if (plan.worktrees.length === 0 && plan.teamReview.length === 0) return
    return afterFirstPaint(() => {
      const known = (id: string): boolean => latest.current.some((p) => p.id === id)
      for (const id of plan.worktrees) {
        done.current.add(`worktrees:${id}`)
        // A project deleted while queued is skipped: no git call for it (spec 10.4, review L1).
        void projectQueue.enqueue('worktrees', id, () => (known(id) ? window.orgai.maintenance.listWorktrees(id) : Promise.resolve(null))).then((list) => {
          if (!alive.current || !known(id)) return
          setBranches((b) => (b[id] === branchCount(list) ? b : { ...b, [id]: branchCount(list) }))
        })
      }
      for (const id of plan.teamReview) {
        done.current.add(`teamReview:${id}`)
        void projectQueue.enqueue('teamReview', id, () => seedTeamReview(id))
      }
    })
  }, [signature])

  return useMemo(() => {
    const out: Record<string, ProjectSignal> = {}
    for (const p of projects) out[p.id] = { branches: branches[p.id], suggestions: summaries[p.id]?.pendingCount ?? 0 }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, branches, summaries])
}
