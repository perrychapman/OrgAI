import type { ProjectPathCheck, RepoClonePhase, RepoCloneProgress, RepoCloneFork, RepoCloneMode, RepoConfigEffect, RepoSourceParse, RepoTools, SetupKind } from '@shared/types'
import { REPO_CLONE_CANCELLED_PREFIX, REPO_CONFIG_PATHS, REPO_DESTINATION_MAX_CHARS } from '@shared/types'
import { isFullPath } from './projectsForm'

/**
 * Pure logic of the New project form's "From GitHub" start (components/dashboard/RepoStartPanel). The URL git receives
 * is never built here: main parses `source` again and these helpers only decide what the form says and allows.
 */

/** The code project segments. 'github' creates the project like 'existing', once the clone exists. */
export type StartKind = SetupKind | 'github'

/** What the From GitHub panel holds while the form is open. Session memory only; the source may be sensitive. */
export interface RepoFields {
  source: string
  mode: RepoCloneMode
  /** "Save in". */
  parent: string
  /** Folder name under the parent. */
  folder: string
  /** The user typed a folder name, so a new source no longer replaces it. */
  folderEdited: boolean
}

export function emptyRepoFields(parent = ''): RepoFields {
  return { source: '', mode: 'clone', parent, folder: '', folderEdited: false }
}

export const LAST_CLONE_PARENT_KEY = 'orgai.lastCloneParent'

type ParentStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ParentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The folder the last clone was saved in, or '' (first time, junk, storage unavailable). */
export function readLastCloneParent(storage: ParentStorage | null = defaultStorage()): string {
  try {
    const v = storage?.getItem(LAST_CLONE_PARENT_KEY)
    return typeof v === 'string' && v.length <= REPO_DESTINATION_MAX_CHARS && isFullPath(v) ? v : ''
  } catch {
    return ''
  }
}

export function writeLastCloneParent(parent: string, storage: ParentStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAST_CLONE_PARENT_KEY, parent.trim())
  } catch {
    /* remembering is a convenience */
  }
}

/** `<parent><separator><folder>`, in the parent's own separator style. */
export function joinDestination(parent: string, folder: string): string {
  const p = parent.trim()
  const name = folder.trim()
  if (!p) return name
  const sep = /^[a-zA-Z]:|\\/.test(p) ? '\\' : '/'
  // A root keeps its separator ("C:\", "/"); anything else loses a trailing one.
  const base = /^([a-zA-Z]:[\\/]?|[\\/]+)$/.test(p) ? p.replace(/[\\/]*$/, '') : p.replace(/[\\/]+$/, '')
  return `${base}${sep}${name}`
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/** Why this folder name cannot be used, or null. Main checks the whole path again. */
export function folderNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the folder a name.'
  if (/[\\/]/.test(n)) return 'Use one folder name here, without slashes. Put the rest of the path in "Save in".'
  if (n === '.' || n === '..') return 'Give the folder a real name.'
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return 'A folder name cannot hold these characters: < > : " | ? *'
  if (/[. ]$/.test(n)) return 'A folder name cannot end with a dot or a space.'
  if (WINDOWS_RESERVED.test(n.split('.')[0].trimEnd())) return 'Windows keeps that name for itself. Choose another folder name.'
  return null
}

/** The folder the clone would go into, or null while parent or name cannot make one. */
export function cloneTarget(fields: Pick<RepoFields, 'parent' | 'folder'>): string | null {
  if (!fields.parent.trim() || !isFullPath(fields.parent) || folderNameProblem(fields.folder)) return null
  const target = joinDestination(fields.parent, fields.folder)
  return target.length <= REPO_DESTINATION_MAX_CHARS ? target : null
}

/** Why the "Save in" and folder name fields cannot make a target, or null. */
export function destinationFieldProblem(fields: Pick<RepoFields, 'parent' | 'folder'>): string | null {
  if (!fields.parent.trim()) return null
  if (!isFullPath(fields.parent)) return 'Use a full path in "Save in".'
  if (fields.folder.trim()) {
    const bad = folderNameProblem(fields.folder)
    if (bad) return bad
  }
  if (joinDestination(fields.parent, fields.folder).length > REPO_DESTINATION_MAX_CHARS) return 'That folder path is too long.'
  return null
}

/** What checkPath says against this target, or null when a clone can go there. */
export function targetProblem(check: ProjectPathCheck | null): string | null {
  if (!check || !check.exists) return null
  if (!check.isDirectory) return 'That path is a file, not a folder.'
  if (!check.empty) return 'That folder is not empty. Choose an empty or new folder.'
  return null
}

export interface ForkView {
  /** The fork radio can be chosen. */
  available: boolean
  /** Why not, or a sentence worth saying while it can (a check that could not finish). */
  reason: string | null
  /** Offer "Check again". */
  canRecheck: boolean
  /** The command to copy. */
  command: string | null
}

