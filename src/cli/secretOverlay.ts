/**
 * Environment secrets (cli-spec 3.5): ORGAI_SECRET_LITELLM_API_KEY and repeated
 * `--secret-env <owner>:<kind>:<name>=<ENV_VAR>` become an in-memory SecretStore overlay of this process's host. The
 * variables are deleted from process.env before anything spawns.
 *
 * Commands that never start a host (HOSTLESS_COMMANDS: the read-only ones) refuse an explicit --secret-env and ignore an
 * ambient ORGAI_SECRET_* with one warning; the variables are scrubbed either way. Every other command collects the
 * overlay and its host uses it.
 */
import { PARAM_ID_PATTERN } from '../main/host/params'
import { LITELLM_KEY } from '../main/store/secrets'
import { CliError, EXIT } from './types'

export const SECRET_ENV_PREFIX = 'ORGAI_SECRET_'
export const LITELLM_SECRET_ENV = 'ORGAI_SECRET_LITELLM_API_KEY'

/** Env names that carry a non-original proxy's key (the migrated 'litellm' proxy keeps LITELLM_SECRET_ENV). */
export const PROXY_SECRET_ENV_RE = /^ORGAI_SECRET_PROXY_([0-9A-Fa-f]{8})_API_KEY$/

/** SecretStore key of a proxy's API key: `connection:<proxy id>:apiKey` (litellm's is LITELLM_KEY). */
export function proxyKeyName(proxyId: string): string {
  return proxyId === 'litellm' ? LITELLM_KEY : `connection:${proxyId}:apiKey`
}

export const SECRET_ENV_REFUSAL =
  "Environment secret overrides (--secret-env / ORGAI_SECRET_*) work only for a command that runs a host. This one only reads saved data. To store a secret, use 'orgai connections set-secret' or 'orgai mcp set-secret'."

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
  // ORGAI_SECRET_PROXY_<8 hex, any case>_API_KEY is the key of proxy `proxy-<hex lowercase>`.
  for (const [name, value] of Object.entries(env)) {
    const m = PROXY_SECRET_ENV_RE.exec(name)
    if (!m || typeof value !== 'string' || value === '') continue
    overlay.set(proxyKeyName(`proxy-${m[1].toLowerCase()}`), value)
    consumed.add(name)
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

/** True when any ORGAI_SECRET_* variable is set (an "ambient" secret, as opposed to --secret-env). */
export function hasAmbientSecretEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((k) => k.startsWith(SECRET_ENV_PREFIX))
}

/** The one warning for an ambient ORGAI_SECRET_* a read-only command ignores. */
export const SECRET_ENV_IGNORED_WARNING = 'ORGAI_SECRET_* ignored: this command does not start a host'

/** Commands that only read saved data and never start a host (whatever their subcommand): environment secrets mean nothing to them. */
export const HOSTLESS_COMMANDS: ReadonlySet<string> = new Set(['status', 'runs', 'doctor', 'completions'])

/** Subcommands of other commands that only read saved data (cli-standalone-default.md 4.3; `usage show` and `secrets status` still go through a host). */
const HOSTLESS_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = { projects: ['list', 'show'] }

/** The arguments before `--`. */
const beforeDashes = (args: readonly string[]): readonly string[] => {
  const end = args.indexOf('--')
  return end === -1 ? args : args.slice(0, end)
}

/** True when `orgai <command> <args>` is a read-only command that never starts a host (4.3). `undefined` is bare `orgai`. */
export function isHostlessCommand(command: string | undefined, args: readonly string[]): boolean {
  if (command === undefined) return false
  if (HOSTLESS_COMMANDS.has(command)) return true
  const sub = beforeDashes(args)[0]
  return HOSTLESS_SUBCOMMANDS[command]?.includes(sub ?? '') === true
}

/** What prepareContext does with environment secrets for one command. */
export interface SecretEnvPlan {
  /** Refuse the command (exit 2) with this text before anything else. */
  refusal?: string
  /** Print this on stderr once, then go on. */
  warning?: string
  /** Collect the overlay and scrub the variables (when any secret is present). */
  collect: boolean
  /** Scrub the variables but hand no overlay to the context (a read-only command ignores them). */
  dropOverlay?: boolean
}

/** The plan for a command that is `hostless` (read-only) or not. */
export function planSecretEnv(hostless: boolean, env: NodeJS.ProcessEnv, flags: readonly string[]): SecretEnvPlan {
  const explicit = flags.length > 0
  const ambient = hasAmbientSecretEnv(env)
  if (!explicit && !ambient) return { collect: false }
  if (!hostless) return { collect: true }
  return explicit ? { collect: false, refusal: SECRET_ENV_REFUSAL } : { collect: true, dropOverlay: true, warning: SECRET_ENV_IGNORED_WARNING }
}
