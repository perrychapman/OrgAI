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
 * orgai: `cat notes.sh | sh`), commands other wrappers run (`parallel`, a Makefile, an npm script, a
 * PowerShell backtick escape), an `orgai` reached through an alias, a shell function or a renamed copy outside the
 * CLI folders, and a Grep `glob` filter (a Grep rooted above a protected path is denied whatever its filter).
 * Commands a provider runs without asking OrgAI (Codex inside its own sandbox) are governed by that provider's sandbox
 * policy, not this gate.
 *
 * Wave 7 (docs/design/cli-standalone.md 8.4; text checks, a speed bump and not a boundary, 5.8):
 * - Package runners (npx, pnpx, bunx, `npm exec|x`, `pnpm dlx|exec`, `yarn dlx|exec`, `bun x`, options first allowed)
 *   with `orgai`, `orgai-cli` or `@orgai/cli` in any word (versions, `-p` / `--package` forms, `npm:` aliases, registry URLs; the
 *   scoped name is matched on the raw word, SCOPED_CLI), and their `-c` / `--call` value or a first positional word
 *   holding whitespace (`npx -c 'orgai status'`) as command texts (runnerCommandTexts; the package's own arguments,
 *   `npx vitest -t 'a b'`, are not). A `node_modules/orgai-cli/...` or `node_modules/@orgai/cli/...` path run as a program, script or interpreter
 *   argument counts too, and (review round 2) a glob the shell may expand to the package (`npx @orgai/cl?`,
 *   runnerWordNamesCli).
 * - Files directly in the data folder whose base name starts with `vault.json` or `secrets.json` (the .tmp, .reset-*,
 *   .corrupt-* siblings), lexical and canonical, for every file tool and shell word (referenceDirectories.ts
 *   PrefixProtection; the data folder is found among the protected paths, vaultPrefixProtections), and globs in the data
 *   folder that may match such a name unless they end in a source or document extension. The vault key files are exact
 *   protected paths (controlProtectedPaths extras). The path scan also reads a second spelling of the command:
 *   brace expansions expanded, `$XDG_CONFIG_HOME` / `%APPDATA%` / `$env:APPDATA` / LOCALAPPDATA read as their usual
 *   place under the home folder, escaped spaces (`Application\ Support`) kept in the word, and a third with quotes,
 *   parentheses and commas as spaces (paths inside inline code).
 * - Any word referencing ORGAI_VAULT_* (VAULT_ENV_WORD, spec 8.4 as written; review round 1): expansions,
 *   assignments, environment dumps filtered on it (`printenv | grep ORGAI_VAULT`, `Get-ChildItem Env: | ? Name -like
 *   'ORGAI_VAULT*'`) and plain mentions (`grep -rn ORGAI_VAULT_KEY_FILE src`; the Grep tool is the way to search for
 *   it), with quotes, backslashes, backticks and brackets removed first, plus a shortened prefix that can only stand for
 *   it (`ORGAI_V*`). A data-only here-document body is left out as for every rule (stripDataHeredocs).
 * - Key custodian tools: `security` with a keychain item subcommand (KEYCHAIN_SUBCOMMANDS) after its own options (read
 *   as getopt does: `--`, `-pX`, `-p X`; securityOptions), `-i`, a redirect or here-string, no subcommand, a pipe into
 *   it; `security`, `keyring` (python-keyring) or `kwallet-query` / `kwalletcli` followed by the `OrgAI Vault` name
 *   (spec 8.4's "any word `OrgAI Vault`" is read as a word given to a keyring front end, so a search of the sources for
 *   the name passes); any `secret-tool` call; busctl
 *   / gdbus / dbus-send / qdbus naming the Secret Service; PowerShell text naming ProtectedData or Unprotect (the
 *   PowerShell tool, `pwsh -c`, a pipe or here-string into pwsh, and `-EncodedCommand` texts, which are decoded and
 *   scanned like any command); and code a code runner in the text runs (its own words, a here-document, a pipe into
 *   one that reads stdin) that names any of these (CUSTODIAN_CODE, custodianCodeRuns; also `security -i` and a bare
 *   `security` at the end of a string or array or after a `|`, which read stdin). Program, wrapper and subcommand
 *   names are read through backslash escapes and globs (wordMayBe: `sec\urity`, `/usr/bin/secur*y`, `np?`, `npm
 *   ex?c`; a single-letter bracket class counts as its letter, `[s][e][c][u][r][i][t][y]`), and `arch -arch <name>` /
 *   `xcrun --sdk <x>`, `launchctl asuser|bsexec <id>` and `script [options] <file> <cmd>` are unwrapped (util-linux
 *   `script -c <text>` is read as a command text).
 * - On win32 a local drive written as a device path or an admin share (`\\?\C:\...`, `\\.\C:\...`,
 *   `\\localhost\c$\...`, `\\127.0.0.1\c$\...`, `\\?\UNC\localhost\c$\...`) is read as that drive, lexically
 *   (referenceDirectories.ts localDrivePathOf); other UNC paths stay with the normal flow.
 * Honest limits as above, plus: the data folder named as a whole (`cp -r <data> x`, `grep -r k <data>`, `find <data>
 * -exec cat {} +`) is a parent and passes, as before; a moved APPDATA / XDG folder is not followed; a script file or a
 * program that calls the keychain, the Secret Service or DPAPI itself (Python's keyring from a .py file, a compiled
 * helper) is not seen; a bare environment dump (`env`, `printenv`, `env | grep ORGAI_`) is not a reference to
 * ORGAI_VAULT_* and passes (the 6.3 environment scrub is the defence there); an awk or other program text that names a
 * custodian (`awk '/secret-tool/'`) is read as code and denied, as is interpreter code that only prints the word
 * (`print('security')`); a program word that is all wildcards (`/usr/bin/????????`) or a class of several letters is
 * not read as a custodian name; a UNC path to this computer under its own host name (`\\MYPC\c$`) is not mapped; the
 * keyring service name passed through a variable or built by code at run time is not seen.
 */
