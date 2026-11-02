import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionDecision, PermissionRuleSpec, PermissionSuggestion } from '@shared/types'
import { isWholeToolRule } from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { isFreeCd, isFreeCdTarget, mcpServerOfRule, rulePrefix, shellRulesFor, splitCommand, unwrapShellCommand, type MatchOptions } from './ruleMatch'
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

/** Rules trimmed, empty ones dropped, duplicates removed (first kept): a bloated file (issue #14) behaves. */
function uniqueRules(rules: readonly string[]): string[] {
  return [...new Set(rules.map((r) => r.trim()).filter(Boolean))]
}

/** Saved allow rules, trimmed and deduplicated. An unreadable file yields no rules rather than failing the caller. */
export function listRules(projectPath: string): string[] {
  try {
    return uniqueRules(allowOf(readLocalSettings(projectPath)))
  } catch {
    return []
  }
}

/**
 * Merge rules into permissions.allow, creating the file if needed. Duplicates are removed on read and write (the
 * file is rewritten when it held any, even with nothing new). `added` lists only rules that were not there before.
 * Synchronous read-modify-write: no other write in this process can interleave.
 */
export function addRulesReport(projectPath: string, rules: string[]): { rules: string[]; added: string[] } {
  const settings = readLocalSettings(projectPath)
  const raw = allowOf(settings)
  const current = uniqueRules(raw)
  // Never write a rule with a hidden character (card suggestions, install-card edits and permissions:add alike).
  const clean = rules.filter((r) => {
    const problem = typeof r === 'string' ? hiddenCharProblem('Permission rule', r.trim()) : null
    if (problem) console.warn(`Skipped a permission rule: ${problem}`)
    return !problem
  })
  const added = uniqueRules(clean).filter((r) => !current.includes(r))
  const next = [...current, ...added]
  if (added.length || raw.length !== current.length || raw.some((r, i) => r !== current[i])) {
    settings.permissions = { ...(settings.permissions ?? {}), allow: next }
    writeLocalSettings(projectPath, settings)
  }
  return { rules: next, added }
}

/** Merge rules into permissions.allow (addRulesReport). Returns the full list. */
export function addRules(projectPath: string, rules: string[]): string[] {
  return addRulesReport(projectPath, rules).rules
}

/** Drop one rule from permissions.allow. Returns the remaining rules. */
export function removeRule(projectPath: string, rule: string): string[] {
  const settings = readLocalSettings(projectPath)
  const raw = allowOf(settings)
  const target = rule.trim()
  if (!raw.some((r) => r.trim() === target)) return uniqueRules(raw)
  // Every copy goes (a bloated file may hold the rule many times, with stray whitespace).
  const next = uniqueRules(raw.filter((r) => r.trim() !== target))
  settings.permissions = { ...(settings.permissions ?? {}), allow: next }
  writeLocalSettings(projectPath, settings)
  return next
}

/** Shell rules that must never be saved as a blanket allow: destructive or privilege-raising commands. */
const DESTRUCTIVE_SHELL = /^(rm|rmdir|del|rd|ri|erase|sudo|su|chmod|chown|mkfs|dd|shutdown|reboot|git\s+push|git\s+reset|git\s+clean|git\s+checkout|git\s+restore|git\s+rebase|git\s+branch\s+-D|gh\s+[\w-]+\s+delete|Remove-Item|Clear-Content)(?![\w-])/i

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
  return !command || command === '*' || DESTRUCTIVE_SHELL.test(command) || execWrapperOf(command) !== null
}

/** File-editing tools: a bare rule naming one would allow edits anywhere on disk. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Shells, interpreters and exec wrappers: a prefix rule on one (`Bash(bash:*)`, `Bash(env:*)`, `Bash(xargs:*)`) runs
 * any command, so the harness never suggests or saves one.
 */
