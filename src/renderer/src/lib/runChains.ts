import type { RunStatus, RunSummary } from '@shared/types'

/**
 * Session chains. Continuing a run starts a new run that resumes the old run's provider session, so the new run
 * has `resumedFrom` = old id and (once init arrives) the same `sessionId`. A chain is the set of runs linked by
 * either; only its newest member may be continued.
 */

type ChainSummary = Pick<RunSummary, 'id' | 'startedAt' | 'status'> & Partial<Pick<RunSummary, 'sessionId' | 'resumedFrom' | 'projectId'>>

const OPEN: ReadonlySet<RunStatus> = new Set<RunStatus>(['starting', 'running', 'idle', 'stopping'])
const CONTINUABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(['finished', 'error', 'paused'])

/** Run is open: a live session still taking work or messages. */
export const isOpenStatus = (status: RunStatus): boolean => OPEN.has(status)

/** Members of the run's session chain, oldest first. Includes the run itself; empty when the id is unknown. */
export function chainOf<T extends ChainSummary>(runs: readonly T[], id: string): T[] {
  const start = runs.find((r) => r.id === id)
  if (!start) return []
  const members = new Set<string>([id])
  const queue: T[] = [start]
  while (queue.length > 0) {
    const cur = queue.pop() as T
    for (const r of runs) {
      if (members.has(r.id)) continue
      const linked =
        (cur.sessionId !== undefined && r.sessionId === cur.sessionId) || r.resumedFrom === cur.id || cur.resumedFrom === r.id
      if (linked) {
        members.add(r.id)
        queue.push(r)
      }
    }
  }
  return runs.filter((r) => members.has(r.id)).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** The chain's newest member. */
export function newestOf<T extends ChainSummary>(runs: readonly T[], id: string): T | undefined {
  const chain = chainOf(runs, id)
  return chain[chain.length - 1]
}

/** The run that continued this one (the next chain member), when this run is not the newest. */
export function continuedBy<T extends ChainSummary>(runs: readonly T[], id: string): T | undefined {
  const chain = chainOf(runs, id)
  const direct = chain.find((r) => r.resumedFrom === id)
  if (direct) return direct
  const i = chain.findIndex((r) => r.id === id)
  return i >= 0 ? chain[i + 1] : undefined
}

/** Continue is offered only on the chain's newest member, once it stopped and has a provider session. */
export function canContinue<T extends ChainSummary>(runs: readonly T[], id: string): boolean {
  const run = runs.find((r) => r.id === id)
  if (!run || !run.sessionId || !CONTINUABLE.has(run.status)) return false
  return newestOf(runs, id)?.id === id
}

interface CountedRun {
  summary: ChainSummary
  permissions?: readonly unknown[]
  proposals?: readonly unknown[]
  questions?: readonly unknown[]
  plan?: { status: string }
}

/** An open run that is waiting for the user: an unanswered card, a question or a blocked plan. */
export const needsYou = (r: CountedRun): boolean =>
  isOpenStatus(r.summary.status) &&
  ((r.permissions?.length ?? 0) + (r.proposals?.length ?? 0) + (r.questions?.length ?? 0) > 0 || r.plan?.status === 'blocked')

/** Open runs and runs that need the user, per project. */
export function projectCounts(runs: readonly CountedRun[], projectId: string): { open: number; needsYou: number } {
  let open = 0
  let waiting = 0
  for (const r of runs) {
    if (r.summary.projectId !== projectId) continue
    if (isOpenStatus(r.summary.status)) open++
    if (needsYou(r)) waiting++
  }
  return { open, needsYou: waiting }
}

/** Short relative time such as "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** Plain-words status for chips and rows. `waiting` wins over the run status. */
export function statusLabel(status: RunStatus, waiting = false, endedWithApp = false): string {
  if (waiting) return 'Waiting for you'
  // Cut by app exit wins even when the run had paused before the restart.
  if (endedWithApp && status === 'finished') return 'Ended when OrgAI closed'
  switch (status) {
    case 'starting':
    case 'running':
      return 'Working'
    case 'idle':
      return 'Idle'
    case 'stopping':
      return 'Stopping'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Failed'
    default:
      return 'Finished'
  }
}

/** Parses a "Session already open" refusal from runs.continue; returns the live run's id. */
export function sessionOpenRunId(message: string): string | null {
  if (!/Session already open/i.test(message)) return null
  return /run (run_[A-Za-z0-9_-]+)/.exec(message)?.[1] ?? null
}
