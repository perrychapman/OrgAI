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
 * ancestor of a protected path, a Glob whose pattern reaches one), unless its file filter (Grep `glob` / `type`, the
 * Glob pattern) only matches source or document extensions no protected file has (review M3: a search of the home
 * folder for `*.ts`). A shell command the scanners cannot read to the end (over 256 KB, over 20,000 words, 40,000
 * parts or 2,000 segments, quoting or `bash -c` nested deeper than three levels), an internal error, or a run whose
 * protected paths are unavailable (review M2) is denied with SELF_CONTROL_UNCHECKED_MESSAGE, since bypassPermissions
 * would otherwise run it unread. Bash here-documents whose body is only data (stripDataHeredocs: `cat <<'EOF' >
 * file`, a `git commit -m "$(cat <<'EOF' ...)"` message) are left out of the scan first. Text piped into an
 * interpreter or POSIX shell that runs a script file is data, not code (review M3), and a test runner (`node --test`,
 * `bun test`, vitest) given test files or folders of this install's own `src/cli` is not the CLI. The scanner's other
 * fail-closed answers (untrackable cds, UNC words) give null so the normal permission flow decides. Running the CLI by
 * interpreter is matched on an `orgai` / `orgai.mjs` / `orgai.js` argument, or on an argument inside this install's
 * own CLI folders (setOrgaiCliRoots: `<app>/out/cli`, `<app>/src/cli`, and in a packaged app
 * `<Resources>/app.asar.unpacked/out/cli` and `<Resources>/bin`), never on any project's `src/cli`; sh / bash / zsh /
 * dash / ksh given such a file (or an `orgai`-named one) as their script count the same way (every word that may be
 * an option's value is checked too: `bash -O extglob <launcher>`, `bash --rcfile F <launcher>`), as do an input
 * redirect of such a file into a shell or interpreter and `.` / `source` of one; `env -S '<text>'` is read as a
 * command text of its own; the words after `find -exec` / `-execdir` / `-ok`, `fd -x` / `-X` and `watch` are a
 * command. Program and script words are read the way the shell expands them: brace expansions are expanded
 * (`orga{i,}`; at most 256 words, past that the command is unchecked), backslash escapes removed (`org\ai`), and a glob
 * (`<Resources>/bin/orga?`, `<Resources>/bin/*`, `~/.local/bin/orga*`) counts when it may match an orgai file name or
 * reach a CLI folder (a glob argument must keep three of the name's letters, so `node x.mjs src/*.js` passes). Code
 * fed to a shell, an interpreter or `.` / `source` is read too: a here-string (`bash <<< 'orgai x'`), and for a pipe
 * into one every earlier piece of the command (`echo 'orgai runs stop R1' | sh`, `cat ~/.local/bin/orgai | sh -s
 * status`) counts when one of its words names the CLI or is a command text running it, as does any `$(...)`, backtick
 * or `<(...)` body (`sh -c "$(cat <launcher>)"`, `echo "$(which orgai)"`, fail closed). The
 * ELECTRON_RUN_AS_NODE check needs an assignment (`X=1` before a program or after env / export / set, `$env:X`,
 * Set-Item env:X, SetEnvironmentVariable('X'), never a quoted argument that only mentions it. Honest limits: other
 * variables (`$p status` with p=orgai), a script or program that opens the file itself or sets ELECTRON_RUN_AS_NODE
 * itself (a Python or Node script; the packaged app keeps Electron's RunAsNode fuse on, cli-spec Wave 6 deviations),
 * text a program generates rather than names (`printf 'org%sai'`, `base64 -d`, a download, a file whose contents run
 * orgai: `cat notes.sh | sh`), commands other wrappers run (`parallel`, `script -c`, a Makefile, an npm script, a
 * PowerShell backtick escape), an `orgai` reached through an alias, a shell function or a renamed copy outside the
 * CLI folders, and a Grep `glob` filter (a Grep rooted above a protected path is denied whatever its filter).
 * Commands a provider runs without asking OrgAI (Codex inside its own sandbox) are governed by that provider's sandbox
 * policy, not this gate.
 */
import { join, posix, resolve, win32 } from 'node:path'
import { packagedCliRoots } from '../host/packagedLayout'
import { canonicalDeep } from '../quick/scratch'
import { commandControlScan, pathAtOrUnder, searchReaches } from './referenceDirectories'
import { segmentWords } from './ruleMatch'

export const SELF_CONTROL_DENIAL_MESSAGE = "OrgAI: Agent tools may not invoke the OrgAI CLI or access OrgAI's internal control and secret files."

/**
 * The denial for a shell command the gate could not check (a scan limit, an internal error, or a run whose protected
 * paths are unavailable; review M2): under bypassPermissions or the 'auto' classifier the normal flow would allow it,
 * so the gate never lets an unchecked command through.
 */
export const SELF_CONTROL_UNCHECKED_MESSAGE =
  "OrgAI: OrgAI could not check that this command leaves the OrgAI CLI and OrgAI's control files alone, so it was not run. If it is very long or deeply nested, split it into shorter commands."

/** The warning every adapter logs once per run when the run's protected paths are unavailable (review M2). */
export const SELF_CONTROL_PATHS_UNAVAILABLE_LOG =
  'OrgAI control paths are unavailable for this run; the self-control gate refuses shell commands until they are back'

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
  /**
   * The run has a protected-path source (RuntimeContext.controlProtectedPaths) but it threw or returned none (review
   * M2): a shell command cannot be checked against the control files, so it is denied with
   * SELF_CONTROL_UNCHECKED_MESSAGE (the orgai command check still runs first). File tools are left to the normal flow.
   */
  pathsUnavailable?: boolean
}

/**
 * The protected paths of a run, for the adapters' gate call (review M2): `paths` from RuntimeContext.controlProtectedPaths
 * (an empty list when it threw or returned junk) and `unavailable` when the context has that source but it gave none,
 * so shell commands fail closed. A context without the source (tests, drafts) is not unavailable.
 */
export function readControlProtectedPaths(source: (() => string[]) | undefined): { paths: string[]; unavailable: boolean } {
  if (!source) return { paths: [], unavailable: false }
  let paths: unknown
  try {
    paths = source()
  } catch {
    paths = undefined
  }
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p !== '') : []
  return { paths: list, unavailable: list.length === 0 }
}

let configuredCliRoots: string[] = []

/**
 * The CLI folders of this OrgAI install, set once by the host entry (index.ts: app.getAppPath(); inprocHost.ts: the
 * CLI bundle's own folder): `node <root>/x.mjs` or `tsx <root>/index.ts` inside one counts as running the CLI.
 */
export function setOrgaiCliRoots(roots: readonly string[]): void {
  configuredCliRoots = roots.filter((r) => typeof r === 'string' && r !== '').map((r) => resolve(r))
}

/**
 * The CLI folders of an app root: `<root>/out/cli` (the bundle) and `<root>/src/cli` (sources, dev), plus for a
 * packaged app (`<Resources>/app.asar` or `app.asar.unpacked`) the unpacked bundle `<Resources>/app.asar.unpacked/out/cli`
 * and the launcher folder `<Resources>/bin` (packagedLayout.ts `packagedCliRoots`).
 */
export function orgaiCliRootsOf(appRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  const out = [join(appRoot, 'out', 'cli'), join(appRoot, 'src', 'cli')]
  for (const r of packagedCliRoots(appRoot, platform)) if (!out.includes(r)) out.push(r)
  return out
}

interface CliCheck {
  cwd?: string
  roots: readonly string[]
  platform: NodeJS.Platform
  /** The interpreter is a test runner: test files and folders under a `src/cli` root are not the CLI (isTestRun). */
  testRun?: boolean
}

/** Test runner programs an interpreter may run as its script (`node node_modules/.bin/vitest run src/cli`). */
const TEST_RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'uvu'])
/** A test file name: `x.test.ts`, `x.spec.mjs`, `x_test.js`. */
const TEST_FILE = /(?:[._-](?:test|spec))\.[cm]?[jt]sx?$/i