import { join, posix, resolve, win32 } from 'node:path'
import { packagedCliRoots } from '../host/packagedLayout'
import { canonicalDeep } from '../quick/scratch'
import { LEGACY_SECRETS_FILE, VAULT_FILE } from '../store/vaultTypes'
import { commandControlScan, pathAtOrUnder, searchReaches, type PrefixProtection } from './referenceDirectories'
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

/** Extra protected paths (Wave 7, cli-standalone.md 8.4). */
export interface ControlProtectedExtras {
  /**
   * The vault's key file(s): ORGAI_VAULT_KEY_FILE and custody.keyFile (SecretStoreApi.vaultKeyFiles), protected as
   * exact files. The `vault.json*` / `secrets.json*` basename rule (vaultPrefixProtections) and the ORGAI_VAULT_* word
   * rule live in checkSelfControlDenial.
   */
  vaultKeyFiles?: readonly string[]
}

/**
 * The paths the gate protects, each in its lexical (path.resolve) and canonical (canonicalDeep: real path of the
 * nearest existing ancestor plus the rest) spelling, deduped, in a stable order.
 */
export function controlProtectedPaths(dataDir: string, runtimeSocketDir?: string, extras: ControlProtectedExtras = {}): string[] {
  const roots = [join(dataDir, 'run'), join(dataDir, 'secrets.json'), join(dataDir, 'codex')]
  if (runtimeSocketDir) roots.push(runtimeSocketDir)
  for (const f of extras.vaultKeyFiles ?? []) if (typeof f === 'string' && f !== '') roots.push(f)
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
const CLI_NAME = /^orgai(?:-cli)?(?:@[^\\/]*)?(?:\.(?:exe|cmd|bat|ps1|mjs|js))?$/i
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
const PACKAGE_RUNNERS: readonly string[] = ['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx']
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_NEST = 3
const MAX_SEGMENTS = 2000

/**
 * The npm package in a word (Wave 7, cli-standalone 8.4; the published name is `orgai-cli`, owner decision 2026-11-06,
 * and the scoped `@orgai/cli` stays covered): a package spec (`orgai-cli`, `orgai-cli@1.2.3`, `@orgai/cli`,
 * `@orgai/cli@1.2.3`, `npm:orgai-cli`, `x@npm:@orgai/cli`), a `node_modules/orgai-cli/...` or
 * `node_modules/@orgai/cli/...` path or a registry URL (`@orgai%2fcli`, `/orgai-cli/-/orgai-cli-1.0.0.tgz`). Never
 * `@orgai/cli-tools`, `orgai-cli-tools` or `my-orgai-cli`.
 */
const SCOPED_CLI = /(?:@orgai(?:[\\/]|%2f)cli|(?<![\w@.-])orgai-cli)(?=$|[@\\/?#])/i
/** Package runners that need no subcommand, and the subcommands that make npm / pnpm / yarn / bun one. */
const RUNNER_PROGRAMS: readonly string[] = ['npx', 'pnpx', 'bunx']
const RUNNER_SUBCOMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ['npm', ['exec', 'x']],
  ['pnpm', ['dlx', 'exec']],
  ['yarn', ['dlx', 'exec']],
  ['bun', ['x']]
]
const RUNNER_SUB_NAMES: readonly string[] = ['exec', 'x', 'dlx']

/** Compiled glob names (wordMayBe), at most 256 kept. */
const globCache = new Map<string, RegExp>()

function cachedGlobRegex(glob: string): RegExp {
  let re = globCache.get(glob)
  if (!re) {
    if (globCache.size >= 256) globCache.clear()
    re = globRegex(glob)
    globCache.set(glob, re)
  }
  return re
}

/** The base names a word may stand for: each spelling (as written, backslash escapes removed), lowercase, `.exe` dropped. */
function wordNames(word: string): readonly string[] {
  let out = wordNamesCache.get(word)
  if (out) return out
  const names: string[] = []
  for (const v of spellings(word)) {
    const n = stripExe(binName(v))
    if (!names.includes(n)) names.push(n)
  }
  if (wordNamesCache.size >= 4096) wordNamesCache.clear()
  wordNamesCache.set(word, (out = names))
  return out
}

/** wordNames results (a long segment asks for one word's names many times), at most 4,096 kept. */
const wordNamesCache = new Map<string, readonly string[]>()

/**
 * The letters a glob keeps, lowercase, in order: its literal characters plus every bracket class that can match only one
 * letter (case folded: `[s]`, `[sS]`, `[e-e]`; review round 2), so `[s][e][c][u][r][i][t][y]` keeps all of `security`.
 * Wildcards, negated classes and classes of several letters keep nothing. When the glob matches a name these letters
 * are that name's, in order.
 */
function globKeptLetters(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' || ch === '?') continue
    if (ch === '[') {
      // The same bracket reading as globRegex: a `]` right after `[` is part of the class.
      const end = glob.indexOf(']', i + 2)
      if (end !== -1) {
        out += singleClassLetter(glob.slice(i + 1, end))
        i = end
        continue
      }
    }
    out += ch.toLowerCase()
  }
  return out
}

/** The one letter a bracket class body can match (case folded), else ''. */
function singleClassLetter(body: string): string {
  if (body === '' || body.startsWith('!') || body.startsWith('^')) return ''
  const seen = new Set<string>()
  for (let k = 0; k < body.length; k++) {
    let lo = body[k]
    let hi = lo
    if (body[k + 1] === '-' && k + 2 < body.length) {
      hi = body[k + 2]
      k += 2
    }
    if (lo.toLowerCase() !== hi.toLowerCase()) return ''
    lo = lo.toLowerCase()
    seen.add(lo)
    if (seen.size > 1) return ''
  }
  return seen.size === 1 ? [...seen][0] : ''
}

/**
 * Review round 1 (Wave 7): a program or subcommand word that may be one of `names` the way the shell reads it: any
 * spelling (`sec\urity`, `secret\-tool`, `np\x`), or a glob that matches the name and keeps at least three of its
 * letters, two of a three-letter name (`secur?ty`, `/usr/bin/secur*y`, `ex?c`, `np?`; a bare `*` or `?` is not read
 * as a name).
 */
function wordMayBe(word: string, names: readonly string[]): boolean {
  for (const n of wordNames(word)) {
    if (names.includes(n)) return true
    if (!GLOB_CHARS.test(n)) continue
    const re = cachedGlobRegex(n)
    const kept = globKeptLetters(n).length
    for (const name of names) if (re.test(name) && kept >= Math.min(3, Math.max(1, name.length - 1))) return true
  }
  return false
}

/** Where the words after a package runner start (after `npm [options] exec`), or -1 when words[k] is not one. */
function runnerArgsStart(words: readonly string[], k: number): number {
  if (wordMayBe(words[k], RUNNER_PROGRAMS)) return k + 1
  for (const [runner, subs] of RUNNER_SUBCOMMANDS) {
    if (!wordMayBe(words[k], [runner])) continue
    let j = k + 1
    // Options may come first (`pnpm --package=@orgai/cli dlx cli`).
    for (let guard = 0; j < words.length && words[j].startsWith('-') && guard < 64; guard++) {
      if (/^(?:-p|--package)$/.test(words[j])) j++
      j++
    }
    if (j < words.length && wordMayBe(words[j], subs)) return j + 1
  }
  return -1
}

/** A segment that runs a package: npx, pnpx, bunx, `npm exec|x`, `pnpm dlx|exec`, `yarn dlx|exec`, `bun x` (options may come first). */
function isPackageRunner(words: readonly string[]): boolean {
  // Walked from the end with the subcommands seen so far, so a long segment costs one pass.
  const later = new Set<string>()
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k]
    if (wordMayBe(w, RUNNER_PROGRAMS)) return true
    for (const [runner, subs] of RUNNER_SUBCOMMANDS) {
      if (subs.some((s) => later.has(s)) && wordMayBe(w, [runner])) return true
    }
    for (const sub of RUNNER_SUB_NAMES) if (!later.has(sub) && wordMayBe(w, [sub])) later.add(sub)
  }
  return false
}

