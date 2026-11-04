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
 * PowerShell array and hash literals (`@(...)`, `@{...}`) in every shell.
 */
const UNSAFE_UNQUOTED = /[(){}]|@[({]/

/**
 * PowerShell splatting (`@args`) at the start of a word or after `,` / `;` / `=` (reviewer-3 M4): refused only for
 * PowerShell, so bash keeps `npm install @types/node` and `npx @biomejs/biome check`. A mid-word `@` (`pkg@1.2.3`)
 * stays plain in both.
 */
const UNSAFE_UNQUOTED_POWERSHELL = /(?:^|[\s,;=])@/

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

/** The segment with single-quoted text removed (double-quoted text kept: both shells expand `$` there). */
function outsideSingleQuotes(segment: string): string {
  let out = ''
  let quote: string | null = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"') out += ch
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else out += ch
  }
  return out
}

/**
 * A segment's words the way a shell hands them to the program: split on whitespace outside quotes, quote characters
 * removed (so `--upload-p"ack"=x` reads `--upload-pack=x`). Backslashes are kept (Windows paths).
 */
export function segmentWords(segment: string): string[] {
  const words: string[] = []
  let cur = ''
  let inWord = false
  let quote: string | null = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
      continue
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(cur)
      cur = ''
      inWord = false
      continue
    }
    cur += ch
    inWord = true
  }
  if (inWord) words.push(cur)
  return words
}

/** A program word's name: base name, lowercase, `.exe` / `.cmd` / `.bat` / `.ps1` dropped. */
function binName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/**
 * Environment variables that make the next program run another one or load code (`NODE_OPTIONS=--import=x npm test`,
 * `GIT_SSH_COMMAND=x git fetch`). A leading `NAME=value` with one of these names is refused even under a rule that
 * spells it out. Curated, not complete.
 */
const PROGRAM_ENV =
  /^(?:NODE_OPTIONS|NODE_PATH|NPM_CONFIG_\w+|YARN_\w+|PNPM_\w+|BUN_\w+|GIT_\w+|LD_\w+|DYLD_\w+|PAGER|EDITOR|VISUAL|SHELL|BASH_ENV|ENV|PATH|PYTHON\w*|PERL5\w*|RUBYOPT|RUBYLIB|CARGO_\w+|RUSTC\w*|RUSTDOC\w*|RUSTFLAGS|GOFLAGS|GOENV|GOTOOLCHAIN|MAKEFLAGS|MAKEFILES|MFLAGS|DOTNET_\w+|MSBUILD\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PROMPT_COMMAND|PS4|IFS|SSH_ASKPASS|SUDO_ASKPASS|DOCKER_\w+|KUBECONFIG|CC|CXX)$/i

/** The long option name of `--name` / `--name=value` (lowercase, `_` read as `-`), else null. */
function longName(word: string): string | null {
  const m = /^--([^=]+)/.exec(word)
  return m ? m[1].toLowerCase().replace(/_/g, '-') : null
}

/** True when `n` names one of `refused` or abbreviates one (two letters at least), unless it is one of `exact`. */
function refusedName(n: string, refused: readonly string[], exact: ReadonlySet<string> = EMPTY): boolean {
  if (exact.has(n) || n.startsWith('no-')) return refused.includes(n)
  return n.length >= 2 && refused.some((r) => r.startsWith(n))
}
const EMPTY: ReadonlySet<string> = new Set()

/**
 * True when a long option names one of `refused`, abbreviates one (npm's nopt, git's parse-options and GNU make's
 * getopt accept unique prefixes: `--node-opt=x`, `--upload-p=x`; two letters at least) or starts with one of `prefixes`.
 */
function refusedLong(word: string, refused: readonly string[], prefixes: readonly string[] = []): boolean {
  const n = longName(word)
  if (!n) return false
  if (prefixes.some((p) => n.startsWith(p))) return true
  return n.length >= 2 && refused.some((r) => r.startsWith(n))
}

/**
 * True when `args[i]` is a `--` that really ends the options (reviewer-4 H-E): go's flag parser and git's parse-options
 * take the next word as an option's value even when it is `--` (`go test -run -- -exec=calc`, `git clone -b -- -c x`),
 * so a `--` right after an option without `=` (other than a known flag in `bools`) is that option's value.
 */
