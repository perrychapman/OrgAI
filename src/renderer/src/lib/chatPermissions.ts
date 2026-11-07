/**
 * Chat (quick run) wording for permission and install cards, the RunMeta access chip and the Needs-you captions
 * (docs/design/ux-review-chat-permissions.md, "What the ask path should read"). Pure: no IPC, no store. Every path is
 * untrusted (it came through main from the user's folder pick), so it is made visible and one line, and only ever
 * rendered as React text. The generic project wording stays in lib/permissionCopy.ts (shared/view/permissionCopy.ts).
 */
import type { PermissionSuggestion, PermissionRequest, Project, QuickRunInfo, RunSummary } from '@shared/types'
import { QUICK_PROJECT_ID, QUICK_WRITE_TOOLS } from '@shared/types'
import { oneLine } from './decisionTitle'
import { showHidden } from './hiddenChars'
import { abbreviatePath, folderName } from './paths'
import { ruleSubject } from './permissionCopy'
import { locationLabel } from './assistants'

const SHELL = new Set(['Bash', 'PowerShell'])

/** Where a Chat's calls land: the folder's name (full path in `full`) or the scratch area. */
export interface ChatPlace {
  /** "this chat's scratch area" or the folder's name. */
  name: string
  /** The full path for a title attribute; absent for scratch. */
  full?: string
  scratch: boolean
}

/** The place a Chat card names, or null when the request carries no working folder (not a Chat card). */
export function chatPlace(request: Pick<PermissionRequest, 'workingFolder' | 'workingFolderScratch'>): ChatPlace | null {
  if (request.workingFolderScratch) return { name: "this chat's scratch area", scratch: true }
  const folder = typeof request.workingFolder === 'string' ? request.workingFolder.trim() : ''
  if (!folder) return null
  const full = showHidden(folder)
  return { name: oneLine(abbreviatePath(showHidden(folderName(folder)), 48), 60) || oneLine(abbreviatePath(full, 48), 60), full, scratch: false }
}

/** The glance line of a Chat card: "Runs in <folder>" / "Runs in this chat's scratch area". */
export function chatLocationLine(place: ChatPlace): string {
  return `Runs in ${place.name}`
}

/**
 * The read-only start line, only for a request main flagged `quickReadOnly`: edits name what they change, commands
 * where they run. Null otherwise.
 */
export function quickReadOnlyLine(request: Pick<PermissionRequest, 'quickReadOnly' | 'toolName' | 'workingFolder' | 'workingFolderScratch'>): string | null {
  if (request.quickReadOnly !== true) return null
  const place = chatPlace(request)
  const where = place ? (place.scratch ? 'the scratch area' : place.name) : 'its working folder'
  if (SHELL.has(request.toolName)) return `This chat started read-only. Allowing lets it run this command in ${where}.`
  return `This chat started read-only. Allowing lets it change ${where}.`
}

/** True for the quick session edit offer main puts on a Chat edit card (never sent to a provider). */
export function isChatSessionEdit(s: PermissionSuggestion): boolean {
  return s.type === 'setMode' && s.mode === 'acceptEdits' && s.destination === 'session'
}

/** What a card may offer, from main's `maxScope` (absent = 'project' possible). */
export function scopeLimit(request: Pick<PermissionRequest, 'maxScope'>): 'once' | 'session' | 'project' {
  return request.maxScope === 'once' || request.maxScope === 'session' ? request.maxScope : 'project'
}

/**
 * The scope sentences of a card limited to the session (Chat, MCP build session): once, and session with "until you
 * end this chat" on a Chat (`chat` true) or "until you end this session" otherwise. No project sentence, ever.
 */
export function sessionScopeCopy(suggestions: readonly PermissionSuggestion[] | undefined, chat: boolean): { once: string; session?: string } {
  const once = 'Allow once: this call only.'
  const parts: string[] = []
  const rules: string[] = []
  for (const s of suggestions ?? []) {
    if (!s || typeof s !== 'object') continue
    if (isChatSessionEdit(s)) {
      const edits = chat ? EDITS_PART : 'auto-accepts file edits'
      if (!parts.includes(edits)) parts.unshift(edits)
    } else if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow' && Array.isArray(s.rules)) {
      for (const r of s.rules) {
        if (!r || typeof r.toolName !== 'string') continue
        const subject = ruleSubject(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)
        if (!rules.includes(subject)) rules.push(subject)
      }
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
      const dirs = s.directories.filter((d): d is string => typeof d === 'string' && !!d.trim()).map((d) => abbreviatePath(showHidden(d), 48))
      if (dirs.length) parts.push(`allows edits and reads in ${join(dirs)}`)
    }
  }
  if (rules.length) parts.push(`stops asking for ${join(rules)}`)
  if (!parts.length) return { once }
  const until = chat ? 'until you end this chat' : 'until you end this session'
  return { once, session: oneLine(`Allow for session: ${join(parts)} ${until}.`, 400) }
}

