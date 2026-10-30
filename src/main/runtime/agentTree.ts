import type { AgentInstance } from '@shared/types'

/**
 * Agent parent chains are trees. The SDK can emit a `task_started` for an agent the run already knows (a SendMessage
 * to a finished subagent resumes it, with `parent_task_id` = the messaging agent), so adapters resolve parents here
 * instead of trusting the event, and RunManager repairs records that were written before this rule existed.
 */

type ParentLink = Pick<AgentInstance, 'id' | 'parentId'>
type AgentLookup = Record<string, ParentLink> | Map<string, ParentLink>

function lookup(agents: AgentLookup, id: string): ParentLink | undefined {
  return agents instanceof Map ? agents.get(id) : Object.prototype.hasOwnProperty.call(agents, id) ? agents[id] : undefined
}

/** True when making `parentId` the parent of `childId` would close a loop. Terminates on already-cyclic input. */
export function wouldCycle(agents: AgentLookup, childId: string, parentId: string): boolean {
  const seen = new Set<string>()
  let cur: string | null = parentId
  while (cur !== null && !seen.has(cur)) {
    if (cur === childId) return true
    seen.add(cur)
    cur = lookup(agents, cur)?.parentId ?? null
  }
  return false
}

/**
 * The parent an adapter should record for `taskId`. A known agent keeps its parent (a task_started for it is a
 * resume, not a spawn); the root has none; otherwise `candidate` wins unless it is missing, the agent itself or would
 * create a cycle, in which case the agent goes under `rootId`. A candidate the run does not know yet is accepted.
 */
export function resolveParent(agents: AgentLookup, taskId: string, candidate: string | undefined, rootId: string): string | null {
  if (taskId === rootId) return null
  const existing = lookup(agents, taskId)
  if (existing && existing.parentId !== null) return existing.parentId
  if (candidate === undefined || candidate === taskId || wouldCycle(agents, taskId, candidate)) return rootId
  return candidate
}

/**
 * Returns `agents` with every parent cycle broken. In each cycle the earliest-started member (ties by id) moves under
 * `rootId` (or gets `parentId: null` when the root is missing or is itself on the cycle), which keeps the rest of the
 * cycle's structure. Dangling parents are not cycles and are left alone. Never mutates the input and returns the same
 * object when nothing is cyclic, so it is idempotent.
 */
export function breakParentCycles(agents: Record<string, AgentInstance>, rootId: string): Record<string, AgentInstance> {
  let out = agents
  const ok = new Set<string>()
  for (const start of Object.keys(agents)) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = start
    while (cur !== null && !ok.has(cur)) {
      const node: AgentInstance | undefined = Object.prototype.hasOwnProperty.call(out, cur) ? out[cur] : undefined
      if (!node) break
      if (onPath.has(cur)) {
        const cycle = path.slice(path.indexOf(cur)).map((id) => out[id])
        const pick = cycle.reduce((a, b) => (b.startedAt < a.startedAt || (b.startedAt === a.startedAt && b.id < a.id) ? b : a))
        const rootOk = pick.id !== rootId && Object.prototype.hasOwnProperty.call(out, rootId) && !cycle.some((a) => a.id === rootId)
        if (out === agents) out = { ...agents }
        out[pick.id] = { ...pick, parentId: rootOk ? rootId : null }
        break
      }
      path.push(cur)
      onPath.add(cur)
      cur = node.parentId
    }
    for (const id of path) ok.add(id)
  }
  return out
}