/** The interpreter runs tests: `node|tsx --test ...`, `bun|deno test ...`, or a test runner as its script. */
function isTestRun(bare: string, rest: readonly string[]): boolean {
  const positional = rest.filter((w) => !w.startsWith('-'))
  const runnerName = (w: string | undefined): boolean => w !== undefined && TEST_RUNNERS.has(binName(w).replace(/\.[cm]?js$/, ''))
  if (bare === 'bun' || bare === 'deno') {
    if (positional[0] === 'test') return true
    if ((positional[0] === 'run' || positional[0] === 'x') && runnerName(positional[1])) return true
    return runnerName(positional[0])
  }
  if (rest.some((w) => /^--test(?:$|=|-)/.test(w))) return true
  return runnerName(positional[0])
}

/** A root holding CLI sources (`<repo>/src/cli`), never a bundle or the packaged launcher folder. */
function isSourceCliRoot(root: string, platform: NodeJS.Platform): boolean {
  const parts = root.split(/[\\/]+/).filter(Boolean)
  const fold = (s: string | undefined): string | undefined => (platform === 'linux' ? s : s?.toLowerCase())
  return fold(parts.at(-1)) === 'cli' && fold(parts.at(-2)) === 'src'
}

/** In a test run: a test file, a folder (no extension) or a test-file glob, which the runner reads but never runs as the CLI. */
function testRunTarget(value: string): boolean {
  const base = value.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return base === '' || !base.includes('.') || TEST_FILE.test(base)
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
/** POSIX shells that run a script file given as their first non-option argument (`sh <res>/bin/orgai status`). */
const SCRIPT_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** ELECTRON_RUN_AS_NODE set by PowerShell: `$env:X = 1`, `Set-Item env:X`, `SetEnvironmentVariable('X'`. */
const ELECTRON_AS_NODE_PS = [/\$env:ELECTRON_RUN_AS_NODE\s*=/i, /\bset-item\b[^;|&\n]*\benv:ELECTRON_RUN_AS_NODE\b/i, /SetEnvironmentVariable\s*\(\s*["']ELECTRON_RUN_AS_NODE/i]
const ELECTRON_AS_NODE_ASSIGN = /^ELECTRON_RUN_AS_NODE=/i
/** Words that may come before an assignment in a segment (env, export, cmd `set`, declare...). */
const ASSIGN_LEADERS: ReadonlySet<string> = new Set(['env', 'export', 'set', 'declare', 'typeset', 'local', 'readonly', 'sudo', 'command', 'exec', 'nohup'])
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_NEST = 3
const MAX_SEGMENTS = 2000

/** Segments read so far; `limited` once MAX_SEGMENTS or MAX_NEST cut the scan short. */
type CliBudget = { n: number; limited: boolean }

function binName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase()
}

function stripExe(name: string): string {
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/** One piece of a shell text: `pipeIn` when a single `|` (or `|&`) feeds it, `producer` for a `$(...)`, backtick or
 * `<(...)` body (its output becomes words, a script or a file). */
interface CliSegment {
  text: string
  pipeIn: boolean
  producer: boolean
}

/**
 * Split on `;`, `&`, `|`, newlines, parentheses and braces outside quotes (more eagerly than ruleMatch splitCommand:
 * pipes and subshells start a new program too), plus the bodies of `$(...)`, `<(...)` / `>(...)` and backtick
 * substitutions outside single quotes as segments of their own. With `keepBraces` a `{` / `}` never splits, so a
 * brace expansion (`orga{i,}`) stays one word for expandBraces.
 */
function cliSegments(text: string, keepBraces = false): CliSegment[] {
  const out: CliSegment[] = []
  let cur = ''
  let pipeIn = false
  let quote: string | null = null
  // An empty piece (`a | (sh)`, `(a) | sh`) passes its pipe on to the next one.
  const push = (nextPipe: boolean): void => {
    if (cur.trim() === '') pipeIn ||= nextPipe
    else {
      out.push({ text: cur, pipeIn, producer: false })
      pipeIn = nextPipe
    }
    cur = ''
  }
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
    if (ch === '|') {
      if (text[i + 1] === '|') {
        i++
        push(false)
      } else {
        if (text[i + 1] === '&') i++
        push(true)
      }
      continue
    }
    if (ch === '&' && text[i + 1] === '&') {
      i++
      push(false)
      continue
    }
    if (ch === ')' || ch === '}') {
      if (ch === '}' && keepBraces) {
        cur += ch
        continue
      }
      push(false)
      continue
    }
    if (ch === ';' || ch === '&' || ch === '\n' || ch === '\r' || ch === '(' || ch === '{' || ch === '`') {
      if (ch === '{' && keepBraces) {
        cur += ch
        continue
      }
      push(false)
      continue
    }
    cur += ch
  }
  push(false)
  // Substitutions inside double quotes ("$(orgai status)", "`orgai x`") and process substitutions.
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
  for (const m of outside.matchAll(/[$<>]\(([^()]*)\)|`([^`]*)`/g)) out.push({ text: m[1] ?? m[2] ?? '', pipeIn: false, producer: true })
  return out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text !== '')
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
    if (['command', 'exec', 'nohup', 'time', 'builtin', 'sudo', 'doas', 'stdbuf', 'caffeinate', 'call', 'start', 'xargs', 'nice', 'ionice', 'chrt', 'setsid', 'bunx', 'pnpx', 'watch'].includes(name)) {
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

/** The text `env -S` / `--split-string` splits into words, joined with the words after it; null without one. */
function envSplitText(words: readonly string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    if (stripExe(binName(words[i])) !== 'env') continue
    for (let j = i + 1; j < words.length && words[j].startsWith('-'); j++) {
      const w = words[j]
      let value: string | undefined
      let after = j + 1
      if (w === '-S' || w === '--split-string') {
        value = words[j + 1]
        after = j + 2
      } else if (w.startsWith('--split-string=')) value = w.slice('--split-string='.length)
      else if (/^-[^-]*S/.test(w)) value = w.slice(w.indexOf('S') + 1) || words[(after = j + 2) - 1]
      if (value !== undefined) return [value, ...words.slice(after)].join(' ')
      if (/^-[uC]$/.test(w) || /^--(?:unset|chdir)$/.test(w)) j++
    }
  }
  return null
}

/** True when one segment (or a shell -c text inside it) runs the OrgAI CLI. */
function segmentRunsCli(segment: string, depth: number, budget: CliBudget, check: CliCheck): boolean {
  // Past the budget the rest of the command goes unread: count it as running the CLI (fail closed).
  if (++budget.n > MAX_SEGMENTS) return (budget.limited = true)
  const words = expandWords(segmentWords(segment), budget)
  return wordsRunCli(words, depth, budget, check)
}

/** `find -exec` / `-execdir` / `-ok` / `-okdir` and `fd -x` / `-X` / `--exec` / `--exec-batch`: the command they run. */
const FIND_EXEC: Readonly<Record<string, RegExp>> = { find: /^-(?:exec|execdir|ok|okdir)$/, gfind: /^-(?:exec|execdir|ok|okdir)$/, fd: /^(?:-x|-X|--exec|--exec-batch)$/, fdfind: /^(?:-x|-X|--exec|--exec-batch)$/ }

function wordsRunCli(words: readonly string[], depth: number, budget: CliBudget, check: CliCheck): boolean {
  if (!words.length) return false
  // npx / npm exec with `-p orgai` / `--package=orgai`.
  const runner = words.some((w) => PACKAGE_RUNNERS.has(stripExe(binName(w))))
  for (let k = 0; runner && k < words.length; k++) {
    if (/^(?:-p|--package)$/.test(words[k]) && words[k + 1] && CLI_NAME.test(binName(words[k + 1]))) return true
    const eq = /^--package=(.+)$/.exec(words[k])
    if (eq && CLI_NAME.test(binName(eq[1]))) return true
  }
  // `env -S 'X=1 prog' args`: the split string is a command text of its own (assignments included).
  const split = envSplitText(words)
  if (split !== null) {
    if (depth >= MAX_NEST) return (budget.limited = true)
    if (textRunsCli(split, depth + 1, budget, check)) return true
  }
  const at = programIndex(words)
  const prog = words[at]
  if (prog === undefined) return false
  if (programIsCli(prog, check)) return true
  const name = binName(prog)
  const bare = stripExe(name)
  const rest = words.slice(at + 1)
  // `find . -exec orgai status \;`: the words after -exec are a command of their own.
  const execFlag = FIND_EXEC[bare]
  if (execFlag) {
    for (let k = 0; k < rest.length; k++) {
      if (!execFlag.test(rest[k])) continue
      const cmd: string[] = []
      for (const w of rest.slice(k + 1)) {
        if (w === ';' || w === '\\' || w === '+' || w === '\\;') break
        cmd.push(w)
      }
      if (wordsRunCli(cmd, depth, budget, check)) return true
    }
  }
  // A here-string fed to a shell or interpreter is a script (`bash <<< 'orgai runs stop R1'`).
  if (readsCode(prog, bare)) {
    for (const text of hereStrings(rest)) {
      if (scriptWordIsCli(text, check)) return true
      if (depth >= MAX_NEST) return (budget.limited = true)
      if (textRunsCli(text, depth + 1, budget, check)) return true
    }
  }
  // `. <file>` / `source <file>` runs a script in the current shell.
  if ((prog === '.' || name === 'source') && rest[0] !== undefined && scriptWordIsCli(rest[0], check)) return true
  if (INTERPRETERS.has(bare)) {
    // A test runner (`node --test`, `bun test`, `deno test`, vitest / jest run by the interpreter) reads test files and
    // folders of this install's own src/cli when the install is the repo being edited (review M3): those are not the CLI.
    const testCheck: CliCheck = isTestRun(bare, rest) ? { ...check, testRun: true } : check
    if (rest.some((w) => interpreterArgIsCli(w, testCheck)) || redirectFeedsCli(rest, check)) return true
  }
  // `sh <file>`, `bash -e <file>`: a POSIX shell runs its first non-option argument as a script.
  if (SCRIPT_SHELLS.has(bare) && shellScriptIsCli(rest, check)) return true
  if (NESTING_SHELLS.has(bare) || bare === 'eval') {
    for (let k = 0; k < rest.length; k++) {
      const inner = bare === 'eval' ? rest.join(' ') : NESTING_FLAGS.test(rest[k]) ? rest.slice(k + 1).join(' ') : null
      if (inner === null) continue
      // A shell text nested deeper than MAX_NEST is not read: fail closed.
      if (depth >= MAX_NEST) {
        if (!inner.trim()) return false
        return (budget.limited = true)
      }
      return textRunsCli(inner, depth + 1, budget, check)
    }
  }
  return false
}

/** A program that runs what it reads on stdin (or a here-string) as code: a shell, an interpreter, `.` / `source`. */
function readsCode(prog: string, bare: string): boolean {
  return SCRIPT_SHELLS.has(bare) || NESTING_SHELLS.has(bare) || INTERPRETERS.has(bare) || prog === '.' || bare === 'source'
}

/** The texts of `<<< text` / `<<<text` here-strings among the words. */
function hereStrings(rest: readonly string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const m = /^\d*<<<(.*)$/.exec(rest[k])
    if (!m) continue
    const text = m[1] !== '' ? m[1] : rest[++k]
    if (text !== undefined && text !== '') out.push(text)
  }
  return out
}

/**
 * A segment whose output may become code or a script: a word naming the CLI (`cat ~/.local/bin/orgai | sh`,
 * `sh -c "$(cat <launcher>)"`, `echo orgai status | sh`) or a word that is itself a command text running it
 * (`echo 'orgai runs stop R1' | sh`).
 */
function producerRunsCli(segment: string, depth: number, budget: CliBudget, check: CliCheck): boolean {
  if (++budget.n > MAX_SEGMENTS) return (budget.limited = true)
  for (const w of expandWords(segmentWords(segment), budget)) {
    if (literalNamesCli(w, check) || scriptWordIsCli(w, check)) return true
    if (/\s/.test(w)) {
      if (depth >= MAX_NEST) return (budget.limited = true)
      if (textRunsCli(w, depth + 1, budget, check)) return true
    }
  }
  return false
}

/** Most words one segment's brace expansions may produce before the scan gives up (fail closed). */
const MAX_BRACE_WORDS = 256

/** The words after bash brace expansion (`orga{i,}` -> `orgai orga`); numeric and letter ranges keep their first value. */
function expandWords(words: readonly string[], budget: CliBudget): string[] {
  if (!words.some((w) => w.includes('{'))) return [...words]
  const out: string[] = []
  for (const w of words) {
    for (const e of expandBraces(w, MAX_BRACE_WORDS - out.length)) out.push(e)
    if (out.length >= MAX_BRACE_WORDS) {
      budget.limited = true
      break
    }
  }
  return out
}

function expandBraces(word: string, limit: number): string[] {
  // The first `{` with a matching `}` that holds a top-level comma or a `..` range.
  for (let open = word.indexOf('{'); open !== -1; open = word.indexOf('{', open + 1)) {
    let depth = 0
    const commas: number[] = []
    let close = -1
    for (let i = open; i < word.length; i++) {
      const ch = word[i]
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        close = i
        break
      } else if (ch === ',' && depth === 1) commas.push(i)
    }
    if (close === -1) return [word]
    const pre = word.slice(0, open)
    const post = word.slice(close + 1)
    let alts: string[]
    if (commas.length) {
      alts = []
      let from = open + 1
      for (const c of [...commas, close]) {
        alts.push(word.slice(from, c))
        from = c + 1
      }
    } else {
      const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/.exec(word.slice(open + 1, close))
      if (!range) continue
      alts = [range[1]]
    }
    const out: string[] = []
    for (const alt of alts) {
      for (const e of expandBraces(pre + alt + post, limit - out.length)) {
        out.push(e)
        if (out.length >= limit) return out
      }
    }
    return out
  }
  return [word]
}

/** The CLI file names a glob in a program or script word may stand for. */
const CLI_FILE_NAMES = ['orgai', 'orgai.exe', 'orgai.cmd', 'orgai.bat', 'orgai.ps1', 'orgai.mjs', 'orgai.js']
const GLOB_CHARS = /[*?[]/

/** The ways a shell may read one word: as written and with backslash escapes removed (`org\ai` is `orgai`). */
function spellings(word: string): string[] {
  const unescaped = word.replace(/\\(.)/g, '$1')
  return unescaped === word ? [word] : [word, unescaped]
}

/** A glob component (`orga?`, `*`, `[o]rgai`, `[!x]*`) as a whole-string, case-insensitive pattern. */
function globRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end === -1) re += '\\['
      else {
        let body = pattern.slice(i + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        re += `[${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  try {
    return new RegExp(`^${re}$`, 'i')
  } catch {
    return /^.*$/
  }
}

/**
 * A program word that runs the CLI: an orgai-named file (also after backslash escapes), a path at or inside one of this
 * install's CLI folders (`<Resources>/bin/<anything>`), or a glob that may expand to either (`<Resources>/bin/orga?`,
 * `~/.local/bin/orga*`, `./o*`). Brace expansions arrive expanded (expandWords).
 */
function programIsCli(word: string, check: CliCheck): boolean {
  for (const w of spellings(word)) {
    if (CLI_NAME.test(binName(w))) return true
    if (/[\\/]/.test(w) && (insideCliRoot(w, check) || (GLOB_CHARS.test(w) && globMayReachCliRoot(w, check)))) return true
    if (GLOB_CHARS.test(binName(w))) {
      const re = globRegex(binName(w))
      if (CLI_FILE_NAMES.some((n) => re.test(n))) return true
    }
  }
  return false
}

/** A literal word (no glob reading) naming the CLI or a path inside one of this install's CLI folders. */
function literalNamesCli(word: string, check: CliCheck): boolean {
  return spellings(word).some((w) => CLI_NAME.test(binName(w)) || (/[\\/]/.test(w) && insideCliRoot(w, check)))
}

/** A glob path whose leading components may match one of this install's CLI folders (fail closed: any component). */
function globMayReachCliRoot(word: string, check: CliCheck): boolean {
  if (!check.roots.length) return false
  const p = check.platform === 'win32' ? win32 : posix
  const abs = p.isAbsolute(word) ? word : check.cwd && p.isAbsolute(check.cwd) ? p.join(check.cwd, word) : null
  if (!abs) return false
  const parts = (w: string): string[] => w.split(/[\\/]+/).filter((x) => x !== '' && x !== '.')
  const got = parts(abs)
  for (const root of check.roots) {
    if (check.testRun && isSourceCliRoot(root, check.platform) && testRunTarget(word)) continue
    const want = parts(p.resolve(root))
    if (got.length < want.length || got.slice(0, want.length).includes('..')) continue
    if (want.every((c, k) => (GLOB_CHARS.test(got[k]) ? globRegex(got[k]).test(c) : got[k].toLowerCase() === c.toLowerCase()))) return true
  }
  return false
}

/** A shell option word that may take the next word as its value: a short cluster with o / O / R (`-o x`, `-eo x`,
 * bash `-O shopt` / `+O shopt`, ksh `-R file`), or any long option without `=` (`--rcfile FILE`, `--init-file FILE`;
 * `--noprofile` takes none, but counting it fails closed). */
const SHELL_OPTION_WITH_VALUE = /^(?:[-+][A-Za-z]*[oOR][A-Za-z]*|--[^=]+)$/

/**
 * A POSIX shell's script argument is the CLI: the first word that is not an option or an option's value is an
 * `orgai`-named file or a file inside a CLI root (the packaged Resources/bin launcher). Every word that may be an
 * option's value is checked as well (fail closed: `bash -O extglob <launcher>` and `bash --rcfile /dev/null
 * <launcher>` run the launcher), and so is an input redirect's file (`sh < <launcher>`). A -c text is left to the
 * nesting scan.
 */
function shellScriptIsCli(rest: readonly string[], check: CliCheck): boolean {
  if (redirectFeedsCli(rest, check)) return true
  let valueNext = false
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    // A here-doc / here-string (`<<EOF`, `<<< text`) is stdin, never the script (hereStrings reads the text).
    const here = /^\d*<<(.*)$/.exec(w)
    if (here) {
      if (here[1] === '' || here[1] === '<' || here[1] === '-') k++
      continue
    }
    const redirect = /^\d*<(.*)$/.exec(w)
    if (redirect) {
      if (redirect[1] === '') k++
      continue
    }
    if (w === '--' || w === '-') {
      const next = rest[k + 1]
      return next !== undefined && scriptWordIsCli(next, check)
    }
    if (NESTING_FLAGS.test(w)) return false
    if (/^[-+]/.test(w)) {
      valueNext = SHELL_OPTION_WITH_VALUE.test(w)
      continue
    }
    if (scriptWordIsCli(w, check)) return true
    // A word that is not an option's value is the script: what follows are its own arguments.
    if (!valueNext) return false
    valueNext = false
  }
  return false
}

/** An input redirect anywhere in the words (`sh < <launcher>`, `node <orgai.mjs`) that feeds the program the CLI. */
function redirectFeedsCli(rest: readonly string[], check: CliCheck): boolean {
  for (let k = 0; k < rest.length; k++) {
    // `<<EOF` / `<<< text` are not files.
    const redirect = /^\d*<(?!<)(.*)$/.exec(rest[k])
    if (!redirect) continue
    const target = redirect[1] !== '' ? redirect[1] : rest[k + 1]
    if (target !== undefined && scriptWordIsCli(target, check)) return true
  }
  return false
}

function scriptWordIsCli(word: string, check: CliCheck): boolean {
  return spellings(word).some((w) => CLI_NAME.test(binName(w)) || (GLOB_CHARS.test(binName(w)) && globNamesCli(binName(w)))) || interpreterArgIsCli(word, check)
}

/**
 * An interpreter argument that is the CLI: an `orgai` / `orgai.mjs` / `orgai.js` file, or a path (relative against the
 * cwd) inside one of this install's CLI folders, also through backslash escapes and globs (`<Resources>/bin/o*`,
 * `out/cli/orga?.mjs`; a bare `*.js` is not read as one).
 */
function interpreterArgIsCli(word: string, check: CliCheck): boolean {
  const value = word.replace(/^--?[A-Za-z][\w-]*=/, '')
  if (!value || value.startsWith('-')) return false
  for (const v of spellings(value)) {
    if (!PATHISH.test(v)) continue
    if (CLI_NAME.test(binName(v)) || insideCliRoot(v, check)) return true
    if (GLOB_CHARS.test(v) && (globMayReachCliRoot(v, check) || (GLOB_CHARS.test(binName(v)) && globNamesCli(binName(v))))) return true
  }
  return false
}

/**
 * A glob file name in an argument that stands for the CLI: it matches an orgai file name and keeps at least three of
 * its letters (`orga?`, `o?gai.mjs`, `org*`), so `*.js` or `*` in an ordinary argument is not read as the CLI.
 */
function globNamesCli(base: string): boolean {
  const re = globRegex(base)
  if (!CLI_FILE_NAMES.some((n) => re.test(n))) return false
  const literal = base.replace(/\[[^\]]*\]/g, '').replace(/[*?]/g, '').toLowerCase()
  let got = 0
  for (const ch of literal) if ('orgai'[got] === ch) got++
  return got >= 3
}

/** A path (relative against the cwd) at or inside one of this install's CLI folders. */
function insideCliRoot(value: string, check: CliCheck): boolean {
  if (!check.roots.length) return false
  const p = check.platform === 'win32' ? win32 : posix
  const fold = (v: string): string => (check.platform === 'win32' || check.platform === 'darwin' ? v.toLowerCase() : v)
  const abs = p.isAbsolute(value) ? p.resolve(value) : check.cwd && p.isAbsolute(check.cwd) ? p.resolve(check.cwd, value) : null
  if (!abs) return false
  for (const root of check.roots) {
    if (check.testRun && isSourceCliRoot(root, check.platform) && testRunTarget(value)) continue
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

function textRunsCli(text: string, depth: number, budget: CliBudget, check: CliCheck): boolean {
  if (ELECTRON_AS_NODE_PS.some((re) => re.test(text))) return true
  const plain = unquoted(text)
  if (/\bsetx\s+ELECTRON_RUN_AS_NODE\b/i.test(plain)) return true
  for (const segment of cliSegments(plain)) if (assignsElectronAsNode(segment.text)) return true
  // A second pass keeps brace expansions whole (`<Resources>/bin/orga{i,} status`) when there are any.
  for (const keepBraces of /\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/.test(text) ? [false, true] : [false]) {
    const segments = cliSegments(text, keepBraces)
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k]
      if (segmentRunsCli(seg.text, depth, budget, check)) return true
      if (seg.producer && producerRunsCli(seg.text, depth, budget, check)) return true
      // `echo 'orgai runs stop R1' | sh`, `cat <launcher> | sh -s status`: a shell or interpreter reading code from a
      // pipe runs what any earlier piece names (fail closed: every piece before it in this text).
      if (seg.pipeIn && segmentReadsCode(seg.text) && segments.slice(0, k).some((u) => producerRunsCli(u.text, depth, budget, check))) return true
    }
  }
  return false
}

/**
 * The segment's program may run what a pipe feeds it as code: a shell, an interpreter or `.` / `source` reading its
 * script from stdin. A POSIX shell given a script file (and no -c / -s) or an interpreter given a script file reads
 * stdin as data (review M3: `grep -rn orgai src | node x.mjs` is not the CLI). Inline code (`node -e`), `-`, `-s`
 * and every other shell still count (fail closed).
 */
function segmentReadsCode(segment: string): boolean {
  const words = segmentWords(segment)
  const at = programIndex(words)
  const prog = words[at]
  if (prog === undefined) return false
  const bare = stripExe(binName(prog))
  if (!readsCode(prog, bare)) return false
  const rest = words.slice(at + 1)
  if (INTERPRETERS.has(bare)) return !interpreterHasScript(bare, rest)
  if (SCRIPT_SHELLS.has(bare)) return !shellHasScriptFile(rest)
  return true
}

/** Interpreter options that take the next word as their value (when written without `=`). */
const INTERPRETER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title',
  '--env-file', '--watch-path', '--test-reporter', '--test-reporter-destination', '--test-name-pattern',
  '--test-skip-pattern', '--redirect-warnings', '--diagnostic-dir', '--disable-warning', '--cwd', '--config', '-c',
  '--tsconfig', '--project', '-P', '--preload', '--allow-read', '--allow-write', '--allow-net', '--allow-env',
  '--allow-run', '--import-map', '--lock', '--cert', '--location', '--seed', '--v8-flags'
])
/** Interpreter options whose value is code to run (the program then has no script file; stdin may be read). */
const INTERPRETER_EVAL_OPTIONS = /^(?:-e|-p|-pe|-ep|--eval|--print)(?:=|$)/

/** True when the interpreter runs a script file (or a subcommand such as `bun test`), so stdin is data to it. */
function interpreterHasScript(bare: string, rest: readonly string[]): boolean {
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    if (w === '-') return false
    if (w === '--') return rest[k + 1] !== undefined && rest[k + 1] !== '-'
    if (INTERPRETER_EVAL_OPTIONS.test(w)) return false
    // Redirects are not arguments (`node x.mjs < in.txt`, `node <script`: the latter feeds code, handled by redirectFeedsCli).
    if (/^\d*[<>]/.test(w)) {
      if (/^\d*[<>]+&?$/.test(w)) k++
      continue
    }
    if (w.startsWith('-')) {
      if (!w.includes('=') && INTERPRETER_VALUE_OPTIONS.has(w)) k++
      continue
    }
    // deno / bun subcommands that read code from stdin.
    if ((bare === 'deno' || bare === 'bun') && (w === 'eval' || w === 'repl')) return false
    return true
  }
  return false
}

