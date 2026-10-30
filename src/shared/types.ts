/**
 * Shared domain types used by the main process, preload bridge and renderer.
 * Everything that crosses IPC is defined here.
 */

// ---------- Providers ----------

/**
 * A runtime adapter: the code that drives one agent runtime (src/main/runtime/<adapter>.ts).
 * 'claude' drives the Claude Agent SDK; 'codex' drives `codex app-server` (JSON-RPC over stdio);
 * 'mock' is a scripted, token-free adapter for UI work and tests, registered only with ORGAI_MOCK=1.
 * Adapters are separate from connections: one connection (LiteLLM) can feed either adapter.
 */
export type ProviderId = 'claude' | 'codex' | 'mock'

/** How a role authenticates with its provider. Also the Anthropic connection's auth. */
export type ProviderAuth =
  | { kind: 'subscription' } // e.g. Claude Code login
  | { kind: 'apiKey'; envVar: string } // read from the named environment variable at run time

export interface ProviderConfig {
  /** The adapter that runs this project. For litellm projects the run picks it by model family (adapterForProject). */
  id: ProviderId
  label: string
  /** Legacy per-project Anthropic auth. Superseded by the app-wide connection when `connection` is set. */
  auth: ProviderAuth
  /**
   * The app-wide connection (AppSettings.connections) this project's models come from. Missing on projects
   * saved before connections existed; read it with projectConnection(), which treats missing as 'anthropic'
   * (or 'openai' for a 'codex' provider).
   */
  connection?: ConnectionId
}

// ---------- Connections and model catalog ----------

/**
 * Where model access comes from, independent of the adapter that drives it. 'anthropic' = Claude Code login
 * or an Anthropic API key; 'openai' = ChatGPT (Codex) login or an OpenAI API key; 'litellm' = a LiteLLM proxy
 * that serves Claude-family and OpenAI-family models behind one base URL and key.
 */
export type ConnectionId = 'anthropic' | 'openai' | 'litellm'

/** Every connection id, in settings display order. */
export const CONNECTION_IDS: readonly ConnectionId[] = ['anthropic', 'openai', 'litellm']

/**
 * The intent behind a role's model, so the model can be remapped when the project's connection changes.
 * top = most capable (fable), deep = deep reasoning (opus), everyday = fast and capable (sonnet),
 * fast = cheap and quick (haiku).
 */
export type ModelTier = 'top' | 'deep' | 'everyday' | 'fast'

/** Every tier, most capable first, with labels for selects. */
export const MODEL_TIER_OPTIONS: { value: ModelTier; label: string; hint: string }[] = [
  { value: 'top', label: 'Top', hint: 'Most capable, highest cost' },
  { value: 'deep', label: 'Deep', hint: 'Deep reasoning, orchestration, architecture' },
  { value: 'everyday', label: 'Everyday', hint: 'Fast and capable, everyday coding' },
  { value: 'fast', label: 'Fast', hint: 'Cheap and quick, lookups and summaries' }
]

export const MODEL_TIERS: readonly ModelTier[] = MODEL_TIER_OPTIONS.map((o) => o.value)

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v)
}

/** Model lineage. Decides the adapter for litellm models: 'claude' runs on the Claude adapter, anything else on Codex. */
export type ModelFamily = 'claude' | 'openai' | 'other'

/** Live state of one connection. Never persisted; the main process probes it. */
export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  /** Human-readable detail, e.g. the error message or "Using ANTHROPIC_API_KEY". */
  detail?: string
  /** The signed-in account (email or plan name) when the provider reports one. */
  account?: string
  /** When the status was last checked, epoch ms. */
  checkedAt?: number
}

/** Fields every connection record has. */
interface ConnectionBase {
  /** Off = the connection is hidden from project pickers and never probed. */
  enabled: boolean
  /**
   * The model each tier maps to on this connection (ProviderModel.id). Auto-filled from the catalog when the
   * connection connects or its catalog changes; the user can override each entry. Missing tiers mean
   * "no model for this tier": roles of that tier keep their current model on remap.
   */
  tierModels: Partial<Record<ModelTier, ModelRef>>
}

/** OpenAI auth: the ChatGPT login Codex keeps (connections:login), or an API key read from an env var. */
export type OpenAIAuth = { kind: 'chatgpt' } | { kind: 'apiKey'; envVar: string }

/** Anthropic access through the Claude adapter. `auth` is mirrored into the legacy AppSettings.providerAuth. */
export interface AnthropicConnection extends ConnectionBase {
  id: 'anthropic'
  auth: ProviderAuth
}

/** OpenAI access through the Codex adapter. */
export interface OpenAIConnection extends ConnectionBase {
  id: 'openai'
  auth: OpenAIAuth
}

/**
 * A LiteLLM proxy. Claude-family models run on the Claude adapter (ANTHROPIC_BASE_URL = baseUrl), other
 * models on the Codex adapter (openai_base_url). The key lives in Electron safeStorage and is set only with
 * connections:setSecret; this record carries only whether one is stored.
 */
export interface LiteLLMConnection extends ConnectionBase {
  id: 'litellm'
  /** Proxy root, e.g. "http://localhost:4000". '' until the user sets it. */
  baseUrl: string
  /** A LiteLLM key is stored in safeStorage. Read-only for the renderer: the main process sets it. */
  hasApiKey: boolean
}

/** One app-wide connection record, discriminated by id. Persisted in settings.json; never holds secrets. */
export type ProviderConnection = AnthropicConnection | OpenAIConnection | LiteLLMConnection

/** All connection records, one per ConnectionId. */
export interface ProviderConnections {
  anthropic: AnthropicConnection
  openai: OpenAIConnection
  litellm: LiteLLMConnection
}

/** connections:list entry: the persisted record plus its live status. */
export interface ConnectionInfo {
  connection: ProviderConnection
  status: ConnectionStatus
  /** Models currently in the catalog for this connection (builtin plus discovered). */
  modelCount: number
}

/** connections:setSecret. Only LiteLLM has a stored secret today. null clears the stored key. */
export interface ConnectionSecretInput {
  id: 'litellm'
  apiKey: string | null
}

/**
 * connections:login result for the OpenAI ChatGPT login. 'browser': the main process opened `authUrl` in the
 * system browser and waits for the callback. 'deviceCode': show `userCode` and let the user open
 * `verificationUrl`. Progress arrives as `connection.login` events with the same loginId.
 */
export type ConnectionLoginStart =
  | { loginId: string; connection: 'openai'; method: 'browser'; authUrl: string }
  | {
      loginId: string
      connection: 'openai'
      method: 'deviceCode'
      verificationUrl: string
      userCode: string
      /** When the code stops working (epoch ms), if Codex said so. */
      expiresAt?: number
    }

/** connections:login method for the OpenAI ChatGPT login. Default 'browser'. */
export type ConnectionLoginMethod = 'browser' | 'deviceCode'

/** Progress of one login started with connections:login. */
export interface ConnectionLoginUpdate {
  loginId: string
  connection: 'openai'
  state: 'pending' | 'success' | 'error' | 'cancelled'
  /** Error text, or a hint while pending. */
  detail?: string
  /** On success: the signed-in account. */
  account?: string
}

/** A model a connection can serve. Structured-clone safe. */
export interface ProviderModel {
  /** What Role.model holds: an alias ('opus') or a full model id ('gpt-5', 'anthropic/claude-sonnet-4-5'). */
  id: ModelRef
  label: string
  connection: ConnectionId
  family: ModelFamily
  /** The adapter that runs this model: 'claude' for the claude family, 'codex' otherwise. */
  adapter: ProviderId
  /** Suggested tier, used to auto-fill ConnectionBase.tierModels. */
  tier?: ModelTier
  /** Context window in tokens, when known (LiteLLM /model/info, Codex model/list). */
  contextWindow?: number
  /** One-line hint for pickers. */
  hint?: string
  /** 'builtin' = shipped with OrgAI; 'discovered' = listed by the connection at runtime. */
  source: 'builtin' | 'discovered'
}

/** models:list and models:refresh input. Omit `connection` for every enabled connection. */
export interface ModelsQuery {
  connection?: ConnectionId
}

/** One role whose model a remap changed. */
export interface RemapChange {
  roleId: string
  from: ModelRef
  to: ModelRef
}

/**
 * Why a remap ran. 'connected': the connection just connected. 'catalog': its model list changed.
 * 'tierModels': the user edited the tier mapping. 'switched': the project moved to another connection
 * (every tiered role is remapped). 'manual': projects:remapModels without a connection change.
 */
export type RemapReason = 'connected' | 'catalog' | 'tierModels' | 'switched' | 'manual'

/**
 * What a model remap did to one project. Rules: each role with a tier gets tierModels[role.tier] of the
 * project's connection; a role whose current model is a valid catalog model that differs from its tier's
 * default is an explicit user pick and is kept, except on 'switched'. Roles without a tier and 'inherit'
 * roles are never touched. `changes` is empty when nothing moved.
 */
export interface RemapResult {
  projectId: string
  connection: ConnectionId
  reason: RemapReason
  changes: RemapChange[]
}

/** projects:remapModels input. With `connection`, the project switches to it first (reason 'switched'). */
export interface RemapModelsInput {
  projectId: string
  connection?: ConnectionId
}

/** projects:remapModels output: the result plus the saved project, so the renderer replaces its copy. */
export interface RemapModelsOutput {
  result: RemapResult
  project: Project
}

/**
 * Which adapter a project's run uses (adapterForProject). For 'litellm' the root role's model family decides;
 * every role in the run must then share it, because one run drives one adapter.
 */
export interface AdapterChoice {
  adapter: ProviderId
  connection: ConnectionId
  /** Family of the root role's model, when it is known. */
  family?: ModelFamily
  /** Ids of roles whose model would need the other adapter. Non-empty = the run cannot start as configured. */
  mismatched: string[]
}

/** Push events on the connections:event channel (main -> renderer). */
export type ConnectionEvent =
  | { type: 'connection.status'; connection: ConnectionId; status: ConnectionStatus }
  | { type: 'connection.login'; login: ConnectionLoginUpdate }
  /** The catalog for a connection changed (discovery, refresh, login). Carries that connection's full list. */
  | { type: 'models.updated'; connection: ConnectionId; models: ProviderModel[] }
  /** A connection change remapped role models. Only projects with at least one change are listed; reload them. */
  | { type: 'projects.remapped'; results: RemapResult[] }

/** Model choices are provider-scoped aliases or full model IDs. */
export type ModelRef = string

