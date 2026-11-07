import type { PermissionDecision, QuestionAnswer, RunSummary, UserQuestion } from '@shared/types'
import { baseName, isHiddenCommand, oneLine } from './decisionTitle'
import { hasHidden, showHidden } from './hiddenChars'
import { parentPath, type PermissionLocationKind } from './permissionCopy'

/**
 * The Dashboard's inline answers (docs/design/dashboard-2.md 5.2). Pure. The Dashboard answers Allow once and Deny for
 * permission cards and a single click on a short option for questions. It never offers a wider scope, rule chips or the
 * settings link, whatever the request carries (`suggestions`, `maxScope`, `referenceFolder`).
 */

/** The card's deny text (PermissionCard sends the same). */
export const DENY_MESSAGE = 'The user declined this action. Find another way or ask.'

export const ALLOW_ONCE: PermissionDecision = { behavior: 'allow', scope: 'once' }
export const DENY: PermissionDecision = { behavior: 'deny', message: DENY_MESSAGE }

export const INLINE_COMMAND_MAX_CHARS = 200
export const INLINE_COMMAND_MAX_LINES = 2
export const INLINE_SUMMARY_MAX_CHARS = 200
export const INLINE_OPTION_MIN = 2
export const INLINE_OPTION_MAX = 4
export const INLINE_OPTION_LABEL_MAX = 40

export const LONG_COMMAND_NOTE = 'Long command: open it to review'
export const ANSWER_IN_RUN = 'Answer in the run'
export const REFERENCE_LINE = 'Touches a reference folder (read only)'

const SHELL = new Set(['Bash', 'PowerShell'])
const EDIT = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ = new Set(['Read', 'Glob', 'Grep'])

/** The slice of a permission request these helpers read. */
export interface InlineRequest {
  toolName: string
  input?: unknown
  summary?: string
}

function field(input: unknown, key: string): string | undefined {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** The command of a shell request, or undefined. */
export function commandOf(request: InlineRequest): string | undefined {
  return SHELL.has(request.toolName) ? field(request.input, 'command') : undefined
}

/** The file path a file tool names (file_path, notebook_path, path), or undefined. */
export function filePathOf(request: InlineRequest): string | undefined {
  return field(request.input, 'file_path') ?? field(request.input, 'notebook_path') ?? field(request.input, 'path')
}

/**
 * Where a file tool works must be one of these for inline Allow (the PermissionCard's location kinds): outside the
 * project or a place OrgAI cannot work out is opened in the card, where the location line and full path are shown.
 */
const INLINE_FILE_LOCATIONS: ReadonlySet<PermissionLocationKind> = new Set(['project', 'worktree', 'allowed', 'reference'])

/**
 * Tools other than shells and files that may be allowed inline, with the one input field the row shows whole. Anything
 * else (MCP tools, Agent, unknown tools) only has main's activity summary, which leaves the arguments out, so it is
 * opened in the card (review H3).
 */
const INLINE_OTHER_FIELD: Readonly<Record<string, string>> = { WebFetch: 'url', WebSearch: 'query' }

/** Runs of spaces or a tab can push a command's tail out of view; such a command is reviewed in the card (review M3). */
const PADDED = / {2,}|\t/

/** The field an inline "other" tool shows whole, or undefined when the tool is not offered inline. */
export function otherFieldOf(request: InlineRequest): string | undefined {
  const key = INLINE_OTHER_FIELD[request.toolName]
  return key ? field(request.input, key) : undefined
}

/**
 * True when the row may offer Allow once; what it approves is shown whole on the row (review H1-H3).
 * - Shell: no hidden characters, one step per line as the card reads it, at most 2 non-empty lines and 200
 *   characters, no runs of spaces or tabs.
 * - File tools: a path without hidden characters whose location (`permissionLocation` kind) is the project, a worktree,
 *   an allowed folder or a reference folder; `location` undefined or null (no project, unclear) is never inline.
 * - WebFetch / WebSearch: the URL or query, at most 200 characters, no hidden characters. Every other tool: never.
 */
export function inlineAllowable(request: InlineRequest, location?: PermissionLocationKind | null): boolean {
  if (SHELL.has(request.toolName)) {
    const command = commandOf(request)
    if (!command) return false
    if (hasHidden(command) || isHiddenCommand(request.toolName, request.input) || PADDED.test(command)) return false
    const lines = command.split(/\r?\n/).filter((l) => l.trim())
    return lines.length <= INLINE_COMMAND_MAX_LINES && command.length <= INLINE_COMMAND_MAX_CHARS
  }
  if (EDIT.has(request.toolName) || request.toolName === 'Write' || READ.has(request.toolName)) {
    const path = filePathOf(request)
    // Main refuses edits in a reference folder before any allow path, so only reads get a button there.
    const where = !!location && INLINE_FILE_LOCATIONS.has(location) && (location !== 'reference' || READ.has(request.toolName))
    return !!path && !hasHidden(path) && path.length <= INLINE_SUMMARY_MAX_CHARS && where
  }
  const value = otherFieldOf(request)
  return !!value && value.length <= INLINE_SUMMARY_MAX_CHARS && !hasHidden(value) && !/[\r\n]/.test(value)
}

/**
 * True when a question can be answered by one click: single choice, 2 to 4 options, every label at most 40 characters,
 * no description, no hidden characters. Free text is left to the card.
 */
export function inlineOptions(question: Pick<UserQuestion, 'options' | 'allowMultiple'>): boolean {
  const options = question.options ?? []
  if (question.allowMultiple) return false
  if (options.length < INLINE_OPTION_MIN || options.length > INLINE_OPTION_MAX) return false
  const labels = new Set<string>()
  for (const o of options) {
    if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > INLINE_OPTION_LABEL_MAX || hasHidden(o.label)) return false
    if (o.description && o.description.trim()) return false
    labels.add(o.label)
  }
  return labels.size === options.length
}

