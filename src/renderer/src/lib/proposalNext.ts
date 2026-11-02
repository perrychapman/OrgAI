/**
 * Where to send the user after they approve a Skills or MCP servers proposal: the proposal card is gone once it is
 * resolved, so the pointer lives in the run's metadata line. Pure.
 */
import type { Proposal, ProposalOutcome } from '@shared/types'
import { clampLabel } from './clampLabel'
import { proposalScope } from './mcpProposal'

export type ProposalNextKind = 'skillsLibrary' | 'skillsProject' | 'connectors' | 'mcpProject' | 'mcpSecrets'

export interface ProposalNext {
  kind: ProposalNextKind
  /** The project the run belongs to (used by the project-scope links). */
  projectId: string
  /** 'mcpSecrets' only: the servers still waiting on a secret (untrusted text; clamped when shown). */
  names?: string[]
}

/** The follow-up link for an approved proposal, or null when it has none. */
export function proposalNextFor(proposal: Proposal, projectId: string): ProposalNext | null {
  if (proposal.kind === 'skills') {
    const libraryOnly = proposal.payload.items.length > 0 && proposal.payload.items.every((i) => i.scope === 'library')
    return { kind: libraryOnly ? 'skillsLibrary' : 'skillsProject', projectId }
  }
  if (proposal.kind === 'mcpServers') return { kind: proposalScope(proposal.payload) === 'library' ? 'connectors' : 'mcpProject', projectId }
  return null
}

/**
 * The notice for an approved MCP servers proposal that left servers waiting on a secret, or null. Needs a real project
 * (the link opens Project settings > Tools); a library-scope proposal has none.
 */
export function secretsNextFor(proposal: Proposal, outcome: ProposalOutcome, projectId: string): ProposalNext | null {
  if (proposal.kind !== 'mcpServers' || outcome.behavior !== 'approve') return null
  const names = (outcome.waitingForSecrets ?? []).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
  if (names.length === 0 || proposalScope(proposal.payload) === 'library') return null
  return { kind: 'mcpSecrets', projectId, names }
}

const NAME_MAX = 40
const NAMES_SHOWN = 3

/** The visible sentence of a notice. Server names are plain text, clamped. */
export function proposalNextLead(next: ProposalNext): string {
  if (next.kind !== 'mcpSecrets') return PROPOSAL_NEXT_COPY[next.kind].lead
  const names = (next.names ?? []).map((n) => clampLabel(n, NAME_MAX)).filter(Boolean)
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  const more = names.length > NAMES_SHOWN ? ` and ${names.length - NAMES_SHOWN} more` : ''
  return `${shown}${more} ${names.length === 1 ? 'needs' : 'need'} a secret before ${names.length === 1 ? 'it' : 'they'} can start.`
}

export const PROPOSAL_NEXT_COPY: Record<ProposalNextKind, { lead: string; action: string; testId: string }> = {
  skillsLibrary: { lead: 'Skills saved to your library.', action: 'Open Skill library', testId: 'proposal-next-skills' },
  skillsProject: { lead: 'Skills saved to this project.', action: 'Open the Team catalog', testId: 'proposal-next-project-skills' },
  connectors: { lead: 'Saved to your MCP library.', action: 'Open Connectors', testId: 'proposal-next-connectors' },
  mcpProject: { lead: 'Servers saved to this project.', action: 'Open its connections', testId: 'proposal-next-project-mcp' },
  mcpSecrets: { lead: 'A server needs a secret before it can start.', action: 'Set it in Project settings', testId: 'proposal-next-secrets' }
}