/**
 * The command texts a package runner runs (review round 1): the value of `-c` / `--call` (`npx -c 'orgai status'`) and
 * its first positional word when that holds whitespace (fail closed). Words after the package (`npx vitest -t 'a b'`)
 * are the package's own arguments, not command texts.
 */
function runnerCommandTexts(words: readonly string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < words.length; k++) {
    const start = runnerArgsStart(words, k)
    if (start < 0) continue
    for (let j = start; j < words.length; j++) {
      const w = words[j]
      if (w === '-c' || w === '--call') {
        if (words[j + 1] !== undefined) out.push(words[j + 1])
        j++
        continue
      }
      const call = w.startsWith('--call=') ? w.slice('--call='.length) : /^-c[\s\S]/.test(w) ? w.slice(2) : null
      if (call !== null) {
        out.push(call)
        continue
      }
      if (/^(?:-p|--package)$/.test(w)) {
        j++
        continue
      }
      if (w === '--') {
        if (words[j + 1] !== undefined) out.push(words[j + 1])
        break
      }
      if (w.startsWith('-')) continue
      out.push(w)
      break
    }
  }
  return out.filter((t) => /\s/.test(t))
}

/**
 * A package runner's word naming the CLI package (Wave 7): `@orgai/cli` on the raw word (SCOPED_CLI) or an `orgai`
 * base name (CLI_NAME), in every spelling, and (review round 2) a glob the shell may expand to either (`@orgai/cl?`,
 * `@orga?/cli@1.2.3`, `--package=@orgai/c*`, `npm:@orgai/cl?`, `orga?`) that keeps at least three of the letters of
 * `orgai` / `orgaicli` in order (a bare `*` or `src/*.ts` is not read as it).
 */
function runnerWordNamesCli(word: string): boolean {
  for (const v of spellings(word)) {
    if (SCOPED_CLI.test(v) || CLI_NAME.test(binName(v))) return true
    if (!GLOB_CHARS.test(v)) continue
    const specs = [v, v.replace(/^(?:--?[A-Za-z][\w-]*=|-p(?=.))/, '')]
    const alias = v.lastIndexOf('npm:')
    if (alias >= 0) specs.push(v.slice(alias + 4))
    for (const spec of specs) {
      for (const cand of [spec, spec.replace(/(?<=.)@[^@\\/]*$/, '')]) {
        if (!GLOB_CHARS.test(cand)) continue
        const re = cachedGlobRegex(cand)
        if ((re.test('@orgai/cli') || re.test('orgai') || re.test('orgai-cli')) && keptSubsequence(cand, 'orgaicli') >= 3) return true
      }
    }
  }
  return false
}

