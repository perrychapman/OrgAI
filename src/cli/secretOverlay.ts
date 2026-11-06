/**
 * Environment secrets (cli-spec 3.5, cli-standalone.md 4.1 and round 6 item 8): ORGAI_SECRET_LITELLM_API_KEY and
 * repeated `--secret-env <owner>:<kind>:<name>=<ENV_VAR>` become an in-memory SecretStore overlay of an in-process
 * host. The variables are deleted from process.env before anything spawns.
 *
 * Per host mode (planSecretEnv):
 * - `--host inproc`: collected, scrubbed, used.
 * - `--host daemon`: refused (exit 2; the background host keeps its own stored secrets).
 * - `--host auto`: always scrubbed. Commands that never run their own in-process host (NEVER_INPROC_COMMANDS:
 *   hostless, attach-only, daemon, app) refuse an explicit --secret-env and ignore an ambient ORGAI_SECRET_* with one
 *   warning; the overlay is dropped, so a host such a command starts (`daemon start --foreground`) never gets the
 *   secrets (review round 1). `projects list|show` (hostless in the spec, host-backed through withHost here) refuse an
 *   explicit --secret-env and otherwise behave like any other host-backed command. Every other command runs in-process
 *   when no host is live (ensureHost), and against a live host refuses an explicit --secret-env, refuses an ambient one
 *   when it would use a secret there (SECRET_USING_COMMANDS), else warns once.
 */
import { PARAM_ID_PATTERN } from '../main/host/params'
import { LITELLM_KEY } from '../main/store/secrets'
import { CliError, EXIT, type HostMode, type SecretEnvUse } from './types'

export const SECRET_ENV_PREFIX = 'ORGAI_SECRET_'
export const LITELLM_SECRET_ENV = 'ORGAI_SECRET_LITELLM_API_KEY'

export const SECRET_ENV_REFUSAL =
  "Environment secret overrides (--secret-env / ORGAI_SECRET_*) can only be used with --host inproc. Use 'orgai connections set-secret' or 'orgai mcp set-secret' to store secrets in the host."

/** An environment variable name (POSIX portable form) for both the slot name of kind env and the source variable. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** An HTTP header field name (RFC 9110 token). */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

export interface SecretOverlay {
  overlay: Map<string, string>
  /** Variables whose values went into the overlay (scrubSecretEnv deletes them). */
  consumedVars: string[]
}

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/** The SecretStore key of one `--secret-env` spec plus its source variable; throws CliError(2) for a bad spec. */
export function parseSecretEnvSpec(spec: string): { key: string; envVar: string } {
  const bad = (why: string): CliError => usage(`--secret-env ${JSON.stringify(spec)}: ${why} Expected <owner>:<kind>:<name>=<ENV_VAR> with owner mcp:<projectId>:<serverId> or mcplib:<entryId>, kind env or header.`)
  const eq = spec.lastIndexOf('=')
  if (eq <= 0) throw bad('missing =<ENV_VAR>.')
  const left = spec.slice(0, eq)
  const envVar = spec.slice(eq + 1)
  if (!ENV_NAME_RE.test(envVar)) throw bad('the source is not an environment variable name.')
  const parts = left.split(':')
  let owner: string
  let rest: string[]
  if (parts[0] === 'mcp' && parts.length === 5) {
    if (!PARAM_ID_PATTERN.test(parts[1]) || !PARAM_ID_PATTERN.test(parts[2])) throw bad('the project or server id is not valid.')
    owner = `mcp:${parts[1]}:${parts[2]}`
    rest = parts.slice(3)
  } else if (parts[0] === 'mcplib' && parts.length === 4) {
    if (!PARAM_ID_PATTERN.test(parts[1])) throw bad('the library entry id is not valid.')
    owner = `mcplib:${parts[1]}`
    rest = parts.slice(2)
  } else {
    throw bad('the owner is not valid.')
  }
  const [kind, name] = rest
  if (kind !== 'env' && kind !== 'header') throw bad('the kind must be env or header.')
  if (!(kind === 'env' ? ENV_NAME_RE : HEADER_NAME_RE).test(name)) throw bad(`${JSON.stringify(name)} is not a valid ${kind === 'env' ? 'environment variable' : 'header'} name.`)
  return { key: `${owner}:${kind}:${name}`, envVar }
}

