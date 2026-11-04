/**
 * Plain-language copy for permission cards and the Permissions settings (docs/design/permissions.md). Pure: no IPC,
 * no node:path (the renderer sees Windows and POSIX paths). Every input is untrusted agent or provider text; outputs
 * are flattened to one line and only ever rendered as React text.
 */

import type { PermissionMode, PermissionSuggestion } from '@shared/types'
import { PROJECT_ALLOWED_DIRECTORIES_MAX, PROJECT_ALLOWED_DIRECTORY_MAX_CHARS } from '@shared/types'
import { isCdSegment, oneLine, shellSegments } from './decisionTitle'
import { abbreviatePath } from './paths'
import { PERMISSION_MODE_SHORT } from './settingsCopy'

// ---------- Paths ----------

const WIN_ABS = /^[A-Za-z]:[\\/]/
const UNC = /^[\\/]{2}/

/** True for `C:\x`, `C:/x`, `/x` and `\\server\share`. A bare `C:` or `~` is not absolute. */
export function isAbsolutePath(p: string): boolean {
  return WIN_ABS.test(p) || p.startsWith('/') || UNC.test(p)
}

function isWindowsStyle(p: string): boolean {
  return WIN_ABS.test(p) || /^[A-Za-z]:$/.test(p) || p.includes('\\')
}

/**
 * Forward slashes, no doubled separators, `.` and `..` resolved, no trailing separator (a root keeps its own).
 * `..` never climbs above the root. Relative paths stay relative.
 */
export function normalizePath(p: string): string {
  const raw = p.trim().replace(/\\/g, '/')
  const unc = raw.startsWith('//')
  const drive = /^[A-Za-z]:/.exec(raw)?.[0] ?? ''
  const rest = raw.slice(drive.length)
  const rooted = rest.startsWith('/')
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!rooted) out.push('..')
      continue
    }
    out.push(part)
  }
  const head = unc ? '//' : `${drive}${rooted ? '/' : ''}`
  return `${head}${out.join('/')}` || (drive ? `${drive}` : '.')
}

/** Comparison key: normalized, lower-cased for Windows-style paths (case-insensitive file systems). */
export function pathKey(p: string): string {
  const n = normalizePath(p)
  return isWindowsStyle(p) ? n.toLowerCase() : n
}

/** `child` is `parent` or lies under it (by path text; links are not followed). */
export function isInsidePath(child: string, parent: string): boolean {
  const c = pathKey(child)
  const p = pathKey(parent).replace(/\/$/, '')
  return c === p || c.startsWith(`${p}/`)
}

/** `rel` resolved against `base` (an absolute `rel` is returned normalized). */
export function resolvePath(base: string, rel: string): string {
  return isAbsolutePath(rel) ? normalizePath(rel) : normalizePath(`${base.replace(/[\\/]+$/, '')}/${rel}`)
}

/** The path of `child` below `parent` with forward slashes ('' for the folder itself). Assumes `isInsidePath`. */
export function relativePath(child: string, parent: string): string {
  const c = normalizePath(child)
  const p = normalizePath(parent).replace(/\/$/, '')
  return c.length > p.length ? c.slice(p.length + 1) : ''
}

/** The folder holding a file path. */
export function parentPath(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  if (/^[A-Za-z]:$/.test(n.slice(0, i))) return n.slice(0, i + 1)
  return n.slice(0, i)
}