export const CLAUDE_MODEL_OPTIONS: { value: ModelRef; label: string; hint: string }[] = [
  { value: 'inherit', label: 'Inherit from parent', hint: 'Uses whatever model spawned this agent' },
  { value: 'fable', label: 'Fable', hint: 'Most capable, highest cost' },
  { value: 'opus', label: 'Opus', hint: 'Deep reasoning, orchestration, architecture' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Fast and capable, everyday coding' },
  { value: 'haiku', label: 'Haiku', hint: 'Cheap and quick, lookups and summaries' }
]

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------- Tools ----------

export const TOOL_CATALOG = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'NotebookEdit',
  'SendMessage',
  'ListAgents'
] as const
export type ToolName = (typeof TOOL_CATALOG)[number]

/** One-line hints for tools whose purpose is not obvious from the name (role editor tooltips). */
export const TOOL_HINTS: Partial<Record<ToolName, string>> = {
  SendMessage: 'Message another running agent by its handle (or its lead) for hand-offs and questions',
  ListAgents: 'List the agents running right now and their handles'
}

/** The tool name that spawns subagents in the Claude Agent SDK. Granted implicitly by `canSpawn`. */
export const SPAWN_TOOL = 'Agent'

// ---------- Org chart ----------

export interface Role {
  id: string
  /** Stable slug used as the subagent_type, e.g. "backend-engineer". */
  slug: string
  name: string
  /** One-line "when to use" description shown to the parent agent. */
  description: string
  responsibilities: string[]
  /** System prompt body. */
  prompt: string
  tools: ToolName[]
  model: ModelRef
  /**
   * The intent behind `model`, used to remap it when the project's connection or tier mapping changes.
   * Missing on older projects (derive it with tierForModel). 'inherit' roles have no tier.
   */
  tier?: ModelTier
  effort?: Effort
  /** May this role create subagents at all? */
  canSpawn: boolean
  /** Which role ids this role may spawn. Enforced by the harness. */
  spawnable: string[]
  /** Parent in the org chart. null for the root orchestrator. */
  reportsTo: string | null
  /** Editor canvas position. */
  position: { x: number; y: number }
  /** Accent color for the node. */
  color: string
  /**
   * Explicit MCP server grants: McpServerSpec ids this role may use even when the server's own `roles`
   * list leaves it out. See mcpServersForRole. Missing = no explicit grants.
   */
  mcpServers?: string[]
}

/**
 * How tool calls are approved. 'auto': a provider-side classifier approves or denies each call and asks
 * (an approval card) only when it cannot decide. 'dontAsk': anything not pre-approved by a saved rule is denied.
 */
export type PermissionMode = 'auto' | 'acceptEdits' | 'default' | 'dontAsk' | 'plan' | 'bypassPermissions'

/** Every permission mode, recommended first, with the label settings selects show. */
export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'auto', label: 'Unattended: Claude decides each call, asks only when unsure' },
  { value: 'acceptEdits', label: 'Auto-accept file edits, ask for commands' },
  { value: 'default', label: 'Ask for everything risky' },
  { value: 'dontAsk', label: 'Never ask: deny anything that would need approval' },
  { value: 'plan', label: 'Plan only (no changes)' },
  { value: 'bypassPermissions', label: 'Bypass all permission prompts (dangerous)' }
]

export const PERMISSION_MODES: PermissionMode[] = PERMISSION_MODE_OPTIONS.map((o) => o.value)

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as string[]).includes(v)
}

export interface Project {
  id: string
  name: string
  /** Working directory the agents operate in. */
  path: string
  /** Free text describing the project and the kind of work done in it. Feeds the AI drafter. */
  brief: string
  provider: ProviderConfig
  permissionMode: PermissionMode
  /** Hard spend cap per run in USD. undefined = no cap. */
  maxBudgetUsd?: number
  maxSubagentDepth: number
  maxConcurrentSubagents: number
  /**
   * Run reports that can edit files in their own git worktree, and merge each report back
   * when it finishes. Needs a git repository; silently off otherwise. Default true.
   */
  isolateWriters?: boolean
  /**
   * With isolateWriters: pause before merging each report's branch and show its diff to the user,
   * who merges, discards or holds it. Default false (merge automatically).
   */
  reviewMerges?: boolean
  /** Runs to keep on disk for this project; older ones are deleted. Default DEFAULT_KEEP_RUNS. */
  keepRuns?: number
  /**
   * Subscription plans: percent of the five-hour usage window one run may consume before the harness
   * interrupts it (a soft stop the user can continue from). undefined = off.
   */
  maxWindowShare?: number
  /**
   * Subscription plans: spawn new Opus reports on Sonnet while the Opus weekly window (or the
   * seven-day window when the plan has no per-model one) is at or above the app's opusGuardThreshold.
   */
  preferSonnetNearLimit?: boolean
  /**
   * Work runs: once the orchestrator has a plan, the harness reminds it of the remaining steps whenever a
   * turn ends with work left, until the plan is complete or blocked. Default true.
   */
  autoContinue?: boolean
  /** Upper bound on automatic continues per run. Default DEFAULT_MAX_AUTO_CONTINUES. */
  maxAutoContinues?: number
  /**
   * Cross-run messaging opt-in ("Let runs message each other" in Project settings). message_run is refused unless
   * the sender's and the target's projects both have it on. Missing = DEFAULT_RUN_MESSAGING (off); read it with
   * runMessagingOn() from defaults.ts. Saved through projects:save like other settings.
   */
  runMessaging?: boolean
  roles: Role[]
  /**
   * MCP servers this project's agents may use (mcp__<name>__* tools). Missing = none. Secret values are
   * never stored here, only their names (secretEnv, secretHeaders). Change it through mcp:upsert / mcp:remove
   * (which return the saved project) so a stale renderer copy does not overwrite it.
   */
  mcpServers?: McpServerSpec[]
  /** Claude Code plugins loaded for this project's runs (Claude adapter only). Missing = none. */
  plugins?: PluginSpec[]
  /** AI-driven setup state. Missing on projects created before setup existed. */
  setup?: ProjectSetup
  createdAt: string
  updatedAt: string
}

// ---------- MCP servers and plugins ----------

/** How OrgAI reaches an MCP server. 'http' is the MCP streamable HTTP transport. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/**
 * Where an MCP server entry came from. 'agent' = approved from an agent's request_mcp_install. 'library' = a
 * project server linked to an app-wide library entry (McpServerSpec.libraryId); the entry keeps its own source.
 */
export type McpServerSource = 'user' | 'registry' | 'agent' | 'library'

/**
 * Non-secret OAuth state of a remote (http / sse) MCP server, written only by the main process (mcp:authorize);
 * mcp:upsert and mcpLibrary:upsert keep the stored value and ignore what the renderer sends. Secret values
 * (client secret, access and refresh tokens) live only in the SecretStore. Missing on a spec = the server is
 * not known to use OAuth (a static header or no auth).
 */
export interface McpOAuthConfig {
  /** RFC 8707 resource indicator: the canonical MCP server URL the tokens are bound to. */
  resource?: string
  /** Issuer of the authorization server that was used. */
  authorizationServer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  /** RFC 7591 dynamic client registration endpoint, when the server offers one. */
  registrationEndpoint?: string
  /** Scopes requested at the last authorization. */
  scopes?: string[]
  /** The OAuth client id: entered by the user ('manual') or registered by OrgAI ('dcr'). */
  clientId?: string
  /** A client secret is stored for this client (write-only through mcp:authorize). */
  hasClientSecret?: boolean
  clientSource?: 'manual' | 'dcr'
  /** The loopback redirect URI a 'dcr' client was registered with; reused when its port is free. */
  redirectUri?: string
  /** ISO timestamp of the last successful authorization or refresh. */
  authorizedAt?: string
  /** ISO timestamp the current access token expires; missing = no expiry was given. */
  expiresAt?: string
  /** Display only: the account the token belongs to, when the server says. */
  account?: string
}

/** Authorization state of one server, computed by the main process from McpOAuthConfig and the stored tokens. */
export type McpAuthState = 'notRequired' | 'notAuthorized' | 'authorized' | 'expired' | 'error'

export interface McpAuthStatus {
  state: McpAuthState
  /** ISO timestamp the access token expires. */
  expiresAt?: string
  /** Display only: who the token belongs to. */
  account?: string
  /** 'error': what failed, naming the step. Never contains a token or secret. */
  error?: string
  /**
   * 'error': the authorization server offers no dynamic client registration and no client id is stored. Show
   * client id (and optional secret) inputs and call mcp:authorize again with them.
   */
  needsClientId?: true
}

/** Which server mcp:authorize / cancelAuthorize / revokeAuth act on: a library entry or a project-only server. */
export type McpAuthTarget = { libraryId: string } | { projectId: string; serverId: string }

/**
 * mcp:authorize input. clientId / clientSecret are write-only: stored (the secret in safeStorage) and never
 * echoed. A linked project server is authorized through its library entry ({ libraryId }).
 */
export type McpAuthorizeInput = McpAuthTarget & { clientId?: string; clientSecret?: string }

/** The MCP Registry package a server was installed from. */
export interface McpRegistryRef {
  /** Registry server name, e.g. "io.github.owner/server". */
  name: string
  version: string
  /** Package ecosystem, e.g. 'npm', 'pypi', 'oci', or 'remote' for a hosted endpoint. */
  registryType: string
  /** Package identifier (npm name, PyPI name, image) or the remote URL. */
  identifier: string
}

/**
 * One MCP server configured for a project. Structured-clone safe and free of secrets: secret env vars and
 * headers are listed by name only and their values live in Electron safeStorage (mcp:setSecret).
 */
export interface McpServerSpec {
  /** Stable id (newId('mcp')). Role.mcpServers and the mcp:* channels refer to it. */
  id: string
  /** Kebab-case server name; its tools surface as mcp__<name>__<tool>. Unique within the project. */
  name: string
  transport: McpTransport
  /** stdio: the executable to launch, e.g. "npx". */
  command?: string
  /** stdio: command-line arguments. */
  args?: string[]
  /** stdio: non-secret environment variables. */
  env?: Record<string, string>
  /** stdio: names of environment variables whose values are secrets stored in safeStorage. */
  secretEnv?: string[]
  /** http / sse: the endpoint URL. */
  url?: string
  /** http / sse: non-secret request headers. */
  headers?: Record<string, string>
  /** http / sse: names of headers whose values are secrets stored in safeStorage (e.g. "Authorization"). */
  secretHeaders?: string[]
  /** Off = kept in the list but not passed to runs. */
  enabled: boolean
  /** Role slugs allowed to use it. undefined = every role. Role.mcpServers grants it to more roles. */
  roles?: string[]
  source: McpServerSource
  /** Set when the entry was installed from the MCP Registry. */
  registry?: McpRegistryRef
  /** One-line description shown in the list (from the registry or the user). */
  description?: string
  /** ISO timestamp. */
  addedAt: string
  /**
   * Set when this project server is a link to an app-wide library entry (McpLibraryEntry.id). The stored copy is a
   * snapshot of the entry plus the project-owned fields (id, enabled, roles, libraryId, addedAt); the main process
   * refreshes it from the library on every read, and secrets and OAuth tokens are the library entry's.
   */
  libraryId?: string
  /** Remote servers that use OAuth (see McpOAuthConfig). Written by the main process only. */
  oauth?: McpOAuthConfig
}