function endsOptions(args: readonly string[], i: number, bools: ReadonlySet<string> = EMPTY, markers: readonly string[] = ['--']): boolean {
  if (!markers.includes(args[i])) return false
  const prev = i > 0 ? args[i - 1] : ''
  return !prev.startsWith('-') || prev.includes('=') || bools.has(prev)
}

/** go test / build flags that take no value, so a following `-args` / `--` is real. */
const GO_BOOL_FLAGS: ReadonlySet<string> = new Set(['-v', '-race', '-short', '-cover', '-x', '-n', '-a', '-json', '-failfast', '-benchmem', '-trimpath', '-mod=mod'])

const NPM_FAMILY: ReadonlySet<string> = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx'])
/**
 * npm-family options that run another program, load other config or switch the package folder (reviewer-3 H1,
 * reviewer-4 M-4): `--git` (git dependencies), `--browser`, `--editor`, `--shell`, `--node-gyp` and `--viewer` name a
 * program npm runs.
 */
const NPM_REFUSED_LONG = [
  'script-shell', 'node-options', 'userconfig', 'globalconfig', 'prefix', 'dir', 'cwd', 'call', 'use-yarnrc', 'git', 'browser', 'editor',
  'shell', 'node-gyp', 'viewer'
]
/** bun options that load code before the tests or scripts (reviewer-4 M-4). */
const BUN_REFUSED_LONG = ['preload', 'env-file']
/** Real npm keys that are prefixes of a refused name: never read as an abbreviation (`--global`, `--no`). */
const NPM_EXACT_KEYS: ReadonlySet<string> = new Set(['global', 'no'])
/** Subcommands that run a package. */
const NPM_EXEC_SUBS: ReadonlySet<string> = new Set(['exec', 'x', 'dlx'])
/** Flags that take no value, so the word after one is a positional (`npx --yes eslint -c x`). */
const NPM_BOOL_FLAGS: ReadonlySet<string> = new Set([
  '--yes', '-y', '--no', '--no-install', '--quiet', '-q', '--silent', '-s', '--ignore-existing', '--prefer-offline', '--offline',
  '--verbose', '--recursive', '-r', '--if-present', '--frozen-lockfile', '--save-dev', '-D', '--save', '-S', '--global', '-g',
  '--production', '--force', '--watch', '--coverage', '--ci', '--dev', '--exact', '-E'
])

/**
 * npm, pnpm, yarn, bun and their runners, up to a real `--` (endsOptions):
 * - the names in NPM_REFUSED_LONG (and bun's BUN_REFUSED_LONG / `-r`) in any spelling: `=`, a separate value, quoted,
 *   abbreviated, `_` for `-`, and any number of leading dashes (nopt strips `^-+`, so `-script-shell=x` and
 *   `---script-shell=x` are long options too; reviewer-4 H-C); pnpm's `--config.<key>`;
 * - `-C` (npm's --prefix, pnpm's --dir) anywhere for npm and before the subcommand for the others; `-c` (--call / shell
 *   mode) anywhere for `npm exec` / `npm x`, else before the subcommand or before the package of npx / pnpm dlx.
 * npm parses its options everywhere, `npm exec` included (reviewer-4 H-D); only npx, pnpx, bunx and the dlx / exec /
 * x subcommands of pnpm, yarn and bun stop at the package, whose arguments are its own (`npx eslint -c .eslintrc`).
 */
