import type { TeamFileChange, TeamFilesFound } from '@shared/types'
import { hasHidden } from './hiddenChars'
import { elevatedLabels } from './agentImport'

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "4 roles, 2 skills and 1 connected service", leaving out what the folder does not hold. */
export function teamFoundCounts(found: Pick<TeamFilesFound, 'roleCount' | 'roles' | 'skills' | 'mcpServers'>): string {
  const roles = Math.max(found.roleCount, found.roles.length)
  const parts = [count(roles, 'role')]
  if (found.skills.length > 0) parts.push(count(found.skills.length, 'skill'))
  if (found.mcpServers.length > 0) parts.push(count(found.mcpServers.length, 'connected service'))
  return joinWords(parts)
}

/** The heading of the panel. */
export const TEAM_FOUND_TITLE = 'This folder already has a team'

/** Why the folder's team cannot be used to create the project, or null when it can. Names files; never quotes them. */
export function teamFoundBlocker(found: Pick<TeamFilesFound, 'digest' | 'omittedChanges' | 'problems'>): string | null {
  if (found.problems.length > 0) {
    const files = [...new Set(found.problems.map((p) => p.file))]
    const named = files.length <= 3 ? joinWords(files) : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
    return `The team files cannot be used until this is fixed in ${named}. Creating is paused so nothing is guessed.`
  }
  if ((found.omittedChanges ?? 0) > 0) {
    return `The team has ${count(found.omittedChanges ?? 0, 'more change')} than can be shown here, so it cannot be reviewed in full. Creating is paused until the team is smaller.`
  }
  if (!found.digest) return 'The team files could not be read as a whole, so there is nothing safe to create from. Creating is paused.'
  return null
}

/** The one sentence on an existing project that already holds the folder. */
export const TEAM_EXISTING_REASON = "That project already holds this folder's team files, so a second project here would fight it over .orgai/."

/** Polite announcement when the check finds a team. */
export function teamFoundAnnouncement(found: TeamFilesFound, existingName: string | null | undefined, blocker: string | null): string {
  const lead = `${TEAM_FOUND_TITLE}: ${teamFoundCounts(found)}.`
  if (existingName) return `${lead} ${existingName} already holds it. Open it instead.`
  if (blocker) return `${lead} ${blocker}`
  return `${lead} Review it, then create the project.`
}

/** Plain labels for a role's elevated grants (the import wording). */
export function roleElevated(elevated: string[]): string[] {
  return elevatedLabels(elevated)
}

/** The file's change for a server, when main sent one. */
export function changeForServer(changes: TeamFileChange[], name: string): TeamFileChange | undefined {
  return changes.find((c) => c.kind === 'mcp' && c.name === name)
}

/** Changes that need a decision, in the order main sent them (most powerful first). */
export function approvalChanges(found: Pick<TeamFilesFound, 'changes'>): TeamFileChange[] {
  return found.changes.filter((c) => c.needsApproval)
}

/** True when any text of the found team carries a hidden character (a badge is then shown). */
export function anyHidden(values: (string | undefined)[]): boolean {
  return values.some((v) => hasHidden(v))
}

/** Quiet line about other tools' agent files; they are not part of the team path. */
export const OTHER_TOOLS_LINE = 'Agent files from other tools in this folder are not imported.'
