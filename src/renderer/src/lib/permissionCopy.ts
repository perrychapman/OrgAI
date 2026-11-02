/**
 * Plain-language copy for permission cards and the Permissions settings (docs/design/permissions.md). Pure: no IPC,
 * no node:path (the renderer sees Windows and POSIX paths). Every input is untrusted agent or provider text; outputs
 * are flattened to one line and only ever rendered as React text.
 */

import type { PermissionMode, PermissionSuggestion } from '@shared/types'
import { PROJECT_ALLOWED_DIRECTORIES_MAX, PROJECT_ALLOWED_DIRECTORY_MAX_CHARS } from '@shared/types'
import { isCdSegment, oneLine, shellSegments } from './decisionTitle'
import { abbreviatePath } from './paths'

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

export type PermissionLocationKind = 'project' | 'worktree' | 'allowed' | 'outside' | 'unknown'

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
  /** The agent's own working folder when it differs from the project (its worktree). */
  agentCwd?: string
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WORKTREES = '.claude/worktrees/'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function unquote(s: string): string {
  const t = s.trim()
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t
}

/** The folder a `cd`-like step moves to, or null when it cannot be worked out (`cd`, `cd ~`, `cd $X`, `cd -`). */
function cdTarget(segment: string): string | null {
  const m = /^\S+\s+(?:\/d\s+)?(.+)$/i.exec(segment.trim())
  if (!m) return null
  const target = unquote(m[1])
  if (!target || target === '-' || /^~|[$%`]/.test(target)) return null
  return target
}

/** Name of the folder an absolute path is in, relative to the project: worktree, project, allowed folder or outside. */
function classify(target: string, isFile: boolean, ctx: LocationContext): PermissionLocation {
  const project = ctx.projectPath
  const full = display(normalizePath(target), project)
  if (isInsidePath(target, project)) {
    const rel = relativePath(target, project)
    if (rel.toLowerCase().startsWith(WORKTREES) || rel.toLowerCase() === WORKTREES.slice(0, -1)) {
      const rest = rel.slice(WORKTREES.length)
      const slash = rest.indexOf('/')
      const name = slash < 0 ? rest : rest.slice(0, slash)
      const inner = slash < 0 ? '' : rest.slice(slash + 1)
      if (name) return { kind: 'worktree', label: oneLine(`In worktree ${name} (inside the project)`), detail: inner ? oneLine(inner, 200) : undefined, full, attention: false }
    }
    return { kind: 'project', label: 'In the project', detail: rel ? oneLine(rel, 200) : undefined, full, attention: false }
  }
  for (const dir of ctx.allowedDirectories ?? []) {
    if (typeof dir !== 'string' || !dir.trim() || !isInsidePath(target, dir)) continue
    const rel = relativePath(target, dir)
    return { kind: 'allowed', label: oneLine(`In an allowed folder: ${abbreviatePath(display(normalizePath(dir), dir), 48)}`), detail: rel ? oneLine(rel, 200) : undefined, full, attention: false }
  }
  const folder = isFile ? parentPath(target) : normalizePath(target)
  return {
    kind: 'outside',
    label: oneLine(`Outside the project: ${abbreviatePath(display(folder, project), 48)}`),
    detail: isFile ? oneLine(target.split(/[\\/]/).pop() ?? '', 120) : undefined,
    full,
    attention: true
  }
}

/**
 * Where a tool call works, said plainly. File tools: the file path (relative paths resolve against the agent's folder).
 * Shell tools: the folder after the command's `cd` steps (else the input's `cwd`, else the agent's folder). Other
 * tools: the input's `cwd` when given, else null (no line).
 */
export function permissionLocation(toolName: string, input: unknown, ctx: LocationContext): PermissionLocation | null {
  if (!ctx.projectPath || !isAbsolutePath(ctx.projectPath)) return null
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const base = ctx.agentCwd && isAbsolutePath(ctx.agentCwd) ? ctx.agentCwd : ctx.projectPath
  const cwdInput = str(o.cwd)
  const start = cwdInput ? resolvePath(base, cwdInput) : base
  if (FILE_TOOLS.has(toolName)) {
    const file = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
    if (!file) return null
    return classify(resolvePath(start, file), true, ctx)
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = str(o.command)
    let cwd = start
    if (command) {
      const firstLine = command.split(/\r?\n/)[0] ?? ''
      const steps = shellSegments(firstLine)
      // The folder the last real step runs in: follow every cd before it.
      let lastAction = steps.length - 1
      while (lastAction > 0 && isCdSegment(steps[lastAction])) lastAction--
      for (let i = 0; i < lastAction; i++) {
        if (!isCdSegment(steps[i])) continue
        const target = cdTarget(steps[i])
        if (target === null) {
          return { kind: 'unknown', label: oneLine(`Working folder unclear: ${steps[i]}`), attention: true }
        }
        cwd = resolvePath(cwd, target)
      }
    }
    return classify(cwd, false, ctx)
  }
  return cwdInput ? classify(start, false, ctx) : null
}

// ---------- What each scope does ----------

const SHELL_RULE = /^(Bash|PowerShell)\((.*)\)$/s

/** The calls one allow rule covers, as a phrase: `"npm test" commands`, `every WebSearch call`, `all tools of github`. */
export function ruleSubject(rule: string): string {
  const r = rule.trim()
  const server = mcpServerOf(r)
  if (server) return oneLine(`all tools of ${server}`)
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
 * on "Ask for everything risky" switches it to "Auto-accept file edits".
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
  if (rules.length) {
    session.push(`stops asking for ${joinList(rules)}`)
    project.push(`stops asking for ${joinList(rules)} in this project`)
  }
  if (dirs.length) {
    session.push(`allows edits and reads in ${joinList(dirs)}`)
    project.push(`adds ${joinList(dirs)} to this project's allowed folders`)
  }
  for (const mode of modes) {
    if (mode === 'acceptEdits') {
      session.push('auto-accepts file edits')
      // Main switches the project's mode only from "Ask for everything risky"; in other modes the switch is session-only.
      if (projectMode === 'default') project.push('switches this project to Auto-accept file edits')
    } else {
      session.push(oneLine(`uses permission mode ${mode}`, 60))
    }
  }
  if (!session.length) return { once }
  return {
    once,
    session: oneLine(`Allow for session: ${joinList(session)} until you end this session.`, 400),
    project: oneLine(`Always allow for project: ${project.length ? joinList(project) : 'the same as Allow for session; nothing is saved for later runs'}.`, 400)
  }
}

/** A card's rule chip: the label from main plus whether it approves a whole tool (warned on the card). */
export function ruleChip(label: string): { text: string; wholeTool: boolean } {
  const text = oneLine(label, 200)
  return { text, wholeTool: isWholeTool(text) && !mcpServerOf(text) }
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

/** Check a typed rule before it is sent. Main checks again (ipc.ts isValidRule). */
export function checkRuleDraft(draft: string): { ok: true; rule: string; info: RuleInfo } | { ok: false; reason: string } {
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
  const shell = SHELL_RULE.exec(r)
  if (shell && shellPrefix(shell[2].trim()) === '') return { ok: false, reason: `${shell[1]}(*) would approve every command. Use a prefix such as ${shell[1]}(npm test:*).` }
  return { ok: true, rule: r, info: ruleInfo(r) }
}

// ---------- Permission modes ----------

/** One-line trade-off per mode, for the settings select (renderer copy; types.ts keeps the short labels). */
export const PERMISSION_MODE_TRADEOFF: Record<PermissionMode, string> = {
  auto: 'Claude approves safe calls itself; asks only when unsure. Fewest prompts.',
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
  return `${oneLine(path, 200)} was not saved: must be an absolute folder, not a drive root, not OrgAI's data folder.`
}
