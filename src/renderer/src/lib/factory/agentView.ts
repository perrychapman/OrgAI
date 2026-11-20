// What the Factory Floor shows of an agent or a role (docs/design/factory-floor.md sections 1.3, 1.4 and 4.4). Pure.
// Slice 2 has the team half (`factoryRole`) and the static lamp rule; the live mapping (`factoryAgentInput`) still lives
// in views/LiveRunView.tsx and moves here with slice 3's `factoryAgent` and `model.ts`.
import type { AgentState } from '@shared/types'
import type { StatusWord } from '../runStatus'
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