/**
 * A harness-level (app-wide) MCP server definition in the library (<data>/mcp-library.json). Defined once;
 * credentials and OAuth authorization live with it, and projects link it (McpServerSpec.libraryId). The name
 * is unique within the library.
 */
export type McpLibraryEntry = Omit<McpServerSpec, 'enabled' | 'roles' | 'libraryId'>

/** Which secret slot a value fills: an entry of McpServerSpec.secretEnv or of .secretHeaders. */
export type McpSecretKind = 'env' | 'header'

/** mcp:list entry: the spec plus which secrets have a stored value. Secret values never cross IPC. */
export interface McpServerInfo {
  spec: McpServerSpec
  /** secretEnv names with a stored value (the library entry's values for a linked server). */
  envSet: string[]
  /** secretHeaders names with a stored value. */
  headersSet: string[]
  /** Secret names (env and headers) still missing a value; the server cannot start until they are set. */
  missingSecrets: string[]
  /** OAuth state (the library entry's for a linked server). 'notRequired' when spec.oauth is missing. */
  auth: McpAuthStatus
  /** The linked library entry no longer exists: the server is kept as a snapshot but excluded from runs. */
  libraryMissing?: true
}

/** mcpLibrary:list entry: the entry, its secret has-flags, OAuth state and the projects that link it. */
export interface McpLibraryInfo {
  entry: McpLibraryEntry
  envSet: string[]
  headersSet: string[]
  missingSecrets: string[]
  auth: McpAuthStatus
  usedBy: { projectId: string; projectName: string }[]
}

/** mcpLibrary:setSecret input. `value: null` deletes the stored value. Write-only. */
export interface McpLibrarySecretInput {
  libraryId: string
  kind: McpSecretKind
  /** Must be listed in the entry's secretEnv or secretHeaders. */
  name: string
  value: string | null
}

/** mcp:linkLibrary input: add a library entry to a project by reference. */
export interface McpLinkLibraryInput {
  projectId: string
  libraryId: string
  /** Role slugs allowed to use it; omit for every role. */
  roles?: string[]
  /** Default true. */
  enabled?: boolean
}

/** mcp:upsert input. A spec whose id is new is added; otherwise it replaces the entry with that id. */
export interface McpUpsertInput {
  projectId: string
  spec: McpServerSpec
}

/** mcp:upsert / mcp:remove / mcp:setSecret output: the saved project and the refreshed list. */
export interface McpMutationResult {
  project: Project
  servers: McpServerInfo[]
}

/** mcp:setSecret input. `value: null` deletes the stored value. Write-only: values are never read back. */
export interface McpSecretInput {
  projectId: string
  serverId: string
  kind: McpSecretKind
  /** The env var or header name; must be listed in the spec's secretEnv or secretHeaders. */
  name: string
  value: string | null
}

/** mcp:test result: starting the server and listing its tools, without a run. */
export interface McpTestResult {
  ok: boolean
  /** Tool names the server reported (without the mcp__<name>__ prefix). */
  tools?: string[]
  /** The same tools with their descriptions (first 300 characters), in the server's order. */
  toolDetails?: { name: string; description?: string }[]
  error?: string
  /** Last lines the stdio server wrote to stderr (secret values redacted), on failure. */
  stderr?: string
  /** Exit code of a stdio server that exited before answering; null when it was killed by a signal. */
  exitCode?: number | null
  /** How long the check took, ms. */
  durationMs?: number
  /**
   * A remote server answered 401 with an OAuth challenge (or the server uses OAuth and has no valid token):
   * offer Authorize (mcp:authorize) instead of a header field. `ok` is false.
   */
  needsAuthorization?: true
  /** With needsAuthorization: the authorization server or resource metadata URL the challenge named, if any. */
  authorizationServer?: string
}

/** A Claude Code plugin directory loaded for a project's runs (Claude adapter only). */
export interface PluginSpec {
  /** Stable id (newId('plugin')). */
  id: string
  name: string
  /** Absolute path to the plugin directory. */
  path: string
  enabled: boolean
  /** Do not load the MCP servers the plugin declares. */
  skipMcpDiscovery?: boolean
}

/** plugins:upsert input. A plugin whose id is new is added; otherwise it replaces the entry with that id. */
export interface PluginUpsertInput {
  projectId: string
  plugin: PluginSpec
}

/** An environment variable (or header) a registry package needs. */
export interface McpRegistryEnvVar {
  name: string
  description?: string
  /** Treat the value as a secret (safeStorage, secretEnv/secretHeaders). */
  isSecret: boolean
  isRequired?: boolean
  /** Default value the registry suggests, for non-secret variables. */
  default?: string
}

/** Registry transport names. 'streamable-http' maps to McpTransport 'http'. */
export type McpRegistryTransport = 'stdio' | 'streamable-http' | 'sse'

/** One installable package of a registry server. */
export interface McpRegistryPackage {
  /** e.g. 'npm', 'pypi', 'oci', 'nuget', 'mcpb'. */
  registryType: string
  identifier: string
  version: string
  transport: { type: McpRegistryTransport; url?: string }
  /** e.g. 'npx', 'uvx', 'docker': the launcher the registry suggests. */
  runtimeHint?: string
  environmentVariables: McpRegistryEnvVar[]
}

/** A hosted endpoint of a registry server. */
export interface McpRegistryRemote {
  type: Exclude<McpRegistryTransport, 'stdio'>
  url: string
  /** Headers the remote needs, described like env vars. */
  headers?: McpRegistryEnvVar[]
}

/**
 * One server from the official MCP Registry (GET https://registry.modelcontextprotocol.io/v0.1/servers),
 * normalized by the main process from the registry's { server, _meta } wrapper.
 */
export interface McpRegistryEntry {
  /** Reverse-DNS name, e.g. "io.github.owner/server". */
  name: string
  /** Display title when the registry has one. */
  title?: string
  description: string
  version: string
  /** Source repository URL. */
  repositoryUrl?: string
  websiteUrl?: string
  packages: McpRegistryPackage[]
  remotes: McpRegistryRemote[]
  /** Registry status; deprecated entries are shown but not suggested. */
  status?: 'active' | 'deprecated' | 'deleted'
  /** ISO timestamp from the registry metadata. */
  publishedAt?: string
}

/** mcp:registrySearch input. */
export interface McpRegistrySearchInput {
  /** Substring search on server names. '' lists everything. */
  query: string
  /** Opaque cursor from a previous result's nextCursor. */
  cursor?: string
  /** Page size; the main process caps it. */
  limit?: number
}

/** mcp:registrySearch output. Only the latest version of each server is returned. */
export interface McpRegistrySearchResult {
  entries: McpRegistryEntry[]
  /** Pass back as `cursor` for the next page; undefined on the last page. */
  nextCursor?: string
}

/** An agent asks to add an MCP server (request_mcp_install). Shown as an approval card. */
export interface McpInstallRequest {
  id: string
  runId: string
  agentId: string
  /** Why the agent needs it, in its words. */
  reason: string
  /** The proposed server. Its source is 'agent' (or 'registry' when built from a registry entry). */
  spec: McpServerSpec
  /** The registry entry the spec was built from, when there is one. */
  registry?: McpRegistryEntry
  /** Secret names (from spec.secretEnv and spec.secretHeaders) the user must fill to approve. */
  requiredSecrets: string[]
  createdAt: number
}

/**
 * The user's answer to an McpInstallRequest (renderer -> main only). `secrets` maps required secret names to
 * values; the main process moves them into safeStorage and never echoes them. `scope` 'run' adds the server
 * for this run only; 'project' also saves it to Project.mcpServers as a project-only server; 'library' saves it
 * to the app-wide library (secrets with the library entry) and links it to the project.
 */
export interface McpInstallDecision {
  approved: boolean
  secrets?: Record<string, string>
  /** Shown to the agent, e.g. why it was denied or what was changed. */
  note?: string
  scope: 'run' | 'project' | 'library'
  /** The spec as the user edited it before approving. Omitted = the proposed spec. */
  spec?: McpServerSpec
}

/** The secret-free part of a decision, as carried by the mcpInstall.resolved event. */
export type McpInstallOutcome = Omit<McpInstallDecision, 'secrets'>

/** mcp:answerInstall input. */
export interface McpAnswerInstallInput {
  runId: string
  requestId: string
  decision: McpInstallDecision
}

/**
 * mcp:startAssist input. scope 'project' (default) starts the MCP assistant for a project (projectId required);
 * scope 'library' starts it at the harness level on the virtual project HARNESS_PROJECT_ID (projectId ignored),
 * where it proposes library entries.
 */
export interface McpAssistInput {
  projectId?: string
  scope?: 'project' | 'library'
  /** What the user wants, e.g. "connect our Postgres and GitHub". */
  instruction?: string
}

/**
 * Harness tool names for MCP (bare names; adapters expose them under their harness server, e.g.
 * mcp__orgai__search_mcp_registry). propose_mcp_servers is the MCP assistant's proposal tool.
 */
export const MCP_HARNESS_TOOLS = {
  searchRegistry: 'search_mcp_registry',
  requestInstall: 'request_mcp_install',
  listServers: 'list_mcp_servers',
  proposeServers: 'propose_mcp_servers'
} as const
export type McpHarnessToolName = (typeof MCP_HARNESS_TOOLS)[keyof typeof MCP_HARNESS_TOOLS]

/** Harness tool every agent gets: ask the user for permission rules after a policy denial. */
export const PERMISSION_HARNESS_TOOLS = { request: 'request_permission_rules' } as const

/**
 * Work-run root tools for talking to other runs' orchestrators (cross-run messaging). Both return at once.
 * list_runs: every other live work run, all projects. message_run: deliver a message to one of them.
 */
export const RUN_HARNESS_TOOLS = { list: 'list_runs', message: 'message_run' } as const
export type RunHarnessToolName = (typeof RUN_HARNESS_TOOLS)[keyof typeof RUN_HARNESS_TOOLS]
/** message_run text is cut to this many characters before delivery. */
export const RUN_MESSAGE_MAX_CHARS = 4000
/** RunPeer.prompt and run.message peerPrompt: one line, at most this many characters. */
export const RUN_PEER_PROMPT_CHARS = 120
/** RunSummary.title and the run.title event: at most this many characters (cut on a word boundary with …). */
export const RUN_TITLE_MAX_CHARS = 32