export const EXEC_WRAPPERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'env', 'xargs', 'eval', 'exec', 'source', '.',
  'nohup', 'timeout', 'time', 'nice', 'find', 'perl', 'ruby', 'php', 'awk', 'osascript', 'start', 'invoke-expression', 'iex',
  'start-process', 'invoke-command', 'wsl',
  // Unix exec helpers.
  'command', 'builtin', 'setsid', 'stdbuf', 'taskset', 'ionice', 'flock', 'watch', 'busybox', 'parallel', 'doas',
  // PowerShell aliases and jobs.
  'icm', 'saps', 'start-job', 'sajb', 'invoke-item', 'ii',
  // Windows script hosts and launchers.
  'forfiles', 'mshta', 'rundll32', 'wscript', 'cscript', 'regsvr32', 'msiexec', 'schtasks',
  // Node and version-manager launchers that run the command they are given (reviewer-4 M-3).
  'cross-env', 'dotenv', 'env-cmd', 'concurrently', 'nodemon', 'npm-run-all', 'run-p', 'run-s', 'corepack', 'volta', 'mise', 'asdf'
])

/** A command word's program name: base name, lowercase, `.exe` / `.cmd` / `.bat` / `.ps1` dropped. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/**
 * Programs that run code they are handed (scripts, eval strings, packages): a launcher or runner whose target is one
 * (`npx tsx`, `uv run python`, `pnpm dlx tsx`, `bunx node`) is treated like an exec wrapper, and a one-word rule on
 * one (`python.exe:*`) is never derived.
 */
const CODE_RUNNERS: ReadonlySet<string> = new Set([
  ...EXEC_WRAPPERS, 'tsx', 'ts-node', 'node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'py', 'pythonw', 'ipython', 'lua', 'r', 'rscript'
])

/** Whole-package runners: their second word is the program they run. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx'])

/**
 * Prefixes the harness never derives as a prefix rule (review re-check M2): the rule would grant far more than the
 * approved command. First words that write or move files or talk to the network (`cp`, `mv`, `curl`, `wget`, `ssh`,
 * `scp`, `rsync`) and pairs whose next words can run code or change tool config (`git config` with core.fsmonitor,
 * `npm pkg` / `npm config`, `gh api`, `deno eval`...). Such a command gets "allow once" (or the provider's exact rule).
 */
const NEVER_DERIVE_FIRST: ReadonlySet<string> = new Set([
  'cp', 'mv', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'nc', 'netcat', 'socat', 'telnet',
  'copy-item', 'copy', 'cpi', 'move-item', 'move', 'mi', 'set-content', 'add-content', 'out-file', 'invoke-webrequest', 'iwr',
  'invoke-restmethod', 'irm',
  // Compose files can mount the host and run privileged (reviewer-3 H3), like `docker compose`.
  'docker-compose', 'podman-compose'
])
const NEVER_DERIVE_PAIRS: ReadonlySet<string> = new Set([
  'git config', 'git submodule', 'git bisect', 'git difftool', 'git filter-branch', 'npm pkg', 'npm config', 'npm set',
  'pnpm config', 'pnpm pkg', 'yarn config', 'yarn node', 'gh api', 'gh extension', 'gh alias', 'deno eval',
  // Containers (reviewer-3 H3): run / exec / compose / buildx can mount the host or run as root; podman and nerdctl alike.
  // reviewer-4 M-1: create (then start), service / stack / plugin / kube, cp (writes anywhere on the host).
  ...['docker', 'podman', 'nerdctl'].flatMap((c) =>
    ['run', 'container', 'compose', 'buildx', 'exec', 'create', 'service', 'stack', 'plugin', 'cp', 'kube', 'swarm'].map((s) => `${c} ${s}`)
  ),
  'kubectl apply', 'kubectl create', 'kubectl debug', 'kubectl cp', 'kubectl attach', 'kubectl replace', 'kubectl patch',
  // Credentials and package scaffolders that run any package (reviewer-3 M1).
  'gh auth', 'gh secret', 'gh ssh-key', 'gh gpg-key', 'gh codespace', 'npm init', 'npm create', 'pnpm create', 'yarn create', 'bun create',
  'uv tool', 'kubectl exec', 'kubectl run', 'kubectl delete', 'terraform destroy'
])

/** Launchers whose second word is only a command group: the rule takes the third word too (`gh pr list`, `aws s3 ls`). */
const THREE_WORD_LAUNCHERS: ReadonlySet<string> = new Set(['gh', 'aws', 'az', 'gcloud'])