export type InlineMode = 'allow' | 'options' | 'none'

/** The row's `data-inline` for a permission request. */
export function permissionInlineMode(request: InlineRequest, location?: PermissionLocationKind | null): InlineMode {
  return inlineAllowable(request, location) ? 'allow' : 'none'
}

/** The row's `data-inline` for a question. */
export function questionInlineMode(question: Pick<UserQuestion, 'options' | 'allowMultiple'>): InlineMode {
  return inlineOptions(question) ? 'options' : 'none'
}

/** What an answer sends for each button. */
export function optionAnswer(label: string): QuestionAnswer {
  return { selected: [label] }
}

/** Verb of "{agent} wants to {verb}:". */
export function askVerb(toolName: string): string {
  if (SHELL.has(toolName)) return 'run'
  if (EDIT.has(toolName)) return 'edit'
  if (toolName === 'Write') return 'write'
  if (READ.has(toolName)) return 'read'
  return `use ${oneLine(toolName, 40)}`
}

export interface PermissionAsk {
  kind: 'shell' | 'file' | 'other'
  /** "{who} wants to {verb}:" */
  lead: string
  /** Shell: the command (hidden characters written out), whole when inline Allow is offered, else its first line clipped. File: the file name. Other: the summary on one line. */
  object: string
  /** File tools: the folder, in caption. */
  folder?: string
  /** The full path, for a title. */
  full?: string
  /** True when a shell command is too long, hidden or multi-step for inline Allow. */
  long: boolean
  /** The ask as one sentence for accessible names and announcements: "impl-2 wants to run npm test". */
  text: string
}

/**
 * The two-line ask of a permission row (spec 5.1). `who` is the agent's label. When inline Allow is offered (`allowable`)
 * the object is what is approved, whole: the command, the full path, the URL or query; `text` (the buttons' names and
 * the main button's) carries it whole too, never a cut.
 */
