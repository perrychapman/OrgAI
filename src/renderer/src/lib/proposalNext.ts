/**
 * Where to send the user after they approve a Skills or MCP servers proposal: the proposal card is gone once it is
 * resolved, so the pointer lives in the run's metadata line. Pure.
 */
import type { Proposal } from '@shared/types'
import { proposalScope } from './mcpProposal'

export type ProposalNextKind = 'skillsLibrary' | 'skillsProject' | 'connectors' | 'mcpProject'

export interface ProposalNext {
  kind: ProposalNextKind
  /** The project the run belongs to (used by the project-scope links). */
  projectId: string
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

export const PROPOSAL_NEXT_COPY: Record<ProposalNextKind, { lead: string; action: string; testId: string }> = {
  skillsLibrary: { lead: 'Skills saved to your library.', action: 'Open Skill library', testId: 'proposal-next-skills' },
  skillsProject: { lead: 'Skills saved to this project.', action: 'Open the Team catalog', testId: 'proposal-next-project-skills' },
  connectors: { lead: 'Saved to your MCP library.', action: 'Open Connectors', testId: 'proposal-next-connectors' },
  mcpProject: { lead: 'Servers saved to this project.', action: 'Open its connections', testId: 'proposal-next-project-mcp' }
}
