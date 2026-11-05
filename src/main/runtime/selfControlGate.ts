/**
 * Pre-mode self-control denial gate (cli-spec 3.4(1)). Agent tools must never drive OrgAI itself: no `orgai` CLI
 * invocation from a shell tool and no access to the host's control and secret files. The check runs in every adapter
 * before any saved rule, permission mode or card (claude.ts PreToolUse, codex.ts onCommandApproval / onFileApproval,
 * mock.ts), like mcpCallDenial and the reference-folder write denials.
 *
 * Protected: `<dataDir>/run` (socket, daemon.json, daemon.secret, startup.mkdir), `<dataDir>/secrets.json`,
 * `<dataDir>/codex` (OrgAI's CODEX_HOME with ChatGPT tokens) and a fallback runtime socket dir. Never protected:
 * `<dataDir>` itself, `quick/` scratch dirs, `project-skills/` and `skills/` (quick runs, MCP build sessions and skill
 * loads read and write there).
 *
 * Only definite hits deny: a path AT or UNDER a protected path (a parent such as the home folder or the data dir never
 * counts for a file path or a shell word), a shell glob whose components can match a protected path
 * (`cat <dataDir>/r?n/daemon.secret`), a leading `$HOME` / `${HOME}` / `$env:USERPROFILE` / `%USERPROFILE%` read as the
 * home folder, and a Grep / Glob search that can descend into a protected path (a Grep rooted at the data dir or any
 * ancestor of a protected path, a Glob whose pattern reaches one). The shell scanner's fail-closed answers (over-long
 * commands, untrackable cds, UNC words) give null so the normal permission flow decides. Running the CLI by
 * interpreter is matched on an `orgai` / `orgai.mjs` / `orgai.js` argument, or on an argument inside this install's
 * own CLI folders (setOrgaiCliRoots: `<app>/out/cli`, `<app>/src/cli`), never on any project's `src/cli`; the
 * ELECTRON_RUN_AS_NODE check needs an assignment (`X=1` before a program or after env / export / set, `$env:X`,
 * Set-Item env:X, SetEnvironmentVariable('X'), never a quoted argument that only mentions it. Honest limits: other
 * variables, a script or program that opens the file itself, an `orgai` reached through an alias, a shell function or
 * a renamed copy, and a Grep `glob` filter (a Grep rooted above a protected path is denied whatever its filter).
 * Commands a provider runs without asking OrgAI (Codex inside its own sandbox) are governed by that provider's sandbox
 * policy, not this gate.
 */
import { join, posix, resolve, win32 } from 'node:path'
import { canonicalDeep } from '../quick/scratch'
import { commandReferenceTouch, pathAtOrUnder, searchReaches } from './referenceDirectories'
import { segmentWords } from './ruleMatch'

export const SELF_CONTROL_DENIAL_MESSAGE = "OrgAI: Agent tools may not invoke the OrgAI CLI or access OrgAI's internal control and secret files."

/** The harness transcript row every adapter writes on the agent when the gate refuses a call. */
export const SELF_CONTROL_REFUSAL_TEXT = "Refused: agents may not run the orgai command or open OrgAI's control files"

/** The log line every adapter writes (warn) when the gate refuses a call. */
export function selfControlLogLine(toolName: string, agent: string): string {
  return `Blocked ${toolName} by ${agent}: OrgAI control files or the orgai command`
}

/**
 * The paths the gate protects, each in its lexical (path.resolve) and canonical (canonicalDeep: real path of the
 * nearest existing ancestor plus the rest) spelling, deduped, in a stable order.
 */
export function controlProtectedPaths(dataDir: string, runtimeSocketDir?: string): string[] {
  const roots = [join(dataDir, 'run'), join(dataDir, 'secrets.json'), join(dataDir, 'codex')]
  if (runtimeSocketDir) roots.push(runtimeSocketDir)
  const out: string[] = []
  for (const p of roots) {
    for (const spelling of [resolve(p), canonicalDeep(p)]) if (!out.includes(spelling)) out.push(spelling)
  }
  return out
}

/** What checkSelfControlDenial needs besides the tool call. */
export interface SelfControlContext {
  /** controlProtectedPaths() of the host (RuntimeContext.controlProtectedPaths). */
  protectedPaths: readonly string[]
  /** The agent's effective cwd (relative paths and cd tracking start here). */
  cwd?: string
  /** Shell grammar of a Bash / PowerShell command. Default from the tool name. */
  shell?: 'bash' | 'powershell'
  platform?: NodeJS.Platform
  /** For `~` expansion. */
  home?: string
  /** This install's CLI folders (an interpreter run of a file inside one is the CLI). Default: setOrgaiCliRoots. */
  cliRoots?: readonly string[]
}