/** True when a POSIX shell's words name a script file to run (no -c, no -s, not `-`), so stdin is data to it. */
function shellHasScriptFile(rest: readonly string[]): boolean {
  let valueNext = false
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    if (/^\d*[<>]/.test(w)) {
      if (/^\d*(?:<<<?|[<>]+&?)$/.test(w)) k++
      continue
    }
    if (w === '-') return false
    if (w === '--') return rest[k + 1] !== undefined && rest[k + 1] !== '-'
    if (NESTING_FLAGS.test(w)) return false
    if (/^[-+][A-Za-z]*s[A-Za-z]*$/.test(w)) return false
    if (/^[-+]/.test(w)) {
      valueNext = SHELL_OPTION_WITH_VALUE.test(w)
      continue
    }
    if (valueNext) {
      valueNext = false
      continue
    }
    return true
  }
  return false
}

type CliScanOptions = { cwd?: string; cliRoots?: readonly string[]; platform?: NodeJS.Platform }

/** 'runs' when a shell command runs the OrgAI CLI, 'limit' when the scan stopped before reading all of it, else null. */
function cliScan(command: string, opts: CliScanOptions): 'runs' | 'limit' | null {
  if (typeof command !== 'string' || !command.trim()) return null
  const budget: CliBudget = { n: 0, limited: false }
  const runs = textRunsCli(command, 0, budget, { cwd: opts.cwd, roots: opts.cliRoots ?? configuredCliRoots, platform: opts.platform ?? process.platform })
  return budget.limited ? 'limit' : runs ? 'runs' : null
}