/** Build the overlay. A spec whose variable is unset (or empty) is a usage error (exit 2). */
export function collectSecretOverlay(env: NodeJS.ProcessEnv, secretEnvFlags: readonly string[]): SecretOverlay {
  const overlay = new Map<string, string>()
  const consumed = new Set<string>()
  const litellm = env[LITELLM_SECRET_ENV]
  if (typeof litellm === 'string' && litellm !== '') {
    overlay.set(LITELLM_KEY, litellm)
    consumed.add(LITELLM_SECRET_ENV)
  }
  for (const spec of secretEnvFlags) {
    const { key, envVar } = parseSecretEnvSpec(spec)
    const value = env[envVar]
    if (typeof value !== 'string' || value === '') throw usage(`--secret-env names ${envVar}, which is not set.`)
    overlay.set(key, value)
    consumed.add(envVar)
  }
  return { overlay, consumedVars: [...consumed] }
}

/**
 * The usage error when a command is told to read a secret from an ORGAI_SECRET_* variable (`--from-env`, `decide
 * --secret NAME=VAR`, `--client-secret-from-env`): prepareContext takes every such variable out of the environment for
 * the environment secret overlay before any command runs, so it would read as unset (WP-B review round 2). Undefined for
 * any other name.
 */
export function reservedSecretSourceProblem(envVar: string, flag: string): string | undefined {
  if (!envVar.startsWith(SECRET_ENV_PREFIX)) return undefined
  return `${envVar} is an ORGAI_SECRET_* variable: OrgAI keeps those for its environment secret overrides and takes them out of the environment before any command runs. Put the value in another variable for ${flag}.`
}

/** Delete every ORGAI_SECRET_* variable and each consumed variable from `env` (process.env by default). */
export function scrubSecretEnv(env: NodeJS.ProcessEnv, consumedVars: readonly string[]): void {
  for (const k of Object.keys(env)) if (k.startsWith(SECRET_ENV_PREFIX)) delete env[k]
  for (const k of consumedVars) delete env[k]
}

/** True when any ORGAI_SECRET_* variable or --secret-env flag is present. */
export function hasSecretEnv(env: NodeJS.ProcessEnv, flags: readonly string[]): boolean {
  return flags.length > 0 || Object.keys(env).some((k) => k.startsWith(SECRET_ENV_PREFIX))
}

/** True when any ORGAI_SECRET_* variable is set (an "ambient" secret, as opposed to --secret-env). */
export function hasAmbientSecretEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((k) => k.startsWith(SECRET_ENV_PREFIX))
}

/**
 * The exact refusal message when secret overrides meet `--host daemon` (any secret) or a command that attaches to a
 * live host, else null. Kept for the cases where the answer does not depend on the command (cli-spec 3.5 text).
 */
export function secretEnvRefusal(hostMode: HostMode, env: NodeJS.ProcessEnv, flags: readonly string[]): string | null {
  return hostMode !== 'inproc' && hasSecretEnv(env, flags) ? SECRET_ENV_REFUSAL : null
}

/** The one warning for an ambient ORGAI_SECRET_* a command ignores (round 6 item 8). */
export const SECRET_ENV_IGNORED_WARNING = 'ORGAI_SECRET_* ignored: a running OrgAI host keeps its own secrets'

/**
 * How a command treats environment secrets under `--host auto`:
 * - 'never-inproc': never runs its own in-process host for a client (hostless, attach-only, daemon, app, doctor,
 *   completions, terminal-access): an explicit --secret-env is refused, an ambient one ignored with a warning and
 *   scrubbed without reaching any host (`daemon start --foreground` starts one, and other clients use it).
 * - 'listing': `projects list|show`, which the spec lists as hostless but which go through withHost here: an explicit
 *   --secret-env is refused (the spec's hostless rule), an ambient one behaves as 'host' (with no live host the command
 *   stays in-process, so it never spawns a background host in the middle of such a session; round 6 item 8).
 * - 'secret-using': would use a secret on a live host (starts or continues a run, the Architect, an assistant, a
 *   credential probe, a model call): an ambient secret is refused against a live host.
 * - 'host': any other host-backed command: an ambient secret is ignored against a live host with a warning.
 * With no live host, 'secret-using', 'listing' and 'host' commands run in-process and use the secrets.
 */
export type SecretEnvClass = 'never-inproc' | 'listing' | 'secret-using' | 'host'

/** Commands that never run their own in-process host (whatever their subcommand). */
export const NEVER_INPROC_COMMANDS: ReadonlySet<string> = new Set(['status', 'runs', 'watch', 'inbox', 'decide', 'daemon', 'app', 'doctor', 'completions', 'terminal-access'])

