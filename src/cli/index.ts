/**
 * `orgai` CLI entry (bundled to out/cli/orgai.mjs; the build adds the `#!/usr/bin/env node` banner). Plain Node only:
 * no desktop-shell import, ever. Routes over commandTable.ts (cli-spec 6.1): global flags first (flags.ts), then the
 * command. Exit codes are EXIT in types.ts; a CliError carries its own, anything else is 1.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runCompletions } from './commands/completions'
import { runConnections } from './commands/connections'
import { runDoctor } from './commands/doctor'
import { runExec, runResume } from './commands/exec'
import { runInit } from './commands/init'
import { runKit } from './commands/kit'
import { runKnowledge } from './commands/knowledge'
import { runMcp } from './commands/mcp'
import { runModels } from './commands/models'
import { runNotes } from './commands/notes'
import { runOrg } from './commands/org'
import { runPermissions } from './commands/permissions'
import { runProjects } from './commands/projects'
import { runRuns } from './commands/runs'
import { runSecrets } from './commands/secrets'
import { runSkills } from './commands/skills'
import { runStatus } from './commands/status'
import { runTeam } from './commands/team'
import { defaultTuiPrintsHelp, PROMPT_HINT, runDefaultTui, runTuiCommand } from './commands/tui'
import { runUsage } from './commands/usage'
import { runWorktrees } from './commands/worktrees'
import { COMMANDS, DEFAULT_TUI_FLAGS, GLOBAL_FLAGS, findCommand, type CommandEntry, type CommandFlag } from './commandTable'
import { buildContext } from './context'
import { splitGlobalFlags } from './flags'
import { safe } from './output'
import { collectSecretOverlay, isHostlessCommand, planSecretEnv, scrubSecretEnv } from './secretOverlay'
import { CliError, EXIT, type CliIo, type CommandFn } from './types'
import { CLI_VERSION } from './version'
import { readInstallInfo } from './installInfo'
import { versionLine } from './versionLine'

/** Command name -> its CommandFn; every COMMANDS entry has one (index.test.ts). */
export const ROUTES: Record<string, CommandFn> = {
  status: runStatus,
  runs: runRuns,
  doctor: runDoctor,
  completions: runCompletions,
  exec: runExec,
  resume: runResume,
  tui: runTuiCommand,
  init: runInit,
  org: runOrg,
  team: runTeam,
  worktrees: runWorktrees,
  permissions: runPermissions,
  connections: runConnections,
  models: runModels,
  mcp: runMcp,
  skills: runSkills,
  knowledge: runKnowledge,
  notes: runNotes,
  usage: runUsage,
  kit: runKit,
  projects: runProjects,
  secrets: runSecrets
}

export interface MainOverrides {
  env?: NodeJS.ProcessEnv
  cwd?: string
  platform?: NodeJS.Platform
  io?: CliIo
}

const VERSION_WORDS = new Set(['--version', '-V', 'version'])
const HELP_WORDS = new Set(['--help', '-h', 'help'])

/** Levenshtein distance (small inputs only). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]
}

/** The closest command name within edit distance 2, if any. */
export function suggestCommand(word: string): string | undefined {
  let best: { name: string; d: number } | undefined
  for (const c of COMMANDS) {
    const d = editDistance(word.toLowerCase(), c.name)
    if (d <= 2 && (!best || d < best.d)) best = { name: c.name, d }
  }
  return best?.name
}

const flagLabel = (f: CommandFlag): string => `${f.short ? `-${f.short}, ` : ''}--${f.name}${f.takesValue ? (f.values ? ` <${f.values.join('|')}>` : ' <value>') : ''}`

function table(rows: [string, string][]): string {
  const w = Math.min(34, Math.max(...rows.map(([a]) => a.length)))
  return rows.map(([a, b]) => `  ${a.padEnd(w)}  ${b}`).join('\n')
}

