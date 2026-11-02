import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionDecision, PermissionRuleSpec, PermissionSuggestion } from '@shared/types'
import { isWholeToolRule } from '@shared/types'
import { posix, win32 } from 'node:path'
import { isFreeCd, isFreeCdTarget, mcpServerOfRule, splitCommand, unwrapShellCommand, type MatchOptions } from './ruleMatch'
import type { RuntimeContext } from './types'

/**
 * Saved "always allow in this project" rules. They live where Claude Code keeps per-user project
 * permissions, `<project>/.claude/settings.local.json`, under `permissions.allow`, so the CLI
 * honours them too. Every other key in the file is preserved.
 */

type LocalSettings = Record<string, unknown> & { permissions?: Record<string, unknown> & { allow?: unknown } }

export function settingsLocalPath(projectPath: string): string {
  return join(projectPath, '.claude', 'settings.local.json')
}

/** The parsed file, {} when it does not exist. Throws when it exists but is not a JSON object. */
export function readLocalSettings(projectPath: string): LocalSettings {
  const file = settingsLocalPath(projectPath)
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`)
  return parsed as LocalSettings
}

function writeLocalSettings(projectPath: string, settings: LocalSettings): void {
  const file = settingsLocalPath(projectPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

function allowOf(settings: LocalSettings): string[] {
  const allow = settings.permissions?.allow
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : []
}

/** Saved allow rules. An unreadable file yields no rules rather than failing the caller. */
export function listRules(projectPath: string): string[] {
  try {
    return allowOf(readLocalSettings(projectPath))
  } catch {
    return []
  }
}

/** Merge rules into permissions.allow, creating the file if needed. Returns the full list. */
export function addRules(projectPath: string, rules: string[]): string[] {
  const settings = readLocalSettings(projectPath)
  const current = allowOf(settings)
  const fresh = rules.filter((r) => r && !current.includes(r))
  if (fresh.length === 0) return current
  const next = [...current, ...[...new Set(fresh)]]
  settings.permissions = { ...(settings.permissions ?? {}), allow: next }
  writeLocalSettings(projectPath, settings)
  return next
}

/** Drop one rule from permissions.allow. Returns the remaining rules. */
export function removeRule(projectPath: string, rule: string): string[] {
  const settings = readLocalSettings(projectPath)
  const current = allowOf(settings)
  if (!current.includes(rule)) return current
  const next = current.filter((r) => r !== rule)
  settings.permissions = { ...(settings.permissions ?? {}), allow: next }
  writeLocalSettings(projectPath, settings)
  return next
}

/** Shell rules that must never be saved as a blanket allow: destructive or privilege-raising commands. */
const DESTRUCTIVE_SHELL = /^(rm|rmdir|del|rd|sudo|su|chmod|chown|mkfs|dd|shutdown|reboot|git\s+push|git\s+reset|git\s+clean|git\s+checkout|git\s+rebase|git\s+branch\s+-D|Remove-Item)(?![\w-])/i

/**
 * True for a rule the harness refuses to save from a proposal: a bare shell tool (every command), a
 * wildcard-only shell rule, or one whose command starts with a destructive verb (rm, sudo, git push, git reset, ...).
 */
export function isUnsafeAllowRule(rule: string): boolean {
  const r0 = rule.trim()
  if (/^mcp__[^()]*\*/.test(r0) || /^mcp__orgai$/i.test(r0)) return mcpServerOfRule(r0) === null
  const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return true
  const [, tool, content] = m
  if (content === undefined && EDIT_TOOLS.has(tool)) return true
  if (!SHELL_TOOLS.has(tool)) return false
  if (content === undefined) return true
  // `prefix:*` and `prefix *` are the same prefix rule (the CLI writes both).
  const command = content.trim().replace(/(?::\*| \*)$/, '').trim()
  return !command || command === '*' || DESTRUCTIVE_SHELL.test(command)
}

/** File-editing tools: a bare rule naming one would allow edits anywhere on disk. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * True for a whole-tool rule on a shell or file-editing tool (`Bash`, `Edit`, `Write`...): it would allow every
 * command or edits anywhere on disk. Never saved to a project (rules panel, request_permission_rules project scope).
 */
export function isBlanketAllowRule(rule: string): boolean {
  const r = rule.trim()
  return SHELL_TOOLS.has(r) || EDIT_TOOLS.has(r)
}

/** The refusal shown when someone tries to save a blanket rule; null when the rule is not one. */
export function blanketRuleRefusal(rule: string): string | null {
  const r = rule.trim()
  if (EDIT_TOOLS.has(r)) {
    return `"${r}" on its own would allow edits anywhere on disk. Add the folder to the project's allowed folders, or set the project's permission mode to accept edits.`
  }
  if (SHELL_TOOLS.has(r)) return `"${r}" on its own would allow every command. Use a prefix rule such as ${r}(npm test:*).`
  return null
}

/** Re-exported for main-process callers; the renderer imports it from @shared/types. */
export { isWholeToolRule }

/** `Bash(npm test:*)` style string for a rule. */
export function ruleToString(rule: PermissionRuleSpec): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

/** The card label for a rule: server-level MCP forms read "All tools of <server>", everything else is the rule. */
export function ruleLabel(rule: string): string {
  const server = mcpServerOfRule(rule)
  return server ? `All tools of ${server}` : rule
}

/** Labels for the approval card, one per rule or directory the suggestions grant. */
export function suggestionLabels(suggestions: PermissionSuggestion[]): string[] {
  const labels: string[] = []
  for (const s of suggestions) {
    if (s.type === 'addRules' || s.type === 'replaceRules') {
      if (s.behavior === 'allow') labels.push(...s.rules.map((r) => ruleLabel(ruleToString(r))))
    } else if (s.type === 'addDirectories') labels.push(...s.directories.map((d) => `Edits and reads in ${d}`))
    else if (s.type === 'setMode') labels.push(s.mode === 'acceptEdits' ? 'Auto-accept file edits in this project' : `Permission mode: ${s.mode}`)
  }
  return [...new Set(labels)]
}

/** Allow rules (as strings) the suggestions add; what gets persisted for "always allow". */
export function allowRuleStrings(suggestions: PermissionSuggestion[]): string[] {
  const out: string[] = []
  for (const s of suggestions) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow') out.push(...s.rules.map(ruleToString))
  }
  return [...new Set(out)]
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Commands whose first word alone says little: their rule is the first two words (`npm test`, `git status`). */
export const LAUNCHERS: ReadonlySet<string> = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'go', 'cargo', 'dotnet', 'python', 'python3', 'pip', 'uv', 'node', 'deno', 'make', 'docker', 'gh'
])

/** A plain command word: no quotes, parentheses, variables, globs, assignments or redirects. */
const PLAIN_WORD = /^[\w.@/\\:+-]+$/

/**
 * The prefix rule content for one command segment (`npm test`), or null when the segment gives no safe rule: an
 * unusable first word (quotes, parentheses, `VAR=x`), a launcher without a plain subcommand (`git -C x status`), or a
 * destructive prefix (isUnsafeAllowRule).
 */
export function segmentRulePrefix(toolName: string, segment: string): string | null {
  const words = segment.trim().split(/\s+/)
  const first = words[0] ?? ''
  if (!first || !PLAIN_WORD.test(first)) return null
  let prefix = first
  if (LAUNCHERS.has(first.toLowerCase())) {
    const second = words[1] ?? ''
    if (!second || second.startsWith('-') || !PLAIN_WORD.test(second)) return null
    prefix = `${first} ${second}`
  }
  if (isUnsafeAllowRule(`${toolName}(${prefix}:*)`)) return null
  return prefix
}

/**
 * Per-segment prefix rules for a shell command: one per `&&` / `||` / `;` / `|` segment, free `cd` segments skipped
 * (they need no rule, see ruleMatch.ts MatchOptions), duplicates dropped, segments without a safe rule skipped.
 * `cd wt && npm test && git status` gives `npm test:*`, `git status:*`.
 */
export function shellRuleContents(toolName: string, command: string, opts?: MatchOptions): string[] {
  const out: string[] = []
  for (const segment of splitCommand(unwrapShellCommand(command))) {
    if (!segment || isFreeCd(segment, opts)) continue
    // A pipe's parts each run a command; the CLI matches them one by one too.
    for (const part of segment.split(/\|&?|&/).map((s) => s.trim())) {
      if (!part) continue
      const prefix = segmentRulePrefix(toolName, part)
      if (prefix && !out.includes(`${prefix}:*`)) out.push(`${prefix}:*`)
    }
  }
  return out
}

function commandOf(input: unknown): string | undefined {
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  return typeof command === 'string' ? command : undefined
}

/** The file an edit tool call targets (`file_path`, or `notebook_path` for NotebookEdit). */
export function editTargetOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as { file_path?: unknown; notebook_path?: unknown }
  const v = typeof o.file_path === 'string' && o.file_path ? o.file_path : o.notebook_path
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Suggestions for an edit tool, mirroring what the CLI offers: auto-accept edits (setMode acceptEdits), plus the
 * file's folder (addDirectories) when the file is outside the project and the allowed directories. Never a bare
 * `Edit` / `Write` rule, which would allow edits anywhere on disk.
 */
export function editSuggestions(input: unknown, opts?: MatchOptions): PermissionSuggestion[] {
  const out: PermissionSuggestion[] = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const target = editTargetOf(input)
  if (!target) return out
  const p = (opts?.platform ?? process.platform) === 'win32' ? win32 : posix
  const abs = p.isAbsolute(target) ? p.resolve(target) : opts?.cwd && p.isAbsolute(opts.cwd) ? p.resolve(opts.cwd, target) : null
  if (!abs) return out
  const dir = p.dirname(abs)
  // A file directly in a drive or file-system root gives no folder to add (cleanAllowedDirectories refuses roots).
  if (p.parse(dir).root === dir) return out
  if (!isFreeCdTarget(dir, opts ?? {})) out.push({ type: 'addDirectories', directories: [dir], destination: 'session' })
  return out
}

/**
 * Rules for when the provider offers none: shell tools get one prefix rule per command segment (shellRuleContents),
 * edit tools get editSuggestions, every other tool is allowed by name (`WebSearch`, `mcp__x__y`).
 */
export function deriveSuggestions(toolName: string, input: unknown, opts?: MatchOptions): PermissionSuggestion[] {
  if (EDIT_TOOLS.has(toolName)) return editSuggestions(input, opts)
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(input)
    // Without a usable rule, a bare tool-name rule would allow every command; offer nothing.
    const contents = command ? shellRuleContents(toolName, command, opts) : []
    if (!contents.length) return []
    return [{ type: 'addRules', rules: contents.map((ruleContent) => ({ toolName, ruleContent })), behavior: 'allow', destination: 'session' }]
  }
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}

/** True for a shell rule whose content spans several `&&` / `||` / `;` segments (outside quotes): it can never match. */
function isCompoundShellRule(rule: PermissionRuleSpec): boolean {
  return SHELL_TOOLS.has(rule.toolName) && !!rule.ruleContent && splitCommand(rule.ruleContent).length > 1
}

/**
 * Suggestions to offer on an approval card: none when the provider forbids a "don't ask again" choice
 * for this ask, otherwise the provider's own suggestions, otherwise ones derived by the harness. A provider rule
 * spanning several segments (`Bash(cd x && npm test *)`, which never matches) is replaced by per-segment rules
 * derived from the command (free `cd` segments skipped); a suggestion left without rules is dropped.
 */
export function chooseSuggestions(
  toolName: string,
  input: unknown,
  provided: PermissionSuggestion[] | undefined,
  suppressed = false,
  opts?: MatchOptions
): PermissionSuggestion[] {
  if (suppressed) return []
  if (!provided?.length) return deriveSuggestions(toolName, input, opts)
  const out: PermissionSuggestion[] = []
  for (const s of provided) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow' && s.rules.some(isCompoundShellRule)) {
      const command = commandOf(input)
      const rules: PermissionRuleSpec[] = []
      const seen = new Set<string>()
      const push = (r: PermissionRuleSpec): void => {
        const key = ruleToString(r)
        if (seen.has(key)) return
        seen.add(key)
        rules.push(r)
      }
      for (const r of s.rules) {
        if (!isCompoundShellRule(r)) push(r)
        else {
          const source = command ?? r.ruleContent!.trim().replace(/(?::\*| \*)$/, '')
          for (const ruleContent of shellRuleContents(r.toolName, source, opts)) push({ toolName: r.toolName, ruleContent })
        }
      }
      if (rules.length) out.push({ ...s, rules })
      continue
    }
    out.push(s)
  }
  return out
}

/** What a 'project' scope may persist besides rules (RuntimeContext; both missing on trust-restricted runs). */
export type AllowScopePersist = Pick<RuntimeContext, 'allowDirectories' | 'acceptEditsForProject'>

/**
 * Apply an allow decision's scope. Returns the suggestions to grant for the rest of the session, or
 * null when the allow covers this call only. Project scope also saves the allow rules to the project, the
 * addDirectories folders through persist.allowDirectories and a setMode acceptEdits through
 * persist.acceptEditsForProject (RunManager logs both and switches the mode only from 'default').
 */
export function applyAllowScope(
  projectPath: string,
  decision: Extract<PermissionDecision, { behavior: 'allow' }>,
  suggestions: PermissionSuggestion[],
  log: (level: 'info' | 'warn', message: string) => void,
  persist?: AllowScopePersist
): PermissionSuggestion[] | null {
  const scope = decision.scope ?? 'once'
  if (scope === 'once' || suggestions.length === 0) return null
  if (scope === 'project') {
    const all = allowRuleStrings(suggestions)
    // A bare Bash / Edit / Write rule is never written to the project; it still applies for this session.
    const rules = all.filter((r) => !isBlanketAllowRule(r))
    if (rules.length < all.length) log('warn', `Not saved for the project (too broad): ${all.filter(isBlanketAllowRule).join(', ')}. It applies to this session only.`)
    try {
      if (rules.length) {
        addRules(projectPath, rules)
        log('info', `Saved permission rule${rules.length === 1 ? '' : 's'} for this project: ${rules.join(', ')}`)
      }
    } catch (e) {
      log('warn', `Could not save permission rules: ${(e as Error).message}`)
    }
    const dirs = [...new Set(suggestions.flatMap((s) => (s.type === 'addDirectories' ? s.directories : [])))].filter((d) => typeof d === 'string' && d.length > 0)
    if (dirs.length && persist?.allowDirectories) {
      try {
        persist.allowDirectories(dirs)
      } catch (e) {
        log('warn', `Could not save allowed folders: ${(e as Error).message}`)
      }
    }
    if (persist?.acceptEditsForProject && suggestions.some((s) => s.type === 'setMode' && s.mode === 'acceptEdits')) {
      try {
        persist.acceptEditsForProject()
      } catch (e) {
        log('warn', `Could not save the permission mode: ${(e as Error).message}`)
      }
    }
  }
  return suggestions
}