const EDITS_PART = "stops asking for edits in this chat's folder"

function join(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The lead of the rule chips on a session-limited card ("Allow for session covers:"). */
export const SESSION_CHIPS_LABEL = 'What Allow for session approves'

// ---------- MCP install card, run only ----------

export const RUN_ONLY_INSTALL_LINE = 'For this chat only. It is not added to your library.'
export const RUN_ONLY_APPROVE = 'Add for this chat'
export const RUN_ONLY_DENY = "Don't add"
/** "Add a server: <name>". */
export function runOnlyInstallTitle(name: string): string {
  return oneLine(`Add a server: ${showHidden(name)}`, 120)
}
/** The resolved line of a run-only install card. */
export function runOnlyOutcome(approved: boolean): string {
  return approved ? 'Added for this chat' : 'Not added'
}

// ---------- RunMeta access chip ----------

export type ChatAccessState = 'asks' | 'edits' | 'session'

/**
 * The chip state of a Chat run: 'session' once the user allowed a change or command for the session in this run,
 * else 'edits' when the chat started with edits allowed, else 'asks'.
 */
export function chatAccessState(quick: Pick<QuickRunInfo, 'allowEdits'>, sessionChanges: boolean): ChatAccessState {
  if (sessionChanges) return 'session'
  return quick.allowEdits ? 'edits' : 'asks'
}

export const CHAT_ACCESS_LABEL: Record<ChatAccessState, string> = {
  asks: 'asks first',
  edits: 'edits allowed',
  session: 'changes allowed this session'
}

export const CHAT_ACCESS_TITLE: Record<ChatAccessState, string> = {
  asks: 'This chat asks before it changes files or runs commands.',
  edits: 'You let this chat make changes. It still asks before each edit and command.',
  session: 'You allowed changes for the rest of this chat. Other edits and commands still ask.'
}

/** Announced once when the chip turns to 'session'. */
export const CHAT_ACCESS_ANNOUNCEMENT = 'Changes allowed for the rest of this chat.'

/** Whether a resolved allow on this request counts as "changes allowed this session": a session allow of a write or command tool. */
export function countsAsSessionChange(toolName: string | undefined, scope: string | undefined): boolean {
  return (scope === 'session' || scope === 'project') && !!toolName && QUICK_WRITE_TOOLS.includes(toolName)
}

// ---------- Needs-you captions ----------

/**
 * Where a decision lives, for the Needs-you rows and the bell: "Chat, scratch" / "Chat, <folder>" for a Chat that is
 * still in the Chat project, else the usual location label.
 */
export function decisionLocationLabel(summary: Pick<RunSummary, 'projectId' | 'quick'>, projects: readonly Pick<Project, 'id' | 'name'>[]): string {
  if (summary.projectId === QUICK_PROJECT_ID && summary.quick) {
    const where = summary.quick.scratch ? 'scratch' : oneLine(showHidden(folderName(summary.quick.folder)), 40)
    return `Chat, ${where || 'scratch'}`
  }
  return locationLabel(summary.projectId, projects)
}

// ---------- Start page ----------

export const CHAT_ASKS_LINE = 'It asks before it changes anything.'
export const CHAT_CHANGES_SWITCH = 'Let it make changes'
/** The hint under the switch. */
export function chatChangesHint(scratch: boolean, folder?: string): string {
  if (scratch || !folder) return 'Changes happen in a private scratch folder. You approve each one.'
  return oneLine(`Changes happen in ${showHidden(folder)}. You approve each one.`, 160)
}
/** Save as project: grants never carry over. */
export const SAVE_AS_PROJECT_PERMISSIONS_NOTE = 'Permissions you gave this chat do not carry over.'
