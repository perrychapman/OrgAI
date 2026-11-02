import type { McpServerSpec, Proposal, Role, RunSummary } from '@shared/types'
import { diffOrgChart } from './orgDiff'
import { diffMcpProposal, mcpRowVerb } from './mcpProposal'
import { diffSkillsProposal, skillRowVerb, type SkillCurrent } from './skillProposal'
import { oneLine } from './decisionTitle'

/** What the summary and the cards compare a proposal against. */
export interface ProposalContext {
  roles: readonly Role[]
  /** The project's (or, in library scope, the library's) servers; null when unknown. */
  mcpServers: readonly McpServerSpec[] | null
  skills: SkillCurrent
}

/** "a, b, c and 2 more": at most `max` items are named. */
export function foldList(items: readonly string[], max = 3): string {
  if (items.length <= max) return items.join(', ')
  const rest = items.length - max
  return `${items.slice(0, max).join(', ')} and ${rest} more`
}

/**
 * The one line a folded proposal card shows under its title (DecisionCard `summary`): MCP "add github-issues, link
 * mock-fs, remove old-fs", skills "new release-notes, update mock-skill", org chart the diff summary, anything else
 * the clipped title. Undefined when there is nothing to say. Output is plain text for React.
 */
export function proposalFoldSummary(proposal: Proposal, ctx: ProposalContext): string | undefined {
  switch (proposal.kind) {
    case 'mcpServers': {
      const d = diffMcpProposal(proposal.payload, ctx.mcpServers, ctx.roles)
      const verbs = [...d.rows.map(mcpRowVerb), ...d.removals.map((r) => `remove ${r.name}`)]
      return verbs.length > 0 ? foldList(verbs) : undefined
    }
    case 'skills': {
      const d = diffSkillsProposal(proposal.payload.items, ctx.skills)
      const verbs = d.rows.map((r) => skillRowVerb(r.item, r.view))
      return verbs.length > 0 ? foldList(verbs) : undefined
    }
    case 'orgChart':
      return diffOrgChart(ctx.roles, proposal.payload.roles).summary || undefined
    default:
      return oneLine(proposal.title, 120) || undefined
  }
}

/** Who proposed, for "<Proposer> revises and proposes again." */
export function proposerName(summary: Pick<RunSummary, 'kind' | 'quick'> | undefined): string {
  if (!summary) return 'The orchestrator'
  if (summary.kind === 'setup') return 'The Architect'
  if (summary.kind === 'mcp-assist' || summary.kind === 'skill-assist' || summary.quick) return 'The assistant'
  return 'The orchestrator'
}

export function revisePlaceholder(proposer: string): string {
  return `What should change? ${proposer} revises and proposes again.`
}