/** True when a shell prefix (`npm test`, `npx tsx`) must never be derived or kept as a prefix rule. */
export function isTooBroadPrefix(prefix: string): boolean {
  const words = prefix.trim().split(/\s+/).map(programName)
  const [first = '', second = '', third = ''] = words
  if (!first) return true
  if (NEVER_DERIVE_FIRST.has(first) || EXEC_WRAPPERS.has(first)) return true
  // A one-word rule on an interpreter (`python.exe:*`, `/usr/bin/node:*`) runs anything; on a launcher (`docker:*`,
  // `git:*`, `npx:*`) it covers every verb, `docker run --privileged` included (reviewer-4 M-2).
  if (words.length === 1 && (CODE_RUNNERS.has(first) || LAUNCHERS.has(first))) return true
  // gh / aws / az / gcloud: the group alone (`gh repo:*`) covers delete and auth verbs.
  if (words.length === 2 && THREE_WORD_LAUNCHERS.has(first)) return true
  if (second && NEVER_DERIVE_PAIRS.has(`${first} ${second}`)) return true
  // npx / bunx / pnpx / uvx / pipx run a package: an interpreter as the package runs anything.
  if (PACKAGE_RUNNERS.has(first) && CODE_RUNNERS.has(second)) return true
  // A runner word's target (`uv run python`, `pnpm dlx tsx`, `npm exec node`).
  if (RUNNER_WORDS.has(second) && CODE_RUNNERS.has(third)) return true
  return false
}

/** The exec wrapper a shell rule's command starts with (base name, `.exe` dropped), else null. */
function execWrapperOf(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = programName(first)
  return EXEC_WRAPPERS.has(base) ? base : null
}

/** The shell rule's command part (`npm test` from `Bash(npm test:*)`), else null. */
function shellRuleCommand(rule: string): string | null {
  const m = /^([\w-]+)\((.*)\)$/.exec(rule.trim())
  if (!m || !SHELL_TOOLS.has(m[1])) return null
  return m[2].trim().replace(/(?::\*| \*)$/, '').trim()
}

/**
 * True for a rule that would allow every command or edits anywhere on disk: a whole-tool rule on a shell or
 * file-editing tool (`Bash`, `Edit`, `Write`...), or a shell rule on an exec wrapper (`Bash(bash:*)`, `Bash(env:*)`).
 * Never saved to a project (rules panel, request_permission_rules project scope, "always allow for project").
 */
export function isBlanketAllowRule(rule: string): boolean {
  const r = rule.trim()
  if (SHELL_TOOLS.has(r) || EDIT_TOOLS.has(r)) return true
  const command = shellRuleCommand(r)
  return command !== null && execWrapperOf(command) !== null
}

/** The refusal shown when someone tries to save a blanket rule; null when the rule is not one. */
export function blanketRuleRefusal(rule: string): string | null {
  const r = rule.trim()
  if (EDIT_TOOLS.has(r)) {
    return `"${r}" on its own would allow edits anywhere on disk. Add the folder to the project's allowed folders, or set the project's permission mode to accept edits.`
  }
  if (SHELL_TOOLS.has(r)) return `"${r}" on its own would allow every command. Use a prefix rule such as ${r}(npm test:*).`
  const command = shellRuleCommand(r)
  const wrapper = command !== null ? execWrapperOf(command) : null
  if (wrapper) return `"${r}" would let "${wrapper}" run any other command. Allow the commands it runs instead, such as Bash(npm test:*).`
  return null
}

/**
 * The refusal for a path rule with one leading slash (`Edit(/src/x)`): Claude Code reads it as relative to the
 * project folder, and an absolute path needs two (`Edit(//home/me/x)`). Null for any other rule. Hygiene only: the
 * harness never matches path rules itself.
 */
export function pathRuleRefusal(rule: string): string | null {
  const m = /^(Edit|Write|Read|MultiEdit|NotebookEdit)\(\/(?!\/)(.*)\)$/.exec(rule.trim())
  if (!m) return null
  return `Claude Code reads ${m[1]}(/${m[2]}) as relative to the project folder. For an absolute path write ${m[1]}(//${m[2]}); for a project path write ${m[1]}(${m[2]}).`
}

