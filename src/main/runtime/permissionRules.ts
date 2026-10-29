import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionDecision, PermissionRuleSpec, PermissionSuggestion } from '@shared/types'

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

/** `Bash(npm test:*)` style string for a rule. */
export function ruleToString(rule: PermissionRuleSpec): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

/** Labels for the approval card, one per rule or directory the suggestions grant. */
export function suggestionLabels(suggestions: PermissionSuggestion[]): string[] {
  const labels: string[] = []
  for (const s of suggestions) {
    if (s.type === 'addRules' || s.type === 'replaceRules') {
      if (s.behavior === 'allow') labels.push(...s.rules.map(ruleToString))
    } else if (s.type === 'addDirectories') labels.push(...s.directories.map((d) => `Access to ${d}`))
    else if (s.type === 'setMode') labels.push(`Permission mode: ${s.mode}`)
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

/**
 * A rule for when the provider offers none: shell tools get the command's first word as a prefix
 * rule (`Bash(npm:*)`), every other tool is allowed by name (`Edit`).
 */
export function deriveSuggestions(toolName: string, input: unknown): PermissionSuggestion[] {
  let rule: PermissionRuleSpec = { toolName }
  if (SHELL_TOOLS.has(toolName)) {
    const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
    const first = typeof command === 'string' ? command.trim().split(/\s+/)[0] : ''
    // Without a usable first word, a bare tool-name rule would allow every command; offer nothing.
    if (!first || /[()]/.test(first)) return []
    rule = { toolName, ruleContent: `${first}:*` }
  }
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }]
}

/**
 * Suggestions to offer on an approval card: none when the provider forbids a "don't ask again" choice
 * for this ask, otherwise the provider's own suggestions, otherwise ones derived by the harness.
 */
export function chooseSuggestions(
  toolName: string,
  input: unknown,
  provided: PermissionSuggestion[] | undefined,
  suppressed = false
): PermissionSuggestion[] {
  if (suppressed) return []
  return provided?.length ? provided : deriveSuggestions(toolName, input)
}

/**
 * Apply an allow decision's scope. Returns the suggestions to grant for the rest of the session, or
 * null when the allow covers this call only. Project scope also saves the allow rules to the project.
 */
export function applyAllowScope(
  projectPath: string,
  decision: Extract<PermissionDecision, { behavior: 'allow' }>,
  suggestions: PermissionSuggestion[],
  log: (level: 'info' | 'warn', message: string) => void
): PermissionSuggestion[] | null {
  const scope = decision.scope ?? 'once'
  if (scope === 'once' || suggestions.length === 0) return null
  if (scope === 'project') {
    const rules = allowRuleStrings(suggestions)
    try {
      if (rules.length) {
        addRules(projectPath, rules)
        log('info', `Saved permission rule${rules.length === 1 ? '' : 's'} for this project: ${rules.join(', ')}`)
      }
    } catch (e) {
      log('warn', `Could not save permission rules: ${(e as Error).message}`)
    }
  }
  return suggestions
}