let configuredCliRoots: string[] = []

/**
 * The CLI folders of this OrgAI install, set once by the host entry (index.ts: app.getAppPath(); inprocHost.ts: the
 * CLI bundle's own folder): `node <root>/x.mjs` or `tsx <root>/index.ts` inside one counts as running the CLI.
 */
export function setOrgaiCliRoots(roots: readonly string[]): void {
  configuredCliRoots = roots.filter((r) => typeof r === 'string' && r !== '').map((r) => resolve(r))
}

/** The CLI folders of an app root: `<root>/out/cli` (the bundle) and `<root>/src/cli` (sources, dev). */
export function orgaiCliRootsOf(appRoot: string): string[] {
  return [join(appRoot, 'out', 'cli'), join(appRoot, 'src', 'cli')]
}

interface CliCheck {
  cwd?: string
  roots: readonly string[]
  platform: NodeJS.Platform
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/** CLI program names (base name, lowercase). `orgai@1.2.3` (an npx spec) counts too. */
const CLI_NAME = /^orgai(?:@[^\\/]*)?(?:\.(?:exe|cmd|bat|ps1|mjs|js))?$/i
/** Interpreters that could run the CLI bundle or its sources directly. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno', 'electron'])
/** A path-looking argument (an interpreter's script): a separator or a script extension. */
const PATHISH = /[\\/]|\.(?:m?[jt]sx?|c[jt]s)$/i
/** Shells whose -c / -Command text is scanned as a nested command. */
const NESTING_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])
const NESTING_FLAGS = /^(?:-[a-z]*c|-command|\/c|\/k)$/i
/** ELECTRON_RUN_AS_NODE set by PowerShell: `$env:X = 1`, `Set-Item env:X`, `SetEnvironmentVariable('X'`. */
const ELECTRON_AS_NODE_PS = [/\$env:ELECTRON_RUN_AS_NODE\s*=/i, /\bset-item\b[^;|&\n]*\benv:ELECTRON_RUN_AS_NODE\b/i, /SetEnvironmentVariable\s*\(\s*["']ELECTRON_RUN_AS_NODE/i]
const ELECTRON_AS_NODE_ASSIGN = /^ELECTRON_RUN_AS_NODE=/i
/** Words that may come before an assignment in a segment (env, export, cmd `set`, declare...). */
const ASSIGN_LEADERS: ReadonlySet<string> = new Set(['env', 'export', 'set', 'declare', 'typeset', 'local', 'readonly', 'sudo', 'command', 'exec', 'nohup'])
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_NEST = 3
const MAX_SEGMENTS = 2000

function binName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase()
}

function stripExe(name: string): string {
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/**
 * Split on `;`, `&`, `|`, newlines, parentheses and braces outside quotes (more eagerly than ruleMatch splitCommand:
 * pipes and subshells start a new program too), plus the bodies of `$(...)` and backtick substitutions outside single
 * quotes as segments of their own.
 */
function cliSegments(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
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
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  // Substitutions inside double quotes ("$(orgai status)", "`orgai x`").
  let outside = ''
  quote = null
  for (const ch of text) {
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (ch === "'" && quote === null) {
      quote = "'"
      continue
    }
    if (ch === '"') quote = quote === '"' ? null : '"'
    outside += ch
  }
  for (const m of outside.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? '')
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Index of the program word after env assignments and wrappers (env, command, exec, nohup, time, npx, npm exec...). */
function programIndex(words: readonly string[]): number {
  let i = 0
  for (let guard = 0; i < words.length && guard < 64; guard++) {
    const w = words[i]
    if (ASSIGNMENT.test(w)) {
      i++
      continue
    }
    const name = stripExe(binName(w))
    const next = words[i + 1] ? stripExe(binName(words[i + 1])) : ''
    if (name === 'env') {
      i++
      while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]))) {
        // `env -u NAME` / `env -C dir` take a value.
        if (/^-[uCS]$/.test(words[i]) || /^--(?:unset|chdir|split-string)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if (['command', 'exec', 'nohup', 'time', 'builtin', 'sudo', 'doas', 'stdbuf', 'caffeinate', 'call', 'start', 'xargs', 'nice', 'ionice', 'chrt', 'setsid', 'bunx', 'pnpx'].includes(name)) {
      i++
      // Options of the wrapper (and a value after nice -n / timeout's duration).
      while (i < words.length && words[i].startsWith('-')) {
        if (/^-(?:n|p|c|u|I|L|P)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if (name === 'timeout') {
      i++
      while (i < words.length && words[i].startsWith('-')) i++
      i++ // duration
      continue
    }
    if (name === 'npx') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (/^(?:-p|--package)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if ((name === 'npm' && (next === 'exec' || next === 'x')) || ((name === 'pnpm' || name === 'yarn') && (next === 'dlx' || next === 'exec')) || (name === 'bun' && next === 'x')) {
      i += 2
      while (i < words.length && words[i].startsWith('-')) {
        if (/^(?:-p|--package)$/.test(words[i])) i++
        i++
      }
      if (words[i] === '--') i++
      continue
    }
    break
  }
  return i
}

/** True when one segment (or a shell -c text inside it) runs the OrgAI CLI. */
function segmentRunsCli(segment: string, depth: number, budget: { n: number }, check: CliCheck): boolean {
  if (++budget.n > MAX_SEGMENTS) return false
  const words = segmentWords(segment)
  if (!words.length) return false
  // npx / npm exec with `-p orgai` / `--package=orgai`.
  const runner = words.some((w) => PACKAGE_RUNNERS.has(stripExe(binName(w))))
  for (let k = 0; runner && k < words.length; k++) {
    if (/^(?:-p|--package)$/.test(words[k]) && words[k + 1] && CLI_NAME.test(binName(words[k + 1]))) return true
    const eq = /^--package=(.+)$/.exec(words[k])
    if (eq && CLI_NAME.test(binName(eq[1]))) return true
  }
  const at = programIndex(words)
  const prog = words[at]
  if (prog === undefined) return false
  const name = binName(prog)
  if (CLI_NAME.test(name)) return true
  const bare = stripExe(name)
  if (INTERPRETERS.has(bare) && words.slice(at + 1).some((w) => interpreterArgIsCli(w, check))) return true
  if (depth < MAX_NEST && (NESTING_SHELLS.has(bare) || bare === 'eval')) {
    const rest = words.slice(at + 1)
    for (let k = 0; k < rest.length; k++) {
      const inner = bare === 'eval' ? rest.join(' ') : NESTING_FLAGS.test(rest[k]) ? rest.slice(k + 1).join(' ') : null
      if (inner !== null) return textRunsCli(inner, depth + 1, budget, check)
    }
  }
  return false
}

/**
 * An interpreter argument that is the CLI: an `orgai` / `orgai.mjs` / `orgai.js` file, or a path (relative against the
 * cwd) inside one of this install's CLI folders.
 */
function interpreterArgIsCli(word: string, check: CliCheck): boolean {
  const value = word.replace(/^--?[A-Za-z][\w-]*=/, '')
  if (!value || value.startsWith('-')) return false
  if (CLI_NAME.test(binName(value)) && PATHISH.test(value)) return true
  if (!check.roots.length || !PATHISH.test(value)) return false
  const p = check.platform === 'win32' ? win32 : posix
  const fold = (v: string): string => (check.platform === 'win32' || check.platform === 'darwin' ? v.toLowerCase() : v)
  const abs = p.isAbsolute(value) ? p.resolve(value) : check.cwd && p.isAbsolute(check.cwd) ? p.resolve(check.cwd, value) : null
  if (!abs) return false
  for (const root of check.roots) {
    const rel = p.relative(fold(p.resolve(root)), fold(abs))
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))) return true
  }
  return false
}

/** Quoted spans replaced by a placeholder, so only unquoted text is read as an assignment. */
function unquoted(text: string): string {
  let out = ''
  let quote: string | null = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) {
        quote = null
        out += 'Q'
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    out += ch
  }
  return out
}

/** True when a segment assigns ELECTRON_RUN_AS_NODE: before its program, or after env / export / set / declare. */
function assignsElectronAsNode(segment: string): boolean {
  const words = segment.split(/\s+/).filter(Boolean)
  for (const w of words) {
    if (ELECTRON_AS_NODE_ASSIGN.test(w)) return true
    if (ASSIGNMENT.test(w) || w.startsWith('-') || ASSIGN_LEADERS.has(stripExe(binName(w)))) continue
    // setx NAME value (Windows, persistent).
    return false
  }
  return false
}

function textRunsCli(text: string, depth: number, budget: { n: number }, check: CliCheck): boolean {
  if (ELECTRON_AS_NODE_PS.some((re) => re.test(text))) return true
  const plain = unquoted(text)
  if (/\bsetx\s+ELECTRON_RUN_AS_NODE\b/i.test(plain)) return true
  for (const segment of cliSegments(plain)) if (assignsElectronAsNode(segment)) return true
  for (const segment of cliSegments(text)) if (segmentRunsCli(segment, depth, budget, check)) return true
  return false
}

/** True when a shell command runs the OrgAI CLI (cli-spec 3.4(1)(a)); exported for tests. */
export function commandRunsOrgaiCli(command: string, opts: { cwd?: string; cliRoots?: readonly string[]; platform?: NodeJS.Platform } = {}): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  return textRunsCli(command, 0, { n: 0 }, { cwd: opts.cwd, roots: opts.cliRoots ?? configuredCliRoots, platform: opts.platform ?? process.platform })
}

/** The paths a file tool call names (file_path, path, notebook_path). MultiEdit's edits[] never name another file. */
function fileTargets(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key]
    if (typeof v === 'string' && v) out.push(v)
  }
  return out
}

