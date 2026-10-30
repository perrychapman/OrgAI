/**
 * Child-process environment isolation for Claude Code runs (provider-neutral helper, pure).
 *
 * OrgAI must behave the same whatever another harness on the machine has configured. A user's shell exports
 * (ANTHROPIC_BASE_URL pointing at their own gateway, a model override, a cloud-provider switch) would otherwise
 * leak into every run, because the SDK child inherits whatever env the adapter passes, and `options.env`
 * replaces the child's whole environment. So the adapter builds the child env as:
 *
 *   isolateClaudeEnv(process.env, ...) + OrgAI's own settings + the run connection's env
 *
 * Always removed: every variable that routes requests, picks models, enables a cloud provider or a gateway,
 * authenticates through workload-identity federation, or flips a CLI behaviour switch (CLAUDE_CODE_DISABLE_* /
 * CLAUDE_CODE_ENABLE_*, except CLAUDE_CODE_ALLOWED_SWITCHES). See CLAUDE_ROUTING_VARS / CLAUDE_ROUTING_PATTERNS.
 * Only the connection (or OrgAI's own settings, merged after this) may set them.
 *
 * Kept: everything else (PATH, HOME, locale, HTTP(S)_PROXY / NO_PROXY, SSL certs, OTEL_*, tool env), plus two
 * legitimate auth sources for the Anthropic connection:
 * - CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` login; CLAUDE_CODE_OAUTH_REFRESH_TOKEN likewise), and
 * - CLAUDE_CONFIG_DIR (where the user's Claude Code login lives; the Keychain entry is derived from it).
 * ANTHROPIC_API_KEY is kept only when the caller says so (`keepApiKey`: the Anthropic connection on an API-key
 * project). On a proxy connection (`proxy`: LiteLLM) ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (and its refresh
 * token) and CLAUDE_CONFIG_DIR are removed too, so neither an inherited key nor a claude.ai login can
 * authenticate: only the connection's own ANTHROPIC_AUTH_TOKEN does.
 */

/** Exact names (compared upper-cased, Windows env names are case-insensitive) that only a connection may set. */
export const CLAUDE_ROUTING_VARS: readonly string[] = [
  // Endpoint and gateway auth
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_UNIX_SOCKET',
  // Model selection
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // Cloud providers
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLOUD_ML_REGION'
]

/**
 * CLI behaviour switches a user may legitimately export outside routing, kept although they match the
 * CLAUDE_CODE_(DISABLE|ENABLE)_ family. CLAUDE_CODE_ENABLE_TELEMETRY is an organisation's OpenTelemetry
 * monitoring opt-in (the OTEL_* settings it reads pass through anyway).
 */
export const CLAUDE_CODE_ALLOWED_SWITCHES: readonly string[] = ['CLAUDE_CODE_ENABLE_TELEMETRY']

/** Families of routing variables: tier model overrides, provider switches, provider endpoints and auth skips. */
export const CLAUDE_ROUTING_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_DEFAULT_[A-Z0-9_]+$/, // ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL and their _NAME/_DESCRIPTION
  /^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)_[A-Z0-9_]+$/,
  // Workload-identity federation: ANTHROPIC_IDENTITY_TOKEN(_FILE), _SERVICE_ACCOUNT_ID, _WORKSPACE_ID, _FEDERATION_RULE_ID
  /^ANTHROPIC_(IDENTITY|SERVICE_ACCOUNT|WORKSPACE|FEDERATION)_[A-Z0-9_]*$/,
  /^CLAUDE_CODE_USE_[A-Z0-9_]+$/, // CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY / _ANTHROPIC_AWS
  /^CLAUDE_CODE_SKIP_[A-Z0-9_]+_AUTH$/,
  // Behaviour switches (experimental betas, thinking, gateway model discovery, auth refresh lock, proxy auth helper...)
  /^CLAUDE_CODE_(DISABLE|ENABLE)_[A-Z0-9_]+$/,
  /^VERTEX_REGION_[A-Z0-9_]+$/
]

const ROUTING = new Set(CLAUDE_ROUTING_VARS)
const ALLOWED = new Set(CLAUDE_CODE_ALLOWED_SWITCHES)

/** True for a variable only a connection may set (routing, model, gateway, cloud provider, behaviour switch). */
export function isClaudeRoutingVar(name: string): boolean {
  const n = name.toUpperCase()
  if (ALLOWED.has(n)) return false
  return ROUTING.has(n) || CLAUDE_ROUTING_PATTERNS.some((re) => re.test(n))
}

export interface IsolateClaudeEnvOptions {
  /** Keep the inherited ANTHROPIC_API_KEY (Anthropic connection, API-key auth). Default false. */
  keepApiKey?: boolean
  /**
   * A proxy connection (LiteLLM): drop ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN / _REFRESH_TOKEN and
   * CLAUDE_CONFIG_DIR whatever keepApiKey says.
   */
  proxy?: boolean
}

/** Inherited Anthropic login sources a proxy connection must not see. */
const PROXY_DROPPED = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CONFIG_DIR'])

/**
 * A copy of `base` without the routing variables (and, per the options, the inherited auth). Undefined values
 * are dropped. Never mutates `base`.
 */
export function isolateClaudeEnv(base: NodeJS.ProcessEnv, opts: IsolateClaudeEnvOptions = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    const n = name.toUpperCase()
    if (isClaudeRoutingVar(n)) continue
    if (n === 'ANTHROPIC_API_KEY' && (opts.proxy || !opts.keepApiKey)) continue
    if (opts.proxy && PROXY_DROPPED.has(n)) continue
    out[name] = value
  }
  return out
}
