/**
 * Environment secrets for `--host inproc` (cli-spec 3.5): ORGAI_SECRET_LITELLM_API_KEY and repeated
 * `--secret-env <owner>:<kind>:<name>=<ENV_VAR>` become an in-memory SecretStore overlay. The variables are deleted
 * from process.env before anything spawns, and they are refused outright with any other host mode (a running host
 * keeps its own stored secrets).
 */
import { PARAM_ID_PATTERN } from '../main/host/params'
import { LITELLM_KEY } from '../main/store/secrets'
import { CliError, EXIT, type HostMode } from './types'

export const SECRET_ENV_PREFIX = 'ORGAI_SECRET_'
export const LITELLM_SECRET_ENV = 'ORGAI_SECRET_LITELLM_API_KEY'

/** Env names that carry a non-original proxy's key (the migrated 'litellm' proxy keeps LITELLM_SECRET_ENV). */
export const PROXY_SECRET_ENV_RE = /^ORGAI_SECRET_PROXY_([0-9A-Fa-f]{8})_API_KEY$/

/** SecretStore key of a proxy's API key: `connection:<proxy id>:apiKey` (litellm's is LITELLM_KEY). */
export function proxyKeyName(proxyId: string): string {
  return proxyId === 'litellm' ? LITELLM_KEY : `connection:${proxyId}:apiKey`
}

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

/** Delete every ORGAI_SECRET_* variable and each consumed variable from `env` (process.env by default). */
export function scrubSecretEnv(env: NodeJS.ProcessEnv, consumedVars: readonly string[]): void {
  for (const k of Object.keys(env)) if (k.startsWith(SECRET_ENV_PREFIX)) delete env[k]
  for (const k of consumedVars) delete env[k]
}

/** True when any ORGAI_SECRET_* variable or --secret-env flag is present. */
export function hasSecretEnv(env: NodeJS.ProcessEnv, flags: readonly string[]): boolean {
  return flags.length > 0 || Object.keys(env).some((k) => k.startsWith(SECRET_ENV_PREFIX))
}

/** The exact refusal message when secret overrides meet a host mode other than inproc, else null. */
export function secretEnvRefusal(hostMode: HostMode, env: NodeJS.ProcessEnv, flags: readonly string[]): string | null {
  return hostMode !== 'inproc' && hasSecretEnv(env, flags) ? SECRET_ENV_REFUSAL : null
}