/**
 * Grep / Glob: true when the search can descend into a protected path. Grep searches recursively from `path` (else
 * the cwd), so a root that is the data dir or any ancestor of a protected path reaches it whatever its `glob` filter;
 * an absolute Grep `pattern` that names a protected path counts too (the old rule). Glob lists what its `pattern`
 * (relative to `path`, else the cwd; or absolute / ~) matches.
 */
function searchDenied(toolName: string, input: Record<string, unknown>, refs: readonly string[], ctx: SelfControlContext, platform: NodeJS.Platform): boolean {
  const opts = { platform, home: ctx.home }
  const root = typeof input.path === 'string' && input.path ? input.path : ctx.cwd
  const pattern = typeof input.pattern === 'string' && input.pattern ? input.pattern : undefined
  if (toolName === 'Grep') {
    if (root !== undefined && searchReaches(root, undefined, refs, ctx.cwd, opts)) return true
    return pattern !== undefined && isRootedPattern(pattern, platform) && pathAtOrUnder(pattern, refs, ctx.cwd, opts) !== null
  }
  if (pattern === undefined) return root !== undefined && pathAtOrUnder(root, refs, ctx.cwd, opts) !== null
  if (root !== undefined && pathAtOrUnder(root, refs, ctx.cwd, opts)) return true
  return searchReaches(root ?? '', pattern, refs, ctx.cwd, opts) !== null
}