/** `security` subcommands that read, write, delete or export keychain items (and the vault's key with them). */
const KEYCHAIN_SUBCOMMANDS: readonly string[] = [
  'find-generic-password', 'find-internet-password', 'add-generic-password', 'add-internet-password',
  'delete-generic-password', 'delete-internet-password', 'set-generic-password-partition-list',
  'set-internet-password-partition-list', 'dump-keychain', 'export'
]
/** The keychain service name `OrgAI Vault` (vaultTypes KEYCHAIN_SERVICE) in any case and spacing, quotes or escapes between. */
const VAULT_LABEL = /orgai(?:[\s"'\\]|\\x20|\\040|\\u0020)*vault/i
/** secret-tool subcommands (any secret-tool call is denied at the program position; elsewhere one must follow it). */
const SECRET_TOOL_SUBCOMMANDS: readonly string[] = ['lookup', 'store', 'search', 'clear', 'lock', 'unlock']
/** D-Bus clients that can call the Secret Service. */
const DBUS_TOOLS: readonly string[] = ['busctl', 'gdbus', 'dbus-send', 'qdbus', 'qdbus6', 'qdbus-qt5', 'qdbus-qt6']
/** The Secret Service bus name, object path or interface (`org.freedesktop.secrets`, `/org/freedesktop/secrets`, `org.freedesktop.Secret.Service`). */
const SECRETS_BUS = /org[./]freedesktop[./]secrets?\b/i
/** PowerShell programs, and the DPAPI names their text may not carry (ProtectedData, Unprotect, CryptUnprotectData). */
const POWERSHELLS: readonly string[] = ['pwsh', 'pwsh-preview', 'powershell', 'powershell_ise']
const PS_DPAPI = /ProtectedData|Unprotect/i
const SECURITY: readonly string[] = ['security']
const SECRET_TOOL: readonly string[] = ['secret-tool']
/**
 * Keyring front ends that take a service name (review round 2): `security`, python-keyring's `keyring` console script
 * (Keychain or Secret Service) and KWallet's `kwallet-query` / `kwalletcli`. Any of these followed later by the
 * `OrgAI Vault` name is denied.
 */
const VAULT_LABEL_TOOLS: readonly string[] = ['security', 'keyring', 'kwallet-query', 'kwalletcli', 'kwallet5-query', 'kwallet6-query']

/** What `security`'s leading options say (securityOptions). */
interface SecurityOptions {
  /** Index of the subcommand word (words.length when there is none). */
  sub: number
  /** `-i` among the options: it then reads commands from stdin. */
  interactive: boolean
  /** An input redirect, here-document or here-string before the subcommand. */
  stdin: boolean
}

/**
 * `security`'s options after words[k], read the way its getopt does (review round 2): `--` ends them, `-p` takes the
 * rest of its cluster or else the next word as its value (`-pfoo`, `-qpfoo`, `-p foo`), and any other cluster of h, i,
 * l, q, v is skipped. `strict` (a `security` word anywhere in the segment, maybe some other program's argument) stops at
 * a word that is not one of those clusters; at the program position every `-` word is skipped (fail closed: security
 * answers an unknown option with its usage text), and redirects are read too.
 */
function securityOptions(words: readonly string[], k: number, strict: boolean): SecurityOptions {
  let interactive = false
  let stdin = false
  let j = k + 1
  for (; j < words.length; j++) {
    const w = words[j]
    if (!strict && /^\d*[<>]/.test(w)) {
      if (w.includes('<')) stdin = true
      if (/^\d*(?:<<<?|[<>]+&?)$/.test(w)) j++
      continue
    }
    if (w === '--') {
      j++
      break
    }
    if (w.length < 2 || !w.startsWith('-')) break
    if (strict && !/^-[hilqv]*(?:p[\s\S]*)?$/.test(w)) break
    if (!strict && w.includes('<')) stdin = true
    const p = w.indexOf('p', 1)
    if (w.slice(1, p < 0 ? undefined : p).includes('i')) interactive = true
    // `-p` with nothing after it in the cluster takes the next word.
    if (p === w.length - 1) j++
  }
  return { sub: Math.min(j, words.length), interactive, stdin }
}

/** Separators between words in code text: spaces, quotes, array and call punctuation. */
const SEP = `[\\s'",[\\](){}+]`
const NOT_SEP = `[^\\s'",[\\](){}+]`
/** One `security` option in code text: `-p <value>`, `-pX`, `--`, `-qv`. Bounded repetitions only. */
const SECURITY_CODE_OPTION = `(?:-p${SEP}{1,16}(?!-)${NOT_SEP}{1,64}${SEP}{1,16}|--?${NOT_SEP}{0,64}${SEP}{1,16})`

/**
 * Wave 7 (cli-standalone 8.4): the segment calls a key custodian tool. Every name is read through wordMayBe (escapes
 * and globs, review round 1). Anywhere in the words (wrappers OrgAI does not unwrap): `security` whose subcommand after
 * its own options (securityOptions, strict) is a KEYCHAIN_SUBCOMMANDS word; a keyring front end (VAULT_LABEL_TOOLS)
 * followed later by the `OrgAI Vault` name; `secret-tool` directly followed by one of its subcommands; a D-Bus client
 * followed later by a Secret Service name. At the program position: any `secret-tool` call; `security` with `-i` among
 * its leading options, an input redirect, here-document or here-string before its subcommand, a keychain subcommand,
 * or no subcommand at all (it then reads commands from stdin; a pipe into it is caught by textRunsCli); PowerShell
 * with a word naming ProtectedData or Unprotect. Other `security` subcommands (find-certificate, find-identity, cms -D
 * -i, verify-cert...) pass, and so does a word `security` that is some other program's argument (`rg security -e
 * export`).
 */
function custodianCall(words: readonly string[], at: number): boolean {
  let busLater = false
  let labelLater = false
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k]
    if (busLater && wordMayBe(w, DBUS_TOOLS)) return true
    if (labelLater && wordMayBe(w, VAULT_LABEL_TOOLS)) return true
    busLater ||= SECRETS_BUS.test(w)
    // `OrgAI Vault` in this word, also split over this and the next one (`OrgAI\ Vault`, `OrgAI Vault` unquoted).
    labelLater ||= VAULT_LABEL.test(words[k + 1] === undefined ? w : `${w} ${words[k + 1]}`)
  }
  for (let k = 0; k < words.length; k++) {
    const w = words[k]
    if (wordMayBe(w, SECRET_TOOL) && words[k + 1] !== undefined && wordMayBe(words[k + 1], SECRET_TOOL_SUBCOMMANDS)) return true
    if (!wordMayBe(w, SECURITY)) continue
    const { sub } = securityOptions(words, k, true)
    if (sub < words.length && wordMayBe(words[sub], KEYCHAIN_SUBCOMMANDS)) return true
  }
  const prog = words[at]
  if (prog === undefined) return false
  if (wordMayBe(prog, SECRET_TOOL)) return true
  if (wordMayBe(prog, POWERSHELLS)) return words.slice(at + 1).some((w) => PS_DPAPI.test(w))
  if (!wordMayBe(prog, SECURITY)) return false
  const opts = securityOptions(words, at, false)
  if (opts.interactive || opts.stdin || opts.sub >= words.length) return true
  return wordMayBe(words[opts.sub], KEYCHAIN_SUBCOMMANDS)
}

/**
 * Programs that run inline or stdin code (`python3 -c`, `osascript -e`, a here-document fed to perl...): CUSTODIAN_CODE
 * is matched on the code such a segment carries (custodianCodeRuns), since the code may call a custodian tool itself
 * (`subprocess.run(['security', 'dump-keychain'])`, `keyring.get_password('OrgAI Vault', id)`).
 */