function npmRunsProgram(bin: string, args: readonly string[]): boolean {
  const runner = bin === 'npx' || bin === 'pnpx' || bin === 'bunx'
  const isBun = bin === 'bun' || bin === 'bunx'
  let positional = 0
  let execMode = runner
  let prev = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endsOptions(args, i, NPM_BOOL_FLAGS)) break
    if (!a.startsWith('-') || a === '-' || a === '--') {
      // A word right after an option that takes a value is that value, not a positional.
      const isValue = prev.startsWith('-') && !prev.includes('=') && !NPM_BOOL_FLAGS.has(prev)
      prev = a
      if (isValue) continue
      positional++
      if (positional === 1 && !runner && NPM_EXEC_SUBS.has(a.toLowerCase())) {
        execMode = true
        continue
      }
      // The package of a runner: what follows is the package's own (npm exec keeps parsing, H-D).
      if (execMode && bin !== 'npm') return false
      continue
    }
    prev = a
    const name = /^-+([^=]+)/.exec(a)?.[1].toLowerCase().replace(/_/g, '-') ?? ''
    if (name.startsWith('config.')) return true
    // Short flags (`-g`, `-w`, `-C`) are handled below; any longer name after one or more dashes is a long option.
    if (name.length > 1 && (refusedName(name, NPM_REFUSED_LONG, NPM_EXACT_KEYS) || (isBun && refusedName(name, BUN_REFUSED_LONG)))) return true
    if (isBun && /^-r(?:=|$)/.test(a)) return true
    const beforeSub = positional === 0 || execMode
    if (/^-C/.test(a) && (bin === 'npm' || beforeSub)) return true
    if (/^-c/.test(a) && beforeSub) return true
  }
  return false
}

/**
 * go: `-exec`, `-toolexec`, `-vettool` (one or two dashes) before a real `-args` / `--` (endsOptions: `-run -- -exec`
 * keeps scanning), and `go env -w` / `-u` (writes GOFLAGS).
 */
function goRunsProgram(args: readonly string[]): boolean {
  const sub = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endsOptions(args, i, GO_BOOL_FLAGS, ['--', '-args', '--args'])) break
    if (/^--?(?:exec|toolexec|vettool)(?:=|$)/i.test(a)) return true
    if (sub === 'env' && /^--?[wu](?:=|$)/.test(a)) return true
  }
  return false
}

/** cargo: `--config` (runner, rustc wrapper, aliases) and the unstable `-Z` flags, before a real `--`. */
function cargoRunsProgram(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (endsOptions(args, i)) break
    if (/^--config(?:=|$)/i.test(args[i]) || /^-Z/.test(args[i])) return true
  }
  return false
}

/** make variable values that cannot name a program: empty, numbers and switches (`VERBOSE=1`, `DEBUG=true`). */
const MAKE_SAFE_VALUE = /^(?:\d+|true|false|yes|no|on|off)?$/i

/**
 * make: another makefile or folder (`-f`, `-C`, `-I`, `--file`, `--makefile`, `--directory`, `--include-dir`),
 * `--eval` / `-E`, and any `NAME=value` argument whose value is not a number or switch (`SHELL=calc`, `CC=calc`: a
 * recipe may run the variable). Short options may be clustered (`-sf x`).
 */
function makeRunsProgram(args: readonly string[]): boolean {
  for (const a of args) {
    if (refusedLong(a, ['file', 'makefile', 'eval', 'directory', 'include-dir'])) return true
    if (/^-[a-zA-Z]*[fECI]/.test(a)) return true
    const assign = /^[A-Za-z_.][\w.]*\s*[:?+!]?=(.*)$/.exec(a)
    if (assign && !MAKE_SAFE_VALUE.test(assign[1])) return true
  }
  return false
}

/** MSBuild properties that run a program. */
const DOTNET_PROGRAM_PROPERTY = /(?:event|runcommand|runarguments|runworkingdirectory)\s*=/i

/**
 * dotnet / msbuild before a real `--`: build-event and run-command properties in every form (`-p:PreBuildEvent=calc`,
 * `/property:RunCommand=calc`, `-p=X=calc`, and a separate value `-p PreBuildEvent=calc` / `--property X=calc`;
 * reviewer-4 H-F), loggers (`-logger:x.dll`, `-dl:`) and response files (`@x.rsp`).
 */
function dotnetRunsProgram(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (endsOptions(args, i)) break
    if (a.startsWith('@')) return true
    const m = /^(?:--?|\/)([a-zA-Z]+)(?:[:=](.*))?$/.exec(a)
    if (!m) continue
    const name = m[1].toLowerCase()
    if (name === 'p' || name === 'property') {
      const value = m[2] ?? args[i + 1] ?? ''
      if (DOTNET_PROGRAM_PROPERTY.test(value)) return true
    }
    if (['l', 'logger', 'dl', 'distributedlogger'].includes(name) && m[2] !== undefined) return true
  }
  return false
}

