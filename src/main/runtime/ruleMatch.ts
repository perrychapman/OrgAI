import { isWholeToolRule } from '@shared/types'

/**
 * Permission rule matching the harness does itself, vendor-neutral. Claude Code loads the saved rules
 * (`.claude/settings.local.json`) as `allowedTools` when a session starts, but rules granted while a run
 * is live (request_permission_rules, the rules panel) must take effect without a restart: the Claude
 * adapter's PreToolUse hook answers `allow` for a matching call, which bypasses the permission system
 * (the classifier included) in every mode; the Codex adapter accepts a matching command approval.
 *
 * Supported rules: a bare tool name (`WebSearch`), `Bash(prefix:*)` / `PowerShell(prefix:*)` (the command
 * or every `&&`/`||`/`;` segment of it starts with the prefix as whole words) and `Bash(exact command)`.
 * Pipes, redirects, command substitution, background `&` and newlines never match: such a command goes
 * through the provider's own permission flow. Content rules for other tools (`Read(path)`,
 * `WebFetch(domain:x)`) are left to the provider too.
 */

export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/** Shell syntax a segment may not contain for a rule to apply. */
const UNSAFE_SEGMENT = /[|&`<>\n\r]|\$\(/

/** `Tool`, `Tool(content)`; one line, no stray parentheses around the content. */
export function isValidRule(rule: string): boolean {
  const r = rule.trim()
  if (!r || /[\n\r]/.test(r)) return false
  return /^[A-Za-z_][\w-]*(?:\(.+\))?$/.test(r)
}

/**
 * Commands are matched exactly as submitted. Shell wrappers are deliberately not unwrapped: a basename cannot
 * prove which executable will run (`./bash`, PATH shadowing on Windows), so approving their inner command would
 * let a repository-controlled program inherit an unrelated saved prefix rule.
 */
export function unwrapShellCommand(command: string): string {
  return command.trim()
}

/** Split a command on `&&`, `||` and `;` outside quotes. A trailing or empty segment stays empty (invalid). */
export function splitCommand(command: string): string[] | null {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\') {
      if (i + 1 >= command.length) return null
      const next = command[i + 1]
      // Backslash escaping differs between POSIX shells and PowerShell. Refuse any case that could
      // alter quoting or command boundaries under one of them; ordinary Windows paths remain usable.
      if (/['";&|`<>\r\n]/.test(next)) return null
      cur += ch + next
      i++
      continue
    }
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';') {
      parts.push(cur)
      cur = ''
      continue
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  if (quote) return null
  parts.push(cur)
  return parts.map((s) => s.trim())
}

/** The shell rule (Bash or PowerShell) covering one command segment, if any. */
function shellRuleFor(segment: string, rules: readonly string[]): string | undefined {
  for (const rule of rules) {
    const m = /^(?:Bash|PowerShell)\((.*)\)$/.exec(rule.trim())
    if (!m) continue
    const body = m[1].trim()
    if (body.endsWith(':*')) {
      const prefix = body.slice(0, -2).trim()
      if (prefix && (segment === prefix || segment.startsWith(`${prefix} `))) return rule.trim()
    } else if (body === segment) return rule.trim()
  }
  return undefined
}

/**
 * The rules that cover every segment of the command (deduplicated), or null when any segment is uncovered
 * or contains shell syntax the matcher refuses.
 */
export function shellRulesFor(command: string, rules: readonly string[]): string[] | null {
  const cmd = unwrapShellCommand(command)
  if (!cmd) return null
  const segments = splitCommand(cmd)
  if (!segments) return null
  const hits: string[] = []
  for (const segment of segments) {
    if (!segment || UNSAFE_SEGMENT.test(segment)) return null
    const rule = shellRuleFor(segment, rules)
    if (!rule) return null
    if (!hits.includes(rule)) hits.push(rule)
  }
  return hits
}

/** True when a saved `Bash(prefix:*)` / `Bash(exact)` rule covers the command (every segment of it). */
export function matchesBashRule(command: string, rules: readonly string[]): boolean {
  return shellRulesFor(command, rules) !== null
}

/**
 * The rule(s) that allow this tool call, as a label for the log, or undefined when none does: a whole-tool
 * rule naming the tool, or shell rules covering the command. Never matches a bare shell tool rule unless it
 * is literally saved (`Bash`), which the harness refuses to save.
 */
export function matchingRule(toolName: string, input: unknown, rules: readonly string[]): string | undefined {
  for (const rule of rules) {
    const r = rule.trim()
    if (isWholeToolRule(r) && r === toolName) return r
  }
  if (!SHELL_TOOLS.has(toolName)) return undefined
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return undefined
  const scoped = rules.filter((r) => r.trim().startsWith(`${toolName}(`))
  const hits = shellRulesFor(command, scoped)
  return hits ? hits.join(', ') : undefined
}
