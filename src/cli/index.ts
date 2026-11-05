/**
 * `orgai` CLI entry (bundled to out/cli/orgai.mjs; the build adds the `#!/usr/bin/env node` banner). Plain Node only:
 * no desktop-shell import, ever. Routes over commandTable.ts (cli-spec 6.1): global flags first (flags.ts), then the
 * command. Exit codes are EXIT in types.ts; a CliError carries its own, anything else is 1.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runApp } from './commands/app'
import { runCompletions } from './commands/completions'
import { runDaemon } from './commands/daemon'
import { runDecide } from './commands/decide'
import { runDoctor } from './commands/doctor'
import { runExec, runResume } from './commands/exec'
import { runInbox } from './commands/inbox'
import { runRuns } from './commands/runs'
import { runStatus } from './commands/status'
import { runWatch } from './commands/watch'
import { COMMANDS, GLOBAL_FLAGS, findCommand, type CommandEntry, type CommandFlag } from './commandTable'
import { buildContext } from './context'
import { splitGlobalFlags } from './flags'
import { safe } from './output'
import { collectSecretOverlay, scrubSecretEnv, secretEnvRefusal } from './secretOverlay'
import { CliError, EXIT, type CliIo, type CommandFn } from './types'
import { CLI_VERSION } from './version'

export const TUI_LATER_NOTE = 'The interactive terminal UI comes in a later version.'

const ROUTES: Record<string, CommandFn> = {
  status: runStatus,
  runs: runRuns,
  watch: runWatch,
  inbox: runInbox,
  daemon: runDaemon,
  app: runApp,
  doctor: runDoctor,
  completions: runCompletions,
  exec: runExec,
  resume: runResume,
  decide: runDecide
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
    'Usage: orgai <command> [options]',
    '',
    'Commands:',
    table(now.map((c) => [c.name, c.summary])),
    '',
    `Coming later: ${later.map((c) => c.name).join(', ')}.`,
    '',
    'Global options:',
    table(GLOBAL_FLAGS.map((f) => [flagLabel(f), f.summary])),
    '',
    "Run 'orgai help <command>' for a command's options."
  ].join('\n')
}

/** `orgai help <command>`. */
export function commandHelp(c: CommandEntry): string {
  const lines = [`Usage: orgai ${c.usage}`, '', c.summary]
  if (!c.available) lines.push('', `Not available in this build yet.`)
  if (c.flags.length) lines.push('', 'Options:', table(c.flags.map((f) => [flagLabel(f), f.summary])))
  return lines.join('\n')
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

    if (name === undefined) {
      out(`${generalHelp()}\n\n${TUI_LATER_NOTE}`)
      return EXIT.ok
    }
    if (VERSION_WORDS.has(name)) {
      out(CLI_VERSION)
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

    if (command.name !== 'completions') {
      const refusal = secretEnvRefusal(globals.host, env, globals.secretEnv)
      if (refusal) throw new CliError(refusal, EXIT.usage)
    }
    // --host inproc: take the secrets out of the environment before anything can spawn.
    let overlay: Map<string, string> | undefined
    if (globals.host === 'inproc') {
      const collected = collectSecretOverlay(env, globals.secretEnv)
      scrubSecretEnv(env, collected.consumedVars)
      overlay = collected.overlay
    }

    const ctx = buildContext({
      globals,
      env,
      cwd: overrides.cwd ?? process.cwd(),
      platform: overrides.platform ?? process.platform,
      io,
      ...(overlay ? { overlay } : {})
    })
    return await ROUTES[command.name](ctx, args)
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

function unknownCommandMessage(word: string): string {
  const s = suggestCommand(word)
  return s ? `Unknown command '${word}'. Did you mean '${s}'?` : `Unknown command '${word}'. Run 'orgai --help' for the commands.`
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