/** `orgai --help`. */
export function generalHelp(): string {
  const now = COMMANDS.filter((c) => c.available)
  const later = COMMANDS.filter((c) => !c.available)
  return [
    'Usage: orgai [options] [--] [prompt]   Start the terminal UI (with a prompt: start a run)',
    '       orgai <command> [options]',
    '',
    'Terminal UI options:',
    table(DEFAULT_TUI_FLAGS.map((f) => [flagLabel(f), f.summary])),
    '',
    'Commands:',
    table(now.map((c) => [c.name, c.summary])),
    '',
    ...(later.length ? [`Coming later: ${later.map((c) => c.name).join(', ')}.`, ''] : []),
    'Global options:',
    table(GLOBAL_FLAGS.map((f) => [flagLabel(f), f.summary])),
    '',
    "Run 'orgai help <command>' for a command's options.",
    "Untrusted text (an issue title, a web page) goes in a file or on stdin: orgai exec --prompt-file <path>. On Windows",
    'the orgai command is a .cmd file and cmd.exe re-reads its arguments.'
  ].join('\n')
}

/** `orgai help <command>`. */
export function commandHelp(c: CommandEntry): string {
  const lines = [`Usage: orgai ${c.usage}`, '', c.summary]
  if (!c.available) lines.push('', `Not available in this build yet.`)
  if (c.flags.length) lines.push('', 'Options:', table(c.flags.map((f) => [flagLabel(f), f.summary])))
  for (const n of c.notes ?? []) lines.push('', wrap(n, 100))
  return lines.join('\n')
}

/** Word-wraps a paragraph at `width` columns (a word longer than that keeps its own line). */
function wrap(text: string, width: number): string {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out.join('\n')
}

/** Arguments before `--` ask for this command's help. */
const asksHelp = (args: readonly string[]): boolean => {
  const end = args.indexOf('--')
  return (end === -1 ? args : args.slice(0, end)).some((a) => a === '--help' || a === '-h')
}

const defaultIo = (): CliIo => ({ stdout: process.stdout, stderr: process.stderr, stdinIsTTY: process.stdin.isTTY === true })

/** Run the CLI. Resolves with the exit code; never calls process.exit. */
export async function main(argv: string[] = process.argv.slice(2), overrides: MainOverrides = {}): Promise<number> {
  const env = overrides.env ?? process.env
  const io = overrides.io ?? defaultIo()
  const out = (s: string): void => void io.stdout.write(s.endsWith('\n') ? s : `${s}\n`)
  // Error text can carry host-provided words (a hello refusal read before the hostProof check, an RPC error message):
  // sanitizeTty before it reaches the terminal (cli-spec 5.2, error banners).
  const err = (s: string): void => void io.stderr.write(`orgai: ${safe(s)}\n`)
  try {
    const { globals, rest } = splitGlobalFlags(argv)
    const [name, ...args] = rest

    /**
     * Environment secrets (secretOverlay.ts planSecretEnv): the refusal, the one warning, and the overlay taken out of
     * the environment before anything can spawn. `command` undefined is bare `orgai`; null is completions.
     */
    const prepareContext = (command: string | null | undefined, commandArgs: readonly string[]): ReturnType<typeof buildContext> => {
      const plan = planSecretEnv(command === null ? true : isHostlessCommand(command, commandArgs), env, globals.secretEnv)
      if (plan.refusal) throw new CliError(plan.refusal, EXIT.usage)
      let overlay: Map<string, string> | undefined
      if (plan.collect) {
        const collected = collectSecretOverlay(env, globals.secretEnv)
        scrubSecretEnv(env, collected.consumedVars)
        // An ignored ambient secret is scrubbed, never handed to a host (there is none for such a command).
        if (!plan.dropOverlay) overlay = collected.overlay
      }
      if (plan.warning) io.stderr.write(`${plan.warning}\n`)
      return contextFor(globals, env, io, overrides, overlay)
    }

    // Bare `orgai`, `orgai [tui options] [--] <prompt>` or a quoted prompt (an unknown first word with whitespace).
    if (name === undefined || name === '--' || isDefaultTuiFlag(name) || (findCommand(name) === undefined && !name.startsWith('-') && /\s/.test(name))) {
      if (asksHelp(rest)) {
        out(generalHelp())
        return EXIT.ok
      }
      // No terminal and no prompt: help, before the context (no secret-env refusal or scrub just to print it).
      if (defaultTuiPrintsHelp(io, rest)) {
        out(generalHelp())
        return EXIT.ok
      }
      return await runDefaultTui(prepareContext(undefined, rest), rest, { help: generalHelp })
    }
    if (VERSION_WORDS.has(name)) {
      out(versionLine(CLI_VERSION, readInstallInfo()))
      return EXIT.ok
    }
    if (HELP_WORDS.has(name)) {
      const topic = args.find((a) => a !== '--')
      if (topic === undefined) {
        out(generalHelp())
        return EXIT.ok
      }
      const c = findCommand(topic)
      if (!c) throw new CliError(unknownCommandMessage(topic), EXIT.usage)
      out(commandHelp(c))
      return EXIT.ok
    }

    // `orgai -p <prompt>` / `--print` is `orgai exec <prompt>`.
    const command = name === '-p' || name === '--print' ? findCommand('exec') : findCommand(name)
    if (!command) {
      if (name.startsWith('-')) throw new CliError(`Unknown option ${name}.`, EXIT.usage)
      throw new CliError(unknownCommandMessage(name), EXIT.usage)
    }
    if (asksHelp(args)) {
      out(commandHelp(command))
      return EXIT.ok
    }
    if (!command.available || !ROUTES[command.name]) throw new CliError(`\`orgai ${command.name}\` is not available in this build yet.`, EXIT.usage)

    return await ROUTES[command.name](prepareContext(command.name === 'completions' ? null : command.name, args), args)
  } catch (e) {
    if (e instanceof CliError) {
      err(e.message)
      return e.exitCode
    }
    const message = e instanceof Error ? e.message : String(e)
    err(message)
    if (env.ORGAI_CLI_DEBUG === '1' && e instanceof Error && e.stack) io.stderr.write(`${safe(e.stack)}\n`)
    return EXIT.failure
  }
}

