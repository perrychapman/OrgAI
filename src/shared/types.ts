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

/** Where an MCP server entry came from. 'agent' = approved from an agent's request_mcp_install. */
export type McpServerSource = 'user' | 'registry' | 'agent'

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
}

/** Which secret slot a value fills: an entry of McpServerSpec.secretEnv or of .secretHeaders. */
export type McpSecretKind = 'env' | 'header'

/** mcp:list entry: the spec plus which secrets have a stored value. Secret values never cross IPC. */
export interface McpServerInfo {
  spec: McpServerSpec
  /** secretEnv names with a stored value. */
  envSet: string[]
  /** secretHeaders names with a stored value. */
  headersSet: string[]
  /** Secret names (env and headers) still missing a value; the server cannot start until they are set. */
  missingSecrets: string[]
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
 * for this run only; 'project' also saves it to Project.mcpServers.
 */
export interface McpInstallDecision {
  approved: boolean
  secrets?: Record<string, string>
  /** Shown to the agent, e.g. why it was denied or what was changed. */
  note?: string
  scope: 'run' | 'project'
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

/** mcp:startAssist input: start the MCP assistant session for a project. */
export interface McpAssistInput {
  projectId: string
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

// ---------- App settings (global) ----------

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
  notifications?: boolean
  /** Weekly-window utilization (percent) above which projects that prefer Sonnet steer Opus spawns to Sonnet. */
  opusGuardThreshold: number
  /** preferSonnetNearLimit for new projects. */
  defaultPreferSonnetNearLimit: boolean
  /** autoContinue for new projects. */
  defaultAutoContinue: boolean
  /** maxAutoContinues for new projects. */
  defaultMaxAutoContinues: number
}

/** What settings:get returns: the settings plus read-only facts about the install. */
export type AppSettingsInfo = AppSettings & { dataDir: string }

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
 * MCP assistant proposal (propose_mcp_servers): servers to add or replace, servers to remove, and the secret
 * slots the user must fill after approving. Applying it saves Project.mcpServers.
 */
export interface McpServersProposalPayload {
  /** Specs to add (new id) or replace (existing id). */
  upsert: McpServerSpec[]
  /** Ids of servers to remove. */
  remove?: string[]
  /** Secret slots to fill once approved; values are entered through mcp:setSecret, never in the proposal. */
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
  | { kind: 'system'; text: string }

export interface TranscriptEntry {
  id: string
  agentId: string
  at: number
  block: TranscriptBlock
}

/** 'paused': the session ended on a subscription usage limit; it can resume when the window resets. */
export type RunStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'finished' | 'error' | 'paused'

/**
 * 'work' runs the project's org chart; 'setup' runs the built-in Architect that designs it; 'mcp-assist' runs
 * a built-in MCP assistant (like setup, never the project's roles, never nudged) that proposes McpServerSpec
 * changes through the proposal mechanism (kind 'mcpServers').
 */
export type RunKind = 'work' | 'setup' | 'mcp-assist'

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
  | { type: 'agent.upsert'; runId: string; agent: AgentInstance }
  | { type: 'agent.remove'; runId: string; agentId: string }
  | { type: 'transcript'; runId: string; entry: TranscriptEntry }
  /** Text the agent is streaming right now; '' clears it once the completed message lands. Never persisted. */
  | { type: 'agent.partial'; runId: string; agentId: string; text: string }
  | { type: 'permission.request'; runId: string; request: PermissionRequest }
  | { type: 'permission.resolved'; runId: string; requestId: string }
  | { type: 'run.cost'; runId: string; totalCostUsd: number }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'proposal.request'; runId: string; proposal: Proposal }
  | { type: 'proposal.resolved'; runId: string; proposalId: string; decision: ProposalDecision }
  | { type: 'question.request'; runId: string; question: UserQuestion }
  | { type: 'question.resolved'; runId: string; questionId: string; answer: QuestionAnswer }
  | { type: 'merge.request'; runId: string; review: MergeReview }
  | { type: 'merge.resolved'; runId: string; reviewId: string; decision: MergeDecision }
  /** The main process changed the project (an approved proposal, setup completion). */
  | { type: 'project.updated'; runId: string; project: Project }
  /** Latest plan usage as seen by a live session. Account-wide, not specific to the run. */
  | { type: 'usage.status'; runId: string; usage: UsageStatus }
  /** The orchestrator's plan changed (plan tools, or the harness counting an automatic continue). */
  | { type: 'plan.updated'; runId: string; plan: RunPlan }
  /** One agent messaged another (SendMessage). Live only; the sender's transcript carries a persisted copy. */
  | ({ type: 'agent.message'; runId: string } & AgentMessage)
  /** An agent asked to install an MCP server (request_mcp_install); the run waits for mcp:answerInstall. */
  | { type: 'mcpInstall.request'; runId: string; request: McpInstallRequest }
  /** The install request was answered (or dropped when the run ended: approved false). Never carries secrets. */
  | { type: 'mcpInstall.resolved'; runId: string; requestId: string; outcome: McpInstallOutcome }

/** Payload of the main -> renderer `app:focusRun` message sent when a notification is clicked. */
export interface FocusRunTarget {
  projectId: string
  runId: string
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

export interface OrgAIApi {
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    /** Omit setupKind to skip AI setup and start with the default roles. */
    create(input: { name: string; path: string; brief: string; setupKind?: SetupKind }): Promise<Project>
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
    /** The project's MCP servers with their secret has-flags. */
    list(projectId: string): Promise<McpServerInfo[]>
    /** Add or replace one server. */
    upsert(input: McpUpsertInput): Promise<McpMutationResult>
    /** Remove one server and its stored secrets. */
    remove(input: { projectId: string; serverId: string }): Promise<McpMutationResult>
    /** Store or clear one secret value. Write-only. */
    setSecret(input: McpSecretInput): Promise<McpMutationResult>
    /** Start the server outside a run and list its tools. */
    test(input: { projectId: string; serverId: string }): Promise<McpTestResult>
    /** Search the official MCP Registry. */
    registrySearch(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult>
    /** Answer an agent's request_mcp_install card. */
    answerInstall(input: McpAnswerInstallInput): Promise<void>
    /** Start the MCP assistant session (RunKind 'mcp-assist'); its proposals are answered with setup.decide. */
    startAssist(input: McpAssistInput): Promise<RunSummary>
  }
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
  }
  permissions: {
    /** Allow rules saved in the project's .claude/settings.local.json, e.g. "Bash(npm:*)". */
    list(projectId: string): Promise<string[]>
    /** Remove one saved allow rule; returns the remaining rules. */
    remove(input: { projectId: string; rule: string }): Promise<string[]>
  }
  onRunEvent(cb: (event: RunEvent) => void): () => void
  /** A clicked OS notification asks the renderer to show this run. */
  onFocusRun(cb: (target: FocusRunTarget) => void): () => void
  usage: {
    /** Read plan usage now, without a run. null when the provider cannot report it. */
    refresh(): Promise<UsageStatus | null>
  }
  notifications: {
    /** Global on/off for OS attention notifications. The renderer persists the choice. */
    setEnabled(enabled: boolean): Promise<void>
  }
  auth: {
    status(): Promise<AuthStatusResult>
  }
  settings: {
    get(): Promise<AppSettingsInfo>
    set(s: AppSettings): Promise<AppSettingsInfo>
  }
  app: {
    /** Open a file or folder with the OS default handler. Resolves to an error message, or '' on success. */
    openPath(path: string): Promise<string>
    /** Open the main-process logs folder in the system file manager. */
    openLogs(): Promise<void>
    /** Absolute path of the current main-process log file. */
    logPath(): Promise<string>
  }
}

export const IPC = {
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsCreate: 'projects:create',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsPickDir: 'projects:pickDirectory',
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
  appOpenPath: 'app:openPath',
  appFocusRun: 'app:focusRun',
  appSetNotifications: 'app:setNotifications',
  usageRefresh: 'usage:refresh',
  appOpenLogs: 'app:openLogs',
  appLogPath: 'app:logPath',
  permissionsList: 'permissions:list',
  permissionsRemove: 'permissions:remove',
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
  pluginsUpsert: 'plugins:upsert',
  pluginsRemove: 'plugins:remove'
} as const