// ---------- App settings (global) ----------

/** 'system' follows the OS (Electron nativeTheme); the renderer resolves it with matchMedia('(prefers-color-scheme: dark)'). */
export type ThemeMode = 'dark' | 'light' | 'system'
export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
export type CanvasPattern = 'dots' | 'grid' | 'none'
export const CANVAS_PATTERNS: readonly CanvasPattern[] = ['dots', 'grid', 'none']
export type CanvasEdgeStyle = 'curved' | 'orthogonal' | 'straight'
export const CANVAS_EDGE_STYLES: readonly CanvasEdgeStyle[] = ['curved', 'orthogonal', 'straight']

/** App-wide look. Main applies `theme` to nativeTheme.themeSource at startup and on every settings:set. */
export interface AppearanceSettings {
  /** Default 'dark' until the light theme is signed off (docs/design/plan.md section 2). */
  theme: ThemeMode
  /** Accent color '#rrggbb' (lowercase). Default '#7c5cff'. */
  accent: string
  canvas: {
    pattern: CanvasPattern
    /** Tint the canvas background with the accent. */
    tint: boolean
    edges: CanvasEdgeStyle
    minimap: boolean
  }
  /** 'system' honours prefers-reduced-motion; 'on' always reduces motion. */
  reduceMotion: 'system' | 'on'
}

/** Global defaults applied to new projects, plus app-wide auth. Persisted as settings.json in the data dir. */
export interface AppSettings {
  defaultPermissionMode: PermissionMode
  /** undefined = no cap. */
  defaultMaxBudgetUsd?: number
  defaultKeepRuns: number
  defaultIsolateWriters: boolean
  defaultRootModel: ModelRef
  defaultReportModel: ModelRef
  /**
   * Legacy Anthropic auth, kept as a mirror of connections.anthropic.auth so older code keeps working.
   * settings:set keeps the two in sync (whichever one the caller changed wins).
   */
  providerAuth: ProviderAuth
  /** App-wide connection records (no secrets). Filled with defaults for settings saved before connections existed. */
  connections: ProviderConnections
  /** Connection new projects use. Default 'anthropic'. */
  defaultConnection: ConnectionId
  /**
   * OS attention notifications on or off. The single source of truth: the main process reads it every time it
   * decides to notify. Default true.
   */
  notifications?: boolean
  /** Theme, accent, canvas and motion. Filled with defaults for settings saved before it existed. */
  appearance: AppearanceSettings
  /** Weekly-window utilization (percent) above which projects that prefer Sonnet steer Opus spawns to Sonnet. */
  opusGuardThreshold: number
  /** preferSonnetNearLimit for new projects. */
  defaultPreferSonnetNearLimit: boolean
  /** autoContinue for new projects. */
  defaultAutoContinue: boolean
  /** maxAutoContinues for new projects. */
  defaultMaxAutoContinues: number
}

/**
 * What settings:get, settings:set and the settings:changed push return: the settings plus read-only facts
 * about the install. The main process ignores these extra fields when they are echoed back.
 */
export type AppSettingsInfo = AppSettings & {
  dataDir: string
  /** app.getVersion(). Always filled by main; optional only so renderer code that rebuilds the object compiles. */
  appVersion?: string
}

/** Result of auth:status, shown as the sidebar pill. */
export interface AuthStatusResult {
  loggedIn: boolean
  method?: string
  detail?: string
  mode: 'subscription' | 'apiKey'
  envVar?: string
  envVarSet?: boolean
}

// ---------- Setup (AI-driven onboarding) ----------

export type SetupKind = 'new' | 'existing'
export type SetupState = 'pending' | 'in_progress' | 'complete'

/** Token-free snapshot of a working directory, gathered by the main process before the Architect runs. */
export interface ProjectProfile {
  scannedAt: string
  exists: boolean
  isEmpty: boolean
  hasGit: boolean
  fileCount: number
  /** Indented directory listing, truncated. */
  tree: string
  languages: { ext: string; files: number }[]
  /** Contents of manifest and documentation files, each truncated. */
  keyFiles: { path: string; content: string }[]
  gitLog: string[]
  /**
   * Agent-definition locations present (`.orgai/org.json`, `.claude/agents`, `.opencode`, `.codex/agents`,
   * `.github/agents`...), project-relative. Missing on profiles taken before the importer existed.
   */
  agentDefinitions?: string[]
}

export interface ArchitectureSpec {
  summary: string
  stack: string[]
  modules: { name: string; purpose: string; paths: string[] }[]
  conventions: string[]
  commands: { name: string; command: string }[]
  risks: string[]
}

export interface ProjectSetup {
  kind: SetupKind
  state: SetupState
  profile?: ProjectProfile
  architecture?: ArchitectureSpec
  /** Repo-relative path of the architecture document written on approval. */
  architecturePath?: string
  /** The Architect's closing summary. */
  summary?: string
  completedAt?: string
  /** New projects only: when the scaffold run was started. */
  scaffoldedAt?: string
  /** When an agent last edited the architecture document during a work run. */
  architectureUpdatedAt?: string
}

export interface OrgChartProposalPayload {
  roles: Role[]
  rationale: string
}

export interface SettingsProposalPayload {
  brief?: string
  permissionMode?: PermissionMode
  /** null clears the cap. */
  maxBudgetUsd?: number | null
  maxSubagentDepth?: number
  maxConcurrentSubagents?: number
  isolateWriters?: boolean
  reviewMerges?: boolean
  /** Keep the orchestrator going until its plan is complete (work runs). */
  autoContinue?: boolean
  /** Automatic continues allowed per run. */
  maxAutoContinues?: number
  /** Permission rules to save as project allow rules, e.g. "Bash(npm:*)". Merged into .claude/settings.local.json. */
  allowRules?: string[]
  rationale: string
}

/**
 * One server of an mcpServers proposal. Project scope: `libraryId` links that existing library entry (its other
 * fields are a display snapshot); otherwise a new server that is also saved to the library and linked, unless
 * `projectOnly`. Library scope: a library entry (enabled, roles, libraryId and projectOnly are ignored).
 */
export type McpProposalServer = McpServerSpec & { projectOnly?: boolean }

/**
 * MCP proposal (propose_mcp_servers, from the MCP assistant or the Architect in setup): servers to add or replace,
 * servers to remove, and the secret slots the user must fill after approving. Applying it saves
 * Project.mcpServers (scope 'project', the default) and creates library entries, or only changes the library
 * (scope 'library', harness-level assistant runs).
 */
export interface McpServersProposalPayload {
  /** Missing = 'project'. */
  scope?: 'project' | 'library'
  /** Specs to add (new id) or replace (existing id). */
  upsert: McpProposalServer[]
  /** Ids of servers to remove (project scope: unlinks linked servers; library scope: library entry ids). */
  remove?: string[]
  /**
   * Secret slots to fill once approved; values are entered through mcp:setSecret / mcpLibrary:setSecret, never in
   * the proposal. serverId is the project server id (project scope; when that server is linked after applying, set
   * the value on its libraryId) or the library entry id (library scope).
   */
  secrets?: { serverId: string; kind: McpSecretKind; name: string; description?: string }[]
  rationale: string
}

export type ProposalKind = 'architecture' | 'orgChart' | 'settings' | 'mcpServers'

interface ProposalBase {
  id: string
  runId: string
  agentId: string
  title: string
  createdAt: number
}

export type Proposal =
  | (ProposalBase & { kind: 'architecture'; payload: ArchitectureSpec })
  | (ProposalBase & { kind: 'orgChart'; payload: OrgChartProposalPayload })
  | (ProposalBase & { kind: 'settings'; payload: SettingsProposalPayload })
  | (ProposalBase & { kind: 'mcpServers'; payload: McpServersProposalPayload })

export type ProposalDecision = { behavior: 'approve' } | { behavior: 'revise'; feedback: string }

/** A multiple-choice question the Architect (setup) or the orchestrator (work runs) puts to the user (ask_user tool). */
export interface UserQuestion {
  id: string
  runId: string
  agentId: string
  question: string
  options: { label: string; description?: string }[]
  allowMultiple: boolean
  allowFreeText: boolean
  createdAt: number
}

/** The user's answer: chosen option labels plus optional free text. Empty when the run ended unanswered. */
export interface QuestionAnswer {
  selected: string[]
  text?: string
}

// ---------- Runs ----------

export type AgentState =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'waiting' // waiting for a permission decision
  | 'delegating'
  | 'idle' // turn finished, session still open
  | 'done'
  | 'error'

export interface AgentInstance {
  /** Harness id. "root" for the orchestrator, otherwise the SDK agent_id. */
  id: string
  roleId: string | null
  roleSlug: string
  name: string
  parentId: string | null
  /** tool_use id of the Agent call that spawned this instance (null for root). */
  spawnToolUseId: string | null
  state: AgentState
  /** One-line description of what the agent is doing right now. */
  activity: string
  model?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  startedAt: number
  endedAt?: number
  /** Last text the agent produced (truncated for the node card). */
  lastText?: string
  result?: string
  /** Present when the agent works in an isolated git worktree. */
  worktree?: WorktreeInfo
  /** Name other agents use to address it (SendMessage), e.g. "implementer-2". */
  handle?: string
}

/** One agent-to-agent message (SendMessage), as drawn on the live canvas. */
export interface AgentMessage {
  /** Sending agent's harness id. */
  from: string
  /** Recipient's harness id; null when it is not an agent on the chart (the user, or an unknown handle). */
  to: string | null
  /** The address the sender used. */
  toHandle: string
  /** First 200 characters of the message. */
  text: string
  at: number
}

export type WorktreeStatus =
  | 'active' // the agent is working in it
  | 'merging' // the harness is committing and merging it
  | 'merged' // merged into its merge target (main checkout or parent's worktree) and removed
  | 'empty' // the report changed nothing; removed
  | 'conflict' // could not merge automatically; branch kept for the orchestrator
  | 'removed' // gone before the harness looked
  | 'review' // waiting for the user to review the diff before merging
  | 'held' // the user chose to hold it; branch kept for later
  | 'waiting-children' // the agent finished; its branch merges after its own isolated reports are integrated

export interface WorktreeInfo {
  path: string
  branch: string
  status: WorktreeStatus
  changedFiles?: string[]
  /** Where the branch merges when the agent finishes. Absent means 'main' (older records). */
  mergeTarget?: 'main' | 'parent'
  /** Nested isolation: the isolated agent that spawned this one; its worktree is the merge target. */
  parentAgentId?: string
  /** Nested isolation: the parent's branch this one was cut from and merges into. */
  parentBranch?: string
}