/** Whether a fork can be chosen. `parse` null means the address is empty or being checked. */
export function forkAvailability(tools: RepoTools | null, parse: RepoSourceParse | null): ForkView {
  if (parse?.ok && !parse.canFork) return { available: false, reason: 'Forking works for github.com repositories only.', canRecheck: false, command: null }
  if (!tools) return { available: false, reason: 'Checking your GitHub CLI sign-in.', canRecheck: false, command: null }
  if (!tools.gh.available) return { available: false, reason: tools.gh.detail ?? 'Install the GitHub CLI from cli.github.com to fork a repository.', canRecheck: true, command: null }
  if (!tools.gh.loggedIn) return { available: false, reason: tools.gh.detail ?? 'Run gh auth login to sign in to the GitHub CLI.', canRecheck: true, command: 'gh auth login' }
  return { available: true, reason: tools.gh.detail ?? null, canRecheck: Boolean(tools.gh.detail), command: null }
}

/** The action that will really run: a fork that cannot be chosen is never what the button does. */
export function effectiveMode(mode: RepoCloneMode, fork: ForkView): RepoCloneMode {
  return mode === 'fork' && fork.available ? 'fork' : 'clone'
}

export function cloneActionLabel(mode: RepoCloneMode): string {
  return mode === 'fork' ? 'Fork and clone' : 'Clone'
}

/** The text that stands in for a confirmation before a fork. */
export function forkPreview(tools: RepoTools | null, parse: RepoSourceParse | null): string[] {
  const login = tools?.gh.login
  const lines: string[] = []
  lines.push(login ? `Signed in to the GitHub CLI as ${login}.` : 'Signed in to the GitHub CLI.')
  if (parse?.ok) lines.push(login ? `Creates github.com/${login}/${parse.repo}.` : `Creates a fork of ${parse.repo} on your GitHub account.`)
  lines.push('A fork of a public repository is public.')
  lines.push('The clone points at your fork, with the original as the upstream remote.')
  return lines
}

export const GIT_MISSING_REASON = 'Git is not installed. Install it from git-scm.com, then check again.'

/** Why the Clone button is inert, or null. `parse` null means the address has not been answered yet. */
export function cloneBlocker(input: { fields: RepoFields; parse: RepoSourceParse | null; tools: RepoTools | null; check: ProjectPathCheck | null; existingProjectName?: string }): string | null {
  const { fields, parse, tools, check } = input
  if (tools && !tools.git.available) return GIT_MISSING_REASON
  if (!fields.source.trim()) return 'Paste a repository address or owner/repo.'
  if (!parse) return 'Checking the address.'
  if (!parse.ok) return parse.problem
  if (!fields.parent.trim()) return 'Choose where to save it.'
  const fieldProblem = destinationFieldProblem(fields)
  if (fieldProblem) return fieldProblem
  if (!fields.folder.trim()) return 'Give the folder a name.'
  if (input.existingProjectName) return `This folder is already a project: ${input.existingProjectName}.`
  if (!check) return 'Checking the folder.'
  return targetProblem(check)
}

const PHASE_LABEL: Record<RepoClonePhase, string> = {
  forking: 'Creating the fork on GitHub',
  'waiting-for-fork': 'Waiting for GitHub to finish the fork',
  cloning: 'Cloning',
  finishing: 'Finishing'
}

/** The visible progress line. */
export function progressLine(p: Pick<RepoCloneProgress, 'phase' | 'percent' | 'text'> | null): string {
  if (!p) return 'Starting'
  const label = p.text ?? PHASE_LABEL[p.phase]
  return p.percent !== undefined ? `${label}, ${p.percent}%` : label
}

export interface ProgressAnnouncer {
  phase: RepoClonePhase | null
  /** The highest quarter already said in this phase. */
  quarter: number
}

export const FRESH_ANNOUNCER: ProgressAnnouncer = { phase: null, quarter: 0 }

/**
 * What a screen reader should hear for this event, if anything: each phase once, then each 25% of the cloning phase.
 * Never every percent, and never a per-tick label such as "Receiving files".
 */
export function nextAnnouncement(prev: ProgressAnnouncer, event: Pick<RepoCloneProgress, 'phase' | 'percent'>): { text: string | null; state: ProgressAnnouncer } {
  const quarter = event.percent !== undefined ? Math.floor(Math.min(event.percent, 99) / 25) : 0
  if (event.phase !== prev.phase) return { text: PHASE_LABEL[event.phase], state: { phase: event.phase, quarter } }
  if (quarter > prev.quarter) return { text: `${PHASE_LABEL[event.phase]}, ${quarter * 25}%`, state: { phase: event.phase, quarter } }
  return { text: null, state: prev }
}