/**
 * True when a shell command runs the OrgAI CLI (cli-spec 3.4(1)(a)), or cannot be read to the end (over MAX_SEGMENTS
 * segments, a shell -c nested deeper than MAX_NEST): both are denied. Exported for tests.
 */
export function commandRunsOrgaiCli(command: string, opts: CliScanOptions = {}): boolean {
  return cliScan(command, opts) !== null
}

/**
 * Programs that read a here-document's body only as data: never as code, file names or arguments to run. Not jq: it
 * takes its program from stdin (`jq -f /dev/stdin`) and a program's `import ... {search: "<dir>"}` reads files there.
 */
const HEREDOC_DATA_SINKS: ReadonlySet<string> = new Set([
  'cat', 'tee', 'git', 'gh', 'wc', 'head', 'tail', 'uniq', 'tr', 'cut', 'grep', 'egrep', 'fgrep', 'rg', 'diff',
  'column', 'fold', 'fmt', 'nl', 'rev', 'paste', 'expand', 'unexpand', 'base64', 'iconv'
])
// Not sort (review follow-up): `sort --compress-program=sh` runs the body as a shell script.
/**
 * Options that make a program read its stdin as file names or paths (`sort --files0-from=-`, `wc --files0-from=-`,
 * `git commit --pathspec-from-file=-`, `git hash-object --stdin-paths`): a here-document next to one is never stripped,
 * whatever the program.
 */