/** A report branch still sitting in the repository, as shown by the maintenance panel. */
export interface PendingWorktree {
  path: string
  branch: string
  agentId: string
  /** False when the directory is gone but the branch remains. */
  exists: boolean
  uncommittedFiles: number
  commitsAhead: number
  changedFiles: string[]
  lastCommitAt?: number
  lastSubject?: string
}

/** A finished report's branch waiting for the user's review before it is merged. */
export interface MergeReview {
  id: string
  runId: string
  agentId: string
  agentName: string
  branch: string
  path: string
  changedFiles: string[]
  /** Output of git diff --stat. */
  stat: string
  /** Unified diff, truncated when very large. */
  patch: string
  createdAt: number
}

export type MergeDecision = { behavior: 'merge' } | { behavior: 'discard' } | { behavior: 'hold' }

/** A branch's diff against the main checkout, as shown by the maintenance panel. */
export interface WorktreeDiff {
  stat: string
  patch: string
}

export interface MaintenanceResult {
  ok: boolean
  message: string
}

/** How many runs to keep per project when none is set. */
export const DEFAULT_KEEP_RUNS = 100

/** Image formats the provider accepts as image content (pasted into the run composer). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/**
 * An image sent with a user message. Structured-clone safe. Live RunEvents and records returned to the
 * renderer always carry `data`; on disk the run record stores `ref` with `data: ''` and the bytes live in
 * the run's content-addressed image store (see src/main/store/runs.ts).
 */
export interface ImageAttachment {
  mediaType: ImageMediaType
  /** Base64 of the image bytes, without a `data:` URL prefix. Empty if a persisted image file is missing. */
  data: string
  /** Original file name, when the paste or drop carried one. */
  name?: string
  /**
   * Main-process storage reference: the image's file name (`<sha256>.<ext>`) under the run's
   * `images/` directory. Set only on persisted records; the renderer never needs it.
   */
  ref?: string
}

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /** `text` may be empty when the message is only images. */
  | { kind: 'user'; text: string; images?: ImageAttachment[] }
  /**
   * A line from the harness. `text` is what the user reads. `detail`, when present, is the full text the
   * harness sent to the agent (for example the complete continuation instruction); show it behind a disclosure.
   */
  | { kind: 'system'; text: string; detail?: string }

export interface TranscriptEntry {
  id: string
  agentId: string
  at: number
  block: TranscriptBlock
  /**
   * 'harness': the harness wrote this entry (a continuation nudge, a report hand-off or a notice it sent to the
   * orchestrator, a limit notice), not the user or a model. Render it as a system row, outside the reading flow.
   * Absent on everything else and on records saved before it existed.
   */
  source?: 'harness'
}

/** 'paused': the session ended on a subscription usage limit; it can resume when the window resets. */
export type RunStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'finished' | 'error' | 'paused'

/**
 * 'work' runs the project's org chart; 'setup' runs the built-in Architect that designs it; 'mcp-assist' runs
 * a built-in MCP assistant (like setup, never the project's roles, never nudged) that proposes McpServerSpec
 * changes through the proposal mechanism (kind 'mcpServers').
 */
export type RunKind = 'work' | 'setup' | 'mcp-assist'

/**
 * Project id of the virtual harness project that owns harness-level runs (the library MCP assistant). It is built
 * in the main process (name "OrgAI", path = the data dir), never stored in projects.json and never listed by
 * projects:list; projects:get(HARNESS_PROJECT_ID) returns it so a run window can render it.
 */
export const HARNESS_PROJECT_ID = 'harness'

export interface RunSummary {
  id: string
  projectId: string
  kind: RunKind
  prompt: string
  status: RunStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  totalCostUsd: number
  error?: string
  /** Set when this run continues an earlier run's SDK session; the earlier run's id. */
  resumedFrom?: string
  /** Paused runs: when the usage window resets (epoch ms) and the run may continue. */
  pausedUntil?: number
  /** Paused runs: why, in words shown to the user. */
  pauseReason?: string
  /** Paused runs: the harness continues the run at pausedUntil unless the user cancels. */
  autoResume?: boolean
  /**
   * The session was still open when OrgAI last quit or crashed; the store marked it finished at startup.
   * It stays continuable.
   */
  endedWithApp?: true
  /**
   * Work runs: a short AI summary of the run's first message (one line, at most RUN_TITLE_MAX_CHARS characters),
   * written by the connection's fast model shortly after the run starts (a run.title event announces it). Absent
   * until generated, and for good when generation failed or was skipped (setup-like runs, image-only prompts).
   * Advisory only: the UI falls back to `prompt`.
   */
  title?: string
}

/**
 * Another run as an orchestrator sees it through list_runs (cross-run messaging). Work runs only: setup-like runs
 * are never listed. Structured-clone safe.
 */
export interface RunPeer {
  runId: string
  projectId: string
  /** Display name of the run's project. */
  projectName: string
  kind: RunKind
  status: RunStatus
  /** The run's prompt on one line, at most RUN_PEER_PROMPT_CHARS characters. */
  prompt: string
  startedAt: number
  /** Name of the run's root role (its orchestrator). */
  rootRole: string
  /** True while the run's session is open (it can receive a message_run). */
  live: boolean
  /** The peer's project has runMessaging on. message_run also needs the caller's project to have it on. */
  messaging: boolean
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'

/** One step of the orchestrator's plan (set_plan / update_plan). */
export interface PlanStep {
  /** p1, p2, ... in plan order. */
  id: string
  title: string
  status: PlanStepStatus
  note?: string
  /** Role or handle expected to do the step. */
  owner?: string
}

/**
 * A work run's plan. The orchestrator writes it with the harness's plan tools; the harness uses it to
 * keep the run going unattended until every step is done ('done') or a decision is needed ('blocked').
 */
export interface RunPlan {
  goal: string
  steps: PlanStep[]
  status: 'active' | 'done' | 'blocked'
  /** complete_plan: the orchestrator's closing summary. */
  summary?: string
  /** mark_blocked: what the user must decide. */
  blockedReason?: string
  /** How many times the harness re-engaged the orchestrator automatically in this run. */
  autoContinues: number
  updatedAt: number
}

/** Automatic continues per run when a project sets none. */
export const DEFAULT_MAX_AUTO_CONTINUES = 40

/** A finished or live run as persisted on disk: everything needed to redraw it later. */
export interface RunRecord {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  transcript: TranscriptEntry[]
  logs: { at: number; level: 'info' | 'warn' | 'error'; message: string }[]
  /** Work runs: the orchestrator's plan, once it set one. */
  plan?: RunPlan
}

export interface PermissionRequest {
  id: string
  runId: string
  agentId: string
  toolName: string
  input: unknown
  /** Human description built by the harness. */
  summary: string
  /** Rule updates that would stop prompts for matching calls (provider suggestions or harness-derived). */
  suggestions?: PermissionSuggestion[]
  /** Human-readable rules the suggestions grant, e.g. "Bash(npm test:*)". Shown on the card. */
  ruleLabels?: string[]
}

/** How long an allow decision lasts: this call only, the rest of this run, or every future run of the project. */
export type PermissionScope = 'once' | 'session' | 'project'

/** One permission rule: a tool name plus optional content, written as `Tool(content)`. */
export interface PermissionRuleSpec {
  toolName: string
  ruleContent?: string
}

/** True for a bare tool-name rule such as "WebSearch": it approves every call of that tool before any prompt. */
export function isWholeToolRule(rule: string): boolean {
  return /^[A-Za-z_][\w-]*$/.test(rule.trim())
}

/** Structured-clone-safe copy of a provider permission update (the Claude SDK's PermissionUpdate). */
export type PermissionSuggestion =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: PermissionRuleSpec[]
      behavior: 'allow' | 'deny' | 'ask'
      destination: string
    }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: string }
  | { type: 'setMode'; mode: string; destination: string }

export type PermissionDecision = { behavior: 'allow'; scope?: PermissionScope } | { behavior: 'deny'; message: string }

/**
 * An agent's request for permission rules after the policy denied a call (request_permission_rules). Granting
 * applies at once to the live run (the harness allows matching calls itself) and, with scope 'project', saves
 * the rules to `.claude/settings.local.json` for future runs.
 */
export interface PermissionRuleRequest {
  id: string
  runId: string
  agentId: string
  /** Rules as written, e.g. "Bash(gh repo create:*)". */
  rules: string[]
  reason: string
  /** Rules the harness flags as broad or destructive (a bare shell tool, a wildcard, rm, git push, sudo...). */
  flagged: string[]
  createdAt: number
}

export type PermissionRuleDecision = { behavior: 'grant'; scope: 'run' | 'project' } | { behavior: 'deny'; message?: string }

// ---------- Subscription usage ----------

/** One plan usage window. */
export interface RateLimitWindow {
  /** Percent of the window used, 0-100. null when the provider did not say. */
  utilization: number | null
  /** When the window resets, epoch ms. */
  resetsAt: number | null
}

/** A per-model weekly window the plan reports by display name (e.g. "Fable"). */
export interface ModelRateLimitWindow extends RateLimitWindow {
  model: string
}

/** The plan limits that constrain a subscription login, as last reported by the provider. */
export interface UsageStatus {
  /** The adapter that reported it. Missing on older records = 'claude'. */
  provider?: ProviderId
  /** The connection the limits belong to. Missing = 'anthropic'. Lets Codex (ChatGPT) limits show beside Claude's. */
  connection?: ConnectionId
  authMode: 'subscription' | 'apiKey' | 'unknown'
  /** e.g. 'pro', 'max'; null for API keys or when unknown. */
  subscriptionType: string | null
  /** Plan windows were reported. False for API keys and before the first report. */
  available: boolean
  windows: {
    fiveHour?: RateLimitWindow
    sevenDay?: RateLimitWindow
    sevenDayOpus?: RateLimitWindow
    sevenDaySonnet?: RateLimitWindow
  }
  /** Other per-model weekly windows reported by name. */
  modelWindows?: ModelRateLimitWindow[]
  /** Latest rate-limit status from a live request. */
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  /** The window that is limiting (provider name, e.g. 'five_hour'). */
  limitedWindow?: string
  /** While rejected: when requests are allowed again, epoch ms. */
  limitedUntil?: number
  overageInUse?: boolean
  updatedAt: number
}

// ---------- Run events (main -> renderer) ----------