/** Why a rule may not be saved through the rules panel (blanket or ambiguous path rule), or null. */
export function ruleSaveRefusal(rule: string): string | null {
  return blanketRuleRefusal(rule) ?? pathRuleRefusal(rule)
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
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'go', 'cargo', 'dotnet', 'python', 'python3', 'pip', 'uv', 'node', 'deno', 'make', 'docker', 'gh',
  'py', 'pythonw', 'bunx', 'pnpx', 'uvx', 'pipx', 'poetry', 'pdm', 'hatch', 'pipenv', 'conda', 'rye', 'nix',
  // Containers and cloud CLIs (reviewer-3 H3 / M1): a one-word rule would cover every verb.
  'podman', 'nerdctl', 'kubectl', 'terraform', 'aws', 'az', 'gcloud', 'helm'
])

/** A launcher's second words that only say "run something": the rule takes the third word too. */
const RUNNER_WORDS: ReadonlySet<string> = new Set(['run', 'run-script', 'exec', 'x', 'dlx'])

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
  if (LAUNCHERS.has(programName(first))) {
    const second = words[1] ?? ''
    if (!second || second.startsWith('-') || !PLAIN_WORD.test(second)) return null
    prefix = `${first} ${second}`
    // `npm run lint`, `docker exec x`, `uv run pytest`: the runner word alone would allow any script, so take the third.
    if (RUNNER_WORDS.has(second.toLowerCase()) || THREE_WORD_LAUNCHERS.has(programName(first))) {
      const third = words[2] ?? ''
      if (!third || third.startsWith('-') || !PLAIN_WORD.test(third)) return null
      prefix = `${prefix} ${third}`
    }
  }
  if (isUnsafeAllowRule(`${toolName}(${prefix}:*)`) || isTooBroadPrefix(prefix)) return null
  return prefix
}

/**
 * Per-segment prefix rules for a shell command, one per `&&` / `||` / `;` segment, free `cd` segments skipped (they
 * need no rule, see ruleMatch.ts MatchOptions), duplicates dropped: `cd wt && npm test && git status` gives
 * `npm test:*`, `git status:*`. All or nothing (issue #14): when any segment has syntax the matcher refuses (pipe,
 * redirect, `$(`, backtick, `&`, newline, ambiguous quoting) or gives no safe rule, the result is empty, never a
 * partial set. A non-empty result always covers the command (shellRulesFor).
 */
export function shellRuleContents(toolName: string, command: string, opts0?: MatchOptions): string[] {
  const opts = withShell(toolName, opts0)
  const out: string[] = []
  for (const segment of splitCommand(unwrapShellCommand(command))) {
    if (!segment) return []
    if (isFreeCd(segment, opts)) continue
    const prefix = segmentRulePrefix(toolName, segment)
    if (!prefix) return []
    if (!out.includes(`${prefix}:*`)) out.push(`${prefix}:*`)
  }
  if (!out.length) return []
  return shellRulesFor(command, out.map((c) => `${toolName}(${c})`), opts) ? out : []
}