export function isCancelledMessage(message: string): boolean {
  return message.startsWith(REPO_CLONE_CANCELLED_PREFIX)
}

/** The note after a stopped clone. Main adds the fork's fate after its prefix when there was a fork. */
export function cancelledNotice(message: string): string {
  const rest = message.slice(REPO_CLONE_CANCELLED_PREFIX.length).trim()
  const stopped = 'Clone stopped. OrgAI removed what it had written.'
  return rest ? `${stopped} ${rest}` : stopped
}

const DESTINATION_REFUSAL =
  /^(That folder|That path|Choose a folder|Use the full path|A part of that folder path|Part of that path|OrgAI could not (check|read) that folder|A clone into that folder)/

/**
 * True for a refusal about the destination, which the form shows in that field. Main's contract has no error kinds, so
 * this reads the sentences of repoClone.ts checkDestination; a sentence this misses still shows, under the button.
 */
export function isDestinationRefusal(message: string): boolean {
  return DESTINATION_REFUSAL.test(message)
}

export const CLONE_KEPT_NOTE = 'Closing this form keeps the folder and creates no project.'

/** Fork facts after a clone, in the order they are shown. */
export function forkResultLines(fork: RepoCloneFork): { text: string; warn?: boolean }[] {
  const lines: { text: string; warn?: boolean }[] = [
    { text: fork.alreadyExisted ? `GitHub returned the fork you already had: github.com/${fork.fullName}.` : `Forked to github.com/${fork.fullName}.` }
  ]
  lines.push(
    fork.upstreamAdded
      ? { text: 'The clone points at your fork, with the original as the upstream remote.' }
      : { text: 'The clone points at your fork. OrgAI could not add the original as the upstream remote; the clone is still good.', warn: true }
  )
  return lines
}

const EFFECT_OF = new Map<string, RepoConfigEffect>(REPO_CONFIG_PATHS.map((c) => [c.path, c.effect]))

/** What the clone ships, most capable first. A path main knows and this build does not counts as 'tools'. */
export function repoConfigGroups(list: readonly string[]): Record<RepoConfigEffect, string[]> {
  const groups: Record<RepoConfigEffect, string[]> = { 'runs-commands': [], tools: [], instructions: [] }
  for (const path of list) groups[EFFECT_OF.get(path) ?? 'tools'].push(path)
  return groups
}

const GATE_NOTE = "Agents won't use these settings until you allow them in the project's Settings."
const NESTED_NOTE ='CLAUDE.md files in subfolders are not listed.'

/**
 * The quiet lines about what the repository ships. When any is listed, one more line says agents do not use them until
 * the user allows them (the folder config trust gate: Project settings > Permissions).
 */
export function repoConfigLines(list: readonly string[]): string[] {
  if (list.length === 0) return [`No agent settings or instruction files at the top of this repository. ${NESTED_NOTE}`]
  const g = repoConfigGroups(list)
  const lines: string[] = []
  if (g['runs-commands'].length) lines.push(`Can run commands or change what agents may do: ${g['runs-commands'].join(', ')}`)
  if (g.tools.length) lines.push(`Can add tools, agents or skills: ${g.tools.join(', ')}`)
  if (g.instructions.length) lines.push(`Instructions agents read: ${g.instructions.join(', ')}`)
  lines.push(GATE_NOTE, NESTED_NOTE)
  return lines
}

/**
 * What the Existing code folder field offers when its text names a repository. `replacesError` says the "full path"
 * error reads wrong under it: a URL could never be a path, while "src/app" may really be a relative path.
 */
export function repoBridge(text: string, parse: RepoSourceParse | null): { line: string; replacesError: boolean } | null {
  const t = text.trim()
  if (!t || isFullPath(t) || !parse?.ok) return null
  const addressLike = /:\/\//.test(t) || /^[^\s/@]+@/.test(t)
  return addressLike
    ? { line: 'This is a repository address, not a folder on this computer.', replacesError: true }
    : { line: `If you meant the repository ${parse.display}, OrgAI can clone it.`, replacesError: false }
}

/** The polite announcement once the setup choice is known or has changed shape, or null to stay quiet. */
export function setupChoiceAnnouncement(input: { found: string | null; hasAgents: boolean; hadAgents: boolean | null; afterClone: boolean }): string | null {
  // Before any answer the form shows the plain choice, the same as a folder with no agents.
  const changed = (input.hadAgents ?? false) !== input.hasAgents
  if (!changed && !input.afterClone) return null
  const lead = input.afterClone ? 'Cloned. ' : ''
  const found = input.found ? `${input.found} ` : ''
  if (input.hasAgents || input.afterClone) return `${lead}${found}Choose how the team starts.`
  return 'The team start options changed.'
}