export type RunEvent =
  | {
      type: 'run.status'
      runId: string
      status: RunStatus
      sessionId?: string
      error?: string
      /** status 'paused' (and later updates to a paused run). */
      pausedUntil?: number
      pauseReason?: string
      autoResume?: boolean
    }
  /**
   * The run's AI-generated title (RunSummary.title) arrived. Sent at most once per run, work runs only, possibly
   * after the run ended. The summary in runs:list / runs:get carries it from then on.
   */
  | { type: 'run.title'; runId: string; title: string }
  | { type: 'agent.upsert'; runId: string; agent: AgentInstance }
  | { type: 'agent.remove'; runId: string; agentId: string }
  | { type: 'transcript'; runId: string; entry: TranscriptEntry }
  /** Text the agent is streaming right now; '' clears it once the completed message lands. Never persisted. */
  | { type: 'agent.partial'; runId: string; agentId: string; text: string }
  | { type: 'permission.request'; runId: string; request: PermissionRequest }
  /**
   * The card is answered or gone. `cancelled`: the run ended (finished, stopped, failed or paused) before the
   * user answered; the same flag is on every *.resolved event. RunManager emits these for every pending item
   * before the terminal run.status, so no card outlives its run.
   */
  | { type: 'permission.resolved'; runId: string; requestId: string; cancelled?: true }
  | { type: 'run.cost'; runId: string; totalCostUsd: number }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'proposal.request'; runId: string; proposal: Proposal }
  | { type: 'proposal.resolved'; runId: string; proposalId: string; decision: ProposalDecision; cancelled?: true }
  | { type: 'question.request'; runId: string; question: UserQuestion }
  | { type: 'question.resolved'; runId: string; questionId: string; answer: QuestionAnswer; cancelled?: true }
  /** An agent asked for permission rules (request_permission_rules); the run waits for permissions:decideRequest. */
  | { type: 'rules.request'; runId: string; request: PermissionRuleRequest }
  | { type: 'rules.resolved'; runId: string; requestId: string; decision: PermissionRuleDecision; cancelled?: true }
  | { type: 'merge.request'; runId: string; review: MergeReview }
  | { type: 'merge.resolved'; runId: string; reviewId: string; decision: MergeDecision; cancelled?: true }
  /** The main process changed the project (an approved proposal, setup completion). */
  | { type: 'project.updated'; runId: string; project: Project }
  /** Latest plan usage as seen by a live session. Account-wide, not specific to the run. */
  | { type: 'usage.status'; runId: string; usage: UsageStatus }
  /** The orchestrator's plan changed (plan tools, or the harness counting an automatic continue). */
  | { type: 'plan.updated'; runId: string; plan: RunPlan }
  /** One agent messaged another (SendMessage). Live only; the sender's transcript carries a persisted copy. */
  | ({ type: 'agent.message'; runId: string } & AgentMessage)
  /**
   * Cross-run messaging: one run's orchestrator messaged another run's orchestrator (message_run). Emitted on both
   * runs: direction 'out' on the sender (runId = sender, peer* = recipient), 'in' on the recipient (runId =
   * recipient, peer* = sender). Separate from agent.message, which is inside one run. Live only; each run's
   * transcript carries a persisted system block on its root. `text` is at most RUN_MESSAGE_MAX_CHARS characters.
   */
  | {
      type: 'run.message'
      runId: string
      direction: 'in' | 'out'
      peerRunId: string
      peerProjectId: string
      peerProjectName: string
      /** The peer run's prompt, one line, at most RUN_PEER_PROMPT_CHARS characters. */
      peerPrompt: string
      text: string
      at: number
    }
  /** An agent asked to install an MCP server (request_mcp_install); the run waits for mcp:answerInstall. */
  | { type: 'mcpInstall.request'; runId: string; request: McpInstallRequest }
  /** The install request was answered (or dropped when the run ended: approved false). Never carries secrets. */
  | { type: 'mcpInstall.resolved'; runId: string; requestId: string; outcome: McpInstallOutcome; cancelled?: true }

/**
 * Payload of the main -> renderer `app:focusRun` message sent when a notification is clicked, and of
 * `window:openRun`. A window opened for a run loads the renderer with the hash `#/run/<projectId>/<runId>`
 * (both encodeURIComponent'd; see RUN_WINDOW_HASH_PREFIX and runWindowHash).
 */
export interface FocusRunTarget {
  projectId: string
  runId: string
}

/** Hash prefix of a run-scoped window: `#/run/<projectId>/<runId>`. The main (unscoped) window has no hash. */
export const RUN_WINDOW_HASH_PREFIX = '#/run/'

/** The location.hash of a window scoped to one run. */
export function runWindowHash(target: FocusRunTarget): string {
  return `${RUN_WINDOW_HASH_PREFIX}${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.runId)}`
}

/** Parse a run-scoped window's location.hash; null for the main window or anything malformed. */
export function parseRunWindowHash(hash: string): FocusRunTarget | null {
  if (!hash.startsWith(RUN_WINDOW_HASH_PREFIX)) return null
  const parts = hash.slice(RUN_WINDOW_HASH_PREFIX.length).split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  try {
    return { projectId: decodeURIComponent(parts[0]), runId: decodeURIComponent(parts[1]) }
  } catch {
    return null
  }
}

// ---------- AI drafting ----------

export interface DraftRequest {
  projectId: string
  /** The user's instruction, e.g. "This is a Next.js + Postgres SaaS; I mostly build features and fix bugs." */
  instruction: string
  /** Whether to start from the existing roles or from scratch. */
  mode: 'replace' | 'revise'
}

export interface DraftResult {
  roles: Role[]
  rationale: string
}

// ---------- IPC surface ----------

/** projects:create. Omit setupKind to skip AI setup and start with the default roles. */
export interface ProjectCreateInput {
  name: string
  path: string
  brief: string
  setupKind?: SetupKind
  /**
   * Run the project on the scripted, token-free mock adapter (provider.id 'mock'). Only accepted when
   * AppInfo.mockAdapter is true (ORGAI_MOCK=1); otherwise projects:create rejects.
   */
  mock?: boolean
  /**
   * Start the project with the agent definitions found in these sources of the folder (projects:scanAgents)
   * instead of the default chart: the 'replace' import, with models mapped to the connection the project is
   * created on. Unknown sources are ignored; when nothing importable is found the default chart is kept.
   */
  importAgents?: AgentImportSource[]
}

/** projects:checkPath. Never rejects; an empty or unreadable path reports exists false. */
export interface ProjectPathCheck {
  exists: boolean
  isDirectory: boolean
  /** The folder itself holds a .git directory or file (a repository root or a worktree). */
  isGitRepo: boolean
  /** The folder's last path segment, '' for a drive root or an empty path. */
  suggestedName: string
  /** An existing directory with no entries at all. False when it does not exist. */
  empty: boolean
  /** Agent definitions found in the folder (the same scan as projects:scanAgents), when there are any. */
  agentSources?: { source: AgentImportSource; label: string; agentCount: number }[]
  /** Instruction-only files found (AGENTS.md, CLAUDE.md...), project-relative, when there are any. */
  instructionFiles?: string[]
  /** The folder (compared by resolved path) is already this OrgAI project. */
  existingProjectId?: string
  existingProjectName?: string
}

// ---------- Agent import ----------

/**
 * Where an imported agent definition came from. 'orgai' = `.orgai/org.json` (projects:exportOrg);
 * 'claude' = `.claude/agents/**\/*.md`; 'opencode' = `.opencode/agents|agent/*.md` and `opencode.json(c)`;
 * 'codex' = `.codex/agents/*.toml`; 'copilot' = `.github/agents/*.agent.md`; 'gemini' = `.gemini/agents/*.md`;
 * 'kiro' = `.kiro/agents/*.json|*.md`; 'roo' = `.roomodes`.
 */
export type AgentImportSource = 'orgai' | 'claude' | 'opencode' | 'codex' | 'copilot' | 'gemini' | 'kiro' | 'roo'

/** Every source, in scan and display order. */
export const AGENT_IMPORT_SOURCES: readonly AgentImportSource[] = ['orgai', 'claude', 'opencode', 'codex', 'copilot', 'gemini', 'kiro', 'roo']

/** Display names of the sources. */
export const AGENT_IMPORT_SOURCE_LABELS: Record<AgentImportSource, string> = {
  orgai: 'OrgAI export',
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  kiro: 'Kiro',
  roo: 'Roo Code'
}

export function isAgentImportSource(v: unknown): v is AgentImportSource {
  return typeof v === 'string' && (AGENT_IMPORT_SOURCES as readonly string[]).includes(v)
}

/** One source found in a folder. `files` are project-relative with forward slashes. */
export interface AgentImportSourceSummary {
  source: AgentImportSource
  label: string
  files: string[]
  agentCount: number
}

/** projects:scanAgents. Never rejects: a missing or unreadable folder gives empty lists (and maybe a warning). */
export interface AgentImportScan {
  /** Only sources with at least one file. */
  sources: AgentImportSourceSummary[]
  /** Instruction-only files (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, GEMINI.md, .cursor/rules/*.mdc). Never roles. */
  instructionFiles: string[]
  /** Parse problems, skipped files and truncations, one readable line each. */
  warnings: string[]
}

/** 'replace' swaps the whole org chart for the imported roles; 'merge' keeps the existing roles and adds the imported ones. */
export type AgentImportMode = 'replace' | 'merge'

/**
 * What to do with one imported role. 'add' (default): add it, renaming its slug when it collides.
 * 'replace': take the place of the existing role with the same slug, keeping that role's id and reportsTo.
 * 'skip': leave it out.
 */
export type AgentImportAction = 'add' | 'replace' | 'skip'

/** A user's choice for one imported role, keyed by AgentImportItem.key. */
export interface AgentImportChoice {
  key: string
  include: boolean
  /** New manager: a role slug or id in the resulting chart. Refused when unknown or when it makes a cycle. */
  reportsTo?: string
  /** 'inherit', a catalog model of the project's connection, or a tier name (top, deep, everyday, fast) mapped there. */
  model?: ModelRef
  action?: AgentImportAction
}

/** projects:previewImport and projects:applyImport input. Omit `sources` for every source found. */
export interface AgentImportInput {
  projectId: string
  sources?: AgentImportSource[]
  mode: AgentImportMode
  choices?: AgentImportChoice[]
  /**
   * applyImport only: AgentImportPreview.digest of the preview the user reviewed. When given and the folder's
   * definitions changed since (another prompt, tool list or model under the same name), apply refuses.
   * Omitting it opts out of that check, so the UI always sends the digest of the preview it showed.
   */
  digest?: string
}

/**
 * Why an imported role got its model. 'kept': the original is a catalog model of the project's connection.
 * 'tier': mapped through the connection's tier mapping from the original's tier. 'default': the original was
 * missing or unknown, so the 'everyday' tier was used. 'inherit': stays 'inherit'. 'chosen': AgentImportChoice.model.
 */
