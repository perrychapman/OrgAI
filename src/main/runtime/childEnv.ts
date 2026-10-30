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
 * Always removed: every variable that routes requests, picks models, enables a cloud provider or a gateway, or
 * changes the API surface (see CLAUDE_ROUTING_VARS / CLAUDE_ROUTING_PATTERNS). Only the connection may set them.
 *
 * Kept: everything else (PATH, HOME, locale, HTTP(S)_PROXY / NO_PROXY, SSL certs, tool env), plus two
 * legitimate auth sources for the Anthropic connection:
 * - CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` login; CLAUDE_CODE_OAUTH_REFRESH_TOKEN likewise), and
 * - CLAUDE_CONFIG_DIR (where the user's Claude Code login lives; the Keychain entry is derived from it).
 * ANTHROPIC_API_KEY is kept only when the caller says so (`keepApiKey`: the Anthropic connection on an API-key
 * project). On a proxy connection (`proxy`: LiteLLM) ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are removed
 * too, so only the connection's own ANTHROPIC_AUTH_TOKEN authenticates.
 */

/** Exact names (compared upper-cased, Windows env names are case-insensitive) that only a connection may set. */
export const CLAUDE_ROUTING_VARS: readonly string[] = [
  // Endpoint and gateway auth
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_UNIX_SOCKET',
  // Model selection
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // Cloud providers
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLOUD_ML_REGION',
  // Behaviour switches a gateway setup turns on
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING'
]

/** Families of routing variables: tier model overrides, provider switches, provider endpoints and auth skips. */
export const CLAUDE_ROUTING_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_DEFAULT_[A-Z0-9_]+$/, // ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL and their _NAME/_DESCRIPTION
  /^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)_[A-Z0-9_]+$/,
  /^CLAUDE_CODE_USE_[A-Z0-9_]+$/, // CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY / _ANTHROPIC_AWS
  /^CLAUDE_CODE_SKIP_[A-Z0-9_]+_AUTH$/,
  /^VERTEX_REGION_[A-Z0-9_]+$/
]

const ROUTING = new Set(CLAUDE_ROUTING_VARS)

/** True for a variable only a connection may set (routing, model, gateway, cloud provider). */
export function isClaudeRoutingVar(name: string): boolean {
  const n = name.toUpperCase()
  return ROUTING.has(n) || CLAUDE_ROUTING_PATTERNS.some((re) => re.test(n))
}

export interface IsolateClaudeEnvOptions {
  /** Keep the inherited ANTHROPIC_API_KEY (Anthropic connection, API-key auth). Default false. */
  keepApiKey?: boolean
  /** A proxy connection (LiteLLM): drop ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN whatever keepApiKey says. */
  proxy?: boolean
}

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
    if ((n === 'CLAUDE_CODE_OAUTH_TOKEN' || n === 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN') && opts.proxy) continue
    out[name] = value
  }
  return out
}
