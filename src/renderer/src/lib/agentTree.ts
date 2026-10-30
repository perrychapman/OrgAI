import type { AgentInstance } from '@shared/types'

type AgentLookup = Map<string, AgentInstance> | Record<string, AgentInstance>

function lookup(byId: AgentLookup, id: string): AgentInstance | undefined {
  return byId instanceof Map ? byId.get(id) : Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : undefined
}

/** Ancestor ids from the direct parent upward. Cycle-safe; stops at null or an unknown parent. */
export function ancestorsOf(byId: AgentLookup, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let p = lookup(byId, id)?.parentId ?? null
  while (p && !seen.has(p)) {
    seen.add(p)
    out.push(p)
    p = lookup(byId, p)?.parentId ?? null
  }
  return out
}

/**
 * Agents whose parent chain does not end at a root (cycle, or a chain through a missing agent) become
 * top-level so they still render. Returns the same array when nothing changes. Never mutates input.
 */
export function normalizeParents(agents: AgentInstance[]): AgentInstance[] {
  const parent = new Map(agents.map((a) => [a.id, a.parentId]))
  // Walk up from id: 'root' when it ends at a null parent, 'cycle' when it returns to id, else 'broken'.
  const walk = (id: string): 'root' | 'cycle' | 'broken' => {
    const seen = new Set<string>([id])
    let p = parent.get(id) ?? null
    while (p !== null) {
      if (p === id) return 'cycle'
      if (!parent.has(p) || seen.has(p)) return 'broken'
      seen.add(p)
      p = parent.get(p) ?? null
    }
    return 'root'
  }
  const detached = new Set<string>()
  for (const a of agents) {
    if (a.parentId === null || walk(a.id) === 'root') continue
    // Break each cycle at its first member and each dangling link at the agent pointing at nothing;
    // descendants keep their parents so subtrees stay attached.
    if (!parent.has(a.parentId) || walk(a.id) === 'cycle') {
      parent.set(a.id, null)
      detached.add(a.id)
    }
  }
  return detached.size === 0 ? agents : agents.map((a) => (detached.has(a.id) ? { ...a, parentId: null } : a))
}

/** True when any descendant of `id` is not settled. Cycle-safe. */
export function hasLiveDescendant(agents: AgentInstance[], id: string, isSettled: (a: AgentInstance) => boolean): boolean {
  const seen = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const c of agents) {
      if (c.parentId !== cur || seen.has(c.id)) continue
      if (!isSettled(c)) return true
      seen.add(c.id)
      stack.push(c.id)
    }
  }
  return false
}