/** An absolute or ~ pattern (Grep's regex is a path only then). */
function isRootedPattern(pattern: string, platform: NodeJS.Platform): boolean {
  const abs = platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(pattern) : pattern.startsWith('/')
  return abs || pattern === '~' || /^~[\\/]/.test(pattern)
}

/**
 * SELF_CONTROL_DENIAL_MESSAGE when the call must be denied outright, else null. Denied: Read / Glob / Grep / Edit /
 * Write / MultiEdit / NotebookEdit on a protected path, and a Bash / PowerShell segment that runs the OrgAI CLI
 * (`orgai`, `orgai.exe`, `orgai.cmd`, an ELECTRON_RUN_AS_NODE assignment, node / tsx / bun / deno on `orgai.mjs` or a
 * file in this install's CLI folders) or names a protected path (or runs inside one). Pure apart from real-path lookups; never throws (an internal error is null).
 */
export function checkSelfControlDenial(toolName: string, input: unknown, ctx: SelfControlContext): string | null {
  try {
    const refs = Array.isArray(ctx?.protectedPaths) ? ctx.protectedPaths.filter((p) => typeof p === 'string' && p !== '') : []
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const platform = ctx.platform ?? process.platform
    if (SHELLS.has(toolName)) {
      const command = i.command
      if (typeof command !== 'string' || !command.trim()) return null
      if (commandRunsOrgaiCli(command, { cwd: ctx.cwd, cliRoots: ctx.cliRoots, platform })) return SELF_CONTROL_DENIAL_MESSAGE
      if (!refs.length) return null
      const shell = ctx.shell ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
      const touch = commandReferenceTouch(command, ctx.cwd, refs, { mode: 'self-control', shell, platform, home: ctx.home })
      return touch ? SELF_CONTROL_DENIAL_MESSAGE : null
    }
    if (!FILE_TOOLS.has(toolName) || !refs.length) return null
    if (toolName === 'Glob' || toolName === 'Grep') return searchDenied(toolName, i, refs, ctx, platform) ? SELF_CONTROL_DENIAL_MESSAGE : null
    for (const target of fileTargets(i)) {
      if (pathAtOrUnder(target, refs, ctx.cwd, { platform, home: ctx.home })) return SELF_CONTROL_DENIAL_MESSAGE
    }
    return null
  } catch {
    return null
  }
}
