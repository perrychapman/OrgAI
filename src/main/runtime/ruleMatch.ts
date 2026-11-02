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

/** The harness's own MCP server: its tools are never granted wholesale through a saved rule. */
const HARNESS_SERVER = 'orgai'

/**
 * The server name of a server-level MCP rule, else null. Two forms: `mcp__<server>` and `mcp__<server>__*`.
 * A server name is letters, digits, `-` and single `_` (starting with a letter or digit): a doubled underscore is
 * the tool separator, so a name containing it cannot be told apart from `<server>__<tool>` and is not a server
 * rule. `mcp__*`, any other wildcard and the harness's own `orgai` server are never server rules.
 */
export function mcpServerOfRule(rule: string): string | null {
  const m = /^mcp__([A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*)(?:__\*)?$/.exec(rule.trim())
  if (!m) return null
  const name = m[1]
  if (name.endsWith('_') || name.toLowerCase() === HARNESS_SERVER) return null
  return name
}

/** True for `Tool`, `Tool(content)` or a server-level MCP rule; one line, no stray parentheses around the content. Refuses `mcp__*` and the harness server's wildcard forms. */
export function isValidRule(rule: string): boolean {
  const r = rule.trim()
  if (!r || /[\n\r]/.test(r)) return false
  if (r.startsWith('mcp__') && r.includes('*')) return mcpServerOfRule(r) !== null
  if (/^mcp__orgai$/i.test(r)) return false
  return /^[A-Za-z_][\w-]*(?:\(.+\))?$/.test(r)
}

/** The inner command of `bash -lc '...'` / `pwsh -Command "..."` style wrappers; the input when it is not wrapped. */
export function unwrapShellCommand(command: string): string {
  const c = command.trim()
  const m = /^(?:"[^"]*"|\S+)\s+(?:-l?c|-Command|-c)\s+(['"])([\s\S]*)\1$/i.exec(c)
  return m ? m[2].trim() : c
}

/** Split a command on `&&`, `||` and `;` outside quotes. A trailing or empty segment stays empty (invalid). */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
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
  const hits: string[] = []
  for (const segment of splitCommand(cmd)) {
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
    // Server-level rules: exact `mcp__<server>__` prefix, so `mcp__a` never covers `mcp__ab__x` or `mcp__a_b__x`.
    // A tool named `mcp__a__b__c` is covered by `mcp__a` (the split is ambiguous; the first segment is the server).
    const server = mcpServerOfRule(r)
    if (server && toolName.startsWith(`mcp__${server}__`) && toolName.length > server.length + 7) return r
  }
  if (!SHELL_TOOLS.has(toolName)) return undefined
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return undefined
  const scoped = rules.filter((r) => r.trim().startsWith(`${toolName}(`))
  const hits = shellRulesFor(command, scoped)
  return hits ? hits.join(', ') : undefined
}
