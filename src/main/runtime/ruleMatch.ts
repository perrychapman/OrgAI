import { posix, win32 } from 'node:path'
import { isWholeToolRule } from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import type { RuntimeContext } from './types'

/**
 * Permission rule matching the harness does itself, vendor-neutral. Claude Code loads the saved rules
 * (`.claude/settings.local.json`) as `allowedTools` when a session starts, but rules granted while a run
 * is live (request_permission_rules, the rules panel) must take effect without a restart: the Claude
 * adapter's PreToolUse hook answers `allow` for a matching call, which bypasses the permission system
 * (the classifier included) in every mode; the Codex adapter accepts a matching command approval.
 *
 * Supported rules: a bare tool name (`WebSearch`), `Bash(prefix:*)` / `Bash(prefix *)` (the CLI writes both;
 * PowerShell too; the command or every `&&`/`||`/`;` segment of it starts with the prefix as whole words) and
 * `Bash(exact command)`. A `*` anywhere else never matches. Pipes, redirects, command substitution, background `&`
 * and newlines never match: such a command goes through the provider's own permission flow. Content rules for
 * other tools (`Read(path)`, `WebFetch(domain:x)`) are left to the provider too.
 *
 * A `cd <dir>` segment needs no rule when <dir> resolves to the project folder, a folder inside it (worktrees
 * included) or an allowed directory (`MatchOptions.freeDirs`), like the CLI's read-only `cd`.
 */