export function permissionAsk(request: InlineRequest, who: string, allowable = inlineAllowable(request)): PermissionAsk {
  const name = oneLine(who, 64) || 'An agent'
  const head = `${name} wants to ${askVerb(request.toolName)}`
  const lead = `${head}:`
  const command = commandOf(request)
  if (SHELL.has(request.toolName)) {
    const first = (command ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
    const shown = allowable ? showHidden(command ?? '') : oneLine(showHidden(first), INLINE_COMMAND_MAX_CHARS)
    return { kind: 'shell', lead, object: shown, long: !allowable, text: `${head} ${allowable ? shown.replace(/\r?\n/g, ' ; ') : oneLine(shown, 120)}` }
  }
  const path = filePathOf(request)
  if (path && (EDIT.has(request.toolName) || request.toolName === 'Write' || READ.has(request.toolName))) {
    const clean = showHidden(path)
    const file = baseName(clean)
    const folder = parentPath(clean)
    return { kind: 'file', lead, object: file, folder: folder === '.' ? undefined : folder, full: clean, long: false, text: `${head} ${oneLine(clean, 400)}` }
  }
  const value = otherFieldOf(request)
  const shown = value !== undefined ? showHidden(value) : oneLine(showHidden(request.summary ?? ''), INLINE_SUMMARY_MAX_CHARS)
  return { kind: 'other', lead, object: shown, long: false, text: `${head} ${oneLine(shown, 400)}` }
}

/** A question's text on one line, at most 200 characters. */
export function questionAsk(question: Pick<UserQuestion, 'question'>): string {
  return oneLine(showHidden(question.question), 200)
}

/** The row's decision word for its accessible name. */
export const KIND_WORD: Record<string, string> = {
  permission: 'permission',
  question: 'question',
  rules: 'rules request',
  proposal: 'proposal',
  merge: 'merge review',
  install: 'install request',
  plan: 'plan',
  team: 'team files'
}

/** "Open permission: Billing API, First task, impl-2 wants to run npm test". */
export function openRowName(kind: string, place: string, ask: string): string {
  return `Open ${KIND_WORD[kind] ?? kind}: ${place}${ask ? `, ${ask}` : ''}`
}

/** The decision label without the "Allow: " lead ("Allow: Run npm test" -> "Run npm test"). */
export function askLabel(label: string): string {
  return label.replace(/^(Allow|Question):\s*/, '')
}

export const allowedAnnouncement = (label: string): string => `Allowed once: ${askLabel(label)}.`
export const deniedAnnouncement = (label: string): string => `Denied: ${askLabel(label)}.`
export const answeredAnnouncement = (option: string): string => `Answered ${oneLine(option, 40)}.`
export const sendFailure = (message: string): string => `Could not send the answer: ${message}`

/** The keys of `current` that `seen` does not hold (decision keys are `runId/key` or a team key). */
export function newDecisionKeys(seen: ReadonlySet<string>, current: readonly string[]): string[] {
  return current.filter((k) => !seen.has(k))
}

/** The sentence for new decisions: one names its project and ask, several count. */
export function newDecisionsText(fresh: readonly { project: string; label: string }[]): string | null {
  if (fresh.length === 0) return null
  if (fresh.length === 1) return `New decision in ${oneLine(fresh[0].project, 60)}: ${oneLine(fresh[0].label, 120)}`
  return `${fresh.length} new decisions`
}

/**
 * Recently ended, L5: a run the user ended (End session) in this window's lifetime is left out, the user just did it.
 * `timeOrigin` is `performance.timeOrigin`.
 */
export function hideUserEnded<T extends { run: Pick<RunSummary, 'endedBy' | 'endedAt'> }>(items: readonly T[], timeOrigin: number): T[] {
  return items.filter((it) => !(it.run.endedBy === 'user' && (it.run.endedAt ?? 0) >= timeOrigin))
}

/** The caption of a paused run: "resumes at 14:05 if OrgAI stays open" or "waits for you to continue". */
export function pausedCaption(s: Pick<RunSummary, 'autoResume' | 'pausedUntil'>, locale?: string): string {
  if (s.autoResume && s.pausedUntil) {
    return `resumes at ${new Date(s.pausedUntil).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} if OrgAI stays open`
  }
  return 'waits for you to continue'
}
