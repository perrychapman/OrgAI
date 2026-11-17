import type { McpServerSpec, ProjectKind, Proposal, Role, RunSummary } from '@shared/types'
import { appSettingsSummary, projectSettingRows, projectSettingsSummary } from './appSettingsCard'
import { diffOrgChart } from './orgDiff'
import { diffMcpProposal, mcpRowVerb, mcpServerHidden } from './mcpProposal'
import { hasHidden } from './hiddenChars'
import { diffSkillsProposal, skillRowVerb, type SkillCurrent } from './skillProposal'
import { oneLine } from './decisionTitle'
import { schedulesFoldVerbs } from '@shared/view/schedules'

/** What the summary and the cards compare a proposal against. */
export interface ProposalContext {
  roles: readonly Role[]
  /** The project's (or, in library scope, the library's) servers; null when unknown. */
  mcpServers: readonly McpServerSpec[] | null
  skills: SkillCurrent
  /** The kind of the project a target 'settings' proposal changes (its wording differs for engagements). */
  projectKind?: ProjectKind
  /** A stored schedule's name by id (schedules proposals); unknown ids read "a schedule". */
  scheduleNames?: (id: string) => string | undefined
}

/** Starts the fold summary of a proposal whose names or commands hold hidden characters. */
export const HIDDEN_PREFIX = 'hidden characters: '

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
      const hidden = proposal.payload.upsert.some((s) => mcpServerHidden(s))
      return verbs.length > 0 ? `${hidden ? HIDDEN_PREFIX : ''}${foldList(verbs)}` : undefined
    }
    case 'skills': {
      const d = diffSkillsProposal(proposal.payload.items, ctx.skills)
      const verbs = d.rows.map((r) => skillRowVerb(r.item, r.view))
      const hidden = proposal.payload.items.some((i) => hasHidden(i.draft.name))
      return verbs.length > 0 ? `${hidden ? HIDDEN_PREFIX : ''}${foldList(verbs)}` : undefined
    }
    case 'schedules': {
      const verbs = schedulesFoldVerbs(proposal.payload.items, (id) => ctx.scheduleNames?.(id))
      return verbs.length > 0 ? `${hasHidden(verbs.join(' ')) ? HIDDEN_PREFIX : ''}${foldList(verbs)}` : undefined
    }
    case 'orgChart':
      return diffOrgChart(ctx.roles, proposal.payload.roles).summary || undefined
    case 'appSettings':
      return appSettingsSummary(proposal.payload.changes) ?? (oneLine(proposal.title, 120) || undefined)
    case 'settings':
      if (proposal.target) return projectSettingsSummary(projectSettingRows(proposal.payload, ctx.projectKind ?? 'code', undefined), !!proposal.payload.brief, proposal.target.projectName) ?? (oneLine(proposal.title, 120) || undefined)
      return oneLine(proposal.title, 120) || undefined
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
