// What the Factory Floor shows of an agent or a role (docs/design/factory-floor.md sections 1.3, 1.4 and 4.4). Pure.
// The live half (`factoryAgent`, slice 3) and the team half (`factoryRole`), the status word map and the static lamp rule.
import type { AgentInstance, AgentState } from '@shared/types'
import type { StatusWord } from '../runStatus'
import { nodeActivity } from '../agentActivity'
import { agentLabel } from '../agentTree'
import type { FactoryAgentInput, Lamp } from './types'

/** Section 1.3: the status word per agent state, the mapping the other per-agent views use. */
export const FACTORY_STATUS_WORD: Record<AgentState, StatusWord> = {
  starting: 'Running',
  thinking: 'Running',
  tool: 'Running',
  delegating: 'Running',
  waiting: 'Needs you',
  idle: 'Idle',
  done: 'Finished',
  error: 'Failed'
}

export interface FactoryAgentOptions {
  /** 'earlier' for agents of an earlier session of a chain (listed in Find a worker, never on the floor). */
  session: 'current' | 'earlier'
}

/**
 * Live mode (sections 1.3 and 10.1): one run agent as the floor takes it, with the same name, word and activity line the
 * graph nodes show. A worktree without a merge target merges into the main checkout.
 */
export function factoryAgent(agent: AgentInstance, opts: FactoryAgentOptions): FactoryAgentInput {
  return {
    id: agent.id,
    name: agentLabel(agent),
    parentId: agent.parentId,
    roleKey: agent.roleSlug,
    ...(agent.handle ? { handle: agent.handle } : {}),
    state: agent.state,
    statusWord: FACTORY_STATUS_WORD[agent.state] ?? 'Idle',
    activity: nodeActivity(agent, { isRoot: agent.parentId === null }),
    toolCalls: agent.usage?.toolCalls ?? 0,
    ...(agent.worktree ? { worktree: { status: agent.worktree.status, mergeTarget: agent.worktree.mergeTarget ?? 'main' } } : {}),
    startedAt: agent.startedAt,
    session: opts.session
  }
}

/** The fields of an org-chart role the floor needs. */
export interface FactoryRoleSource {
  id: string
  name: string
  reportsTo: string | null
}

/**
 * Team mode (section 6.6): one role as a floor worker. `index` is the role's position in `project.roles` and stands in
 * for the start time, so the earliest parentless role is the booth and siblings keep their order.
 */
export function factoryRole(role: FactoryRoleSource, index: number): FactoryAgentInput {
  return {
    id: role.id,
    name: role.name,
    parentId: role.reportsTo,
    roleKey: role.id,
    state: 'role',
    statusWord: 'Role',
    activity: '',
    toolCalls: 0,
    startedAt: index,
    session: 'current'
  }
}

const RUNNING: ReadonlySet<string> = new Set(['starting', 'thinking', 'tool', 'delegating'])

/** The static stack-light lamp (sections 1.4, 4.4): Failed, then Needs you (state or an open decision), then Running, else off. Roles have none. */
export function factoryLamp(a: Pick<FactoryAgentInput, 'id' | 'state'>, needsYou: ReadonlySet<string>): Lamp {
  if (a.state === 'role') return 'off'
  if (a.state === 'error') return 'failed'
  if (a.state === 'waiting' || needsYou.has(a.id)) return 'needs-you'
  return RUNNING.has(a.state) ? 'running' : 'off'
}

/** The word shown with a lamp: an open decision makes a running agent "Needs you"; otherwise the agent's own word. */
export function factoryWord(a: Pick<FactoryAgentInput, 'statusWord'>, lamp: Lamp): FactoryAgentInput['statusWord'] {
  return lamp === 'needs-you' && a.statusWord !== 'Role' ? 'Needs you' : a.statusWord
}