const CODE_RUNNERS: ReadonlySet<string> = new Set([
  ...INTERPRETERS, 'python', 'python2', 'python3', 'pythonw', 'py', 'pypy', 'pypy3', 'perl', 'ruby', 'irb', 'php', 'lua',
  'osascript', 'swift', 'rscript', 'awk', 'gawk', 'mawk', 'nawk', 'jshell', 'groovy', 'tclsh', 'expect'
])
/** Custodian calls and names inside code text (see CODE_RUNNERS). Bounded repetitions only; array and call punctuation between words. */
const CUSTODIAN_CODE: readonly RegExp[] = [
  new RegExp(`\\bsecurity${SEP}{1,16}${SECURITY_CODE_OPTION}{0,8}(?:${KEYCHAIN_SUBCOMMANDS.join('|')})\\b`, 'i'),
  // Review round 2: `security -i` (also after other options), and `security` alone at the end of a string, array or call
  // (`os.system('security')`, `run(['security'], input=...)`, `execSync('printf x | security')`): it reads stdin.
  new RegExp(`\\bsecurity${SEP}{1,16}${SECURITY_CODE_OPTION}{0,8}-[hlqv]*i`, 'i'),
  /\bsecurity['"`]\s*(?:[\]);]|$)/im,
  /\|\s*(?:[^\s|'"]*\/)?security(?![\w.-])/i,
  /\bsecret-tool\b/i,
  SECRETS_BUS,
  VAULT_LABEL,
  /CryptUnprotectData|ProtectedData/i
]

/** A code runner's program name: CODE_RUNNERS, versioned pythons (`python3.12`) included. */
function isCodeRunner(bare: string): boolean {
  return CODE_RUNNERS.has(bare) || /^python[\d.]*$/.test(bare)
}

/** A code runner given no script, program text or inline code reads its code from stdin (`python3`, `perl -`, `awk -f -`). */
function codeRunnerReadsStdin(bare: string, rest: readonly string[]): boolean {
  if (INTERPRETERS.has(bare)) return !interpreterHasScript(bare, rest)
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    if (w === '-') return true
    if (/^\d*[<>]/.test(w)) {
      if (/^\d*(?:<<<?|[<>]+&?)$/.test(w)) k++
      continue
    }
    if (!w.startsWith('-')) return false
  }
  return true
}

/**
 * Review round 1: code a code-runner segment of `text` runs names a key custodian (CUSTODIAN_CODE): its own words
 * (`python3 -c "..."`, `node -e "..."`, a here-string), the whole text when it takes a here-document (the body sits on
 * later lines; fail closed), and the pieces before it when it reads its code from a pipe. A code runner that only
 * shares the text with such a word (`grep -rn 'secret-tool' docs | awk '{print $1}'`, `grep 'OrgAI Vault' src && node
 * -v`) is not.
 */
function custodianCodeRuns(text: string): boolean {
  const segments = cliSegments(text)
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]
    const words = segmentWords(seg.text)
    const at = programIndex(words)
    const prog = words[at]
    if (prog === undefined) continue
    const bare = wordNames(prog).find(isCodeRunner)
    if (bare === undefined) continue
    const rest = words.slice(at + 1)
    if (CUSTODIAN_CODE.some((re) => re.test(seg.text))) return true
    if (rest.some((w) => /^\d*<<(?!<)/.test(w))) return true
    if (seg.pipeIn && codeRunnerReadsStdin(bare, rest) && segments.slice(0, k).some((u) => CUSTODIAN_CODE.some((re) => re.test(u.text)))) return true
  }
  return false
}

/** The program word of a segment (after env assignments and wrappers), or undefined when there is none. */
function segmentProgramWord(segment: string): string | undefined {
  const words = segmentWords(segment)
  return words[programIndex(words)]
}

/**
 * Wave 7 (cli-standalone 8.4, review round 1): any word referencing ORGAI_VAULT_*, matched on the text with quotes,
 * backslashes, backticks and brackets removed (`ORGAI_"VAULT"`, `ORGAI_VAU\LT`, `ORGAI_[V]AULT`), case-insensitive:
 * expansions, assignments, exports, `printenv | grep ORGAI_VAULT`, `Get-ChildItem Env: | ? Name -like 'ORGAI_VAULT*'`,
 * and also a plain mention (`grep -rn ORGAI_VAULT_KEY_FILE src`; agents search with the Grep tool instead). A shortened
 * prefix that can only stand for it (`ORGAI_V*`, `${!ORGAI_VA@}`) counts too; `ORGAI_VERSION` does not.
 */
const VAULT_ENV_WORD = /ORGAI_VAULT|ORGAI_V(?:A(?:UL?)?)?(?![A-Za-z0-9_])/i