const STDIN_NAMES_FILES = /^-{1,2}[A-Za-z0-9-]*(?:files0?-from|from-file|stdin-paths)(?:=|$)/
/**
 * Long options that read file names from stdin or run another program (`--compress-program`, ripgrep's `--pre` /
 * `--pre-glob`). GNU getopt and git's parse-options take any unambiguous prefix (`wc --files0=-`, `sort --compress=sh`,
 * `git commit --pathspec-from=-`), so a long option that is a prefix of one of these counts too.
 */
const STDIN_OR_PROGRAM_OPTIONS: readonly string[] = ['files0-from', 'files-from', 'pathspec-from-file', 'stdin-paths', 'compress-program', 'pre', 'pre-glob']

/**
 * True when a command word makes a here-document next to it more than data: stdin names files or an option runs a
 * program. git's own `--file` (`git commit --file -`, the message) is an exact option, never an abbreviation.
 */
function stdinNotData(word: string, program: string): boolean {
  const w = word.replace(/^['"]|['"]$/g, '')
  if (STDIN_NAMES_FILES.test(w)) return true
  const m = /^--([A-Za-z0-9][A-Za-z0-9-]*)(?:=|$)/.exec(w)
  if (!m) return false
  const name = m[1].toLowerCase()
  if (program === 'git' && name === 'file') return false
  return STDIN_OR_PROGRAM_OPTIONS.some((o) => o.startsWith(name))
}
/** Words that may open a command before its program (`{ cat <<EOF ... }`, `then cat <<EOF`). */
const HEREDOC_LEADERS: ReadonlySet<string> = new Set(['{', '!', 'then', 'do', 'else'])
/** A `$(cat <<'EOF' ...)` substitution that is the value of a git / gh message option. */
const MESSAGE_OPTION_TAIL = /(?:^|\s)(?:-m|--message|--body|-b|--title|-t|--notes)(?:\s+|=)"?$/
const GIT_MESSAGE_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit', 'tag', 'merge', 'notes', 'stash'])
const GH_MESSAGE_SUBCOMMANDS: ReadonlySet<string> = new Set(['pr', 'issue', 'release'])
const HEREDOC_DELIMITER = /^[A-Za-z0-9_.-]{1,64}$/
/** Programs that turn their stdin into arguments or commands: a data-only here-document is never stripped next to one. */
const STDIN_TO_COMMANDS: ReadonlySet<string> = new Set(['xargs', 'parallel', 'eval'])

interface HeredocFrame {
  /** Where the current simple command starts. */
  cmdStart: number
  quote: '"' | "'" | null
  /** Index of the `$(` that opened this frame (-1 at the top). */
  subStart: number
  /** Open `(` inside this frame (subshells, process substitutions). */
  depth: number
}

/** The first word of a command text (assignments and leaders skipped), or null when it is not a plain name. */
function commandName(cmd: string): { name: string; words: string[] } | null {
  const words = cmd.trim().split(/\s+/).filter(Boolean)
  let k = 0
  while (k < words.length && (ASSIGNMENT.test(words[k]) || HEREDOC_LEADERS.has(words[k]))) k++
  const name = words[k]
  if (!name || /['"\\$`/]/.test(name)) return null
  return { name, words: words.slice(k) }
}

/**
 * True for `git <message subcommand> ...` / `gh <message subcommand> ...` with the subcommand in its own position: the
 * first word after `git` (only `-C <dir>` and `--no-pager` may come before it) or after `gh`. A message subcommand's
 * name later in the line (`git --namespace commit hash-object ...`, `git apply --exclude commit ...`) does not count.
 */
function messageCommand(cmd: { name: string; words: string[] }): boolean {
  const w = cmd.words
  if (cmd.name === 'gh') return GH_MESSAGE_SUBCOMMANDS.has(w[1] ?? '')
  if (cmd.name !== 'git') return false
  let k = 1
  for (;;) {
    if (w[k] === '-C' && w[k + 1] !== undefined) k += 2
    else if (w[k] === '--no-pager') k++
    else break
  }
  return GIT_MESSAGE_SUBCOMMANDS.has(w[k] ?? '')
}

/** May the here-document whose operator starts at `op` (inside `frames`) be read as data only? (body checks aside) */
function heredocEligible(text: string, frames: readonly HeredocFrame[], op: number): boolean {
  const f = frames[frames.length - 1]
  const cmd = commandName(text.slice(f.cmdStart, op))
  if (!cmd) return false
  if (cmd.words.some((w) => stdinNotData(w, cmd.name))) return false
  if (frames.length === 1) {
    // git / gh only as a message (`git commit -F -`, `gh pr create --body-file -`): never `git apply`, whose patch names files.
    if (cmd.name === 'git' || cmd.name === 'gh') return messageCommand(cmd)
    return HEREDOC_DATA_SINKS.has(cmd.name)
  }
  // `git commit -m "$(cat <<'EOF' ... EOF)"`: only plain cat, one level deep, as a git / gh message value.
  if (frames.length !== 2 || cmd.name !== 'cat' || cmd.words.length !== 1) return false
  const outerText = text.slice(frames[0].cmdStart, f.subStart)
  if (!MESSAGE_OPTION_TAIL.test(outerText)) return false
  const outer = commandName(outerText)
  if (!outer) return false
  if (outer.words.some((w) => stdinNotData(w, outer.name))) return false
  return messageCommand(outer)
}

/** True when `segment` (the operator's line) pipes anywhere outside quotes. */
function pipesOnLine(segment: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '|') return true
  }
  return false
}

/**
 * A Bash command with the bodies of its data-only here-documents left out (review M3), so a large `cat <<'EOF' >
 * file` or a `git commit -m "$(cat <<'EOF' ...)"` message is neither denied for its size nor read as commands. A body
 * is left out only when all of these hold: its program is a data sink (HEREDOC_DATA_SINKS; git / gh only with a message
 * subcommand in the subcommand position; inside a substitution only `cat` as a git / gh message value), no word of its
 * command makes stdin name files or runs another program (stdinNotData), its delimiter is quoted or its body has no `$(` / backtick, its operator's line
 * pipes nowhere, and no piece of the rest of the command is a shell, an interpreter, `.` / `source`, eval, xargs or
 * parallel, nor a program run by its path (any of which could run the written text). Anything this parser is not sure bash reads the same way (arithmetic
 * `((`, backticks, `$'...'`, `case`, an unterminated or continued body, an odd delimiter) returns the text unchanged,
 * so the scanners read every line as before.
 */
export function stripDataHeredocs(text: string): string {
  if (typeof text !== 'string' || !text.includes('<<')) return text
  if (/\(\(|\$'|\bcase\b/.test(text)) return text
  const frames: HeredocFrame[] = [{ cmdStart: 0, quote: null, subStart: -1, depth: 0 }]
  let pending: { delim: string; dash: boolean; quoted: boolean; op: number; eligible: boolean }[] = []
  const cut: { start: number; end: number }[] = []
  for (let i = 0; i < text.length; i++) {
    const f = frames[frames.length - 1]
    const ch = text[i]
    if (f.quote === "'") {
      if (ch === "'") f.quote = null
      else if (ch === '\n' && pending.length) return text
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') return text
    if (ch === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2)
      if (close < 0) return text
      const inner = text.slice(i + 2, close)
      if (/<<|\$\(|`|\{/.test(inner)) return text
      i = close
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      frames.push({ cmdStart: i + 2, quote: null, subStart: i, depth: 0 })
      i++
      continue
    }
    if (f.quote === '"') {
      if (ch === '"') f.quote = null
      else if (ch === '\n' && pending.length) return text
      continue
    }
    if (ch === '"' || ch === "'") {
      f.quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /[\s;&|()<>]/.test(text[i - 1]))) {
      const nl = text.indexOf('\n', i)
      if (nl < 0) break
      i = nl - 1
      continue
    }
    if (ch === '(') {
      f.depth++
      f.cmdStart = i + 1
      continue
    }
    if (ch === ')') {
      if (f.depth > 0) {
        f.depth--
        f.cmdStart = i + 1
      } else if (frames.length > 1) {
        frames.pop()
      } else return text
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      f.cmdStart = i + 1
      continue
    }
    if (ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        i += 2
        continue
      }
      let j = i + 2
      const dash = text[j] === '-'
      if (dash) j++
      while (text[j] === ' ' || text[j] === '\t') j++
      let delim = ''
      let quoted = false
      for (; j < text.length; j++) {
        const c = text[j]
        if (/[\s;&|<>()]/.test(c)) break
        if (c === "'" || c === '"') {
          const e = text.indexOf(c, j + 1)
          if (e < 0) return text
          const inner = text.slice(j + 1, e)
          if (c === '"' && /[$`\\]/.test(inner)) return text
          delim += inner
          quoted = true
          j = e
          continue
        }
        if (c === '\\') {
          if (j + 1 >= text.length) return text
          delim += text[j + 1]
          quoted = true
          j++
          continue
        }
        if (c === '$' || c === '`') return text
        delim += c
      }
      if (!HEREDOC_DELIMITER.test(delim)) return text
      pending.push({ delim, dash, quoted, op: i, eligible: heredocEligible(text, frames, i) })
      i = j - 1
      continue
    }
    if (ch === '\n') {
      f.cmdStart = i + 1
      if (!pending.length) continue
      let pos = i + 1
      for (const h of pending) {
        const bodyStart = pos
        let end = -1
        while (pos < text.length) {
          const nl = text.indexOf('\n', pos)
          const lineEnd = nl < 0 ? text.length : nl
          const line = text.slice(pos, lineEnd)
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) {
            end = nl < 0 ? text.length : nl + 1
            break
          }
          // An unquoted body continues a line ending in `\`: bash may end it elsewhere.
          if (!h.quoted && line.endsWith('\\')) return text
          if (nl < 0) break
          pos = nl + 1
        }
        if (end < 0) return text
        const body = text.slice(bodyStart, pos)
        if (h.eligible && !pipesOnLine(text.slice(h.op, i)) && (h.quoted || !/\$\(|`/.test(body))) cut.push({ start: bodyStart, end })
        pos = end
      }
      pending = []
      i = pos - 1
      f.cmdStart = pos
      continue
    }
  }
  if (!cut.length) return text
  let out = ''
  let from = 0
  for (const c of cut) {
    out += text.slice(from, c.start)
    from = c.end
  }
  out += text.slice(from)
  // The written text must not reach anything that runs it.
  for (const seg of cliSegments(out)) {
    const words = segmentWords(seg.text)
    if (words.some((w) => STDIN_TO_COMMANDS.has(stripExe(binName(w))))) return text
    const prog = words[programIndex(words)]
    // A shell, an interpreter, or a program run by its path (`./x.sh` may be the file just written).
    if (prog !== undefined && (readsCode(prog, stripExe(binName(prog))) || /[\\/]/.test(prog))) return text
  }
  return out
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
  // A search rooted AT or UNDER a protected path is denied whatever its filter (ripgrep searches a named file whatever
  // its --glob). One rooted ABOVE it (the home folder, the data dir) is allowed when its file filter can only match
  // source or text files with a known extension (review M3): no protected file has one.
  if (root !== undefined && pathAtOrUnder(root, refs, ctx.cwd, opts)) return true
  if (toolName === 'Grep') {
    // Every filter given must be safe (review follow-up): ripgrep lets a positive --glob win over --type, so a safe
    // `type` next to `glob: '*'` still searches every file.
    const has = (v: unknown): boolean => v !== undefined && v !== null && v !== ''
    const safeFilter = (has(input.glob) || has(input.type)) && (!has(input.glob) || safeGrepGlob(input.glob)) && (!has(input.type) || safeSearchType(input.type))
    if (root !== undefined && !safeFilter && searchReaches(root, undefined, refs, ctx.cwd, opts)) return true
    return pattern !== undefined && isRootedPattern(pattern, platform) && pathAtOrUnder(pattern, refs, ctx.cwd, opts) !== null
  }
  if (pattern === undefined) return false
  // A safe-extension Glob lists only such files; one whose literal path itself lands in a protected folder still counts.
  if (safeFileGlob(pattern)) {
    const base = absoluteRoot(root, ctx, platform)
    if (base !== undefined && pathAtOrUnder(pattern, refs, base, opts) === null) return false
  }
  return searchReaches(root ?? '', pattern, refs, ctx.cwd, opts) !== null
}

/** A search root as an absolute path (`~` expanded, relative against the cwd), or undefined when it cannot be told. */
function absoluteRoot(root: string | undefined, ctx: SelfControlContext, platform: NodeJS.Platform): string | undefined {
  if (root === undefined) return undefined
  const p = platform === 'win32' ? win32 : posix
  let r = root
  if (r === '~' || /^~[\\/]/.test(r)) {
    if (!ctx.home || !p.isAbsolute(ctx.home)) return undefined
    r = p.join(ctx.home, r.slice(1))
  }
  if (p.isAbsolute(r)) return p.resolve(r)
  return ctx.cwd && p.isAbsolute(ctx.cwd) ? p.resolve(ctx.cwd, r) : undefined
}

/**
 * Extensions a protected file never has (run/: daemon.json, daemon.secret, sockets; secrets.json; codex/: auth.json,
 * config.toml, *.jsonl sessions, logs, shell snapshots): source and document files only. json, toml, yaml, jsonl, log,
 * txt, sh, env and the like stay out.
 */
const SAFE_SEARCH_EXTS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'rb', 'php', 'scala', 'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'md', 'mdx',
  'markdown', 'rst', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'sql'
])
/** ripgrep --type names whose files all carry SAFE_SEARCH_EXTS extensions. */
const SAFE_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'ts', 'typescript', 'js', 'py', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'cs', 'csharp', 'ruby',
  'php', 'scala', 'vue', 'svelte', 'css', 'sass', 'less', 'html', 'md', 'markdown', 'lua', 'dart', 'elixir', 'erlang',
  'haskell', 'clojure', 'sql'
])

/** A Grep `glob` / Glob pattern whose every brace alternative names files by a literal safe extension (`*.ts`, `src/**\/*.{ts,tsx}`). */
function safeFileGlob(v: unknown): boolean {
  if (typeof v !== 'string' || !v || v.length > 512 || v.startsWith('!')) return false
  const alts = expandBraces(v, 64)
  if (alts.length >= 64) return false
  return alts.every((a) => {
    const base = a.split(/[\\/]/).pop() ?? ''
    const m = /\.([A-Za-z0-9]+)$/.exec(base)
    return !!m && SAFE_SEARCH_EXTS.has(m[1].toLowerCase()) && !a.startsWith('!')
  })
}

/**
 * A Grep `glob` that is safe as ripgrep receives it. Claude Code's Grep splits `glob` on whitespace, and a piece
 * without braces on commas, into several --glob flags (`'* *.ts'`, `'*,x.ts'` would pass `*`), so whitespace and a
 * comma outside braces are refused; what is left must be a safeFileGlob.
 */
function safeGrepGlob(v: unknown): boolean {
  if (typeof v !== 'string' || /\s/.test(v)) return false
  let depth = 0
  for (const ch of v) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) return false
  }
  return safeFileGlob(v)
}

function safeSearchType(v: unknown): boolean {
  return typeof v === 'string' && SAFE_SEARCH_TYPES.has(v.toLowerCase())
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
 * file in this install's CLI folders) or names a protected path (or runs inside one). A Bash command's data-only
 * here-documents are left out of the scan first (stripDataHeredocs). Pure apart from real-path lookups; never throws:
 * an internal error denies a shell command with SELF_CONTROL_UNCHECKED_MESSAGE (review M2) and gives null for a file
 * tool, as does ctx.pathsUnavailable for a shell command the CLI check let through.
 */
export function checkSelfControlDenial(toolName: string, input: unknown, ctx: SelfControlContext): string | null {
  const shellTool = SHELLS.has(toolName)
  try {
    const refs = Array.isArray(ctx?.protectedPaths) ? ctx.protectedPaths.filter((p) => typeof p === 'string' && p !== '') : []
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const platform = ctx.platform ?? process.platform
    if (shellTool) {
      const command = i.command
      if (typeof command !== 'string' || !command.trim()) return null
      const shell = ctx.shell ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
      const text = shell === 'bash' ? stripDataHeredocs(command) : command
      const cli = cliScan(text, { cwd: ctx.cwd, cliRoots: ctx.cliRoots, platform })
      if (cli === 'runs') return SELF_CONTROL_DENIAL_MESSAGE
      if (cli === 'limit') return SELF_CONTROL_UNCHECKED_MESSAGE
      if (ctx.pathsUnavailable) return SELF_CONTROL_UNCHECKED_MESSAGE
      if (!refs.length) return null
      const scan = commandControlScan(text, ctx.cwd, refs, { shell, platform, home: ctx.home })
      return scan === 'touch' ? SELF_CONTROL_DENIAL_MESSAGE : scan === 'limit' ? SELF_CONTROL_UNCHECKED_MESSAGE : null
    }
    if (!FILE_TOOLS.has(toolName) || !refs.length) return null
    if (toolName === 'Glob' || toolName === 'Grep') return searchDenied(toolName, i, refs, ctx, platform) ? SELF_CONTROL_DENIAL_MESSAGE : null
    for (const target of fileTargets(i)) {
      if (pathAtOrUnder(target, refs, ctx.cwd, { platform, home: ctx.home })) return SELF_CONTROL_DENIAL_MESSAGE
    }
    return null
  } catch {
    // A shell command the gate could not check never runs unread (bypassPermissions would allow it).
    return shellTool ? SELF_CONTROL_UNCHECKED_MESSAGE : null
  }
}