/** The options with the shell reading the command: opts.shell (Codex on win32 sets 'powershell'), else from the tool name. */
function withShell(toolName: string, opts: MatchOptions | undefined): MatchOptions {
  return { ...(opts ?? {}), shell: opts?.shell ?? (toolName === 'PowerShell' ? 'powershell' : 'bash') }
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

/** Options for chooseSuggestions / deriveSuggestions: matching plus what the card may offer. */
export interface SuggestOptions extends MatchOptions {
  /**
   * MCP servers the user configured (project or library; never one an agent installed this run, review M3), by the
   * name in their tool prefix. A call to one of their tools is offered the server-level rule `mcp__<server>`.
   * Missing = exact tool rules only.
   */
  userMcpServers?: readonly string[]
  /** The user's home folder (default os.homedir()); tests override it. */
  home?: string
}

/**
 * Folders under home that hold credentials or agent configuration: never offered as an extra directory. AppData and
 * Library are not listed whole (the temp folder lives under AppData\Local); their agent config folders are.
 */
const HOME_CONFIG_DIRS = [
  '.ssh', '.aws', '.gnupg', '.claude', '.codex', '.config', '.kube', '.docker', '.azure', '.npmrc', '.git-credentials',
  'AppData/Roaming', 'Library/Application Support', 'Library/Keychains',
  // On PATH or run at login: a file written there runs later outside any sandbox.
  '.local/bin', '.cargo/bin', '.bun', 'go/bin', '.deno', '.npm-global', 'AppData/Local/Microsoft/WindowsApps', 'Library/LaunchAgents',
  // PowerShell profiles (run at every start), editor extensions (run code), browser profiles and credential stores.
  'Documents/PowerShell', 'Documents/WindowsPowerShell', '.vscode', '.cursor', 'AppData/Local/Google/Chrome', 'AppData/Local/Microsoft/Edge',
  'AppData/Local/Mozilla', '.cargo/credentials', '.cargo/credentials.toml', '.password-store', '.local/share/keyrings', 'Library/Cookies'
]

/**
 * True when `child` is `parent` or inside it. Lexical; case-insensitive on win32 and on darwin (reviewer-3 M3: APFS and
 * HFS+ are case-insensitive by default, so `~/.SSH` is `~/.ssh`). Only used for refusals, so folding never frees more.
 */
export function isWithinDir(parent: string, child: string, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') return isFreeCdTarget(child.toLowerCase(), { freeDirs: [parent.toLowerCase()], platform })
  return isFreeCdTarget(child, { freeDirs: [parent], platform })
}
const within = isWithinDir

/**
 * True for a folder the card may offer as an extra directory (addDirectories): absolute, not a root, not UNC or a
 * device path, not touching a protected folder (MatchOptions.deniedDirs, OrgAI's data folder) in either direction,
 * not home or a folder containing it, not a credential / config folder under home, and not a folder containing the
 * project (opts.cwd).
 */
export function isOfferableDirectory(dir: string, opts: SuggestOptions = {}): boolean {
  const platform = opts.platform ?? process.platform
  const p = platform === 'win32' ? win32 : posix
  if (typeof dir !== 'string' || !dir || dir.includes('\0') || /^[\\/]{2}/.test(dir) || !p.isAbsolute(dir)) return false
  if (platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(dir)) return false
  const abs = p.resolve(dir)
  if (p.parse(abs).root === abs) return false
  for (const d of opts.deniedDirs ?? []) {
    if (typeof d === 'string' && p.isAbsolute(d) && (within(d, abs, platform) || within(abs, d, platform))) return false
  }
  const home = opts.home ?? homedir()
  if (home && p.isAbsolute(home)) {
    if (within(abs, home, platform)) return false
    if (HOME_CONFIG_DIRS.some((c) => within(p.join(home, c), abs, platform))) return false
  }
  if (opts.cwd && p.isAbsolute(opts.cwd) && within(abs, opts.cwd, platform)) return false
  return true
}

/** The suggestion with only offerable directories (isOfferableDirectory); null when none is left. */
function offerableDirs(s: PermissionSuggestion, opts: SuggestOptions | undefined): PermissionSuggestion | null {
  if (s.type !== 'addDirectories') return s
  const directories = s.directories.filter((d) => isOfferableDirectory(d, opts))
  return directories.length ? { ...s, directories } : null
}

/**
 * Suggestions for an edit tool, mirroring what the CLI offers: auto-accept edits (setMode acceptEdits), plus the
 * file's folder (addDirectories) when the file is outside the project and the allowed directories and the folder is
 * offerable (isOfferableDirectory). Never a bare `Edit` / `Write` rule, which would allow edits anywhere on disk.
 */
export function editSuggestions(input: unknown, opts?: SuggestOptions): PermissionSuggestion[] {
  const out: PermissionSuggestion[] = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const target = editTargetOf(input)
  if (!target) return out
  const p = (opts?.platform ?? process.platform) === 'win32' ? win32 : posix
  const abs = p.isAbsolute(target) ? p.resolve(target) : opts?.cwd && p.isAbsolute(opts.cwd) ? p.resolve(opts.cwd, target) : null
  if (!abs) return out
  const dir = p.dirname(abs)
  if (!isFreeCdTarget(dir, opts ?? {}) && isOfferableDirectory(dir, opts)) out.push({ type: 'addDirectories', directories: [dir], destination: 'session' })
  return out
}

/** The server of an `mcp__<server>__<tool>` name when the user configured it (SuggestOptions.userMcpServers), else null. */
function userServerOf(toolName: string, opts: SuggestOptions | undefined): string | null {
  if (!opts?.userMcpServers?.length) return null
  const m = /^mcp__([A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*)__./.exec(toolName)
  if (!m || mcpServerOfRule(`mcp__${m[1]}`) === null) return null
  return opts.userMcpServers.includes(m[1]) ? m[1] : null
}

/** A tool rule widened to its server-level rule when the server is the user's (issue #14 C); otherwise unchanged. */
function widenMcpRule(rule: PermissionRuleSpec, opts: SuggestOptions | undefined): PermissionRuleSpec {
  if (rule.ruleContent) return rule
  const server = userServerOf(rule.toolName, opts)
  return server ? { toolName: `mcp__${server}` } : rule
}

/**
 * Rules for when the provider offers none: shell tools get one prefix rule per command segment (shellRuleContents,
 * all or nothing), edit tools get editSuggestions, a user-configured MCP server's tool gets `mcp__<server>`, every
 * other tool is allowed by name (`WebSearch`, `mcp__x__y`).
 */
export function deriveSuggestions(toolName: string, input: unknown, opts?: SuggestOptions): PermissionSuggestion[] {
  if (EDIT_TOOLS.has(toolName)) return editSuggestions(input, opts)
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(input)
    // Without a usable rule, a bare tool-name rule would allow every command; offer nothing.
    const contents = command ? shellRuleContents(toolName, command, opts) : []
    if (!contents.length) return []
    return [{ type: 'addRules', rules: contents.map((ruleContent) => ({ toolName, ruleContent })), behavior: 'allow', destination: 'session' }]
  }
  return [{ type: 'addRules', rules: [widenMcpRule({ toolName }, opts)], behavior: 'allow', destination: 'session' }]
}

const isAllowRules = (s: PermissionSuggestion): s is Extract<PermissionSuggestion, { rules: PermissionRuleSpec[] }> =>
  (s.type === 'addRules' || s.type === 'replaceRules') && s.behavior === 'allow'

/**
 * Suggestions to offer on an approval card: none when the provider forbids a "don't ask again" choice for this ask,
 * otherwise the provider's own suggestions, otherwise ones derived by the harness.
 * - Shell tools: the allow rules offered always cover the command (shellRulesFor with the free-cd options). The
 *   derived per-segment set wins when it covers the command (the provider's `Bash(cd x && npm test *)` never matches
 *   and its exact one-off rules bloat the file, issue #14); else the provider's rules if they cover it; else no rule
 *   at all (allow once only).
 * - MCP tools of a user-configured server get the server-level rule (`mcp__<server>`).
 * - addDirectories entries are kept only when offerable (isOfferableDirectory).
 */
export function chooseSuggestions(
  toolName: string,
  input: unknown,
  provided: PermissionSuggestion[] | undefined,
  suppressed = false,
  opts?: SuggestOptions
): PermissionSuggestion[] {
  if (suppressed) return []
  if (!provided?.length) return deriveSuggestions(toolName, input, opts).map((s) => offerableDirs(s, opts)).filter((s): s is PermissionSuggestion => !!s)
  // A provider's blanket rule (bare Bash / Edit / Write, an exec wrapper) is never offered: a session grant of it would
  // become a PreToolUse bypass (review re-check L-d).
  // Only acceptEdits may come from a provider's setMode (never bypassPermissions, auto or dontAsk; review re-check L6),
  // and a provider's shell prefix rule that is too broad (isTooBroadPrefix, M2) is dropped like a blanket one.
  let out: PermissionSuggestion[] = provided
    .filter((s) => s.type !== 'setMode' || s.mode === 'acceptEdits')
    .map((s) => offerableDirs(s, opts))
    .filter((s): s is PermissionSuggestion => !!s)
    .map((s) => (isAllowRules(s) ? { ...s, rules: s.rules.filter((r) => !isBlanketAllowRule(ruleToString(r)) && !isTooBroadShellRule(r)) } : s))
    .filter((s) => !isAllowRules(s) || s.rules.length > 0)
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(input) ?? ''
    const derived = deriveSuggestions(toolName, input, opts)
    const providedRules = allowRuleStrings(out).filter((r) => r.startsWith(`${toolName}(`))
    const providedCovers = providedRules.length > 0 && !!command && shellRulesFor(command, providedRules, withShell(toolName, opts)) !== null
    const others = out.filter((s) => !isAllowRules(s))
    const template = out.find(isAllowRules)
    if (derived.length) {
      const rules = derived.flatMap((s) => (isAllowRules(s) ? s.rules : []))
      out = [...others, { ...(template ?? { type: 'addRules', behavior: 'allow', destination: 'session' }), rules } as PermissionSuggestion]
    } else if (!providedCovers) out = others
    return out
  }
  return out.map((s) => (isAllowRules(s) ? { ...s, rules: dedupeRules(s.rules.map((r) => widenMcpRule(r, opts))) } : s))
}

