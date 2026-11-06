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
/** Tooltip of the hidden-characters chip; the user sees a single backslash-u. */
export const HIDDEN_SHOWN_TITLE = 'This text holds characters that cannot be seen. They are shown as \\u codes.'
export const TEAM_FOUND_TITLE = 'This folder already has a team'

/** Why the folder's team cannot be used to create the project, or null when it can. Names files; never quotes them. */
export function teamFoundBlocker(found: Pick<TeamFilesFound, 'digest' | 'omittedChanges' | 'problems'>): string | null {
  if (found.problems.length > 0) {
    const files = [...new Set(found.problems.map((p) => p.file))]
    const named = files.length <= 3 ? joinWords(files) : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
    return `The team files cannot be used until this is fixed in ${named}. Fix or remove the problem, then choose the folder again. Creating is paused so nothing is guessed.`
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

/**
 * The file's change for a server, when main sent one. Never by name alone when names repeat: a change matches when its
 * target equals the server's, or when the name is unique among the servers (`sameName` = how many share it) and among
 * the changes.
 */
export function changeForServer(changes: TeamFileChange[], name: string, target?: string, sameName = 1): TeamFileChange | undefined {
  const byName = changes.filter((c) => c.kind === 'mcp' && c.name === name)
  if (target !== undefined) {
    const exact = byName.find((c) => c.target === target)
    if (exact) return exact
  }
  return byName.length === 1 && sameName === 1 ? byName[0] : undefined
}

/** Changes that need a decision, in the order main sent them (most powerful first). */
export function approvalChanges(found: Pick<TeamFilesFound, 'changes'>): TeamFileChange[] {
  return found.changes.filter((c) => c.needsApproval)
}

/**
 * The change's sentence for a project that does not exist yet. Main words a change against a team in use ("The project
 * brief changed.", "Permission mode changes from not set to default."); here nothing was in use, so these are what the
 * files set, not changes.
 */
export function foundSummary(c: Pick<TeamFileChange, 'kind' | 'summary'>): string {
  if (c.kind !== 'settings') return c.summary
  if (/^The project brief changed\.?$/.test(c.summary)) return 'The files set the project brief.'
  const m = /^(.+?) changes from not set to (.+?)\.?$/.exec(c.summary)
  return m ? `${m[1]} is set to ${m[2]}.` : c.summary
}

/**
 * A reason that more than one approval row carries is said once above the list, not on every row. Returns the repeated
 * reasons (in order of first use); rows then drop them.
 */
export function repeatedReasons(changes: readonly Pick<TeamFileChange, 'reason'>[]): string[] {
  const seen = new Map<string, number>()
  for (const c of changes) if (c.reason) seen.set(c.reason, (seen.get(c.reason) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([r]) => r)
}

/** The settings the files actually set, and how many were left out because they are "not set". */
export function setSettings(settings: readonly { label: string; value: string }[]): { shown: { label: string; value: string }[]; unset: number } {
  const shown = settings.filter((s) => !/^not set$/i.test(s.value.trim()))
  return { shown, unset: settings.length - shown.length }
}

/** True when any text of the found team carries a hidden character (a badge is then shown). */
export function anyHidden(values: (string | undefined)[]): boolean {
  return values.some((v) => hasHidden(v))
}

/** Quiet line about other tools' agent files; they are not part of the team path. */
export const OTHER_TOOLS_LINE = 'Agent files from other tools in this folder are not imported.'
