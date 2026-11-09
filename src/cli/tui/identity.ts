import type { AgentInstance, Role } from '../../shared/types'
import type { Tone } from './types'

export const AGENT_IDENTITY_TONES: readonly Tone[] = ['identity', 'identityCyan', 'identityGreen', 'identityAmber', 'identityPink', 'identityBlue']

/** Configured roles keep the same palette slot in the roster and in every run. */
export function roleIdentityTone(roles: readonly Role[], roleId: string): Tone {
  const index = roles.findIndex(role => role.id === roleId)
  return AGENT_IDENTITY_TONES[Math.max(0, index) % AGENT_IDENTITY_TONES.length]
}

export function agentIdentityTone(roles: readonly Role[], agent: AgentInstance | undefined): Tone {
  if (!agent) return 'identity'
  const role = roles.find(role => role.id === agent.roleId) ?? roles.find(role => role.slug === agent.roleSlug)
  if (role) return roleIdentityTone(roles, role.id)
  if (agent.parentId === null) return 'identity'
  let hash = 0
  for (const char of agent.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return AGENT_IDENTITY_TONES[1 + hash % (AGENT_IDENTITY_TONES.length - 1)]
}