export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/** Shell syntax a segment may not contain for a rule to apply. */
const UNSAFE_SEGMENT = /[|&`<>\n\r]|\$\(/

/**
 * Syntax refused outside quotes (review re-check High 1): parentheses and braces (bash subshells and brace
 * expansion; PowerShell argument-mode expressions such as `cd (Stop-Computer)`, `npm test (calc)`, script blocks) and
 * PowerShell splatting / array and hash literals (`@x`, `@(...)`, `@{...}`). A mid-word `@` (`pkg@1.2.3`) stays.
 */
const UNSAFE_UNQUOTED = /[(){}]|(?:^|\s)@|@[({]/

/** The segment with quoted text removed (quotes included); an unclosed quote drops the rest. */
function unquotedPart(segment: string): string {
  let out = ''
  let quote: string | null = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** True when a segment holds syntax no rule may cover (UNSAFE_SEGMENT anywhere, UNSAFE_UNQUOTED outside quotes). */
export function isUnsafeSegment(segment: string): boolean {
  return UNSAFE_SEGMENT.test(segment) || UNSAFE_UNQUOTED.test(unquotedPart(segment))
}

/** The harness's own MCP server: its tools are never granted wholesale through a saved rule. */
const HARNESS_SERVER = 'orgai'

/** Where a command runs and which folders a `cd` may enter without a rule. */
export interface MatchOptions {
  /** The folder relative `cd` targets resolve against (the project path). Missing = relative targets are never free. */
  cwd?: string
  /** Folders a `cd` may enter freely (the folder itself or anything inside it): the project path plus allowed directories. */
  freeDirs?: readonly string[]
  /** Path rules to apply; default process.platform. win32 compares case-insensitively and reads MSYS `/c/...` paths. */
  platform?: NodeJS.Platform
  /** Folders never offered as extra directories (RuntimeContext.protectedDirectories: OrgAI's data folder). */
  deniedDirs?: readonly string[]
  /**
   * The shell reading the command. On win32 the MSYS spelling `/c/x` means `C:\x` only in bash (Git Bash); PowerShell
   * reads it as `<current drive>:\c\x`, so with 'powershell' it is never free. Missing = bash (matchingRule sets it
   * from the tool name; Codex on win32 passes 'powershell').
   */
  shell?: 'bash' | 'powershell'
}

/** The label a command made only of free `cd` segments is allowed by. */
export const FREE_CD_LABEL = 'cd inside the project'

/**
 * MatchOptions for a run right now: cwd is the project path, free dirs the project path plus `allowedDirectories()`
 * (live), denied dirs `protectedDirectories()`.
 */
export function matchOptionsFor(ctx: Pick<RuntimeContext, 'project' | 'allowedDirectories' | 'protectedDirectories'>): MatchOptions {
  const extra = ctx.allowedDirectories?.() ?? []
  const denied = ctx.protectedDirectories?.() ?? []
  return { cwd: ctx.project.path, freeDirs: [ctx.project.path, ...extra], ...(denied.length ? { deniedDirs: denied } : {}) }
}

/** Shells a wrapped command may name (`bash -lc '...'`); any other first token is never unwrapped. */
const SHELL_BINARY = /^(?:bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?$/i

/**
 * Quote handling bash and PowerShell disagree on, or the splitter does not model: a backslash next to a quote
 * (`"a\" ; b"`) and ANSI-C quoting (`$'...'`). A command containing either is never covered by a rule.
 */
const AMBIGUOUS_QUOTING = /\\["']|\$'/

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
  // Control, zero-width, bidi and other invisible characters (sanitize.ts): a rule must read as what it matches.
  if (hiddenCharProblem('rule', r) !== null) return false
  if (r.startsWith('mcp__') && r.includes('*')) return mcpServerOfRule(r) !== null
  if (/^mcp__orgai$/i.test(r)) return false
  return /^[A-Za-z_][\w-]*(?:\(.+\))?$/.test(r)
}

/**
 * The exact folders a wrapped shell may be named in by absolute path (lowercase, forward slashes, no trailing
 * slash). Exact matches only, never a subfolder: some folders under Program Files and System32 are user-writable
 * (System32\spool\drivers\color, System32\Tasks).
 */
const SYSTEM_SHELL_DIRS = [
  '/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin',
  'c:/program files/git/bin', 'c:/program files/git/usr/bin',
  'c:/program files (x86)/git/bin', 'c:/program files (x86)/git/usr/bin',
  'c:/windows/system32', 'c:/windows/system32/windowspowershell/v1.0', 'c:/program files/powershell/7'
]

/**
 * True for the shell a wrapper may name: a bare shell name (PATH lookup) or an absolute path in a system shell
 * folder. Never a relative path with a separator (`./bash`, `tools/sh`): a repo could ship its own `bash`.
 */
function isSystemShell(bin: string): boolean {
  const parts = bin.split(/[\\/]/)
  const base = parts.pop() ?? ''
  if (!SHELL_BINARY.test(base)) return false
  if (parts.length === 0) return true
  const dir = parts.join('/').toLowerCase()
  return SYSTEM_SHELL_DIRS.includes(dir)
}

/**
 * The inner command of `bash -lc '...'` / `pwsh -Command "..."` style wrappers; the input when it is not wrapped.
 * Only a system shell (isSystemShell) is unwrapped, and only when the inner text cannot close its quote early: for
 * `'...'` no `'` inside, for `"..."` no `"`, `$` or backtick inside. Anything else stays whole, so the outer program
 * needs its own rule (a shell rule is never saved) and UNSAFE_SEGMENT still applies.
 */
export function unwrapShellCommand(command: string): string {
  const c = command.trim()
  const m = /^("[^"]*"|\S+)\s+(?:-l?c|-Command|-c)\s+(?:'([^']*)'|"([^"$`]*)")$/i.exec(c)
  if (!m) return c
  const bin = m[1].replace(/^"|"$/g, '')
  // Shell metacharacters refuse the wrapper; the literal "Program Files (x86)" folder of a quoted path is the one exception.
  if (/[$`(){};&|<>'"]/.test(bin.replace(/^c:[\\/]program files \(x86\)(?=[\\/])/i, 'c:/pf86'))) return c
  if (!isSystemShell(bin)) return c
  return (m[2] ?? m[3] ?? '').trim()
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

/** The prefix of a prefix rule body (`npm test:*` or `npm test *`), else null (an exact rule). */
export function rulePrefix(body: string): string | null {
  const m = /^(.*?)(?::\*| \*)$/.exec(body.trim())
  return m ? m[1].trim() : null
}

/** The shell rule (Bash or PowerShell) covering one command segment, if any. A `*` outside the suffix never matches. */
function shellRuleFor(segment: string, rules: readonly string[]): string | undefined {
  for (const rule of rules) {
    const m = /^(?:Bash|PowerShell)\((.*)\)$/.exec(rule.trim())
    if (!m) continue
    const body = m[1].trim()
    const prefix = rulePrefix(body)
    if (prefix !== null) {
      if (prefix && !prefix.includes('*') && (segment === prefix || segment.startsWith(`${prefix} `))) return rule.trim()
    } else if (!body.includes('*') && body === segment) return rule.trim()
  }
  return undefined
}

/**
 * Characters that make a `cd` target depend on the shell: variables, home, globs, braces, history, and PowerShell
 * expressions, splatting and arrays (`(`, `)`, `@`, `,`), even inside quotes.
 */
const CD_UNSAFE = /[$~*?[\]{}%!`(),@]/

/**
 * The target of a `cd <dir>` segment, quotes stripped; null for `cd` alone, `cd -`, flags, several words, variables,
 * `~`, globs, or (outside win32) an unquoted backslash, which bash reads as an escape.
 */
export function cdTarget(segment: string, platform: NodeJS.Platform = process.platform): string | null {
  const m = /^cd\s+(.+)$/.exec(segment.trim())
  if (!m) return null
  const arg = m[1].trim()
  let dir: string
  const q = /^(["'])(.*)\1$/.exec(arg)
  if (q) {
    if (q[2].includes(q[1])) return null
    dir = q[2]
  } else {
    if (/\s|["']/.test(arg)) return null
    if (arg.includes('\\') && platform !== 'win32') return null
    dir = arg
  }
  // `cd -` / `cd +` walk the location history (bash, PowerShell 7).
  if (!dir || dir.startsWith('-') || dir.startsWith('+') || CD_UNSAFE.test(dir)) return null
  // win32 drops a trailing dot or space from a name (`proj.` and `proj ` open `proj`): never compared lexically.
  if (platform === 'win32' && dir.split(/[\\/]/).some((part) => part !== '.' && part !== '..' && /[. ]$/.test(part))) return null
  return dir
}

/** True when `dir` (resolved against opts.cwd when relative) is one of opts.freeDirs or inside one. Lexical. */
export function isFreeCdTarget(dir: string, opts: MatchOptions): boolean {
  const platform = opts.platform ?? process.platform
  const p = platform === 'win32' ? win32 : posix
  const free = (opts.freeDirs ?? []).filter((d) => typeof d === 'string' && d.length > 0 && p.isAbsolute(d))
  if (!free.length) return false
  let target = dir
  if (platform === 'win32') {
    // MSYS / Git Bash spelling of a drive path: /c/Users/x -> C:\Users\x.
    const msys = opts.shell === 'powershell' ? null : /^\/([a-zA-Z])(?:\/(.*))?$/.exec(target)
    if (msys) target = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`
    // UNC and device paths are never free.
    if (/^[\\/]{2}/.test(target)) return false
    // A drive-relative path (C:foo) or a rooted path without a drive (\foo) depends on state we do not model.
    if (/^[a-zA-Z]:(?![\\/])/.test(target) || /^[\\/]/.test(target)) return false
    // PowerShell provider paths (HKCU:\..., Microsoft.PowerShell.Core\FileSystem::C:\...): a ':' only as a drive.
    if (target.replace(/^[a-zA-Z]:(?=[\\/])/, '').includes(':')) return false
  } else if (target.includes(':')) return false
  if (p.isAbsolute(target)) target = p.resolve(target)
  else {
    if (!opts.cwd || !p.isAbsolute(opts.cwd)) return false
    target = p.resolve(opts.cwd, target)
  }
  return free.some((d) => {
    const rel = p.relative(p.resolve(d), target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
  })
}

/** True for a `cd <dir>` segment that needs no rule (see MatchOptions). */
export function isFreeCd(segment: string, opts: MatchOptions | undefined): boolean {
  if (!opts?.freeDirs?.length) return false
  const dir = cdTarget(segment, opts.platform ?? process.platform)
  return dir !== null && isFreeCdTarget(dir, opts)
}

/**
 * The rules that cover every segment of the command (deduplicated), or null when any segment is uncovered
 * or contains shell syntax the matcher refuses. Free `cd` segments need no rule; a command made only of them is
 * covered by FREE_CD_LABEL.
 */
export function shellRulesFor(command: string, rules: readonly string[], opts?: MatchOptions): string[] | null {
  if (AMBIGUOUS_QUOTING.test(command)) return null
  const cmd = unwrapShellCommand(command)
  if (!cmd) return null
  const hits: string[] = []
  for (const segment of splitCommand(cmd)) {
    if (!segment || isUnsafeSegment(segment)) return null
    if (isFreeCd(segment, opts)) continue
    const rule = shellRuleFor(segment, rules)
    if (!rule) return null
    if (!hits.includes(rule)) hits.push(rule)
  }
  return hits.length ? hits : [FREE_CD_LABEL]
}

/** True when saved `Bash(prefix:*)` / `Bash(prefix *)` / `Bash(exact)` rules (and free cds) cover every segment. */
export function matchesBashRule(command: string, rules: readonly string[], opts?: MatchOptions): boolean {
  return shellRulesFor(command, rules, opts) !== null
}

/**
 * The rule(s) that allow this tool call, as a label for the log, or undefined when none does: a whole-tool
 * rule naming the tool, or shell rules (and free `cd` segments, see MatchOptions) covering the command. Never
 * matches a bare shell tool rule unless it is literally saved (`Bash`), which the harness refuses to save.
 * Callers pass opts (matchOptionsFor(ctx)) even when `rules` is empty: a command of free cds alone is allowed.
 */
export function matchingRule(toolName: string, input: unknown, rules: readonly string[], opts?: MatchOptions): string | undefined {
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
  const hits = shellRulesFor(command, scoped, opts && { ...opts, shell: toolName === 'PowerShell' ? 'powershell' : 'bash' })
  return hits ? hits.join(', ') : undefined
}