/** node options that load or evaluate code. */
const NODE_REFUSED = /^(?:-r|-e|-p|-pe|--require|--import|--loader|--experimental-loader|--eval|--print|--env-file|--env-file-if-exists)(?:=|$)/
/** node options that take a separate value (`--title x`): the next word is not the script. Curated. */
const NODE_VALUE_OPTS: ReadonlySet<string> = new Set([
  '--title', '--conditions', '-C', '--input-type', '--inspect-port', '--redirect-warnings', '--test-reporter', '--test-reporter-destination',
  '--test-name-pattern', '--test-skip-pattern', '--watch-path', '--disable-warning', '--diagnostic-dir', '--report-dir', '--cpu-prof-dir',
  '--heap-prof-dir', '--stack-size', '--max-old-space-size', '--localstorage-file', '--test-concurrency', '--test-timeout'
])

/** node's built-in test reporters; any other `--test-reporter` value is a module node loads (reviewer-4 M-4). */
const NODE_BUILTIN_REPORTERS: ReadonlySet<string> = new Set(['spec', 'tap', 'dot', 'junit', 'lcov'])

/**
 * node: NODE_REFUSED options before the script (node reads `_` as `-` in option names: `--experimental_loader`), and a
 * `--test-reporter` that is not built in; the script's own arguments (`node build.js -p prod`) are its own.
 */
function nodeRunsProgram(args: readonly string[]): boolean {
  let prev = ''
  for (let i = 0; i < args.length; i++) {
    if (endsOptions(args, i)) break
    const raw = args[i]
    const eq = raw.indexOf('=')
    const a = raw.startsWith('-') ? (eq < 0 ? raw.replace(/_/g, '-') : raw.slice(0, eq).replace(/_/g, '-') + raw.slice(eq)) : raw
    if (!a.startsWith('-')) {
      if (!NODE_VALUE_OPTS.has(prev)) return false
      if (prev === '--test-reporter' && !NODE_BUILTIN_REPORTERS.has(a)) return true
      prev = a
      continue
    }
    if (NODE_REFUSED.test(a)) return true
    if (a.startsWith('--test-reporter=') && !NODE_BUILTIN_REPORTERS.has(a.slice('--test-reporter='.length))) return true
    prev = a
  }
  return false
}

/**
 * git long options that run another program, read other config or write a file anywhere (any subcommand); send-email's
 * `--to-cmd` / `--cc-cmd` / `--header-cmd` / `--sendmail-cmd` / `--smtp-server` and instaweb's `--httpd` / `--browser`
 * name a program (reviewer-4 M-4).
 */
const GIT_REFUSED_LONG = [
  'upload-pack', 'receive-pack', 'exec', 'open-files-in-pager', 'extcmd', 'config-env', 'tool', 'config', 'template', 'output', 'output-directory',
  'to-cmd', 'cc-cmd', 'header-cmd', 'sendmail-cmd', 'smtp-server', 'httpd', 'browser'
]
/** git global options (before the subcommand) that change what runs or which repository's config is read. */
const GIT_REFUSED_GLOBAL_LONG = ['exec-path', 'config-env', 'git-dir', 'work-tree']
/** git global options that take a separate value. */
const GIT_GLOBAL_VALUE_OPTS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])

/**
 * git (review re-check M2, reviewer-3 H2 / M2 / L1 / L2 / L5): every global option before the subcommand is read
 * (`git --no-pager -c core.pager=x log`), `-c` case-sensitively so `git -C sub status` keeps matching; then the
 * subcommand's options, abbreviations included; destructive branch / switch / stash forms.
 */
