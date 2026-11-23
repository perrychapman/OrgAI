/**
 * Where to send the user after they approve a Skills or MCP servers proposal: the proposal card is gone once it is
 * resolved, so the pointer lives in the run's metadata line. Pure.
 */
import type { Proposal, ProposalOutcome } from '@shared/types'
import { clampLabel } from './clampLabel'
import { showHidden } from './hiddenChars'
import { proposalScope } from './mcpProposal'

export type ProposalNextKind = 'skillsLibrary' | 'skillsProject' | 'connectors' | 'mcpProject' | 'mcpSecrets' | 'orgRoster'

export interface ProposalNext {
  kind: ProposalNextKind
  /** The project the run belongs to (used by the project-scope links). */
  projectId: string
  /** 'mcpSecrets' only: the servers still waiting on a secret (untrusted text; clamped when shown). */
  names?: string[]
  /** 'orgRoster' only: when the run can use the applied roles, and the roles that wait for the next run. */
  roster?: { applied: boolean; when: 'now' | 'after-turn'; deferred: { name: string; reason: string }[] }
}

/**
 * The notice for an approved org chart a running work run took live (ProposalOutcome.roster), or null: nothing applied
 * to the run (the change reaches the next run, which the card already said) or another kind of proposal.
 */
export function rosterNextFor(proposal: Proposal, outcome: ProposalOutcome, projectId: string): ProposalNext | null {
  if (proposal.kind !== 'orgChart' || outcome.behavior !== 'approve' || !outcome.roster) return null
  const r = outcome.roster
  const appliedAny = r.added.length + r.changed.length + r.removed.length > 0
  const deferred = r.deferred.map((d) => ({ name: d.name, reason: d.reason }))
  if (!appliedAny && deferred.length === 0) return null
  // 'next-run' / absent: the session could not take it live, so the run itself got nothing.
  const when = proposal.effect === 'after-turn' ? 'after-turn' : 'now'
  return { kind: 'orgRoster', projectId, roster: { applied: appliedAny, when, deferred } }
}

/**
 * The card's effect line for an org chart a running work run proposed, or null to use the generic one. The effect is an
 * upper bound: roles the run cannot start wait for the next run, and the line says so.
 */
export function orgChartEffectCopy(effect: Proposal['effect']): string | null {
  const tail = ' Roles it cannot take wait for the next run. Reports already running keep what they have.'
  if (effect === 'now') return `This run can use the new roles now. Removed roles stop being available immediately.${tail}`
  if (effect === 'after-turn') return `New and changed roles can be used once no agent is working and the session restarts. Removed roles stop being available immediately.${tail}`
  return null
}

/** The visible sentence of an 'orgRoster' notice. */
export function rosterNextLead(roster: NonNullable<ProposalNext['roster']>): string {
  const n = roster.deferred.length
  const wait = n === 0 ? '' : ` ${n === 1 ? '1 role waits' : `${n} roles wait`} for the next run:`
  if (!roster.applied) return `Org chart saved.${wait}`
  const use =
    roster.when === 'after-turn'
      ? 'New and changed roles can be used once no agent is working and the session restarts. Removed roles stop being available immediately.'
      : 'This run can use the new roles now. Removed roles stop being available immediately.'
  return `Org chart saved. ${use}${wait}`
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
  if (next.kind === 'orgRoster' && next.roster) return rosterNextLead(next.roster)
  if (next.kind !== 'mcpSecrets') return PROPOSAL_NEXT_COPY[next.kind].lead
  const names = (next.names ?? []).map((n) => clampLabel(n, NAME_MAX)).filter(Boolean)
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  const more = names.length > NAMES_SHOWN ? ` and ${names.length - NAMES_SHOWN} more` : ''
  return `${shown}${more} ${names.length === 1 ? 'needs' : 'need'} a secret before ${names.length === 1 ? 'it' : 'they'} can start.`
}

/**
 * What the frame announcer says (once, politely) when a note appears under the run header: the lead sentence, and for
 * an org chart the roles that wait too. Empty when there is no note. Plain text only: names are clamped and stripped of
 * hidden characters.
 */
export function proposalNextAnnouncement(next: ProposalNext | undefined | null): string {
  if (!next) return ''
  if (next.kind !== 'orgRoster') return proposalNextLead(next)
  return [proposalNextLead(next), ...(next.roster?.deferred ?? []).map((d) => `${clampLabel(showHidden(d.name), 40)}: ${clampLabel(showHidden(d.reason), 200)}`)].join(' ')
}

export const PROPOSAL_NEXT_COPY: Record<ProposalNextKind, { lead: string; action: string; testId: string }> = {
  skillsLibrary: { lead: 'Skills saved to your library.', action: 'Open Skill library', testId: 'proposal-next-skills' },
  skillsProject: { lead: 'Skills saved to this project.', action: 'Open the Team catalog', testId: 'proposal-next-project-skills' },
  connectors: { lead: 'Saved to your MCP library.', action: 'Open Connectors', testId: 'proposal-next-connectors' },
  mcpProject: { lead: 'Servers saved to this project.', action: 'Open its connections', testId: 'proposal-next-project-mcp' },
  mcpSecrets: { lead: 'A server needs a secret before it can start.', action: 'Set it in Project settings', testId: 'proposal-next-secrets' },
  orgRoster: { lead: 'Org chart saved.', action: 'Open the Team tab', testId: 'proposal-next-org-roster' }
}