/** Show a normalized path in the style it was written in (backslashes for Windows-style input). */
function display(p: string, like: string): string {
  return isWindowsStyle(like) ? p.replace(/\//g, '\\') : p
}

// ---------- Where the agent is working ----------

export type PermissionLocationKind = 'project' | 'worktree' | 'allowed' | 'reference' | 'outside' | 'unknown'

export interface PermissionLocation {
  kind: PermissionLocationKind
  /** One line: "In the project", "In worktree agent-a1 (inside the project)", "Outside the project: <folder>". */
  label: string
  /** The file or folder below the place named by the label ("src/server.js"), when there is one. */
  detail?: string
  /** The full folder or file path, for a tooltip. */
  full?: string
  /** True when the user should look twice (outside the project, or a folder OrgAI cannot work out). */
  attention: boolean
}

export interface LocationContext {
  /** The project folder (absolute). */
  projectPath: string
  /** The project's extra allowed folders. */
  allowedDirectories?: readonly string[]
  /** The project's read-only reference folders (engagements). */
  referenceDirectories?: readonly string[]
  /** The agent's own working folder when it differs from the project (its worktree). */
  agentCwd?: string
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WORKTREES = '.claude/worktrees/'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** Invisible characters a path tooltip must not carry (controls, bidi, zero-width, joiners, variation selectors, tags). */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ︀-️﻿ﾠ]|[\u{e0000}-\u{e007f}]/gu

function visible(s: string): string {
  return s.replace(INVISIBLE, '�')
}

/**
 * A path OrgAI must not place by text alone, given the project's path style: a drive-relative Windows path (`C:x`,
 * `C:..\\..`), a rooted-on-current-drive path (`\\x` or `/x`) under a Windows project, or a backslash under a POSIX
 * project (a file name there, not a separator).
 */
function unplaceable(p: string, project: string): boolean {
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return true
  if (isWindowsStyle(project)) return /^[\\/](?![\\/])/.test(p)
  return p.includes('\\') || WIN_ABS.test(p)
}

/** A bare shell word OrgAI accepts as a folder: no options, quotes, expansions, globs, grouping or redirections. */
const BARE_WORD = /^[^\s'"$%~()<>|`;&*?[\]{}!#-][^\s'"$%~()<>|`;&*?[\]{}!#]*$/
const CD_VERB = /^(?:cd|chdir|pushd|set-location|sl)(?=$|[\s\\/.])/i

/**
 * The folder a `cd`-like step moves to, or null when it cannot be worked out exactly: no argument, `-`, `~`, options
 * (`--`, `-P`), variables, globs, more than one word, odd quoting. `cd /d X` (cmd), `cd..` / `cd\` (PowerShell) and
 * `Set-Location -Path X` are understood. Fails closed: anything unusual is "unclear".
 */
function cdTarget(segment: string, project: string): string | null {
  const s = segment.trim()
  const verb = CD_VERB.exec(s)?.[0]
  if (!verb) return null
  let rest = s.slice(verb.length)
  if (/^[\\.]/.test(rest)) {
    // PowerShell's `cd..` / `cd\` functions: the rest is the whole target.
    rest = rest.trim()
  } else {
    rest = rest.replace(/^\s*\/d(?=\s)/i, '').trim()
    if (/^set-location$|^sl$/i.test(verb)) rest = rest.replace(/^-(?:Literal)?Path\s+/i, '')
  }
  if (!rest) return null
  let target: string
  const q = rest[0]
  if (q === '"' || q === "'") {
    if (rest.length < 2 || rest[rest.length - 1] !== q) return null
    target = rest.slice(1, -1)
    if (!target || target.includes(q) || /[$`%]/.test(target) || target.startsWith('-') || target.startsWith('~')) return null
  } else {
    if (!BARE_WORD.test(rest)) return null
    target = rest
  }
  if (target === '\\' || unplaceable(target, project)) return null
  return target
}

/** Steps whose folder change OrgAI cannot follow: a subshell or group, or a nested shell (`bash -c "..."`). */
const NESTED = /^[({]|(?:^|[\s/\\])(?:(?:ba|z|da|k)?sh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:--?[\w-]+\s+)*(?:-l?c|-Command|-EncodedCommand|\/c|\/k)(?:\s|$)|(?:^|\s)eval\s/i

/** Name of the folder an absolute path is in, relative to the project: worktree, project, allowed folder or outside. */
function classify(target: string, isFile: boolean, ctx: LocationContext, shell = false): PermissionLocation {
  const project = ctx.projectPath
  const full = visible(display(normalizePath(target), project))
  // A command can still act on other paths, so a shell location names only where it starts.
  const where = shell ? 'Starts in' : 'In'
  if (isInsidePath(target, project)) {
    const rel = relativePath(target, project)
    if (rel.toLowerCase().startsWith(WORKTREES) || rel.toLowerCase() === WORKTREES.slice(0, -1)) {
      const rest = rel.slice(WORKTREES.length)
      const slash = rest.indexOf('/')
      const name = slash < 0 ? rest : rest.slice(0, slash)
      const inner = slash < 0 ? '' : rest.slice(slash + 1)
      if (name) return { kind: 'worktree', label: oneLine(`${where} worktree ${name} (inside the project)`), detail: inner ? oneLine(inner, 200) : undefined, full, attention: false }
    }
    return { kind: 'project', label: `${where} the project`, detail: rel ? oneLine(rel, 200) : undefined, full, attention: false }
  }
  for (const dir of ctx.referenceDirectories ?? []) {
    if (typeof dir !== 'string' || !dir.trim() || !isInsidePath(target, dir)) continue
    const rel = relativePath(target, dir)
    return {
      kind: 'reference',
      label: oneLine(`${where} a reference folder (read only): ${abbreviatePath(display(normalizePath(dir), dir), 48)}`),
      detail: rel ? oneLine(rel, 200) : undefined,
      full,
      attention: false
    }
  }
  for (const dir of ctx.allowedDirectories ?? []) {
    if (typeof dir !== 'string' || !dir.trim() || !isInsidePath(target, dir)) continue
    const rel = relativePath(target, dir)
    return { kind: 'allowed', label: oneLine(`${where} an allowed folder: ${abbreviatePath(display(normalizePath(dir), dir), 48)}`), detail: rel ? oneLine(rel, 200) : undefined, full, attention: false }
  }
  const folder = isFile ? parentPath(target) : normalizePath(target)
  return {
    kind: 'outside',
    label: oneLine(`${shell ? 'Starts outside' : 'Outside'} the project: ${abbreviatePath(display(folder, project), 48)}`),
    detail: isFile ? oneLine(target.split(/[\\/]/).pop() ?? '', 120) : undefined,
    full,
    attention: true
  }
}

function unclear(why: string): PermissionLocation {
  return { kind: 'unknown', label: oneLine(`Working folder unclear: ${why}`, 160), attention: true }
}

/**
 * Where a tool call works, said plainly. File tools: the file path (relative paths resolve against the agent's folder).
 * Shell tools: the folder after the command's `cd` steps (else the input's `cwd`, else the agent's folder). Other
 * tools: the input's `cwd` when given, else null (no line).
 */
export function permissionLocation(toolName: string, input: unknown, ctx: LocationContext): PermissionLocation | null {
  if (!ctx.projectPath || !isAbsolutePath(ctx.projectPath)) return null
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const project = ctx.projectPath
  const base = ctx.agentCwd && isAbsolutePath(ctx.agentCwd) ? ctx.agentCwd : project
  const cwdInput = str(o.cwd)
  if (cwdInput && unplaceable(cwdInput, project)) return unclear(cwdInput)
  const start = cwdInput ? resolvePath(base, cwdInput) : base
  if (FILE_TOOLS.has(toolName)) {
    const file = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
    if (!file) return null
    if (unplaceable(file, project)) return unclear(file)
    return classify(resolvePath(start, file), true, ctx)
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = str(o.command)
    let cwd = start
    if (command) {
      if (command.split(/\r?\n/).filter((l) => l.trim()).length > 1) return unclear('several lines')
      const steps = shellSegments(command.trim())
      // The folder the last real step runs in: follow every cd before it. Anything OrgAI cannot follow is unclear.
      let lastAction = steps.length - 1
      while (lastAction > 0 && isCdSegment(steps[lastAction])) lastAction--
      for (let i = 0; i <= lastAction; i++) {
        if (NESTED.test(steps[i])) return unclear('nested shell')
        if (i === lastAction || !isCdSegment(steps[i])) continue
        const target = cdTarget(steps[i], project)
        if (target === null) return unclear(steps[i])
        cwd = resolvePath(cwd, target)
      }
    }
    return classify(cwd, false, ctx, true)
  }
  return cwdInput ? classify(start, false, ctx) : null
}

// ---------- What each scope does ----------

const SHELL_RULE = /^(Bash|PowerShell)\((.*)\)$/s

/** The calls one allow rule covers, as a phrase: `"npm test" commands`, `every WebSearch call`, `all tools of github`. */
export function ruleSubject(rule: string): string {
  const r = rule.trim()
  const server = mcpServerOf(r)
  if (server) return oneLine(`every ${server} tool`)
  const shell = SHELL_RULE.exec(r)
  if (shell) {
    const body = shell[2].trim()
    const prefix = shellPrefix(body)
    if (prefix !== null) return prefix ? oneLine(`"${prefix}" commands`) : 'every shell command'
    return oneLine(`the command "${body}"`)
  }
  if (isWholeTool(r)) {
    if (SHELL_TOOLS.has(r)) return 'every shell command'
    return oneLine(`every ${r} call`)
  }
  const m = /^([\w-]+)\((.*)\)$/s.exec(r)
  if (m) return oneLine(`${m[1]} calls matching ${m[2]}`)
  return oneLine(r)
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function dirName(d: string): string {
  return abbreviatePath(display(normalizePath(d), d), 48)
}

export interface ScopeCopy {
  once: string
  /** Absent when the card offers no session or project scope. */
  session?: string
  project?: string
}

/**
 * One sentence per answer, from what the suggestions grant. Session: rules, folders and a mode for the rest of this
 * run. Project: rules saved to the project's rules file, folders added to its allowed folders, and an edit in a project
 * on "Ask for everything risky" switches it to "Auto-accept edits" (PERMISSION_MODE_SHORT).
 */
export function scopeCopy(suggestions: readonly PermissionSuggestion[] | undefined, projectMode?: PermissionMode): ScopeCopy {
  const once = 'Allow once: this call only.'
  const list = (suggestions ?? []).filter((s) => s && typeof s === 'object')
  if (!list.length) return { once }
  const rules: string[] = []
  const dirs: string[] = []
  const modes: string[] = []
  for (const s of list) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow' && Array.isArray(s.rules)) {
      for (const r of s.rules) {
        if (!r || typeof r.toolName !== 'string') continue
        const text = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName
        const subject = ruleSubject(text)
        if (!rules.includes(subject)) rules.push(subject)
      }
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories)) {
      for (const d of s.directories) if (typeof d === 'string' && d.trim() && !dirs.includes(dirName(d))) dirs.push(dirName(d))
    } else if (s.type === 'setMode' && typeof s.mode === 'string' && !modes.includes(s.mode)) modes.push(s.mode)
  }
  const session: string[] = []
  const project: string[] = []
  // The mode change first: it is the broadest effect and must survive the clamp in compact mode.
  for (const mode of modes) {
    if (mode === 'acceptEdits') {
      session.push('auto-accepts file edits')
      // Main switches the project's mode only from "Ask for everything risky"; in other modes the switch is session-only.
      if (projectMode === 'default') project.push(`switches this project to ${PERMISSION_MODE_SHORT.acceptEdits}`)
    } else {
      session.push(oneLine(`uses permission mode ${mode}`, 60))
    }
  }
  if (dirs.length) {
    session.push(`allows edits and reads in ${joinList(dirs)}`)
    project.push(`adds ${joinList(dirs)} to this project's allowed folders`)
  }
  if (rules.length) {
    session.push(`stops asking for ${joinList(rules)}`)
    project.push(`stops asking for ${joinList(rules)} in this project`)
  }
  if (!session.length) return { once }
  return {
    once,
    session: oneLine(`Allow for session: ${joinList(session)} until you end this session.`, 400),
    project: oneLine(`Always allow for project: ${project.length ? joinList(project) : 'the same as Allow for session; nothing is saved for later runs'}.`, 400)
  }
}

/**
 * A card's rule chip: the label from main, whether it approves a whole tool, and whether it is broad (a whole tool or
 * every tool of an MCP server, "All tools of <server>"); broad chips get the attention tone.
 */
export function ruleChip(label: string): { text: string; wholeTool: boolean; broad: boolean } {
  const text = oneLine(label, 200)
  const server = !!mcpServerOf(text) || /^All tools of \S/.test(text)
  const wholeTool = isWholeTool(text) && !server
  return { text, wholeTool, broad: wholeTool || server }
}

/**
 * The glance line for a request main flagged with `referenceFolder` (a shell command that touches a reference folder).
 * Replaces the cwd-based location: the folder is the fact the user needs. The text is untrusted, so it is made visible
 * and one line.
 */
export function referenceLocation(folder: string): PermissionLocation {
  const clean = visible(folder.trim())
  return { kind: 'reference', label: oneLine(`Touches a reference folder (read only): ${abbreviatePath(clean, 48)}`, 160), full: clean, attention: false }
}

/** The effect sentence of a reference-folder request: replaces the scope sentences, since only Allow once is offered. */
export const REFERENCE_EFFECT = 'This command names or runs inside a folder agents may only read. Allow once lets this one command run; nothing is saved.'

/** The line a card without scope buttons shows: why no rule is offered (shell commands only), else null. */
export function noRuleLine(toolName: string, hasSuggestions: boolean): string | null {
  if (hasSuggestions || !SHELL_TOOLS.has(toolName)) return null
  return 'No rule can cover this command (pipes, redirects and $(…) always ask).'
}

/** Saved rules with duplicates collapsed, first-seen order, and how often each appeared. */
export function collapseRules(rules: readonly string[]): { rule: string; count: number }[] {
  const out = new Map<string, number>()
  for (const r of rules) if (typeof r === 'string') out.set(r, (out.get(r) ?? 0) + 1)
  return [...out].map(([rule, count]) => ({ rule, count }))
}

// ---------- Rule grammar (mirror of main's ruleMatch.ts isValidRule) ----------

/** A whole-tool rule: a bare tool name. */
function isWholeTool(rule: string): boolean {
  return /^[A-Za-z_][\w-]*$/.test(rule.trim())
}

/** Server name of `mcp__<server>` / `mcp__<server>__*`, else null. Never the harness's own `orgai` server. */
export function mcpServerOf(rule: string): string | null {
  const m = /^mcp__([A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*)(?:__\*)?$/.exec(rule.trim())
  if (!m) return null
  const name = m[1]
  if (name.endsWith('_') || name.toLowerCase() === 'orgai') return null
  return name
}

/** The prefix of a shell rule body `prefix:*` or `prefix *` ('' for a bare `*` / `:*`), else null (an exact command). */
function shellPrefix(body: string): string | null {
  if (body === '*' || body === ':*') return ''
  if (body.endsWith(':*')) return body.slice(0, -2).trim()
  if (body.endsWith(' *')) return body.slice(0, -2).trim()
  return null
}

export type RuleKind = 'prefix' | 'exact' | 'wholeTool' | 'server' | 'pattern'

export interface RuleInfo {
  kind: RuleKind
  /** Chip text: "command prefix", "exact command", "whole tool", "all tools of <server>", "pattern". */
  label: string
  /** True for forms the harness matches itself, so they take effect in open runs too. */
  live: boolean
  /** One line saying what the rule covers. */
  explain: string
}

/** What a saved rule is. Assumes a rule the grammar accepts; anything else reads as a pattern. */
export function ruleInfo(rule: string): RuleInfo {
  const r = rule.trim()
  const server = mcpServerOf(r)
  if (server) return { kind: 'server', label: oneLine(`all tools of ${server}`, 80), live: true, explain: oneLine(`Every tool of the ${server} server.`) }
  if (isWholeTool(r)) return { kind: 'wholeTool', label: 'whole tool', live: true, explain: oneLine(`Every ${r} call, whatever its input, before any prompt.`) }
  const shell = SHELL_RULE.exec(r)
  if (shell) {
    const body = shell[2].trim()
    const prefix = shellPrefix(body)
    if (prefix !== null) return { kind: 'prefix', label: 'command prefix', live: true, explain: oneLine(`Any command starting with ${prefix}, from any folder; every step of a && command must be covered.`) }
    if (!body.includes('*')) return { kind: 'exact', label: 'exact command', live: true, explain: oneLine(`Exactly ${body}.`) }
  }
  return { kind: 'pattern', label: 'pattern', live: false, explain: 'Applied by the provider when a run starts, not in runs already open.' }
}

/** Tools a whole-tool rule may never approve, with the reason shown under the field. */
const REFUSED_WHOLE: Record<string, string> = {
  Bash: 'A whole-tool Bash rule would approve every shell command. Use a prefix such as Bash(npm test:*).',
  PowerShell: 'A whole-tool PowerShell rule would approve every command. Use a prefix such as PowerShell(npm test:*).',
  Edit: 'A whole-tool Edit rule would approve edits anywhere on this computer. Add the folder under Allowed folders instead.',
  Write: 'A whole-tool Write rule would approve writes anywhere on this computer. Add the folder under Allowed folders instead.',
  MultiEdit: 'A whole-tool MultiEdit rule would approve edits anywhere on this computer. Add the folder under Allowed folders instead.',
  NotebookEdit: 'A whole-tool NotebookEdit rule would approve notebook edits anywhere on this computer. Add the folder under Allowed folders instead.'
}

export const RULE_FORMAT_HINT = 'A rule looks like Tool, Tool(prefix:*), Tool(prefix *), Tool(exact command) or mcp__server.'

/** Shell verbs main's permissionRules.ts treats as destructive: a prefix rule for them gets a warning (not a refusal). */
const DESTRUCTIVE = /^(?:sudo|rm|rmdir|del|erase|rd|format|mkfs|dd|shutdown|reboot|chmod|chown|kill|pkill|killall|curl|wget|git\s+push|git\s+reset|git\s+clean|Remove-Item)(?:\s|$)/i

const FILE_RULE_TOOLS = /^(Edit|Write|Read|MultiEdit|NotebookEdit)\(\/(?!\/)/

export const SINGLE_SLASH_REASON = 'A single leading / is read as relative to the project; write // for an absolute path (e.g. Edit(//Users/me/docs/**)).'

/**
 * Check a typed rule before it is sent. Main checks again (ipc.ts). `warning` flags an accepted rule that is broad or
 * destructive.
 */
export function checkRuleDraft(draft: string): { ok: true; rule: string; info: RuleInfo; warning?: string } | { ok: false; reason: string } {
  const r = draft.trim()
  if (!r) return { ok: false, reason: 'Enter a rule first, for example Bash(npm test:*).' }
  if (/[\n\r]/.test(r)) return { ok: false, reason: 'A rule is one line.' }
  if (r.length > 500) return { ok: false, reason: 'That rule is too long (500 characters at most).' }
  if (/^mcp__orgai(?:__|$)/i.test(r)) return { ok: false, reason: "OrgAI's own tools cannot be allowed by a rule." }
  if (r.startsWith('mcp__') && r.includes('*')) {
    if (!mcpServerOf(r)) return { ok: false, reason: 'Only mcp__<server> or mcp__<server>__* may use a wildcard.' }
    return { ok: true, rule: r, info: ruleInfo(r) }
  }
  if (!/^[A-Za-z_][\w-]*(?:\(.+\))?$/s.test(r)) return { ok: false, reason: RULE_FORMAT_HINT }
  if (REFUSED_WHOLE[r]) return { ok: false, reason: REFUSED_WHOLE[r] }
  if (FILE_RULE_TOOLS.test(r)) return { ok: false, reason: SINGLE_SLASH_REASON }
  const shell = SHELL_RULE.exec(r)
  if (shell) {
    const body = shell[2].trim()
    const prefix = shellPrefix(body)
    if (!body || prefix === '' || (prefix !== null && /^[*:\s]*$/.test(prefix))) {
      return { ok: false, reason: `${shell[1]}(*) would approve every command. Use a prefix such as ${shell[1]}(npm test:*).` }
    }
    const command = prefix ?? body
    if (DESTRUCTIVE.test(command)) return { ok: true, rule: r, info: ruleInfo(r), warning: `Careful: this approves ${oneLine(command, 60)} without asking, which can delete or publish work.` }
  }
  const info = ruleInfo(r)
  if (info.kind === 'server') return { ok: true, rule: r, info, warning: `This approves every tool of ${mcpServerOf(r)}, including any it adds later.` }
  return { ok: true, rule: r, info }
}

// ---------- Permission modes ----------

/** One-line trade-off per mode, for the settings select (renderer copy; types.ts keeps the short labels). */
export const PERMISSION_MODE_TRADEOFF: Record<PermissionMode, string> = {
  auto: "The model's safety check approves routine calls and asks when unsure. Fewest prompts.",
  acceptEdits: 'Edits inside the project and its allowed folders go through; commands still ask unless a rule covers them.',
  default: 'Every edit and command asks. Most prompts.',
  dontAsk: 'Never shows a card: anything a rule does not cover is refused.',
  plan: 'Agents only read and plan; nothing is changed.',
  bypassPermissions: 'Nothing asks, nothing is checked. Only for throwaway folders.'
}

/** Modes in which saved rules and allowed folders do not change what asks. */
export function rulesApplyInMode(mode: PermissionMode): boolean {
  return mode !== 'plan' && mode !== 'bypassPermissions'
}

// ---------- Allowed folders ----------

/** A typed folder's problem before it is sent, or null. Main cleans the list again on save. */
export function allowedFolderDraftProblem(draft: string, existing: readonly string[]): string | null {
  const d = draft.trim()
  if (!d) return 'Enter a folder path first.'
  if (d.length > PROJECT_ALLOWED_DIRECTORY_MAX_CHARS) return `That path is too long (${PROJECT_ALLOWED_DIRECTORY_MAX_CHARS} characters at most).`
  if (existing.some((e) => pathKey(e) === pathKey(d))) return 'That folder is already listed.'
  if (existing.length >= PROJECT_ALLOWED_DIRECTORIES_MAX) return `A project can list at most ${PROJECT_ALLOWED_DIRECTORIES_MAX} folders.`
  return null
}

/** Folders that were sent but are not in the saved list (main dropped them). A duplicate of a kept folder is not dropped. */
export function droppedFolders(sent: readonly string[], saved: readonly string[] | undefined): string[] {
  const keep = new Set((saved ?? []).map(pathKey))
  const out: string[] = []
  for (const s of sent) {
    if (typeof s !== 'string' || !s.trim()) continue
    if (!keep.has(pathKey(s)) && !out.includes(s.trim())) out.push(s.trim())
  }
  return out
}

/** The notice for a folder main did not save. */
export function droppedFolderNotice(path: string): string {
  return `${oneLine(path, 200)} was not saved: must be an absolute folder, not a drive root, not OrgAI's data folder, not the working folder or a folder inside or containing it, and not the same folder as one already listed.`
}
