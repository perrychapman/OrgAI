/**
 * "Hide finished agents" on the Live canvas (docs/design/spec.md, "Folding finished agents"). Pure: no store, no React.
 *
 * Rule: an agent is foldable when it has a parent, is settled and nothing under it is still live. A foldable agent
 * whose parent is on the canvas and whose parent's group is not expanded leaves the canvas; so does everything under
 * it. Every hidden agent belongs to the group of its nearest visible ancestor, so a settled subtree is ONE group under
 * the agent still shown above it (never an orphan group whose parent is itself folded). `expanded` is keyed by that
 * visible ancestor's id (or an earlier-session key): expanding it shows its direct reports, whose own settled reports
 * then fold into one group per report. An expansion keyed by a number (the time it was made) keeps showing the reports
 * that had finished by then, while a report that finishes after it folds again (ux-review-fold.md M1).
 */
import type { AgentInstance } from '@shared/types'

/** How long a finished agent stays on the canvas before it folds. */
export const COLLAPSE_GRACE_MS = 6000
/** The smallest wait before the next fold re-check, so a burst of finishes re-renders once. */
export const SETTLE_TIMER_FLOOR_MS = 250
const SETTLED_WORKTREE = new Set(['merged', 'empty', 'removed', 'held', 'conflict'])

/** Done or failed with its worktree settled: settled once the grace period has passed (timing aside). */
function settlesOnTime(a: AgentInstance): boolean {
  if (a.state !== 'done' && a.state !== 'error') return false
  return !a.worktree || SETTLED_WORKTREE.has(a.worktree.status)
}

/**
 * True once a report has reported back and nothing is still happening to its branch: done or failed, worktree settled,
 * `COLLAPSE_GRACE_MS` after `endedAt`. An agent with no `endedAt` (an adapter or an old record that never set it) has
 * no moment to time the grace from, so it counts as settled at once rather than never folding.
 */
export function isSettledAt(a: AgentInstance, now: number): boolean {
  if (!settlesOnTime(a)) return false
  return a.endedAt === undefined || now - a.endedAt >= COLLAPSE_GRACE_MS
}

/**
 * The next moment an agent becomes settled, judged at `now` (the time the fold was last computed): the earliest
 * `endedAt + COLLAPSE_GRACE_MS` still ahead of `now`, or undefined when nothing is waiting out its grace period. An
 * agent still working, or with an unsettled worktree, has no moment yet (its next event re-runs this).
 */
export function nextSettleAt(agents: readonly AgentInstance[], now: number): number | undefined {
  let next: number | undefined
  for (const a of agents) {
    if (!settlesOnTime(a) || a.endedAt === undefined) continue
    const at = a.endedAt + COLLAPSE_GRACE_MS
    if (at > now && (next === undefined || at < next)) next = at
  }
  return next
}

/** How long to wait for `due` from the real clock `now`: at least the floor, so a moment already past re-checks at once. */
export function settleTimerDelay(due: number, now: number, floor = SETTLE_TIMER_FLOOR_MS): number {
  return Math.max(floor, due - now)
}

export interface FoldInput {
  /** The newest member's agents, parents normalized (`normalizeParents`). */
  agents: readonly AgentInstance[]
  /** Settled = done or failed, worktree settled, past the grace period. */
  isSettled: (a: AgentInstance) => boolean
  /**
   * Expanded group keys: a visible agent's id, or an earlier-session key. `true` shows every report; a number (when it
   * was expanded, epoch ms) shows the reports that ended by then and folds the ones that end later.
   */
  expanded: Readonly<Record<string, boolean | number>>
  /** Earlier chain members' groups (keys from `earlierKey`), oldest first. */
  earlier?: readonly { key: string; agents: AgentInstance[] }[]
  /** False shows every agent ("Hide finished agents" off). */
  collapse: boolean
}

export interface FoldResult {
  /** Agents drawn as nodes: the newest member's visible agents, then any earlier-session agents shown. */
  visibleAgents: AgentInstance[]
  /**
   * Group key -> folded agents. For a report group the key is the visible ancestor the group hangs under and the
   * members are its whole hidden subtree, direct reports first (breadth first). Earlier groups keep their key.
   */
  groups: Map<string, AgentInstance[]>
}

export function foldFinished({ agents, isSettled, expanded, earlier = [], collapse }: FoldInput): FoldResult {
  const groups = new Map<string, AgentInstance[]>()
  const earlierShown: AgentInstance[] = []
  for (const g of earlier) {
    if (collapse && !expanded[g.key]) groups.set(g.key, g.agents)
    else earlierShown.push(...g.agents)
  }
  if (!collapse) return { visibleAgents: [...agents, ...earlierShown], groups }

  const byId = new Map(agents.map((a) => [a.id, a]))
  const children = new Map<string, AgentInstance[]>()
  for (const a of agents) {
    if (a.parentId === null || !byId.has(a.parentId)) continue
    const list = children.get(a.parentId)
    if (list) list.push(a)
    else children.set(a.parentId, [a])
  }

  // "Settled with nothing live under it", memoized per agent; cycle-safe (a cycle counts as live, so it stays shown).
  const quiet = new Map<string, boolean>()
  const isQuiet = (a: AgentInstance, path: Set<string>): boolean => {
    const known = quiet.get(a.id)
    if (known !== undefined) return known
    if (path.has(a.id)) return false
    path.add(a.id)
    const q = isSettled(a) && (children.get(a.id) ?? []).every((c) => isQuiet(c, path))
    path.delete(a.id)
    quiet.set(a.id, q)
    return q
  }

  // Walk down from the roots. A hidden agent's whole subtree joins the group of the nearest visible ancestor.
  const visible: AgentInstance[] = []
  const placed = new Set<string>()
  const roots = agents.filter((a) => a.parentId === null || !byId.has(a.parentId))
  const showFrom = (start: AgentInstance): void => {
    const stack = [start]
    while (stack.length) {
      const v = stack.pop() as AgentInstance
      if (placed.has(v.id)) continue
      placed.add(v.id)
      visible.push(v)
      const openAt = expanded[v.id]
      const folded: AgentInstance[] = []
      for (const c of children.get(v.id) ?? []) {
        if (placed.has(c.id)) continue
        const foldable = !openAt || (typeof openAt === 'number' && c.endedAt !== undefined && c.endedAt > openAt)
        if (foldable && isQuiet(c, new Set())) folded.push(c)
        else stack.push(c)
      }
      if (folded.length) groups.set(v.id, collectSubtree(folded, children, placed))
    }
  }
  for (const r of roots) showFrom(r)
  // Anything not reached (a cycle normalizeParents missed) still renders.
  for (const a of agents) if (!placed.has(a.id)) showFrom(a)

  const order = new Map(agents.map((a, i) => [a.id, i]))
  visible.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return { visibleAgents: [...visible, ...earlierShown], groups }
}

/** Breadth first from the folded direct reports; marks every member placed. */
function collectSubtree(first: AgentInstance[], children: Map<string, AgentInstance[]>, placed: Set<string>): AgentInstance[] {
  const out: AgentInstance[] = []
  const queue = [...first]
  for (const a of first) placed.add(a.id)
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]
    out.push(a)
    for (const c of children.get(a.id) ?? []) {
      if (placed.has(c.id)) continue
      placed.add(c.id)
      queue.push(c)
    }
  }
  return out
}

/** The agent a group node hangs under: the visible ancestor it is keyed by, or the root for an earlier session. */
export function groupParentOf(key: string, rootId: string | undefined, isEarlier: (key: string) => boolean): string | null {
  return isEarlier(key) ? (rootId ?? null) : key
}