export type AgentImportModelReason = 'kept' | 'tier' | 'default' | 'inherit' | 'chosen'

/** One imported role in a preview. */
export interface AgentImportItem {
  /** Stable across scans of the same files: `<source>:<file>#<name>`. Choices refer to it. */
  key: string
  /** The role's id in AgentImportPreview.roles (absent when the action is 'skip'). */
  roleId?: string
  name: string
  slug: string
  source: AgentImportSource
  /** Project-relative file the definition came from. */
  file: string
  description: string
  originalModel?: string
  model: ModelRef
  tier?: ModelTier
  modelReason: AgentImportModelReason
  tools: ToolName[]
  /** Foreign tool names with no OrgAI equivalent. */
  toolsDropped: string[]
  canSpawn: boolean
  /** Slug or name of the manager in the result, null for the root. */
  reportsTo: string | null
  /** The first 600 characters of the imported prompt. */
  promptExcerpt: string
  /** Length of the whole imported prompt (at most 20,000), so the UI can say how much the excerpt leaves out. */
  promptLength: number
  action: AgentImportAction
  /** For 'replace': the existing role it takes the place of. */
  replacesRoleId?: string
  /** A role with this slug already exists (merge mode). */
  slugConflict: boolean
  /** Readable notes: renamed slug, truncated prompt, tier fallback... */
  notes: string[]
}

/** projects:previewImport: what applyImport would save. Nothing is saved. */
export interface AgentImportPreview {
  mode: AgentImportMode
  /** The project's full resulting roles. */
  roles: Role[]
  items: AgentImportItem[]
  /** Existing roles that the result drops (replace mode, or replaced by an item). */
  replacedRoleIds: string[]
  /** Scan warnings plus the roll-up: unmapped models, duplicate slugs, no orchestrator, instruction files not imported, family mix. */
  warnings: string[]
  connection: ConnectionId
  /** Instruction-only files that were not turned into roles. */
  instructionFiles: string[]
  /** sha256 of the scanned definitions; pass it back as AgentImportInput.digest so apply refuses a changed folder. */
  digest: string
}

/** projects:applyImport output. Undo = save previousRoles through projects:save. */
export interface AgentImportApplyResult {
  project: Project
  previousRoles: Role[]
}

/** projects:exportOrg output: the absolute path of the written `.orgai/org.json`. */
export interface OrgExportResult {
  path: string
}

/** runs:start. `scaffold` marks a new project's first build run so the setup banner can step aside. */
export interface StartRunInput {
  projectId: string
  /** May be empty when images are attached. */
  prompt: string
  scaffold?: boolean
  images?: ImageAttachment[]
}

/** runs:send: a follow-up message to a live run's orchestrator. */
export interface SendRunInput {
  runId: string
  /** May be empty when images are attached. */
  text: string
  images?: ImageAttachment[]
}

/** runs:continue: start a new run that resumes a finished run's session. */
export interface ContinueRunInput {
  runId: string
  /** May be empty when images are attached. */
  text: string
  images?: ImageAttachment[]
}

/**
 * runs:pendingCards: a live run's open decision cards, oldest first per kind. Each entry is exactly what the
 * matching `*.request` RunEvent carried (permission, question, proposal, rules, merge, mcpInstall), so no secrets:
 * McpInstallRequest holds secret names only. Structured-clone safe.
 */
export interface PendingCards {
  permissions: PermissionRequest[]
  questions: UserQuestion[]
  proposals: Proposal[]
  ruleRequests: PermissionRuleRequest[]
  mergeReviews: MergeReview[]
  mcpInstalls: McpInstallRequest[]
}

export interface OrgAIApi {
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    /**
     * Omit setupKind to skip AI setup and start with the default roles. Rejects with a readable message when the
     * path is empty, names a file, or (setupKind 'existing') does not exist; and when `mock` is set without the
     * mock adapter.
     */
    create(input: ProjectCreateInput): Promise<Project>
    /** What is at `path` right now, for validating the New project form. Never rejects. */
    checkPath(path: string): Promise<ProjectPathCheck>
    save(project: Project): Promise<Project>
    remove(id: string): Promise<void>
    pickDirectory(): Promise<string | null>
    /**
     * Remap the project's tiered role models to its connection's tierModels. With `connection`, switch the
     * project to that connection first and remap every tiered role. Returns the change list and the saved project.
     */
    remapModels(input: RemapModelsInput): Promise<RemapModelsOutput>
    /** Dry run of remapModels: the RemapResult it would produce, computed by the main process. Saves nothing. */
    previewRemap(input: RemapModelsInput): Promise<RemapResult>
    /** Agent definitions other harnesses (or OrgAI's export) left in a folder. Read-only and token-free; never rejects. */
    scanAgents(path: string): Promise<AgentImportScan>
    /** The org chart an import would produce, with models mapped to the project's connection. Saves nothing. */
    previewImport(input: AgentImportInput): Promise<AgentImportPreview>
    /** Re-scan the folder, apply the import (and the choices) and save. Returns the project and the roles it replaced. */
    applyImport(input: AgentImportInput): Promise<AgentImportApplyResult>
    /** Write the project's org chart to `<project>/.orgai/org.json` (no ids, positions, secrets or MCP specs). */
    exportOrg(projectId: string): Promise<OrgExportResult>
  }
  connections: {
    /** Every connection record (CONNECTION_IDS order) with its live status. */
    list(): Promise<ConnectionInfo[]>
    /**
     * Save one connection record. LiteLLM's hasApiKey is ignored (the main process owns it). Changing
     * tierModels remaps the projects on that connection (a projects.remapped event follows).
     */
    update(connection: ProviderConnection): Promise<ConnectionInfo>
    /** Store or clear the LiteLLM key in safeStorage. Write-only: the key never comes back. */
    setSecret(input: ConnectionSecretInput): Promise<ConnectionInfo>
    /** Probe the connection (auth, reachability) without changing its enabled flag or catalog. */
    test(id: ConnectionId): Promise<ConnectionStatus>
    /** Enable and connect: probe, discover models, fill tierModels, remap projects. */
    connect(id: ConnectionId): Promise<ConnectionInfo>
    /**
     * Start the OpenAI ChatGPT (Codex) login. 'browser' (default) opens the system browser; 'deviceCode'
     * returns a code for another device. Progress arrives as connection.login events.
     */
    login(id: 'openai', method?: ConnectionLoginMethod): Promise<ConnectionLoginStart>
    /** Abandon a pending login. */
    cancelLogin(loginId: string): Promise<void>
    /** Sign out (OpenAI ChatGPT login) or forget the stored key (LiteLLM), and mark the connection disconnected. */
    logout(id: ConnectionId): Promise<ConnectionInfo>
  }
  models: {
    /** The model catalog: builtin plus discovered, for one connection or every enabled one. */
    list(query?: ModelsQuery): Promise<ProviderModel[]>
    /** Re-discover models (LiteLLM /v1/models and /model/info, Codex model/list) and return the new catalog. */
    refresh(query?: ModelsQuery): Promise<ProviderModel[]>
  }
  /** Connection status, login progress, catalog changes and remaps. Returns an unsubscribe function. */
  onConnectionEvent(cb: (event: ConnectionEvent) => void): () => void
  mcp: {
    /** The project's MCP servers (linked ones refreshed from the library) with secret has-flags and OAuth state. */
    list(projectId: string): Promise<McpServerInfo[]>
    /**
     * Add or replace one server. On a linked server (libraryId) only `enabled` and `roles` may change; edit the
     * library entry for the rest. The stored `oauth` is kept whatever the renderer sends.
     */
    upsert(input: McpUpsertInput): Promise<McpMutationResult>
    /** Remove one server and its stored secrets. A linked server is only unlinked (the library entry stays). */
    remove(input: { projectId: string; serverId: string }): Promise<McpMutationResult>
    /** Store or clear one secret value of a project-only server. Write-only. Linked servers: mcpLibrary.setSecret. */
    setSecret(input: McpSecretInput): Promise<McpMutationResult>
    /** Start the server outside a run and list its tools. */
    test(input: { projectId: string; serverId: string }): Promise<McpTestResult>
    /** Search the official MCP Registry. */
    registrySearch(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult>
    /** Answer an agent's request_mcp_install card. */
    answerInstall(input: McpAnswerInstallInput): Promise<void>
    /**
     * Start the MCP assistant session (RunKind 'mcp-assist'); its proposals are answered with setup.decide. scope
     * 'library' runs it on the virtual harness project (RunSummary.projectId === HARNESS_PROJECT_ID).
     */
    startAssist(input: McpAssistInput): Promise<RunSummary>
    /** Add a library entry to a project by reference. Rejects when the project already has a server of that name. */
    linkLibrary(input: McpLinkLibraryInput): Promise<McpMutationResult>
    /**
     * Move a project-only server into the library (with its secrets and OAuth tokens) and relink it. Rejects when
     * the library already has an entry of that name.
     */
    promote(input: { projectId: string; serverId: string }): Promise<McpMutationResult>
    /**
     * Run the whole OAuth authorization (discovery, client registration, the system browser, the loopback
     * callback, token exchange) and resolve with the resulting state; it does not reject for flow failures
     * (state 'error' carries the message; needsClientId asks for a client id). A linked project server is
     * authorized through { libraryId }. Broadcasts mcpLibrary:changed for a library entry.
     */
    authorize(input: McpAuthorizeInput): Promise<McpAuthStatus>
    /** Abandon a pending authorize (its promise resolves with state 'error', "Authorization was cancelled."). */
    cancelAuthorize(target: McpAuthTarget): Promise<void>
    /** Forget the access and refresh tokens; the client registration (client id, secret) is kept. */
    revokeAuth(target: McpAuthTarget): Promise<McpAuthStatus>
  }
  /** The app-wide MCP library. Every mutation also broadcasts mcpLibrary:changed. */
  mcpLibrary: {
    list(): Promise<McpLibraryInfo[]>
    /**
     * Add (new id) or replace one entry; validated like a project server, name unique within the library. The
     * stored `oauth` is kept (an edit that changes the url drops the OAuth state and tokens). Linked projects see
     * the change on their next read.
     */
    upsert(entry: McpLibraryEntry): Promise<McpLibraryInfo[]>
    /** Delete an entry and its secrets, unlink it from every project and drop the Role.mcpServers grants to it. */
    remove(input: { libraryId: string }): Promise<McpLibraryInfo[]>
    /** Store or clear one secret value of an entry. Write-only. */
    setSecret(input: McpLibrarySecretInput): Promise<McpLibraryInfo[]>
    /** Start the entry outside a run and list its tools (refreshes an expiring OAuth token first). */
    test(input: { libraryId: string }): Promise<McpTestResult>
  }
  /** The library changed (any mcpLibrary:* mutation, authorize, revoke, promote). Returns an unsubscribe function. */
  onMcpLibraryChanged(cb: (entries: McpLibraryInfo[]) => void): () => void
  plugins: {
    /** Add or replace one plugin. Returns the saved project. */
    upsert(input: PluginUpsertInput): Promise<Project>
    /** Remove one plugin. Returns the saved project. */
    remove(input: { projectId: string; pluginId: string }): Promise<Project>
  }
  draft: {
    orgChart(req: DraftRequest): Promise<DraftResult>
  }
  setup: {
    /** Profile the working directory and start an Architect session. */
    start(input: { projectId: string; instruction?: string }): Promise<RunSummary>
    /** Architect session that reviews a finished run and revises the org chart where roles struggled. */
    retro(input: { projectId: string; runId: string }): Promise<RunSummary>
    decide(input: { runId: string; proposalId: string; decision: ProposalDecision }): Promise<void>
    /** Answer an ask_user question from the Architect. */
    answer(input: { runId: string; questionId: string; answer: QuestionAnswer }): Promise<void>
  }
  maintenance: {
    /** Report branches still in the repository. */
    listWorktrees(projectId: string): Promise<PendingWorktree[]>
    /** Commit leftovers and merge one branch into the main checkout. */
    integrateWorktree(input: { projectId: string; branch: string }): Promise<MaintenanceResult>
    /** Delete one branch and its worktree, losing its work. */
    discardWorktree(input: { projectId: string; branch: string }): Promise<MaintenanceResult>
    /** The branch's changes against the main checkout. */
    diffWorktree(input: { projectId: string; branch: string }): Promise<WorktreeDiff>
    /** Remove the files OrgAI added to the repository. Refuses while report branches hold work. */
    uninstallRepo(projectId: string): Promise<MaintenanceResult>
  }
  runs: {
    /** `scaffold` marks a new project's first build run so the setup banner can step aside. */
    start(input: StartRunInput): Promise<RunSummary>
    send(input: SendRunInput): Promise<void>
    interrupt(runId: string): Promise<void>
    stop(runId: string): Promise<void>
    list(projectId: string): Promise<RunSummary[]>
    /** Load a past run with its agents and transcript. null when nothing was persisted. */
    get(runId: string): Promise<RunRecord | null>
    decide(input: { runId: string; requestId: string; decision: PermissionDecision }): Promise<void>
    /** Start a new run that resumes a finished run's session, so the orchestrator keeps its memory. */
    continue(input: ContinueRunInput): Promise<RunSummary>
    /** Answer a merge review: merge, discard or hold the report's branch. */
    decideMerge(input: { runId: string; reviewId: string; decision: MergeDecision }): Promise<void>
    /** A paused run: continue it now instead of waiting for the usage window to reset. */
    resumeNow(runId: string): Promise<RunSummary>
    /** A paused run: keep it paused; the user continues it by hand. */
    cancelAutoResume(runId: string): Promise<void>
    /**
     * Every live run (session open or opening: starting, running, idle, stopping) across all projects, every kind,
     * oldest first. For a second window's startup and a global runs list.
     */
    listLive(): Promise<RunSummary[]>
    /**
     * The decision cards a live run is waiting on right now, the same objects its `*.request` events carried.
     * A fresh renderer (a second window, a reload) seeds its cards from this; later changes arrive as events.
     * Empty arrays for an unknown or ended run.
     */
    pendingCards(runId: string): Promise<PendingCards>
  }
  window: {
    /**
     * Open (or focus, if one is already open) a window scoped to this run; it loads the renderer at
     * `#/run/<projectId>/<runId>`. Rejects when the project or run is unknown or the run belongs to another project.
     */
    openRun(target: FocusRunTarget): Promise<void>
  }
  permissions: {
    /** Allow rules saved in the project's .claude/settings.local.json, e.g. "Bash(npm:*)". */
    list(projectId: string): Promise<string[]>
    /** Remove one saved allow rule; returns the remaining rules. */
    remove(input: { projectId: string; rule: string }): Promise<string[]>
    /** Save one allow rule (validated); returns the full list. Live runs of the project honour it at once. */
    add(input: { projectId: string; rule: string }): Promise<string[]>
    /** Answer a request_permission_rules card. */
    decideRequest(input: { runId: string; requestId: string; decision: PermissionRuleDecision }): Promise<void>
  }
  onRunEvent(cb: (event: RunEvent) => void): () => void
  /** A clicked OS notification asks the renderer to show this run. */
  onFocusRun(cb: (target: FocusRunTarget) => void): () => void
  usage: {
    /** Read plan usage now, without a run. null when the provider cannot report it. */
    refresh(): Promise<UsageStatus | null>
  }
  notifications: {
    /**
     * @deprecated Phase 1 removes it with NotificationsToggle. Mirrors into AppSettings.notifications (saved,
     * then broadcast as settings:changed); use settings.set instead.
     */
    setEnabled(enabled: boolean): Promise<void>
  }
  auth: {
    status(): Promise<AuthStatusResult>
  }
  settings: {
    get(): Promise<AppSettingsInfo>
    /** Save. Main applies appearance.theme to nativeTheme, re-reads notifications and broadcasts settings:changed. */
    set(s: AppSettings): Promise<AppSettingsInfo>
  }
  /**
   * The saved settings changed (settings:set from any window, the deprecated notifications mirror). Returns an
   * unsubscribe function.
   */
  onSettingsChanged(cb: (settings: AppSettingsInfo) => void): () => void
  app: {
    /** Open a file or folder with the OS default handler. Resolves to an error message, or '' on success. */
    openPath(path: string): Promise<string>
    /** Open the main-process logs folder in the system file manager. */
    openLogs(): Promise<void>
    /** Absolute path of the current main-process log file. */
    logPath(): Promise<string>
    /** Version, platform, data and logs folders, and whether the token-free mock adapter is available. */
    info(): Promise<AppInfo>
  }
}