function referencesVaultEnv(text: string): boolean {
  return VAULT_ENV_WORD.test(text.replace(/["'\\`[\]]/g, ''))
}

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
    // Every spelling of the word (`ar\\ch`, `/usr/bin/x\\crun`; review round 1).
    const names = wordNames(w)
    const nextNames = words[i + 1] !== undefined ? wordNames(words[i + 1]) : []
    const is = (n: string): boolean => names.includes(n)
    const nextIs = (...ns: string[]): boolean => ns.some((n) => nextNames.includes(n))
    if (is('env')) {
      i++
      while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]))) {
        // `env -u NAME` / `env -C dir` take a value.
        if (/^-[uCS]$/.test(words[i]) || /^--(?:unset|chdir|split-string)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if (['command', 'exec', 'nohup', 'time', 'builtin', 'sudo', 'doas', 'stdbuf', 'caffeinate', 'call', 'start', 'xargs', 'nice', 'ionice', 'chrt', 'setsid', 'bunx', 'pnpx', 'watch'].some(is)) {
      i++
      // Options of the wrapper (and a value after nice -n / timeout's duration).
      while (i < words.length && words[i].startsWith('-')) {
        if (/^-(?:n|p|c|u|I|L|P)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if (is('timeout')) {
      i++
      while (i < words.length && words[i].startsWith('-')) i++
      i++ // duration
      continue
    }
    // macOS `xcrun [--sdk X] security ...`, `arch [-arm64 | -arch arm64] [-e VAR=x] security ...` (Wave 7: key
    // custodian tools). arch(1)'s `-arch <name>`, `-e VAR=x` and `-d VAR` take a value (review round 1).
    if (is('xcrun') || is('arch')) {
      const valued = is('xcrun') ? /^-{1,2}(?:sdk|toolchain)$/ : /^-(?:arch|[ed])$/
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (valued.test(words[i])) i++
        i++
      }
      continue
    }
    // Review round 2: macOS `launchctl asuser <uid> <cmd>` / `bsexec <pid> <cmd>`, and `script [options] <file> <cmd>`
    // (BSD; util-linux `script -c <text>` is read as a command text in wordsRunCli, scriptCommandTexts).
    if (is('launchctl') && nextIs('asuser', 'bsexec')) {
      i += 3
      continue
    }
    if (is('script')) {
      i++
      while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
        if (SCRIPT_VALUE_OPTION.test(words[i])) i++
        i++
      }
      i++ // the typescript file
      continue
    }
    if (is('npx')) {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (/^(?:-p|--package)$/.test(words[i])) i++
        i++
      }
      continue
    }
    if ((is('npm') && nextIs('exec', 'x')) || ((is('pnpm') || is('yarn')) && nextIs('dlx', 'exec')) || (is('bun') && nextIs('x'))) {
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

/** `script` options that take the next word as their value: BSD `-t <time>`, util-linux `-c`, `-T`, `-I`, `-O`, `-B`, `-E`, `-m` and long forms. */
const SCRIPT_VALUE_OPTION = /^(?:-[A-Za-z]*[tcTIOBEm]|--(?:command|log-in|log-out|log-io|log-timing|logging-format|echo|output-limit))$/

/** The command texts util-linux `script -c <text>` / `--command <text>` / `--command=<text>` runs (review round 2). */
function scriptCommandTexts(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (!wordNames(words[i]).includes('script')) continue
    for (let j = i + 1; j < words.length && words[j].startsWith('-'); j++) {
      const w = words[j]
      if (w.startsWith('--command=')) out.push(w.slice('--command='.length))
      else if (/^-[A-Za-z]*c$/.test(w) || w === '--command') {
        if (words[j + 1] !== undefined) out.push(words[j + 1])
        j++
      } else if (SCRIPT_VALUE_OPTION.test(w)) j++
    }
  }
  return out
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
  const runner = words.some((w) => wordMayBe(w, PACKAGE_RUNNERS))
  for (let k = 0; runner && k < words.length; k++) {
    if (/^(?:-p|--package)$/.test(words[k]) && words[k + 1] && CLI_NAME.test(binName(words[k + 1]))) return true
    const eq = /^(?:--package=|-p)(.+)$/.exec(words[k])
    if (eq && CLI_NAME.test(binName(eq[1]))) return true
  }
  // Wave 7 (cli-standalone 8.4): a package runner naming the npm package. `@orgai/cli` is matched on the raw word
  // (binName keeps only `cli`), in every spelling (`@orgai/cli@1.2.3`, `--package=@orgai/cli`, `npm:@orgai/cli`, a
  // registry URL), and so is any `orgai` word; a `-c` / `--call` value or a first positional word holding whitespace
  // (`npx -c 'orgai status'`, `pnpm dlx -c ...`) is a command text of its own (runnerCommandTexts).
  if (isPackageRunner(words)) {
    for (const w of words) if (runnerWordNamesCli(w)) return true
    for (const t of runnerCommandTexts(words)) {
      if (depth >= MAX_NEST) return (budget.limited = true)
      if (textRunsCli(t, depth + 1, budget, check)) return true
    }
  }
  // `env -S 'X=1 prog' args`: the split string is a command text of its own (assignments included).
  const split = envSplitText(words)
  if (split !== null) {
    if (depth >= MAX_NEST) return (budget.limited = true)
    if (textRunsCli(split, depth + 1, budget, check)) return true
  }
  // util-linux `script -c 'security -i' /dev/null`: the -c text is a command of its own.
  for (const t of scriptCommandTexts(words)) {
    if (depth >= MAX_NEST) return (budget.limited = true)
    if (textRunsCli(t, depth + 1, budget, check)) return true
  }
  const at = programIndex(words)
  // Wave 7: the vault key's custodian tools (security, secret-tool, D-Bus clients, PowerShell DPAPI).
  if (custodianCall(words, at)) return true
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
    if (CLI_NAME.test(binName(w)) || SCOPED_CLI.test(w)) return true
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
  return spellings(word).some((w) => CLI_NAME.test(binName(w)) || SCOPED_CLI.test(w) || (/[\\/]/.test(w) && insideCliRoot(w, check)))
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
    if (CLI_NAME.test(binName(v)) || SCOPED_CLI.test(v) || insideCliRoot(v, check)) return true
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
  return keptSubsequence(base, 'orgai') >= 3
}

/** How many letters of `name`, in order, a glob keeps (globKeptLetters). */
function keptSubsequence(glob: string, name: string): number {
  let got = 0
  for (const ch of globKeptLetters(glob)) if (name[got] === ch) got++
  return got
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
  // Wave 7: any word referencing ORGAI_VAULT_*, quoted or not (it may be handed to a shell).
  if (referencesVaultEnv(text)) return true
  const plain = unquoted(text)
  if (/\bsetx\s+ELECTRON_RUN_AS_NODE\b/i.test(plain)) return true
  for (const segment of cliSegments(plain)) if (assignsElectronAsNode(segment.text)) return true
  // Wave 7: code run by an interpreter (inline, piped or a here-document) that calls a key custodian tool.
  if (CUSTODIAN_CODE.some((re) => re.test(text)) && custodianCodeRuns(text)) return true
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
      // Wave 7: `security` reading its commands from a pipe; PowerShell reading DPAPI code from one.
      if (seg.pipeIn) {
        const reader = segmentProgramWord(seg.text)
        if (reader !== undefined && wordMayBe(reader, SECURITY)) return true
        if (reader !== undefined && wordMayBe(reader, POWERSHELLS) && segments.slice(0, k).some((u) => PS_DPAPI.test(u.text))) return true
      }
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
 * True when a shell command runs the OrgAI CLI (cli-spec 3.4(1)(a)), a key custodian tool or references ORGAI_VAULT_*
 * (Wave 7), or cannot be read to the end (over MAX_SEGMENTS segments, a shell -c nested deeper than MAX_NEST): all are
 * denied. Path rules and the PowerShell-tool DPAPI rule are not part of it. Exported for tests.
 */
export function commandRunsOrgaiCli(command: string, opts: CliScanOptions = {}): boolean {
  return cliScan(command, opts) !== null
}

/** Programs that read a here-document's body only as data: never as code, file names or arguments to run. */
const HEREDOC_DATA_SINKS: ReadonlySet<string> = new Set([
  'cat', 'tee', 'git', 'gh', 'wc', 'head', 'tail', 'sort', 'uniq', 'tr', 'cut', 'grep', 'egrep', 'fgrep', 'rg', 'diff',
  'jq', 'column', 'fold', 'fmt', 'nl', 'rev', 'paste', 'expand', 'unexpand', 'base64', 'iconv'
])
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

/** May the here-document whose operator starts at `op` (inside `frames`) be read as data only? (body checks aside) */
function heredocEligible(text: string, frames: readonly HeredocFrame[], op: number): boolean {
  const f = frames[frames.length - 1]
  const cmd = commandName(text.slice(f.cmdStart, op))
  if (!cmd) return false
  if (frames.length === 1) {
    // git / gh only as a message (`git commit -F -`, `gh pr create --body-file -`): never `git apply`, whose patch names files.
    if (cmd.name === 'git') return cmd.words.some((w) => GIT_MESSAGE_SUBCOMMANDS.has(w))
    if (cmd.name === 'gh') return cmd.words.some((w) => GH_MESSAGE_SUBCOMMANDS.has(w))
    return HEREDOC_DATA_SINKS.has(cmd.name)
  }
  // `git commit -m "$(cat <<'EOF' ... EOF)"`: only plain cat, one level deep, as a git / gh message value.
  if (frames.length !== 2 || cmd.name !== 'cat' || cmd.words.length !== 1) return false
  const outerText = text.slice(frames[0].cmdStart, f.subStart)
  if (!MESSAGE_OPTION_TAIL.test(outerText)) return false
  const outer = commandName(outerText)
  if (!outer) return false
  if (outer.name === 'git') return outer.words.some((w) => GIT_MESSAGE_SUBCOMMANDS.has(w))
  if (outer.name === 'gh') return outer.words.some((w) => GH_MESSAGE_SUBCOMMANDS.has(w))
  return false
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
 * is left out only when all of these hold: its program is a data sink (HEREDOC_DATA_SINKS; inside a substitution only
 * `cat` as a git / gh message value), its delimiter is quoted or its body has no `$(` / backtick, its operator's line
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
function searchDenied(
  toolName: string,
  input: Record<string, unknown>,
  refs: readonly string[],
  ctx: SelfControlContext,
  platform: NodeJS.Platform,
  prefixed: readonly PrefixProtection[]
): boolean {
  const opts = { platform, home: ctx.home, prefixed }
  const root = typeof input.path === 'string' && input.path ? input.path : ctx.cwd
  const pattern = typeof input.pattern === 'string' && input.pattern ? input.pattern : undefined
  // A search rooted AT or UNDER a protected path is denied whatever its filter (ripgrep searches a named file whatever
  // its --glob). One rooted ABOVE it (the home folder, the data dir) is allowed when its file filter can only match
  // source or text files with a known extension (review M3): no protected file has one.
  if (root !== undefined && pathAtOrUnder(root, refs, ctx.cwd, opts)) return true
  if (toolName === 'Grep') {
    const safeFilter = safeFileGlob(input.glob) || safeSearchType(input.type)
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

function safeSearchType(v: unknown): boolean {
  return typeof v === 'string' && SAFE_SEARCH_TYPES.has(v.toLowerCase())
}

/** An absolute or ~ pattern (Grep's regex is a path only then). */
function isRootedPattern(pattern: string, platform: NodeJS.Platform): boolean {
  const abs = platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(pattern) : pattern.startsWith('/')
  return abs || pattern === '~' || /^~[\\/]/.test(pattern)
}

/** Base-name prefixes protected directly inside the data folder (cli-standalone 8.4): the vault, secrets.json and their siblings. */
export const VAULT_FILE_PREFIXES: readonly string[] = [VAULT_FILE, LEGACY_SECRETS_FILE]

/**
 * The data folders among the protected paths, each spelling (Wave 7): the parent of a `secrets.json` entry that also
 * has a `run` sibling in the list (controlProtectedPaths always lists both, lexical and canonical), so adapters need
 * no new field. Their direct children named `vault.json*` / `secrets.json*` are protected by prefix; a glob ending in
 * a source or document extension (SAFE_SEARCH_EXTS: `<data>/*.md`) is not read as one of them.
 */
export function vaultPrefixProtections(refs: readonly string[], platform: NodeJS.Platform = process.platform): PrefixProtection[] {
  const p = platform === 'win32' ? win32 : posix
  const fold = (v: string): string => (platform === 'win32' || platform === 'darwin' ? v.toLowerCase() : v)
  const all = new Set(refs.filter((r) => p.isAbsolute(r)).map((r) => fold(p.resolve(r))))
  const out: PrefixProtection[] = []
  for (const r of refs) {
    if (!p.isAbsolute(r) || fold(p.basename(r)) !== LEGACY_SECRETS_FILE) continue
    const dir = p.dirname(p.resolve(r))
    if (all.has(fold(p.join(dir, 'run'))) && !out.some((o) => o.dir === dir)) out.push({ dir, prefixes: VAULT_FILE_PREFIXES, safeExtensions: SAFE_SEARCH_EXTS })
  }
  return out
}

/** Most brace-expanded words one shell text may grow by before the path scan gives up (fail closed). */
const MAX_PATH_BRACE_WORDS = 1024
/** A shell token: quoted spans, backslash escapes (an escaped space included) and other non-space characters. */
const SHELL_TOKEN = /(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|`[\s\S]|[^\s'"\\`])+/g

/**
 * The other spellings of a shell text the path scan also reads (Wave 7), or 'limit'. The first:
 * brace expansions expanded per token (`<data>/{vault,x}.json`), the folders OrgAI's data folder lives in written as
 * the home folder (`$XDG_CONFIG_HOME` -> `$HOME/.config`, `%APPDATA%` / `$env:APPDATA` -> `$HOME/AppData/Roaming`,
 * LOCALAPPDATA likewise; the conventional values, so a moved folder is not followed), and an escaped space (bash `\ `,
 * PowerShell backtick-space) written as a quoted one, since the word splitter would otherwise cut
 * `~/Library/Application\ Support/OrgAI/vault.json` in two. The second: the first with quotes, parentheses and commas
 * read as spaces, so a path inside inline code (`node -e "fs.readFileSync('<data>/vault.json')"`) is a word of its
 * own. Spellings equal to the text or to each other are left out.
 */
function pathScanVariants(text: string): string[] | 'limit' {
  let grown = 0
  let limited = false
  let out = text.replace(SHELL_TOKEN, (tok) => {
    if (!/\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/.test(tok)) return tok
    const words = expandBraces(tok, MAX_BRACE_WORDS)
    if (words.length >= MAX_BRACE_WORDS) limited = true
    grown += words.length
    return words.join(' ')
  })
  if (limited || grown > MAX_PATH_BRACE_WORDS) return 'limit'
  out = out
    .replace(/\$\{?XDG_CONFIG_HOME\}?/g, '$HOME/.config')
    .replace(/\$\{?XDG_DATA_HOME\}?/g, '$HOME/.local/share')
    .replace(/%APPDATA%|\$\{?env:APPDATA\}?|\$\{?APPDATA\}?/gi, '$HOME/AppData/Roaming')
    .replace(/%LOCALAPPDATA%|\$\{?env:LOCALAPPDATA\}?|\$\{?LOCALAPPDATA\}?/gi, '$HOME/AppData/Local')
  const code = out.replace(/['"(),]/g, ' ')
  out = out.replace(/(?:\\|`)([ \t])/g, "'$1'")
  return [...new Set([out, code])].filter((v) => v !== text)
}

/**
 * PowerShell `-EncodedCommand` texts in a command (`pwsh -enc <base64 UTF-16LE>`, also `-e`, `-ec` and any prefix of
 * `-EncodedCommand`, `/` or `-`), decoded, at most 16 and 256 KB each; read like any other command text (Wave 7: a
 * DPAPI call or a vault path must not hide in one). A word that is not one decodes to noise and matches nothing.
 */
function encodedCommandTexts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[\s'"(])[-/]([A-Za-z]+)(?::|\s+)['"]?([A-Za-z0-9+/]{4,}={0,2})/g)) {
    const flag = m[1].toLowerCase()
    if (!(flag === 'e' || flag === 'ec' || (flag.length >= 2 && 'encodedcommand'.startsWith(flag)))) continue
    if (m[2].length > 4 * 256 * 1024 || out.length >= 16) continue
    const decoded = Buffer.from(m[2], 'base64').toString('utf16le').replace(/\0/g, '')
    if (decoded.trim()) out.push(decoded)
  }
  return out
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
    const prefixed = vaultPrefixProtections(refs, platform)
    if (shellTool) {
      const command = i.command
      if (typeof command !== 'string' || !command.trim()) return null
      const shell = ctx.shell ?? (toolName === 'PowerShell' ? 'powershell' : 'bash')
      const text = shell === 'bash' ? stripDataHeredocs(command) : command
      // The text as given, then any -EncodedCommand text it carries (PowerShell grammar), one level deep.
      const texts: { text: string; shell: 'bash' | 'powershell' }[] = [{ text, shell }, ...encodedCommandTexts(text).map((t) => ({ text: t, shell: 'powershell' as const }))]
      let limited = false
      for (const t of texts) {
        // PowerShell text naming DPAPI (Wave 7): the PowerShell tool's own command or an encoded one.
        if (t.shell === 'powershell' && PS_DPAPI.test(t.text)) return SELF_CONTROL_DENIAL_MESSAGE
        const cli = cliScan(t.text, { cwd: ctx.cwd, cliRoots: ctx.cliRoots, platform })
        if (cli === 'runs') return SELF_CONTROL_DENIAL_MESSAGE
        if (cli === 'limit') limited = true
      }
      if (limited) return SELF_CONTROL_UNCHECKED_MESSAGE
      if (ctx.pathsUnavailable) return SELF_CONTROL_UNCHECKED_MESSAGE
      if (!refs.length) return null
      for (const t of texts) {
        const variants = pathScanVariants(t.text)
        if (variants === 'limit') return SELF_CONTROL_UNCHECKED_MESSAGE
        for (const spelling of [t.text, ...variants]) {
          const scan = commandControlScan(spelling, ctx.cwd, refs, { shell: t.shell, platform, home: ctx.home, prefixed })
          if (scan === 'touch') return SELF_CONTROL_DENIAL_MESSAGE
          if (scan === 'limit') limited = true
        }
      }
      return limited ? SELF_CONTROL_UNCHECKED_MESSAGE : null
    }
    if (!FILE_TOOLS.has(toolName) || !refs.length) return null
    if (toolName === 'Glob' || toolName === 'Grep') return searchDenied(toolName, i, refs, ctx, platform, prefixed) ? SELF_CONTROL_DENIAL_MESSAGE : null
    for (const target of fileTargets(i)) {
      if (pathAtOrUnder(target, refs, ctx.cwd, { platform, home: ctx.home, prefixed })) return SELF_CONTROL_DENIAL_MESSAGE
    }
    return null
  } catch {
    // A shell command the gate could not check never runs unread (bypassPermissions would allow it).
    return shellTool ? SELF_CONTROL_UNCHECKED_MESSAGE : null
  }
}