function gitRunsProgram(args: readonly string[]): boolean {
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i]
    if (/^-c/.test(a) || refusedLong(a, GIT_REFUSED_GLOBAL_LONG)) return true
    if (GIT_GLOBAL_VALUE_OPTS.has(a)) i++
  }
  const sub = (args[i] ?? '').toLowerCase()
  const rest = args.slice(i + 1)
  const lower = rest.map((w) => w.toLowerCase())
  // `git submodule foreach <cmd>` and `git bisect run <cmd>` run a command even under a saved submodule / bisect rule.
  if ((sub === 'submodule' && lower.includes('foreach')) || (sub === 'bisect' && lower.includes('run'))) return true
  if (sub === 'stash' && (lower.includes('clear') || lower.includes('drop'))) return true
  for (let j = 0; j < rest.length; j++) {
    const o = rest[j]
    // A `--` right after an option without `=` is that option's value (`git clone -b -- -c x`, reviewer-4 H-E).
    if (endsOptions(rest, j)) break
    if (refusedLong(o, GIT_REFUSED_LONG)) return true
    if (sub === 'rebase' && /^-[a-zA-Z]*x/.test(o)) return true
    if ((sub === 'branch' || sub === 'switch' || sub === 'stash') && refusedLong(o, ['force', 'discard-changes', 'force-create'])) return true
    // Short options may be clustered (`-iOcalc`, `-qu calc`): look for the letter anywhere in a single-dash word.
    if (!/^-[a-zA-Z]/.test(o)) continue
    if (sub === 'grep' && /^-[a-zA-Z]*O/.test(o)) return true
    if (sub === 'difftool' && /^-[a-zA-Z]*[xt]/.test(o)) return true
    if (sub === 'mergetool' && /^-[a-zA-Z]*t/.test(o)) return true
    if ((sub === 'clone' || sub === 'fetch' || sub === 'pull' || sub === 'ls-remote' || sub === 'archive') && /^-[a-zA-Z]*u/.test(o)) return true
    if (sub === 'clone' && /^-[a-zA-Z]*c/.test(o)) return true
    if ((sub === 'format-patch' || sub === 'archive') && /^-[a-zA-Z]*o/.test(o)) return true
    if (sub === 'branch' && /^-[a-zA-Z]*[DfMC]/.test(o)) return true
    if (sub === 'switch' && /^-[a-zA-Z]*[fC]/.test(o)) return true
  }
  return false
}

/**
 * True when a segment's program would run another program, read other config or write outside the project through
 * its own options (reviewer-3 H1): a saved `npm test:*`, `go test:*`, `cargo test:*`, `make test:*` or `git clone:*`
 * must not cover `npm test --script-shell=calc`, `go test -exec=calc`, `cargo test --config target.x.runner=calc`,
 * `make test SHELL=calc` or `git clone -c core.sshCommand=calc url`. A leading `NAME=value` with a PROGRAM_ENV name is
 * refused too. Checked at match time for every rule, saved ones included. Exported for tests.
 */
export function programRunsProgram(segment: string): boolean {
  const words = segmentWords(segment)
  let i = 0
  for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]); i++) {
    if (PROGRAM_ENV.test(words[i].slice(0, words[i].indexOf('=')))) return true
  }
  const bin = binName(words[i] ?? '')
  // Option words are compared without backslashes: bash reads `--node\-options` as `--node-options`.
  const args = words.slice(i + 1).map((w) => (w.replace(/\\/g, '').startsWith('-') ? w.replace(/\\/g, '') : w))
  if (NPM_FAMILY.has(bin)) return npmRunsProgram(bin, args)
  switch (bin) {
    case 'git':
      return gitRunsProgram(args)
    case 'go':
      return goRunsProgram(args)
    case 'cargo':
      return cargoRunsProgram(args)
    case 'make':
    case 'gmake':
    case 'mingw32-make':
      return makeRunsProgram(args)
    case 'dotnet':
    case 'msbuild':
      return dotnetRunsProgram(args)
    case 'node':
    case 'nodejs':
      return nodeRunsProgram(args)
    default:
      return false
  }
}

/**
 * True when a segment holds syntax no rule may cover (UNSAFE_SEGMENT anywhere, UNSAFE_UNQUOTED outside quotes,
 * PowerShell splatting when `shell` is 'powershell') or its program's options run another program (programRunsProgram).
 */
