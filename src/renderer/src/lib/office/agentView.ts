import type { AgentInstance, AgentState } from '@shared/types'
import type { StatusWord } from '../runStatus'
import { nodeActivity } from '../agentActivity'
import { agentLabel } from '../agentTree'

const STATUS: Record<AgentState, StatusWord> = {
  starting: 'Running', thinking: 'Running', tool: 'Running', delegating: 'Running',
  waiting: 'Needs you', idle: 'Idle', done: 'Finished', error: 'Failed'
}

/** Keep runtime state for poses, and share the graph's truthful outcome/activity text. */
export function officeAgentView(agent: AgentInstance) {
  return {
    id: agent.id, name: agentLabel(agent), status: agent.state, statusLabel: STATUS[agent.state],
    activity: nodeActivity(agent, { isRoot: agent.parentId === null })
  }
}
