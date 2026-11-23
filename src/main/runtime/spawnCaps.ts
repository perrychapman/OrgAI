import { AGENT_BRIEF_MAX_CHARS, type AgentInstance, type Project, type Role } from '@shared/types'
import { ROOT_AGENT_ID } from './types'

/**
 * UI overhaul spawn caps, one decision for every adapter (Claude, Codex, mock) and for the bridge's delegate path
 * (bridge.ts, counted over the run's whole agent record). Two limits the user sets and an adapter must hold at its spawn enforcement point:
 *  - `Role.maxConcurrent` (1..ROLE_MAX_CONCURRENT_LIMIT): most live agents of that role at a time.
 *  - `Project.maxAgentsPerRun` (1..PROJECT_MAX_AGENTS_PER_RUN_LIMIT): most agents one run may start in total. The root is
 *    never counted; a resumed agent is the same agent, so it counts once. Per session: a continued run starts a new count.
 *
 * Both are read by the caller from `ctx.project` / `ctx.roles` at the moment of the spawn (they can change mid-run), and
 * a missing value means no cap. This module is pure: it counts what it is given and returns the model-readable refusal.
 * The existing `maxConcurrentSubagents` limit (effectiveSubagentLimits) stays where each adapter enforces it.
 */

/** The part of an agent the decision reads. */
export type SpawnCapAgent = Pick<AgentInstance, 'id' | 'state'> & { roleId?: string | null }

export interface SpawnCapInput {
  project: Pick<Project, 'maxAgentsPerRun'>
  /** The run's roles as they are now. */
  roles: readonly Pick<Role, 'id' | 'name' | 'slug' | 'maxConcurrent'>[]
  /** The role about to be spawned (its id). An unknown role has no per-role cap. */
  roleId: string
  /** Every agent this session has started, ended ones included. The root is skipped. */
  agents: Iterable<SpawnCapAgent>
  /** Role ids of spawns already approved that have no agent yet (parallel calls in one message). Undefined entries count only toward the total. */
  pending?: Iterable<string | undefined>
}

/** What the caps count right now (exported for the tests and the adapters' logs). */
export interface SpawnCapCounts {
  /** Agents started this session, the pending ones included, the root excluded. */
  started: number
  /** Live agents of the role asked about, the pending ones included. */
  liveOfRole: number
}

const ended = (a: Pick<AgentInstance, 'state'>): boolean => a.state === 'done' || a.state === 'error'

export function spawnCapCounts(input: Pick<SpawnCapInput, 'roleId' | 'agents' | 'pending'>): SpawnCapCounts {
  let started = 0
  let liveOfRole = 0
  for (const a of input.agents) {
    if (a.id === ROOT_AGENT_ID) continue
    started++
    if (a.roleId === input.roleId && !ended(a)) liveOfRole++
  }
  for (const roleId of input.pending ?? []) {
    started++
    if (roleId === input.roleId) liveOfRole++
  }
  return { started, liveOfRole }
}

/** A cap value only when it is a positive whole number (the stores already drop anything else; this keeps a stray value from refusing everything). */
function capOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined
}

/**
 * The refusal text when starting one more agent of `roleId` would pass Project.maxAgentsPerRun or the role's
 * maxConcurrent, else undefined. The total is checked first (it never frees up; a per-role cap does when a report ends).
 */
export function spawnCapRefusal(input: SpawnCapInput): string | undefined {
  const total = capOf(input.project.maxAgentsPerRun)
  const role = input.roles.find((r) => r.id === input.roleId)
  const perRole = capOf(role?.maxConcurrent)
  if (total === undefined && perRole === undefined) return undefined
  const { started, liveOfRole } = spawnCapCounts(input)
  if (total !== undefined && started >= total) {
    return `Agent limit reached (this run may start ${total} agent${total === 1 ? '' : 's'} in total and ${started} ${started === 1 ? 'has' : 'have'} started). Do the remaining work yourself or hand it back to your lead; no more agents can start in this run.`
  }
  if (perRole !== undefined && role && liveOfRole >= perRole) {
    return `Concurrent limit for ${role.slug} reached (${perRole} running at once). Wait for one to finish (its result arrives as a message), then spawn again, or give the work to another role.`
  }
  return undefined
}

/** What is left of the caps once one more agent of `roleId` has started (for the session that agent runs). */
export interface SpawnAllowance {
  /** Agents the run may still start after this one; undefined when the project has no total cap. 0 means none. */
  agentsLeft?: number
  /** Per role with a Role.maxConcurrent cap: live agents of it that may still start (0 means none). Roles without a cap are absent. */
  roleLeft: Map<string, number>
}

/**
 * The remaining allowance after the agent being started now (the caller has already passed spawnCapRefusal, and this
 * agent is not in `agents` or `pending` yet). A bridged child gets this instead of the full caps (bridge.ts), so it cannot
 * start more agents than the run has left or more of a capped role than are free. Pure.
 */
export function spawnAllowanceAfter(input: SpawnCapInput): SpawnAllowance {
  const agents = [...input.agents]
  const pending = [...(input.pending ?? [])]
  const total = capOf(input.project.maxAgentsPerRun)
  const out: SpawnAllowance = { roleLeft: new Map() }
  if (total !== undefined) out.agentsLeft = Math.max(0, total - spawnCapCounts({ roleId: input.roleId, agents, pending }).started - 1)
  for (const r of input.roles) {
    const cap = capOf(r.maxConcurrent)
    if (cap === undefined) continue
    const live = spawnCapCounts({ roleId: r.id, agents, pending }).liveOfRole + (r.id === input.roleId ? 1 : 0)
    out.roleLeft.set(r.id, Math.max(0, cap - live))
  }
  return out
}

/** AgentInstance.brief for a spawn: the delegation text the parent wrote, cut to AGENT_BRIEF_MAX_CHARS; undefined when there is none. */
export function agentBriefOf(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (!t) return undefined
  return t.length > AGENT_BRIEF_MAX_CHARS ? t.slice(0, AGENT_BRIEF_MAX_CHARS) : t
}