/** Subcommands cli-standalone.md 4.1 lists as hostless but that run through withHost in this CLI ('listing'). */
const LISTING_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = { projects: ['list', 'show'] }

/** Commands that always use secrets on a live host (bare `orgai` and `orgai [--] <prompt>` route as undefined). */
const SECRET_USING_COMMANDS: ReadonlySet<string> = new Set(['exec', 'resume', 'tui', 'attach'])

/**
 * Subcommand paths that use secrets on a live host (round 6 item 8). The spec's `team review|recommend` are listed as
 * written; the Team assistant's review and recommend commands live under `org` in this CLI, so those are listed too.
 */
const SECRET_USING_SUBCOMMANDS: readonly (readonly string[])[] = [
  ['mcp', 'assist'],
  ['mcp', 'test'],
  ['mcp', 'library', 'test'],
  ['skills', 'assist'],
  ['skills', 'evaluate'],
  ['org', 'retro'],
  ['org', 'draft'],
  ['org', 'review'],
  ['org', 'recommend'],
  ['team', 'review'],
  ['team', 'recommend'],
  ['connections', 'test'],
  ['connections', 'connect'],
  ['models', 'refresh'],
  ['usage', 'refresh']
]

/** The arguments before `--`. */
const beforeDashes = (args: readonly string[]): readonly string[] => {
  const end = args.indexOf('--')
  return end === -1 ? args : args.slice(0, end)
}

/** The class of `orgai <command> <args>`; `command` undefined is bare `orgai` (the terminal UI, maybe with a prompt). */
export function secretEnvCommandClass(command: string | undefined, args: readonly string[]): SecretEnvClass {
  if (command === undefined || SECRET_USING_COMMANDS.has(command)) return 'secret-using'
  if (NEVER_INPROC_COMMANDS.has(command)) return 'never-inproc'
  const head = beforeDashes(args)
  if (LISTING_SUBCOMMANDS[command]?.includes(head[0] ?? '')) return 'listing'
  // `orgai init` runs the Architect unless --skip-architect.
  if (command === 'init') return head.includes('--skip-architect') ? 'host' : 'secret-using'
  for (const path of SECRET_USING_SUBCOMMANDS) {
    if (path[0] === command && path.slice(1).every((word, i) => head[i] === word)) return 'secret-using'
  }
  return 'host'
}

/** What prepareContext does with environment secrets for one command. */
export interface SecretEnvPlan {
  /** Refuse the command (exit 2) with this text before anything else. */
  refusal?: string
  /** Print this on stderr once, then go on. */
  warning?: string
  /** Collect the overlay and scrub the variables (always when any secret is present, and always under inproc). */
  collect: boolean
  /**
   * Scrub the variables but hand no overlay to the context: an ambient secret a 'never-inproc' command ignores must not
   * reach a host it starts (`daemon start --foreground` under --host auto serves other clients).
   */
  dropOverlay?: boolean
  /** For ensureHost under `--host auto` (CliContext.secretEnv). */
  use?: SecretEnvUse
}

/** The plan for `hostMode` and a command of class `cls` (see the module header). */
export function planSecretEnv(hostMode: HostMode, cls: SecretEnvClass, env: NodeJS.ProcessEnv, flags: readonly string[]): SecretEnvPlan {
  const explicit = flags.length > 0
  const ambient = hasAmbientSecretEnv(env)
  if (hostMode === 'inproc') return { collect: true }
  if (!explicit && !ambient) return { collect: false }
  if (hostMode === 'daemon') return { collect: false, refusal: SECRET_ENV_REFUSAL }
  if (cls === 'never-inproc') return explicit ? { collect: false, refusal: SECRET_ENV_REFUSAL } : { collect: true, dropOverlay: true, warning: SECRET_ENV_IGNORED_WARNING }
  if (cls === 'listing' && explicit) return { collect: false, refusal: SECRET_ENV_REFUSAL }
  return { collect: true, use: { explicit, ambient, usesSecrets: cls === 'secret-using' } }
}

/**
 * Against a live host: the refusal text (an explicit --secret-env, or an ambient secret on a secret-using command), or
 * 'warn' (an ambient secret the command ignores), or null (no secrets).
 */
export function liveHostSecretAnswer(use: SecretEnvUse | undefined): string | 'warn' | null {
  if (!use || (!use.explicit && !use.ambient)) return null
  if (use.explicit || use.usesSecrets) return SECRET_ENV_REFUSAL
  return 'warn'
}