/** Read-only facts about the running app (`app:info`). Structured-clone safe. */
export interface AppInfo {
  /** app.getVersion() */
  version: string
  /** process.platform as a plain string ('win32', 'darwin', 'linux', ...). */
  platform: string
  /** app.getPath('userData'), or ORGAI_DATA_DIR when set. */
  dataDir: string
  /** The resolved folder main.log is written to. */
  logsDir: string
  /** True when the scripted mock adapter is registered (the app was started with ORGAI_MOCK=1). */
  mockAdapter: boolean
  /** app.isPackaged */
  packaged: boolean
}

export const IPC = {
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsCreate: 'projects:create',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsPickDir: 'projects:pickDirectory',
  projectsCheckPath: 'projects:checkPath',
  projectsScanAgents: 'projects:scanAgents',
  projectsPreviewImport: 'projects:previewImport',
  projectsApplyImport: 'projects:applyImport',
  projectsExportOrg: 'projects:exportOrg',
  draftOrgChart: 'draft:orgChart',
  runsStart: 'runs:start',
  runsSend: 'runs:send',
  runsInterrupt: 'runs:interrupt',
  runsStop: 'runs:stop',
  runsList: 'runs:list',
  runsGet: 'runs:get',
  runsDecide: 'runs:decide',
  runsContinue: 'runs:continue',
  runsResumeNow: 'runs:resumeNow',
  runsCancelAutoResume: 'runs:cancelAutoResume',
  runEvent: 'runs:event',
  setupStart: 'setup:start',
  setupRetro: 'setup:retro',
  setupDecide: 'setup:decide',
  setupAnswer: 'setup:answer',
  maintListWorktrees: 'maintenance:listWorktrees',
  maintIntegrate: 'maintenance:integrateWorktree',
  maintDiscard: 'maintenance:discardWorktree',
  maintUninstall: 'maintenance:uninstallRepo',
  maintDiff: 'maintenance:diff',
  mergesDecide: 'merges:decide',
  authStatus: 'auth:status',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** main -> renderer push channel carrying AppSettingsInfo after every save. */
  settingsChanged: 'settings:changed',
  appOpenPath: 'app:openPath',
  appFocusRun: 'app:focusRun',
  appSetNotifications: 'app:setNotifications',
  usageRefresh: 'usage:refresh',
  appOpenLogs: 'app:openLogs',
  appLogPath: 'app:logPath',
  appInfo: 'app:info',
  permissionsList: 'permissions:list',
  permissionsRemove: 'permissions:remove',
  permissionsAdd: 'permissions:add',
  permissionsDecideRequest: 'permissions:decideRequest',
  projectsRemapModels: 'projects:remapModels',
  projectsPreviewRemap: 'projects:previewRemap',
  connectionsList: 'connections:list',
  connectionsUpdate: 'connections:update',
  connectionsSetSecret: 'connections:setSecret',
  connectionsTest: 'connections:test',
  connectionsConnect: 'connections:connect',
  connectionsLogin: 'connections:login',
  connectionsCancelLogin: 'connections:cancelLogin',
  connectionsLogout: 'connections:logout',
  /** main -> renderer push channel carrying ConnectionEvent. */
  connectionsEvent: 'connections:event',
  modelsList: 'models:list',
  modelsRefresh: 'models:refresh',
  mcpList: 'mcp:list',
  mcpUpsert: 'mcp:upsert',
  mcpRemove: 'mcp:remove',
  mcpSetSecret: 'mcp:setSecret',
  mcpTest: 'mcp:test',
  mcpRegistrySearch: 'mcp:registrySearch',
  mcpAnswerInstall: 'mcp:answerInstall',
  mcpStartAssist: 'mcp:startAssist',
  mcpLinkLibrary: 'mcp:linkLibrary',
  mcpPromote: 'mcp:promote',
  mcpAuthorize: 'mcp:authorize',
  mcpCancelAuthorize: 'mcp:cancelAuthorize',
  mcpRevokeAuth: 'mcp:revokeAuth',
  mcpLibraryList: 'mcpLibrary:list',
  mcpLibraryUpsert: 'mcpLibrary:upsert',
  mcpLibraryRemove: 'mcpLibrary:remove',
  mcpLibrarySetSecret: 'mcpLibrary:setSecret',
  mcpLibraryTest: 'mcpLibrary:test',
  /** main -> renderer push channel carrying McpLibraryInfo[] after every library or authorization change. */
  mcpLibraryChanged: 'mcpLibrary:changed',
  pluginsUpsert: 'plugins:upsert',
  pluginsRemove: 'plugins:remove',
  runsListLive: 'runs:listLive',
  runsPendingCards: 'runs:pendingCards',
  windowOpenRun: 'window:openRun'
} as const