export function isUnsafeSegment(segment: string, shell: 'bash' | 'powershell' = 'bash'): boolean {
  if (UNSAFE_SEGMENT.test(segment)) return true
  // Expansions (reviewer-4 H-B): `$_`, `${Z:---script-shell=x}`, `$"..."`, `$var` / `$env:X` expand to words the option
  // table never sees, in bash and PowerShell alike. A `$` counts unless it sits inside single quotes (literal in both).
  if (outsideSingleQuotes(segment).includes('$')) return true
  const unquoted = unquotedPart(segment)
  if (UNSAFE_UNQUOTED.test(unquoted)) return true
  if (shell === 'powershell' && UNSAFE_UNQUOTED_POWERSHELL.test(unquoted)) return true
  return programRunsProgram(segment)
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
 * and `referenceDirectories()` (live), denied dirs `protectedDirectories()`.
 */
export function matchOptionsFor(ctx: Pick<RuntimeContext, 'project' | 'allowedDirectories' | 'referenceDirectories' | 'protectedDirectories'>): MatchOptions {
  // A `cd` into a reference folder is free too (it is a read-only move; edits there are refused by the edit gates).
  const extra = [...(ctx.allowedDirectories?.() ?? []), ...(ctx.referenceDirectories?.() ?? [])]
  const denied = ctx.protectedDirectories?.() ?? []
  return { cwd: ctx.project.path, freeDirs: [ctx.project.path, ...extra], ...(denied.length ? { deniedDirs: denied } : {}) }
}

/** Shells a wrapped command may name (`bash -lc '...'`); any other first token is never unwrapped. */
const SHELL_BINARY = /^(?:bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?$/i

/**
 * Quote handling bash and PowerShell disagree on, or the splitter does not model: a backslash next to a quote
 * (`"a\" ; b"`), ANSI-C quoting (`$'...'`), and PowerShell's typographic quotes (U+2018-U+201E, which pair with
 * ASCII quotes there) and dashes (U+2013-U+2015, read as `-`). A command containing any of them is never covered by
 * a rule.
 */
const AMBIGUOUS_QUOTING = /\\["']|\$'|[–-―‘-„]/

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
  // Control, zero-width, bidi and other invisible characters (reviewer-3 L3): a covered command must read as what runs.
  // A tab is plain whitespace to the shell and the splitter (reviewer-4 L-4).
  if (hiddenCharProblem('command', command.replace(/\t/g, ' ')) !== null) return null
  const cmd = unwrapShellCommand(command)
  if (!cmd) return null
  const hits: string[] = []
  for (const segment of splitCommand(cmd)) {
    if (!segment || isUnsafeSegment(segment, opts?.shell ?? 'bash')) return null
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
  const hits = shellRulesFor(command, scoped, { ...(opts ?? {}), shell: toolName === 'PowerShell' ? 'powershell' : 'bash' })
  return hits ? hits.join(', ') : undefined
}

/**
 * True when a shell rule's text covers the command, or one of its `&&` / `||` / `;` segments, but matchingRule refuses
 * it (syntax, expansions, hidden characters, or programRunsProgram). The CLI matches saved rules (`allowedTools`) by
 * its own prefix test, so an adapter that only stays silent would let the CLI approve `npm test --script-shell=calc`
 * under a saved `Bash(npm test:*)` (reviewer-4 H-A): when this is true the adapter must answer "ask" (or deny), never
 * fall through. False for non-shell tools and when matchingRule allows the call.
 */
export function ruleCoversButRefused(toolName: string, input: unknown, rules: readonly string[], opts?: MatchOptions): boolean {
  if (!SHELL_TOOLS.has(toolName)) return false
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string' || !command.trim()) return false
  if (matchingRule(toolName, input, rules, opts) !== undefined) return false
  const scoped = rules.filter((r) => r.trim().startsWith(`${toolName}(`))
  if (!scoped.length) return false
  const candidates = [command.trim(), unwrapShellCommand(command), ...splitCommand(unwrapShellCommand(command)), ...splitCommand(command.trim())]
  return candidates.some((c) => !!c && shellRuleFor(c.trim(), scoped) !== undefined)
}
