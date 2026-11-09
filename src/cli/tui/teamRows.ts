import type { AgentInstance, Role } from '../../shared/types'
import { safeLine } from '../output'
import type { OrgTreeRow } from './types'
import { roleIdentityTone } from './identity'

export function roleForAgent(roles: readonly Role[], agent: AgentInstance): Role | undefined {
  return roles.find(role => role.id === agent.roleId) ?? roles.find(role => role.slug === agent.roleSlug)
}

/** Keep one current representative per role; old instances can still fold. */
export function roleRepresentatives(roles: readonly Role[], agents: readonly AgentInstance[]): Map<string, string> {
  const chosen = new Map<string, AgentInstance>()
  const live = (agent: AgentInstance): boolean => agent.state !== 'done' && agent.state !== 'error'
  for (const agent of agents) {
    const role = roleForAgent(roles, agent)
    if (!role) continue
    const previous = chosen.get(role.id)
    if (!previous || (live(agent) && !live(previous)) || (live(agent) === live(previous) && agent.startedAt >= previous.startedAt)) chosen.set(role.id, agent)
  }
  return new Map([...chosen].map(([id, agent]) => [id, agent.id]))
}

/** Fill unoccupied positions in the configured team without creating runtime agents. */
export function withTeamRows(rows: readonly OrgTreeRow[], roles: readonly Role[], agents: readonly AgentInstance[], runId: string): OrgTreeRow[] {
  const out = [...rows]
  const represented = new Map<string, string>()
  for (const [roleId, agentId] of roleRepresentatives(roles, agents)) {
    if (out.some(row => row.id === agentId)) represented.set(roleId, agentId)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const add = (role: Role): void => {
    if (visited.has(role.id) || visiting.has(role.id)) return
    visiting.add(role.id)
    const parentRole = roles.find(parent => parent.id === role.reportsTo)
    if (parentRole) add(parentRole)
    if (!represented.has(role.id)) {
      const parent = out.find(row => row.id === represented.get(role.reportsTo ?? ''))
      const id = `configured-role:${role.id}`
      const row: OrgTreeRow = {
        id, runId, kind: 'role', configuredRoleId: role.id, identityTone: roleIdentityTone(roles, role.id),
        depth: parent ? parent.depth + 1 : 0, parentId: parent?.id,
        label: safeLine(role.name), role: safeLine(role.name), roleShown: false,
        state: 'idle', stateWord: 'Available', activity: safeLine(role.description), costText: '', isRoot: false
      }
      let at = parent ? out.indexOf(parent) + 1 : out.length
      if (parent) while (at < out.length && out[at].depth > parent.depth) at++
      out.splice(at, 0, row)
      represented.set(role.id, id)
    }
    visiting.delete(role.id)
    visited.add(role.id)
  }
  roles.forEach(add)
  return out
}
