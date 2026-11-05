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
 * counts), and the shell scanner's fail-closed answers (over-long commands, untrackable cds, UNC words) give null so
 * the normal permission flow decides. Honest limits: a command that reaches a protected file through a variable, a
 * glob whose static folder is above the protected path (`cat <dataDir>/r?n/daemon.secret`), a script or program that
 * opens the file itself, an `orgai` reached through an alias, a shell function or a renamed copy, and Grep / Glob over
 * the data dir root (which is allowed) are not detected. Commands a provider runs without asking OrgAI (Codex inside
 * its own sandbox) are governed by that provider's sandbox policy, not this gate.
 */
import { join, resolve } from 'node:path'
import { canonicalDeep } from '../quick/scratch'
import { commandReferenceTouch, pathAtOrUnder } from './referenceDirectories'
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
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
const GLOB_CHAR = /[*?[{]/

/** CLI program names (base name, lowercase). `orgai@1.2.3` (an npx spec) counts too. */
const CLI_NAME = /^orgai(?:@[^\\/]*)?(?:\.(?:exe|cmd|bat|ps1|mjs|js))?$/i
/** Interpreters that could run the CLI bundle or its sources directly. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno', 'electron'])
/** An argument naming the CLI bundle or sources: out/cli or src/cli, either separator. */
const CLI_PATH = /(?:^|[\\/=])(?:out|src)[\\/]cli(?:[\\/]|$)/i
/** Shells whose -c / -Command text is scanned as a nested command. */
const NESTING_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])
const NESTING_FLAGS = /^(?:-[a-z]*c|-command|\/c|\/k)$/i
/** ELECTRON_RUN_AS_NODE set anywhere: `X=1`, `env X=1`, `$env:X = 1`, `set X=1`, `Set-Item env:X`, SetEnvironmentVariable('X'. */
const ELECTRON_AS_NODE = [
  /ELECTRON_RUN_AS_NODE["']?\s*=/i,
  /\benv:ELECTRON_RUN_AS_NODE\b/i,
  /SetEnvironmentVariable\s*\(\s*["']ELECTRON_RUN_AS_NODE/i
]
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
function segmentRunsCli(segment: string, depth: number, budget: { n: number }): boolean {
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
  if (INTERPRETERS.has(bare) && words.slice(at + 1).some((w) => CLI_PATH.test(w))) return true
  if (depth < MAX_NEST && (NESTING_SHELLS.has(bare) || bare === 'eval')) {
    const rest = words.slice(at + 1)
    for (let k = 0; k < rest.length; k++) {
      const inner = bare === 'eval' ? rest.join(' ') : NESTING_FLAGS.test(rest[k]) ? rest.slice(k + 1).join(' ') : null
      if (inner !== null) return textRunsCli(inner, depth + 1, budget)
    }
  }
  return false
}

function textRunsCli(text: string, depth: number, budget: { n: number }): boolean {
  if (ELECTRON_AS_NODE.some((re) => re.test(text))) return true
  for (const segment of cliSegments(text)) if (segmentRunsCli(segment, depth, budget)) return true
  return false
}

/** True when a shell command runs the OrgAI CLI (cli-spec 3.4(1)(a)); exported for tests. */
export function commandRunsOrgaiCli(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false
  return textRunsCli(command, 0, { n: 0 })
}

/** The paths a file tool call names (file_path, path, notebook_path; a Glob / Grep pattern that is absolute or ~). */
function fileTargets(toolName: string, input: Record<string, unknown>, isAbs: (p: string) => boolean): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key]
    if (typeof v === 'string' && v) out.push(v)
  }
  // MultiEdit carries one file_path; edits[] never name another file.
  if (toolName === 'Glob' || toolName === 'Grep') {
    const pattern = input.pattern
    if (typeof pattern === 'string' && pattern && (isAbs(pattern) || pattern === '~' || /^~[\\/]/.test(pattern))) {
      out.push(pattern)
      const idx = pattern.search(GLOB_CHAR)
      if (idx >= 0) {
        const prefix = pattern.slice(0, idx)
        const sep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
        if (sep >= 0) out.push(prefix.slice(0, sep + 1))
      }
    }
  }
  return out
}

/**
 * SELF_CONTROL_DENIAL_MESSAGE when the call must be denied outright, else null. Denied: Read / Glob / Grep / Edit /
 * Write / MultiEdit / NotebookEdit on a protected path, and a Bash / PowerShell segment that runs the OrgAI CLI
 * (`orgai`, `orgai.exe`, `orgai.cmd`, ELECTRON_RUN_AS_NODE, node / tsx / bun / deno on out/cli or src/cli) or names
 * a protected path (or runs inside one). Pure apart from real-path lookups; never throws (an internal error is null).
 */
export function checkSelfControlDenial(toolName: string, input: unknown, ctx: SelfControlContext): string | null {
  try {
    const refs = Array.isArray(ctx?.protectedPaths) ? ctx.protectedPaths.filter((p) => typeof p === 'string' && p !== '') : []
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const platform = ctx.platform ?? process.platform
    if (SHELLS.has(toolName)) {
      const command = i.command
      if (typeof command !== 'string' || !command.trim()) return null
      if (commandRunsOrgaiCli(command)) return SELF_CONTROL_DENIAL_MESSAGE
      if (!refs.length) return null
      const shell = ctx.shell ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
      const touch = commandReferenceTouch(command, ctx.cwd, refs, { mode: 'self-control', shell, platform, home: ctx.home })
      return touch ? SELF_CONTROL_DENIAL_MESSAGE : null
    }
    if (!FILE_TOOLS.has(toolName) || !refs.length) return null
    const isAbs = platform === 'win32' ? (p: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p) : (p: string) => p.startsWith('/')
    for (const target of fileTargets(toolName, i, isAbs)) {
      if (pathAtOrUnder(target, refs, ctx.cwd, { platform, home: ctx.home })) return SELF_CONTROL_DENIAL_MESSAGE
    }
    return null
  } catch {
    return null
  }
}