/** A shell prefix rule (`npm pkg:*`, `curl *`) whose prefix isTooBroadPrefix; exact shell rules and other tools pass. */
function isTooBroadShellRule(rule: PermissionRuleSpec): boolean {
  if (!SHELL_TOOLS.has(rule.toolName) || !rule.ruleContent) return false
  const prefix = rulePrefix(rule.ruleContent)
  return prefix !== null && isTooBroadPrefix(prefix)
}

function dedupeRules(rules: PermissionRuleSpec[]): PermissionRuleSpec[] {
  const seen = new Set<string>()
  return rules.filter((r) => {
    const k = ruleToString(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** What a 'project' scope may persist besides rules (RuntimeContext; both missing on trust-restricted runs). */
export type AllowScopePersist = Pick<RuntimeContext, 'allowDirectories' | 'acceptEditsForProject'>

/**
 * Apply an allow decision's scope. Returns the suggestions to grant for the rest of the session, or
 * null when the allow covers this call only. Project scope also saves the allow rules to the project, the
 * addDirectories folders through persist.allowDirectories and a setMode acceptEdits through
 * persist.acceptEditsForProject (RunManager logs both and switches the mode only from 'default'). "Saved" is logged
 * only for rules that were new; with `call` given, a shell command the saved rules still do not cover logs a warning.
 */
export function applyAllowScope(
  projectPath: string,
  decision: Extract<PermissionDecision, { behavior: 'allow' }>,
  suggestions: PermissionSuggestion[],
  log: (level: 'info' | 'warn', message: string) => void,
  persist?: AllowScopePersist,
  call?: { toolName: string; input: unknown; opts?: MatchOptions }
): PermissionSuggestion[] | null {
  const scope = decision.scope ?? 'once'
  if (scope === 'once' || suggestions.length === 0) return null
  if (scope === 'project') {
    const all = allowRuleStrings(suggestions)
    // A bare Bash / Edit / Write rule (or one on an exec wrapper) is never written to the project; it applies for this session.
    const rules = all.filter((r) => !isBlanketAllowRule(r))
    if (rules.length < all.length) log('warn', `Not saved for the project (too broad): ${all.filter((r) => isBlanketAllowRule(r)).join(', ')}. It applies to this session only.`)
    try {
      if (rules.length) {
        const { rules: saved, added } = addRulesReport(projectPath, rules)
        if (added.length) log('info', `Saved permission rule${added.length === 1 ? '' : 's'} for this project: ${added.join(', ')}`)
        const command = call && SHELL_TOOLS.has(call.toolName) ? commandOf(call.input) : undefined
        if (command && shellRulesFor(command, saved.filter((r) => r.startsWith(`${call!.toolName}(`)), call!.opts) === null) {
          log('warn', `The saved rules do not cover this command, so it will ask again: ${command.slice(0, 120)}`)
        }
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