/** `--inline`, `--ax-screen-reader` or `--team` before the prompt: terminal UI flags of bare `orgai`. */
function isDefaultTuiFlag(arg: string): boolean {
  return DEFAULT_TUI_FLAGS.some((f) => arg === `--${f.name}` || (f.takesValue && arg.startsWith(`--${f.name}=`)))
}

/**
 * The context. `overlay` is the environment secret overlay prepareContext already collected (and scrubbed).
 */
function contextFor(
  globals: ReturnType<typeof splitGlobalFlags>['globals'],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  overrides: MainOverrides,
  overlay?: Map<string, string>
): ReturnType<typeof buildContext> {
  return buildContext({
    globals,
    env,
    cwd: overrides.cwd ?? process.cwd(),
    platform: overrides.platform ?? process.platform,
    io,
    ...(overlay ? { overlay } : {})
  })
}

function unknownCommandMessage(word: string): string {
  const s = suggestCommand(word)
  const base = s ? `Unknown command '${word}'. Did you mean '${s}'?` : `Unknown command '${word}'. Run 'orgai --help' for the commands.`
  return `${base} ${PROMPT_HINT}`
}

/**
 * The packaged launcher (build/bin/orgai) runs this bundle on the app's own binary with ELECTRON_RUN_AS_NODE=1. Under
 * Electron (`versions.electron` set) that variable is taken out of `env` before anything spawns, so pagers, git,
 * MCP servers and the inproc adapters never inherit it (an inherited one would turn any Electron app they
 * start into Node). Plain Node keeps the environment as it is. True when it removed the variable.
 */
export function scrubElectronRunAsNode(env: NodeJS.ProcessEnv, versions: Partial<Record<string, string | undefined>> = process.versions): boolean {
  if (!versions.electron || !('ELECTRON_RUN_AS_NODE' in env)) return false
  delete env.ELECTRON_RUN_AS_NODE
  return true
}

/** True when this module is the process entry (also through a symlinked bin shim). False when imported (tests). */
function isEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) {
  // Before main() builds the context (which reads process.env) and before anything can spawn.
  scrubElectronRunAsNode(process.env)
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`orgai: ${safe(reason instanceof Error ? reason.message : String(reason))}\n`)
    if (process.env.ORGAI_CLI_DEBUG === '1' && reason instanceof Error && reason.stack) process.stderr.write(`${safe(reason.stack)}\n`)
    process.exitCode = EXIT.failure
    // Let pending output drain, then end: a rejection nobody handled leaves the process in an unknown state.
    process.stdout.write('', () => process.exit(EXIT.failure))
  })
  main().then(
    (code) => {
      process.exitCode = code
    },
    (e: unknown) => {
      process.stderr.write(`orgai: ${safe(e instanceof Error ? e.message : String(e))}\n`)
      process.exitCode = EXIT.failure
    }
  )
}
