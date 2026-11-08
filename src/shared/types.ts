/**
 * Shared domain types used by the main process, preload bridge and renderer.
 * Everything that crosses IPC is defined here.
 */
import type { AtlasSurfaceId } from './view/atlas'

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

/** The two built-in connections: 'anthropic' = Claude Code login or an Anthropic API key; 'openai' = ChatGPT (Codex) login or an OpenAI API key. */
export type BuiltinConnectionId = 'anthropic' | 'openai'

/**
 * Where model access comes from, independent of the adapter that drives it. A built-in id, or the id of one proxy
 * connection (ProxyConnection: any number of named proxies behind one base URL and key each). Proxy ids are
 * 'litellm' (the original single LiteLLM record, migrated, id kept so stored projects and run records stay valid) or
 * `proxy-<8 hex>` (main-generated, stable, `isProxyConnectionId`). The `string & {}` keeps autocomplete for the
 * built-ins; the type cannot tell you whether a proxy id still exists, so look it up in AppSettings.proxies (a run
 * record or usage row may name a proxy that was removed).
 */
export type ConnectionId = BuiltinConnectionId | (string & {})

/**
 * The built-in connection ids, in settings display order. NOT every connection: proxies are dynamic. Use
 * defaults.ts `connectionIds(settings)` for the full list (built-ins first, then proxies in AppSettings.proxies order).
 */
export const BUILTIN_CONNECTION_IDS: readonly BuiltinConnectionId[] = ['anthropic', 'openai']

/** True for 'anthropic' and 'openai'. Anything else is a proxy id (adapters use `!isBuiltinConnectionId(id)` for "is a proxy"). */
export function isBuiltinConnectionId(v: unknown): v is BuiltinConnectionId {
  return v === 'anthropic' || v === 'openai'
}

/** @deprecated Built-ins only since proxies became dynamic; kept so old imports compile. Use connectionIds(settings). */
export const CONNECTION_IDS: readonly BuiltinConnectionId[] = BUILTIN_CONNECTION_IDS

/** Proxy ids: the migrated 'litellm', or `proxy-` + 8 lowercase hex. Shape check only (does not say the proxy exists). */
export const PROXY_ID_RE = /^(litellm|proxy-[0-9a-f]{8})$/
export function isProxyConnectionId(v: unknown): v is string {
  return typeof v === 'string' && PROXY_ID_RE.test(v)
}
/** Most proxy connections one profile may hold. */
export const PROXIES_MAX = 20
/** Longest proxy display name, in characters. */
export const PROXY_NAME_MAX = 40

/**
 * The intent behind a role's model, so the model can be remapped when the project's connection changes.
 * top = most capable, deep = deep reasoning, everyday = fast and capable, fast = cheap and quick. Each connection
 * maps tiers to its own models (ConnectionBase.tierModels); defaults and settings are expressed as tiers, never as
 * one vendor's model names.
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
  /**
   * What a proxy probe / test / connect found out (proxies only; never persisted, no secrets). null = not
   * determined. reached: false on a network failure (DNS, refused, timeout); keyAccepted: false on 401 / 403, true
   * when the models list answered; modelCount: models in the answer; reportsPrices: any discovered model carries a
   * price (null until discovery has run: a status probe lists only); reportsSpend: kind 'litellm' and /key/info
   * answered (false otherwise, null when not checked). The mock proxy host fills sensible values (key
   * 'mock-bad-key' => reached true, keyAccepted false).
   */
  checks?: ConnectionChecks
}

/** ConnectionStatus.checks. */
export interface ConnectionChecks {
  reached: boolean
  keyAccepted: boolean | null
  modelCount: number | null
  reportsPrices: boolean | null
  reportsSpend: boolean | null
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
  /**
   * Tiers whose tierModels entry OrgAI chose (auto-fill from the catalog), not the user. Model discovery moves these
   * forward to the catalog's current suggestion for the tier (and remaps roles still on the old model); tiers not
   * listed are explicit user picks and are never changed while their model is still in the catalog. connections:update
   * removes a tier from this list when the user changes its entry. Missing (settings saved before it existed): the
   * main process derives it on the next discovery (an entry equal to the builtin default or the previous catalog's
   * suggestion counts as auto). Main-owned: the renderer echoes it back unchanged.
   */
  autoTiers?: ModelTier[]
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
 * What a proxy speaks beyond model listing. 'litellm' adds /model/info prices and /key/info + daily spend (and the
 * LiteLLM-only key hash filter); 'openai-compatible' (CLIProxyAPI-style gateways and similar) does only
 * GET <modelsUrl> (OpenAI `{ data: [{ id, object, owned_by, created? }] }`): no prices, no spend. Immutable after create.
 */
export type ProxyKind = 'litellm' | 'openai-compatible'
export const PROXY_KINDS: readonly ProxyKind[] = ['litellm', 'openai-compatible']

/**
 * One proxy connection (a gateway that serves Claude-family models on an Anthropic-style endpoint and other models on
 * an OpenAI-style one, behind one key). Persisted in AppSettings.proxies, never with secrets: the key lives in
 * SecretStore under the proxy id (connections:setSecret) and this record carries only `hasApiKey` (main-owned; the
 * renderer echoes it back and main ignores it). Claude-family root models run on the Claude adapter
 * (ANTHROPIC_BASE_URL = anthropicBaseUrl, ANTHROPIC_AUTH_TOKEN = the key), others on the Codex adapter (the `orgai`
 * provider at effective openaiBaseUrl). `id` and `kind` cannot change; `connections:update` ignores edits to them.
 * Every URL: https, or http only for loopback / private-network hosts; no credentials, query or fragment in the URL;
 * at most 2,048 chars; trailing slashes dropped (main refuses with a readable message otherwise).
 */
export interface ProxyConnection extends ConnectionBase {
  /** 'litellm' (migrated original) or `proxy-<8 hex>`. Main-generated at create, never reused after a remove. */
  id: string
  /** Display name: trimmed, 1..PROXY_NAME_MAX chars, no control or hidden characters, unique (case-insensitive). */
  name: string
  kind: ProxyKind
  /** The Anthropic / Claude Code base URL (ANTHROPIC_BASE_URL), e.g. "https://proxy.example.com". '' until set. */
  anthropicBaseUrl: string
  /** The OpenAI / Codex base URL. Unset or '' = `<anthropicBaseUrl>/v1` (defaults.ts `proxyOpenAIBase`). */
  openaiBaseUrl?: string
  /** The model list endpoint (GET, Bearer key). Unset or '' = `<effective openaiBaseUrl>/models` (defaults.ts `proxyModelsUrl`). */
  modelsUrl?: string
  /** A key is stored in SecretStore. Read-only for the renderer: the main process sets it. */
  hasApiKey: boolean
}

/** One app-wide connection record. Persisted in settings.json; never holds secrets. Narrow with `isProxyConnection`. */
export type ProviderConnection = AnthropicConnection | OpenAIConnection | ProxyConnection

/** The built-in connection records. Proxies are the separate AppSettings.proxies list. */
export interface ProviderConnections {
  anthropic: AnthropicConnection
  openai: OpenAIConnection
}

/** Type guard: a proxy record (it alone has `anthropicBaseUrl`). */
export function isProxyConnection(c: ProviderConnection | undefined | null): c is ProxyConnection {
  return !!c && typeof (c as ProxyConnection).anthropicBaseUrl === 'string'
}

/**
 * connections:createProxy input. `id` is generated by main. `apiKey` (optional) is stored exactly like
 * connections:setSecret (at most 4,000 chars, no control or hidden characters) and never echoed back. The new proxy
 * is `enabled: true` but not connected: call connections:connect (or test) next. Refused with a readable message at
 * PROXIES_MAX, on a duplicate name, or on an invalid name / URL.
 */
export interface ProxyCreateInput {
  name: string
  kind?: ProxyKind
  anthropicBaseUrl: string
  openaiBaseUrl?: string
  modelsUrl?: string
  apiKey?: string
}

/** connections:list entry: the persisted record plus its live status. */
export interface ConnectionInfo {
  connection: ProviderConnection
  status: ConnectionStatus
  /** Models currently in the catalog for this connection (builtin plus discovered). */
  modelCount: number
  /** When model discovery last succeeded for this connection (epoch ms). Missing = never (builtin list only). */
  modelsRefreshedAt?: number
  /**
   * The last background (scheduled) discovery failure, cleared by the next success. A scheduled failure keeps the
   * last good catalog and never changes `status`; a manual refresh or connect still reports errors in `status`.
   */
  modelsError?: string
  /**
   * This connection is the effective default connection (defaults.ts `effectiveDefaultConnection` over the stored
   * AppSettings.defaultConnection, defaultConnectionChosen and the live statuses). Exactly one entry of
   * connections:list has it. The renderer reads this instead of guessing from AppSettings.defaultConnection.
   */
  isDefault: boolean
  /**
   * Proxy entries only: the projects whose connection is this proxy (id and name, at most 50, in project order), so
   * the UI can show them before a removal (which is refused while any exist). Computed at list time, never stored.
   */
  usedBy?: { id: string; name: string }[]
}

/**
 * connections:setDefault input. A ConnectionId makes it the default and marks it chosen
 * (AppSettings.defaultConnectionChosen true); refused with a readable error naming the connection when it is not
 * usable (defaults.ts `connectionUsable`) unless it already is the stored default. null returns to automatic
 * (defaultConnectionChosen false; the stored value is rewritten to the effective one at once). Both clear
 * AppSettings.defaultConnectionReplaced. The only way the renderer changes the default (settings:set keeps it).
 */
export type ConnectionDefaultInput = ConnectionId | null

/** connections:setSecret. Only proxies have a stored secret; `id` must be an existing proxy id. null clears the stored key. */
export interface ConnectionSecretInput {
  id: string
  apiKey: string | null
}

/**
 * connections:removeProxy result. Removal is refused (the promise rejects with a readable message naming up to 5
 * projects) while any project's connection is this proxy: move them first (projects:remapModels with a connection).
 * Otherwise it deletes the record, its stored key, its models.json entries and its connection status; a chosen
 * default that was this proxy returns to automatic. Run records and usage rows that name the id are kept (history).
 * `connections` is the list after the removal (the same shape as connections:list).
 */
export interface ProxyRemoveResult {
  connections: ConnectionInfo[]
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
  /** The provider marks this model as its default or recommended choice (Codex model/list isDefault). */
  recommended?: boolean
  /** 'builtin' = shipped with OrgAI; 'discovered' = listed by the connection at runtime. */
  source: 'builtin' | 'discovered'
  /**
   * Token prices, when the connection reports them (LiteLLM /model/info `model_info.*_cost_per_token`). The
   * 'proxy' step of run pricing (pricing.ts), via RunConnection.pricing. Absent = no proxy price; the built-in table
   * (pricing.ts BUILTIN_PRICES) or an override may still price the model, else its cost is unknown (null).
   */
  price?: ModelPrice
  /** LiteLLM: the upstream model the proxy routes this name to (litellm_params.model, e.g. "anthropic/claude-sonnet-4-5"). */
  upstream?: string
  /**
   * Proxies: the `owned_by` the models endpoint reported (sanitized: printable, at most 64 chars, untrusted text).
   * Feeds `family` when the id alone is ambiguous (defaults.ts `proxyModelFamily`); a claude-* id stays Claude family
   * whatever owned_by says (a gateway may list claude-*-high under 'antigravity').
   */
  ownedBy?: string
  /**
   * Proxy models only: the base URL the model is served through. Family 'claude' -> the proxy's anthropicBaseUrl,
   * any other family -> defaults.ts `proxyOpenAIBase`. Set at discovery and re-derived from the proxy's current URLs
   * at catalog-read time (ConnectionService.catalogFor), so a URL change shows at once without a rediscovery.
   */
  baseUrl?: string
}

/**
 * USD per token of one model. Used for LiteLLM /model/info prices (UNVERIFIED against a live proxy), the built-in
 * table (pricing.ts) and user overrides (AppSettings.modelPrices). inputPerToken prices uncached input. A missing cache
 * price falls back to inputPerToken. 0 = free (local models).
 */
export interface ModelPrice {
  inputPerToken: number
  outputPerToken: number
  /** model_info.cache_read_input_token_cost. */
  cacheReadPerToken?: number
  /** model_info.cache_creation_input_token_cost. */
  cacheCreationPerToken?: number
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
 * Which adapter a project's run uses (adapterForProject). For 'litellm' the root role's model family decides, and
 * one run drives that one adapter; reports may run any model the proxy serves (each role's model id goes through).
 */
export interface AdapterChoice {
  adapter: ProviderId
  connection: ConnectionId
  /** Family of the root role's model, when it is known. */
  family?: ModelFamily
  /**
   * Ids of roles ON THE ROOT'S CONNECTION whose model family differs from the adapter's (roles on another connection
   * are never listed here). Informational on a proxy (those roles are also in `bridged`, since they need the other
   * adapter); a work run is refused only per mixedFamilyRefusal: on a proxy when the root has no family, and on the
   * single-family connections (anthropic, openai), where their catalogs make it unreachable.
   */
  mismatched: string[]
  /**
   * Bridged reports (multi-provider org charts): non-root roles whose (connection, adapter) differs from the root's
   * (adapter, connection): a role with its own Role.connection, or a role on the root's proxy whose model family needs
   * the other adapter. Each runs in a child session the harness starts (runtime/bridge.ts) with its own RunConnection.
   * adapterForProject always fills it (empty = every role is native); optional so older constructors stay valid
   * (missing = none). Mock projects: a role whose connection differs from the project's is bridged on 'mock'.
   */
  bridged?: BridgedRoleChoice[]
}

/** AdapterChoice.bridged entry: one role that runs in its own child session. */
export interface BridgedRoleChoice {
  roleId: string
  connection: ConnectionId
  adapter: ProviderId
}

/**
 * defaults.ts roleConnectionProblems entry: a non-root role whose connection cannot run it. 'unknown': the id names no
 * connection (a removed proxy); 'not-configured': connectionConfigured is false (turned off, no key or base URL);
 * 'disconnected': the live status (when the caller passes statuses) is definitely 'disconnected'. `message` is one
 * readable sentence naming the role and the connection, for the UI and the work-run refusal.
 */
export interface RoleConnectionProblem {
  roleId: string
  roleName: string
  connection: ConnectionId
  problem: 'unknown' | 'not-configured' | 'disconnected'
  message: string
}

/** Push events on the connections:event channel (main -> renderer). */
export type ConnectionEvent =
  | { type: 'connection.status'; connection: ConnectionId; status: ConnectionStatus }
  | { type: 'connection.login'; login: ConnectionLoginUpdate }
  /**
   * The set of connections or a proxy record changed (connections:createProxy / removeProxy / update of a proxy /
   * setSecret / a migration). Re-fetch connections:list. Other windows learn of a create or remove only from this.
   */
  | { type: 'connections.changed' }
  /**
   * A connection's catalog was (re)discovered: boot, the 24 h schedule, connect, login or models:refresh. Sent after
   * every successful discovery, even when the list is unchanged; `changed` says whether the model ids differ.
   * Carries that connection's full list and the discovery time (also on ConnectionInfo.modelsRefreshedAt).
   */
  | { type: 'models.updated'; connection: ConnectionId; models: ProviderModel[]; changed?: boolean; refreshedAt?: number }
  /** A connection change remapped role models. Only projects with at least one change are listed; reload them. */
  | { type: 'projects.remapped'; results: RemapResult[] }
  /**
   * An mcp:authorize with `announceUrl` is about to wait for its callback. Sent on the 'connections' host.subscribe
   * topic only when announceUrl was set (the CLI's `orgai mcp auth`). It carries no token or PKCE verifier. The socket
   * server delivers it only to the socket whose mcp:authorize for that target is in flight (socketServer.ts), never to
   * every 'connections' subscriber; the desktop window still gets it.
   */
  | { type: 'mcp.authorize'; authorize: McpAuthorizeUrlUpdate }

/** Model choices are provider-scoped aliases or full model IDs. */
export type ModelRef = string

/**
 * A model setting (AppSettings.defaultRootModel, defaultReportModel, setupModel, mcpAssistModel): a tier name
 * ('top' | 'deep' | 'everyday' | 'fast', resolved through the run's or project's connection tierModels; tier names
 * win over a catalog model of the same name) or a concrete model id from a connection's catalog. Legacy Claude aliases
 * (fable, opus, sonnet, haiku) still work and stand for their tier. Resolve with defaults.ts resolveModelSetting.
 */
export type ModelSetting = ModelTier | ModelRef

/**
 * @deprecated Claude-only aliases. Pickers list MODEL_TIER_OPTIONS plus the connection's catalog (models:list).
 * Kept for labels of legacy values.
 */
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
  /**
   * Skill grants: ids of the project's skills (SkillSpec.id) this role may load. Missing = none. projects:save drops
   * ids the project does not have. Enforced per agent by the harness (Claude: a PreToolUse gate on the Skill tool;
   * Codex and mock: list_skills / load_skill answer only with the caller's grants).
   */
  skills?: string[]
  /**
   * Multi-provider org charts (bridged reports): the connection this role's agents run on. Missing = the project's
   * connection. Read ONLY through defaults.ts `roleConnection(role, project)`, which ignores it on the root (the root
   * always runs on the project's connection, Project.provider.connection) and on mock projects' root. The role's
   * model / tier resolves against THIS connection's tierModels and catalog. A role whose (connection, adapter) differs
   * from the root's is a bridged report (AdapterChoice.bridged): it runs in its own child session started by the
   * harness (delegate_agent), never through the root's native spawn tool. Stored as saved when it passes
   * `isConnectionId` (a built-in id or a proxy id shape; a removed proxy's id is kept and reported by
   * roleConnectionProblems); anything else is dropped on read and save. Never filled or resolved by a store.
   */
  connection?: ConnectionId
}

/**
 * How tool calls are approved. 'auto': a provider-side classifier approves or denies each call and asks
 * (an approval card) only when it cannot decide. 'dontAsk': anything not pre-approved by a saved rule is denied.
 */
export type PermissionMode = 'auto' | 'acceptEdits' | 'default' | 'dontAsk' | 'plan' | 'bypassPermissions'

/**
 * Every permission mode, recommended first, with the label settings selects show. Labels are provider-neutral: they
 * never name a vendor or model, because every connection (Claude, Codex, LiteLLM) shares them.
 */
export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'auto', label: "Unattended: the model's safety check approves routine calls and asks when unsure" },
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

/** Most extra folders a project may list in `Project.allowedDirectories`. */
export const PROJECT_ALLOWED_DIRECTORIES_MAX = 20
/** Longest path accepted in `Project.allowedDirectories`. */
export const PROJECT_ALLOWED_DIRECTORY_MAX_CHARS = 1024
/** Most read-only folders a project may list in `Project.referenceDirectories` (same cap as allowed folders). */
export const PROJECT_REFERENCE_DIRECTORIES_MAX = PROJECT_ALLOWED_DIRECTORIES_MAX
/** Longest path accepted in `Project.referenceDirectories`. */
export const PROJECT_REFERENCE_DIRECTORY_MAX_CHARS = PROJECT_ALLOWED_DIRECTORY_MAX_CHARS
/** Longest `Project.client` kept. */
export const PROJECT_CLIENT_MAX_CHARS = 120
/** Most characters of the engagement document put into each agent's prompt (a truncation note follows). */
export const ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS = 16_000

/** Where a project's saved "always allow" rules live: the project folder's .claude/settings.local.json, or OrgAI's data folder. */
export type ProjectRulesLocation = 'folder' | 'app'

/**
 * What a project is for. 'code': a software repository (the original OrgAI project). 'engagement': client or
 * practice work in any field: a working folder for deliverables (often not git), read-only reference folders, and
 * the Architect specialises the neutral engagement chart from its interview. OrgAI writes nothing into an engagement's
 * working folder (it is often a share the client can see): the engagement document lives at
 * `<data>/projects/<id>/ENGAGEMENT.md` and reaches agents through their prompt, saved rules at
 * `<data>/projects/<id>/permission-rules.json`, no CLAUDE.md, no .orgai/, and writers never run in git worktrees
 * (no .git/info/exclude edit). Industry-neutral by design: no built-in
 * role, prompt or label names a field of work. Read it only through defaults.ts `projectKindOf` (missing = 'code').
 */
export type ProjectKind = 'code' | 'engagement'
export const PROJECT_KINDS: readonly ProjectKind[] = ['code', 'engagement']
export function isProjectKind(v: unknown): v is ProjectKind {
  return typeof v === 'string' && (PROJECT_KINDS as readonly string[]).includes(v)
}

export interface Project {
  id: string
  name: string
  /** Working directory the agents operate in. */
  path: string
  /**
   * What the project is for (see ProjectKind). Missing = 'code'; ProjectStore drops any other value on read and save.
   * Read it through defaults.ts `projectKindOf(project)`. Set by projects:create (`ProjectCreateInput.kind`).
   */
  kind?: ProjectKind
  /**
   * Absolute folders agents may READ like the project folder but never change (client material, source documents).
   * Passed to the provider as extra readable folders; every adapter refuses Edit / Write / MultiEdit / NotebookEdit
   * (and Codex file changes) under them with "<folder> is a reference folder: agents may read it, not change it".
   * Bash writes there are NOT gated (the permission mode still applies to Bash). At most
   * PROJECT_REFERENCE_DIRECTORIES_MAX, each at most PROJECT_REFERENCE_DIRECTORY_MAX_CHARS. Cleaned by ProjectStore on
   * save and on read with the allowedDirectories rules (relative, roots, UNC / device, OrgAI's data folder either
   * way, the project or inside it, a folder containing it, home or above, home config folders dropped silently;
   * duplicates collapse); a folder listed in both lists stays only in allowedDirectories. The folders need not exist.
   */
  referenceDirectories?: string[]
  /**
   * Whether this folder's own agent config may load (section "Folder config trust" near the end of this file). Written
   * only by main: projects:create sets it when the folder holds anything from REPO_CONFIG_PATHS, the trust channel
   * changes it, and a renderer save keeps the stored value. Absent = state 'none': today's behaviour (projects stored
   * before this field, and folders with no such config at creation).
   */
  folderConfigTrust?: FolderConfigTrust
  /**
   * Engagements: who the work is for, in the user's own words (plain text, no category list), so the renderer can
   * group engagements by client. At most PROJECT_CLIENT_MAX_CHARS; ProjectStore trims it on save and read, drops it
   * when empty, not a string or holding control, zero-width, bidi or other hidden characters. The engagement
   * Architect asks for it and propose_settings may set it.
   */
  client?: string
  /**
   * Extra folders, absolute paths, that agents may read and edit like the project folder (passed to the provider as
   * additional working directories; edits there follow the project's permission mode). At most
   * PROJECT_ALLOWED_DIRECTORIES_MAX. Normalized by the main process on save and on read (ProjectStore
   * `cleanAllowedDirectories`): relative paths, drive roots, UNC / device paths, OrgAI's data folder (or a folder
   * inside or containing it) and duplicates are dropped silently. The folders need not exist.
   */
  allowedDirectories?: string[]
  /** Free text describing the project and the kind of work done in it. Feeds the AI drafter. */
  brief: string
  provider: ProviderConfig
  permissionMode: PermissionMode
  /** Hard spend cap per run in USD. undefined = no cap. */
  maxBudgetUsd?: number
  /**
   * How many levels of reports may spawn their own reports. Missing = automatic: defaults.ts
   * `effectiveSubagentLimits` derives it from the org chart (longest reportsTo chain in edges plus 1, at least 1, at
   * most MAX_SUBAGENT_DEPTH_LIMIT). An explicit value is the user's override and is kept as saved. Every reader goes
   * through `effectiveSubagentLimits`; ProjectStore never fills it in.
   */
  maxSubagentDepth?: number
  /**
   * Most reports running at once. Missing = automatic: DEFAULT_MAX_CONCURRENT_SUBAGENTS through
   * `effectiveSubagentLimits`. An explicit value is the user's override.
   */
  maxConcurrentSubagents?: number
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
   * Subscription plans (Anthropic connection): spawn new deep- or top-tier reports on the connection's everyday tier
   * while the guarding weekly window (the deep model's own weekly window, else the seven-day window) is at or above
   * the app's opusGuardThreshold. Read it through defaults.ts `planGuardOf` ('on' | 'off' | 'auto'; the legacy field
   * is honoured): explicit true = on, explicit false = off, missing = 'auto', which engages only while the run's
   * connection reports a weekly plan window or a rate-limit status 'allowed_warning' (`planGuardEngaged`).
   */
  preferEverydayNearLimit?: boolean
  /** @deprecated Legacy name of preferEverydayNearLimit; read only when that is unset. */
  preferSonnetNearLimit?: boolean
  /**
   * Work runs: once the orchestrator has a plan, the harness reminds it of the remaining steps whenever a
   * turn ends with work left, until the plan is complete or blocked. Default true.
   */
  autoContinue?: boolean
  /** Upper bound on automatic continues per run. Default DEFAULT_MAX_AUTO_CONTINUES. */
  maxAutoContinues?: number
  /**
   * Cross-run messaging ("Let runs message each other" in Project settings). Missing = on for 'code' projects
   * (DEFAULT_RUN_MESSAGING) and off for engagements; an explicit value always wins. message_run is refused unless the sender's and the
   * target's projects both have it on; read it with runMessagingOn() from defaults.ts. Saved through projects:save.
   */
  runMessaging?: boolean
  /**
   * Engagements: add known knowledge-graph items to what an agent receives (RuntimeContext.knowledgeContext, no model
   * call). Unset = on; only an explicit false turns it off. Read it with knowledgeAutoContextOn() from
   * shared/knowledge.ts; never fill a default in a store or newProject. Saved through projects:save.
   */
  knowledgeAutoContext?: boolean
  roles: Role[]
  /**
   * MCP servers this project's agents may use (mcp__<name>__* tools). Missing = none. Secret values are
   * never stored here, only their names (secretEnv, secretHeaders). Change it through mcp:upsert / mcp:remove
   * (which return the saved project) so a stale renderer copy does not overwrite it.
   */
  mcpServers?: McpServerSpec[]
  /** Claude Code plugins loaded for this project's runs (Claude adapter only). Missing = none. */
  plugins?: PluginSpec[]
  /**
   * Skills this project's roles may be granted (Role.skills). Missing = none. Change it only through skills:* (which
   * return the saved project); projects:save keeps the stored list.
   */
  skills?: SkillSpec[]
  /** Proactive skill evaluation (skills:evaluate). Missing = DEFAULT_SKILL_EVALUATION (off). Saved through projects:save. */
  skillEvaluation?: SkillEvaluationSettings
  /**
   * Proactive Team setup review (capabilities:review). Missing = DEFAULT_TEAM_REVIEW (auto 'ai', bounded by tokenBudget
   * and everyRuns). Saved through projects:save, normalized by teamReviewOf.
   */
  teamReview?: TeamReviewSettings
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
 * 'local' = copied by the Team assistant (capabilities:apply) from another tool's config on this computer or the
 * repo's .mcp.json-style files: definition only, every env and header value left for the user to enter.
 */
export type McpServerSource = 'user' | 'registry' | 'agent' | 'library' | 'local'

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
export type McpAuthorizeInput = McpAuthTarget & {
  clientId?: string
  clientSecret?: string
  /**
   * CLI only (`orgai mcp auth`, cli-spec 6.3(5)): false = the host does not open a browser itself (an SSH session, where
   * the user opens the URL on their own computer). Default true.
   */
  openBrowser?: boolean
  /**
   * CLI only: true = before waiting for the callback the host sends the authorization URL as a connections:event
   * `mcp.authorize` (McpAuthorizeUrlUpdate) on the 'connections' host.subscribe topic.
   */
  announceUrl?: boolean
}

/** connections:event `mcp.authorize`: the OAuth authorization URL of an mcp:authorize that set announceUrl. */
export interface McpAuthorizeUrlUpdate {
  target: McpAuthTarget
  /** The authorization URL the user opens (it carries the PKCE challenge and state, never the verifier or a token). */
  url: string
  /** The loopback redirect the authorization server calls back (for the SSH port-forward hint). */
  redirectUri?: string
  /** True when the host opened a browser itself. */
  openedBrowser: boolean
  at: number
}

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
  /**
   * Library entries made from a connector preset (connectors:add) carry the ConnectorDef id, and a link copies it.
   * Written by the main process only: mcp:upsert, mcpLibrary:upsert, installs and proposals never set it, and an
   * edit that changes where the entry connects drops it.
   */
  connectorId?: string
  /** With connectorId: the ConnectorVariant id the entry was built from. */
  connectorVariant?: string
}

// ---------- Connectors (curated MCP presets, src/shared/connectors.ts) ----------

export type ConnectorCategory =
  | 'email'
  | 'calendar'
  | 'files'
  | 'chat'
  | 'docs'
  | 'project'
  | 'dev'
  | 'monitoring'
  | 'payments'
  | 'design'
  | 'crm'
  | 'data'
  | 'cloud'
  | 'knowledge'
  | 'automation'
  | 'commerce'
  | 'meetings'

/** Every ConnectorCategory, in gallery order (src/shared/connectors.ts tests that each def uses one). */
export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  'email',
  'calendar',
  'files',
  'chat',
  'docs',
  'project',
  'dev',
  'monitoring',
  'payments',
  'design',
  'crm',
  'data',
  'cloud',
  'knowledge',
  'automation',
  'commerce',
  'meetings'
]

/**
 * How much work connecting takes, derived from the variant's auth kind by connectorEase (src/shared/connectors.ts):
 * 'signIn' = OAuth with dynamic client registration (one click), 'none' = no sign-in at all, 'token' = paste a key,
 * 'ownApp' = create an OAuth app in the vendor's console first (oauthClient).
 */
export type ConnectorEase = 'signIn' | 'none' | 'token' | 'ownApp'

/**
 * OAuth details a preset supplies instead of (or as a fallback for) discovery. Every URL is https on a public
 * host (checked by the catalog test and again at authorize time).
 */
export interface ConnectorOAuthOverrides {
  /** Issuer recorded as McpOAuthConfig.authorizationServer. Default: the authorization endpoint's origin. */
  issuer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  /** 'replace' = skip discovery and use the endpoints; 'fallback' = use them only when discovery fails. */
  endpointsMode?: 'replace' | 'fallback'
  /**
   * Extra authorization-URL parameters, e.g. Google's access_type=offline and prompt=consent. Reserved
   * parameters (response_type, client_id, redirect_uri, state, code_challenge*, resource, scope) are ignored.
   */
  extraAuthParams?: Record<string, string>
  /** Default true. False = never send the RFC 8707 `resource` parameter (servers that do not know it). */
  sendResource?: boolean
  /** 'slackUser' = also read the token from `authed_user` when the response has no top-level access_token. */
  tokenResponse?: 'standard' | 'slackUser'
}

/** How a connector authenticates. */
export type ConnectorAuth =
  /**
   * No authentication: the server is public (e.g. DeepWiki, keyless Exa). The entry has no secret slots and no
   * OAuth config; it counts as connected once added, and mcp:authorize / connectors:setToken refuse it.
   */
  | { kind: 'none' }
  /** OAuth with dynamic client registration: the user only clicks Authorize. */
  | { kind: 'oauth'; scopes?: string[]; overrides?: ConnectorOAuthOverrides }
  /**
   * OAuth with the user's own app (no DCR): the user creates a client in the vendor's console, registers
   * CONNECTOR_REDIRECT_URI there, and passes client id (and secret) to mcp:authorize. The flow listens on that
   * fixed port and fails with a clear message when it is busy.
   */
  | {
      kind: 'oauthClient'
      scopes?: string[]
      overrides?: ConnectorOAuthOverrides
      /** Where the user creates the OAuth client. */
      consoleUrl: string
      clientSecret: 'required' | 'optional'
    }
  /** A pasted token sent as a secret header (connectors:setToken adds the prefix). */
  | {
      kind: 'token'
      /** The secret header name, e.g. "Authorization". */
      header: string
      /** Prepended to the pasted token, e.g. "Bearer ". */
      prefix?: string
      /** Field label, e.g. "Personal access token". */
      label: string
      /** One-line help: which scopes or permissions the token needs. */
      help: string
      /** Where to create the token. */
      link?: string
    }

/** One way to reach a connector's server, e.g. Linear's read-only endpoint versus the full one. */
export interface ConnectorVariant {
  /** Unique within the connector, e.g. 'readonly', 'full'. */
  id: string
  label: string
  description?: string
  /** Curated presets: 'http' | 'sse'. 'stdio' only on a custom preset's variant (command / args / env, url ''). */
  transport: McpTransport
  /** https only; '' for a custom preset's stdio variant. */
  url: string
  /** Non-secret headers sent with every request, e.g. GitHub's X-MCP-Readonly. */
  headers?: Record<string, string>
  /** The server exposes only read tools (or the requested scopes are read-only). */
  readOnly: boolean
  auth: ConnectorAuth
}

/**
 * A curated preset for an outside service's official remote MCP server. Pure data in src/shared/connectors.ts
 * (CONNECTORS); connectors:add turns one into an app-wide MCP library entry. Structured-clone safe.
 */
export interface ConnectorDef {
  /** Kebab-case id, also the preferred library entry name (so tools surface as mcp__<id>__<tool>). */
  id: string
  name: string
  /** Who runs the server, e.g. "Google". */
  vendor: string
  /** Curated presets point at the vendor's own server ('official'); 'user' = a custom preset (UserConnectorDef). */
  publisher: 'official' | 'user'
  category: ConnectorCategory
  /** One line for the gallery card. */
  description: string
  /** The vendor's own label for the server: preview (beta, developer preview) or generally available. */
  status: 'preview' | 'stable'
  docsUrl: string
  variants: ConnectorVariant[]
  /** A variants[].id. */
  defaultVariant: string
  /** Short setup steps in order (console work for oauthClient; the exact redirect URI is included). */
  setup: string[]
  /** Caveats: admin approval, write tools, unverified behaviour. */
  notes?: string[]
  /**
   * Extra search words for the gallery filter, lowercase and non-empty (e.g. Gmail: ['email', 'google mail']).
   * Name, vendor, description and category still match on their own.
   */
  aliases?: string[]
  /** False until someone authorized and listed tools against the live server. */
  verified: boolean
}

/** A gallery card's summary state. */
export type ConnectorState = 'available' | 'needsSetup' | 'connected' | 'error'

/** connectors:list entry: the preset plus its library entry once added. */
export interface ConnectorInfo {
  connector: ConnectorDef
  /** The library entry made from it (McpLibraryEntry.connectorId === connector.id), with auth, secrets and usedBy. */
  library?: McpLibraryInfo
  /** The variant id of the added entry. */
  variant?: string
  /**
   * 'available' = not added; 'needsSetup' = added but not authorized or its token is missing; 'connected' =
   * authorized or token stored (not a liveness check: run mcpLibrary:test); 'error' = the last authorization failed.
   * An auth kind 'none' connector is 'connected' as soon as it is added.
   */
  state: ConnectorState
  /** Epoch ms of the entry's last successful connect (McpLibraryEntry.connectedAt), for pinning recent ones. */
  connectedAt?: number
}

/** connectors:add input. The renderer names a preset; main builds the URL, headers and auth from the catalog. */
export interface ConnectorAddInput {
  connectorId: string
  /**
   * A ConnectorVariant id; missing or unknown = the connector's defaultVariant for a new entry. For an existing entry
   * that is not connected, a different valid id switches the entry to that variant; a connected entry keeps its own.
   */
  variant?: string
}

/** connectors:setToken input for 'token' connectors. Write-only; `null` clears it. */
export interface ConnectorTokenInput {
  connectorId: string
  /** The bare token as pasted; main trims it, adds the preset's prefix and stores it as the secret header. */
  token: string | null
}

/**
 * A harness-level (app-wide) MCP server definition in the library (<data>/mcp-library.json). Defined once;
 * credentials and OAuth authorization live with it, and projects link it (McpServerSpec.libraryId). The name
 * is unique within the library.
 */
export type McpLibraryEntry = Omit<McpServerSpec, 'enabled' | 'roles' | 'libraryId' | 'envOverrides' | 'headerOverrides'> & {
  /**
   * Connector entries only, written by the main process: epoch ms when its auth last succeeded (OAuth authorize,
   * connectors:setToken with a token, or connectors:add for an auth kind 'none' preset). Cleared by mcp:revokeAuth,
   * clearing the token, or an edit that stops it being a connector. Never copied into linked project specs; a
   * renderer-sent value is ignored. Older records simply lack it.
   */
  connectedAt?: number
  /**
   * Built servers only, written by the main process: when an MCP assistant build session (allowBuild) proposed this
   * stdio server with its command or args pointing into the session's scratch workspace, approval copies the workspace
   * to `<data>/mcp-builds/<entryId>/`, rewrites command/args to the copy and records the copy's content digest here
   * (sha256 hex over the sorted relative paths and file bytes). A renderer-sent value is ignored. Removing the entry
   * deletes the build dir.
   */
  buildDigest?: string
}

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

// ---------- Skills ----------

/** SKILL.md frontmatter `name`: at most this many characters of [a-z0-9-], never containing "anthropic" or "claude". */
export const SKILL_NAME_MAX = 64
/** SKILL.md frontmatter `description`: 1 to this many characters, no `<` or `>`. */
export const SKILL_DESCRIPTION_MAX = 1024
/** Longest SKILL.md body (the text after the frontmatter) a draft, an import or a suggestion may carry. */
export const SKILL_BODY_MAX_CHARS = 100_000
/** Most files one skill folder may hold (SKILL.md included). */
export const SKILL_MAX_FILES = 50
/** Largest single file in a skill folder, bytes. */
export const SKILL_MAX_FILE_BYTES = 256 * 1024
/** Largest whole skill folder, bytes. */
export const SKILL_MAX_TOTAL_BYTES = 1024 * 1024
/** Most skills one project (or the library) may hold. */
export const SKILL_MAX_PER_PROJECT = 100

/**
 * Where a project skill (or library entry) came from. 'user': written in OrgAI (skills:create) or added from a folder;
 * 'repo': imported from the project's repository (SkillSpec.repoPath); 'suggestion': created from a skill evaluation
 * suggestion (skills:applySuggestion); 'library': a link to a library entry (SkillSpec.libraryId). 'local': a
 * snapshot copy the Team assistant made from a skill folder on this computer (SkillSpec.sourceRef); 'github': a
 * snapshot of a SKILL.md from CAPABILITY_GITHUB_SKILLS_REPO (sourceRef is its URL).
 */
export type SkillSource = 'user' | 'repo' | 'suggestion' | 'library' | 'local' | 'github'

/** One file inside a skill folder. */
export interface SkillFileInfo {
  /** Relative to the skill folder, '/'-separated, e.g. "SKILL.md" or "scripts/fill.py". */
  path: string
  bytes: number
}

/**
 * One skill of a project: a folder holding SKILL.md (frontmatter `name` and `description`, then instructions) and
 * optional resource files. OrgAI keeps its own copy of the files under the data dir (a project skill under
 * `<data>/project-skills/<projectId>/<skillId>/`, a library entry under `<data>/skills/<entryId>/`); a repo import is
 * a snapshot, re-imported to pick up changes. Grants are per role (Role.skills). Structured-clone safe, no secrets.
 * Change it only through the skills:* channels (projects:save keeps the stored list).
 */
export interface SkillSpec {
  /** Stable id (newId('skill')), SAFE_ID. Role.skills and the skills:* channels refer to it. */
  id: string
  /** The SKILL.md frontmatter name (skillNameProblem() is null). Unique within the project. */
  name: string
  /** The SKILL.md frontmatter description (skillDescriptionProblem() is null): when to use the skill. */
  description: string
  /** Off = kept in the list but not passed to runs. */
  enabled: boolean
  source: SkillSource
  /** source 'repo': the folder it was imported from, project-relative and '/'-separated, e.g. ".claude/skills/pdf". */
  repoPath?: string
  /** source 'local' / 'github': where the snapshot came from, for display only (home as ~, or the URL). Untrusted. */
  sourceRef?: string
  /** sha256 (hex) over the stored files (paths and contents); changes whenever the content changes. */
  digest: string
  /** The stored files, SKILL.md first. */
  files: SkillFileInfo[]
  /** ISO timestamps. */
  addedAt: string
  updatedAt: string
  /**
   * Set when this project skill is a link to an app-wide library entry (SkillLibraryEntry.id). Like a linked MCP
   * server: the stored copy is a snapshot refreshed from the library on every read; the files are the entry's. A link
   * whose entry is gone is kept (SkillInfo.libraryMissing) but never passed to runs.
   */
  libraryId?: string
}

/** An app-wide skill in the library (`<data>/skill-library.json`, files under `<data>/skills/<id>/`). Name unique within the library. */
export type SkillLibraryEntry = Omit<SkillSpec, 'enabled' | 'libraryId'>

/** skills:list entry. */
export interface SkillInfo {
  spec: SkillSpec
  /** Ids of the roles whose Role.skills grant it. */
  grantedTo: string[]
  /** The linked library entry no longer exists: kept as a snapshot but excluded from runs. */
  libraryMissing?: true
}

/** skillLibrary:list entry: the entry and the projects that link it, with the roles that hold a grant there. */
export interface SkillLibraryInfo {
  entry: SkillLibraryEntry
  usedBy: { projectId: string; projectName: string; skillId: string; roleNames: string[] }[]
}

/** The text of a skill: what skills:read / skillLibrary:read return for viewing and editing. */
export interface SkillContent {
  /** The whole SKILL.md as stored (frontmatter included). */
  skillMd: string
  /** SKILL.md without its frontmatter. */
  body: string
  files: SkillFileInfo[]
}

/** A skill written in OrgAI: becomes `SKILL.md` = frontmatter (name, description) + body. */
export interface SkillDraft {
  name: string
  description: string
  /** Markdown instructions, at most SKILL_BODY_MAX_CHARS characters. */
  body: string
}

/** skills:create input. */
export interface SkillCreateInput {
  projectId: string
  draft: SkillDraft
  /** Roles to grant it to right away (Role ids). Default none. */
  roleIds?: string[]
}

/**
 * skills:update input. On a linked skill only `enabled` and `roleIds` may be given (edit the library entry for the
 * rest). `draft` rewrites SKILL.md and keeps the resource files. `roleIds` replaces the set of roles granted.
 */
export interface SkillUpdateInput {
  projectId: string
  skillId: string
  draft?: SkillDraft
  enabled?: boolean
  roleIds?: string[]
}

/** skills:linkLibrary input: add a library entry to a project by reference. */
export interface SkillLinkLibraryInput {
  projectId: string
  libraryId: string
  /** Roles to grant it to (Role ids). Default none. */
  roleIds?: string[]
}

/** Output of every project skill mutation. */
export interface SkillMutationResult {
  project: Project
  skills: SkillInfo[]
  /**
   * skills:remove (and skills:update with roleIds): the roles that lost their grant, so the UI can say so. The UI
   * asks before removing from SkillInfo.grantedTo.
   */
  rolesUpdated?: { roleId: string; roleName: string }[]
}

/** The repository folders the skill import reads, in this order. Each holds `<name>/SKILL.md` folders. */
export type SkillRepoRoot = '.claude/skills' | '.agents/skills' | '.github/skills' | '.opencode/skills'
export const SKILL_REPO_ROOTS: readonly SkillRepoRoot[] = ['.claude/skills', '.agents/skills', '.github/skills', '.opencode/skills']

/** What applying an import item does. 'add': a new project skill; 'update': replace the files of the project skill that has the same repoPath (or name); 'unchanged': same digest, nothing to do; 'skip': left out. */
export type SkillImportAction = 'add' | 'update' | 'unchanged' | 'skip'

/** One valid skill folder found in the repository. */
export interface SkillImportItem {
  /** Stable key for choices: `<root>/<folder>`, e.g. ".claude/skills/pdf". Equal to repoPath. */
  key: string
  root: SkillRepoRoot
  /** Project-relative folder, '/'-separated. */
  repoPath: string
  name: string
  description: string
  /** SKILL.md body (after the frontmatter), whole, at most SKILL_BODY_MAX_CHARS characters. Untrusted text: show it as plain text. */
  body: string
  files: SkillFileInfo[]
  totalBytes: number
  /** Files that look executable (scripts by extension or a shebang), flagged for the user. */
  scripts: string[]
  digest: string
  /** The default action (or the chosen one). */
  action: SkillImportAction
  /** action 'update' / 'unchanged': the project skill it matches. */
  existingSkillId?: string
  /** Another project skill (not this repoPath) already has this name; 'add' is refused for it. */
  nameConflict?: true
  /** The same name appears in an earlier root (".claude/skills" wins); this one defaults to 'skip'. */
  duplicateOf?: string
  notes: string[]
}

/** A skill folder that could not be imported, with the reason (bad frontmatter, too large, symlink, ...). */
export interface SkillImportInvalid {
  repoPath: string
  reason: string
}

/** One choice on an import item (keyed by SkillImportItem.key). */
export interface SkillImportChoice {
  key: string
  include: boolean
  /** Roles to grant the skill to on apply (Role ids). Default: an update keeps the existing grants, an add grants none. */
  roleIds?: string[]
}

/** skills:previewImport input. Always re-scans the stored project's folder. At most AGENT_IMPORT_MAX_CHOICES choices. */
export interface SkillImportInput {
  projectId: string
  choices?: SkillImportChoice[]
}

/** skills:previewImport output. Saves nothing. */
export interface SkillImportPreview {
  items: SkillImportItem[]
  invalid: SkillImportInvalid[]
  /** Scan warnings (caps hit, unreadable folders). */
  warnings: string[]
  /** Which roots exist in the repository. */
  roots: SkillRepoRoot[]
  /** sha256 of the scanned folders; skills:applyImport requires it and refuses when the folder changed since. */
  digest: string
}

/** skills:applyImport input. */
export interface SkillImportApplyInput extends SkillImportInput {
  digest: string
}

/** skills:applyImport output. */
export interface SkillImportApplyResult extends SkillMutationResult {
  /** Project skill ids added and updated. */
  added: string[]
  updated: string[]
  /**
   * Pass to skills:undoImport to restore the skills, files and grants as they were before this apply. Main keeps
   * one undo per project; it expires on the project's next skill mutation and when OrgAI quits.
   */
  undoId: string
}

/** skillLibrary:addFromFolder input: one skill folder (SKILL.md at its top) the user picked; treated as untrusted. */
export interface SkillLibraryFolderInput {
  /** Absolute path. */
  path: string
}

/**
 * Project.skillEvaluation: proactive skill evaluation. Missing = DEFAULT_SKILL_EVALUATION. Read it through defaults.ts
 * `skillEvaluationOf`, which always returns `enabled` filled in.
 */
export interface SkillEvaluationSettings {
  /**
   * Allows the model-assisted step of skills:evaluate (the deterministic checks always run). Missing = follow the Team
   * assistant: on exactly when `teamReviewOf(project).auto === 'ai'`, so one project setting drives both model steps.
   * An explicit true or false is an override and wins.
   */
  enabled?: boolean
  /** Most tokens (input + output) one skills:evaluate may spend on the model-assisted step. */
  tokenBudget: number
}

/**
 * What a skill evaluation finding is about. Quality: 'neverLoaded' (granted, no loads in the last runs),
 * 'neverGranted' (no role has it), 'overlap' (two descriptions too alike), 'vagueDescription' (short or generic),
 * 'stale' (SKILL.md names repo paths that no longer exist), 'libraryMissing' (a link whose entry is gone). Gaps:
 * 'repeatedToolSequence' (the same tool sequence across runs), 'repeatedCorrection' (the user repeated a correction).
 */
export type SkillFindingKind =
  | 'neverLoaded'
  | 'neverGranted'
  | 'overlap'
  | 'vagueDescription'
  | 'stale'
  | 'libraryMissing'
  | 'repeatedToolSequence'
  | 'repeatedCorrection'

export interface SkillFinding {
  /** Stable within one report. */
  id: string
  kind: SkillFindingKind
  severity: 'info' | 'warning'
  /** Project skill ids it concerns (empty for gap findings). */
  skillIds: string[]
  /** One line, plain text. */
  title: string
  detail: string
  evidence?: {
    runIds?: string[]
    /** 'stale': the missing paths. */
    paths?: string[]
    /** 'overlap': token-set similarity 0..1. */
    similarity?: number
    /** 'repeatedToolSequence': tool names in order. */
    sequence?: string[]
    /** How many times it was seen. */
    count?: number
  }
}

/** A drafted new skill. Never applied on its own: skills:applySuggestion creates it on the user's call. */
export interface SkillSuggestion {
  id: string
  draft: SkillDraft
  /** Why, one or two sentences. */
  rationale: string
  /** The gap findings it answers. */
  findingIds: string[]
  /** Set once applied: the project skill it created. */
  appliedSkillId?: string
}

/** skills:evaluate / skills:lastEvaluation: persisted per project (`<data>/skill-evaluations/<projectId>.json`). */
export interface SkillEvaluationReport {
  projectId: string
  /** Epoch ms. */
  at: number
  /** Work runs read (the newest SKILL_EVALUATION_RUNS runs of the project). */
  runsConsidered: number
  findings: SkillFinding[]
  suggestions: SkillSuggestion[]
  /** Whether the model-assisted step ran. */
  modelAssisted: boolean
  /** Why it did not run: 'disabled', 'no-gaps', 'budget' (the estimate exceeded the budget) or 'error' (see error). */
  skippedReason?: 'disabled' | 'no-gaps' | 'budget' | 'error'
  /** Readable failure of the model-assisted step (the deterministic findings are still there). */
  error?: string
  /** The project's budget at evaluation time. */
  tokenBudget: number
  /** Tokens the model-assisted step spent (0 when skipped). */
  tokensUsed: number
  /** True when tokensUsed is an estimate (the adapter reported no usage). */
  tokensEstimated?: true
  /** Cost of the model-assisted step, USD; null = unknown. */
  costUsd: number | null
  /** The model it used. */
  model?: string
}

/** skills:applySuggestion input. */
export interface SkillApplySuggestionInput {
  projectId: string
  suggestionId: string
  /** Roles to grant the new skill to (Role ids). Default none. */
  roleIds?: string[]
}

/** How often a skill was loaded in one run (RunUsage.skills). */
export interface SkillUseCount {
  skillId: string
  name: string
  loads: number
  /** Slugs of the roles whose agents loaded it. */
  roles: string[]
}

/** Harness tools that stand in for a native Skill tool (Codex, mock): list and load the caller's granted skills. */
export const SKILL_HARNESS_TOOLS = { list: 'list_skills', load: 'load_skill' } as const
export type SkillHarnessToolName = (typeof SKILL_HARNESS_TOOLS)[keyof typeof SKILL_HARNESS_TOOLS]

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
  /**
   * Set by RunManager on a Chat (quick) run: the server can only be added for this run. An approval with scope
   * 'project' or 'library' is narrowed to 'run' (nothing is saved to any project or the library), so the card should
   * offer only "For this chat only" and Deny.
   */
  runOnly?: true
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
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
  /** Refused as 'stale-revision' when it does not match the card's revision (cli-spec 5.3). */
  expectedRevision?: number
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
  /**
   * Default false. When true the assistant may also build a local stdio MCP server in its workspace: it gets Edit,
   * Write and Bash under permission mode 'default' (every command and edit asks the user), then proposes the server
   * through propose_mcp_servers like any other. Only the literal true turns it on.
   */
  allowBuild?: boolean
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

// ---------- Multi-provider org charts (bridged reports) ----------

/**
 * delegate_agent (audience 'spawners', blocking, work runs whose chart has bridged roles only): start a bridged
 * report (a role on another connection or adapter, AdapterChoice.bridged) in its own child session and return its
 * final text as fenced data. Codex hands bridged roles to the same child path from spawn_agent.
 */
export const BRIDGE_HARNESS_TOOLS = { delegate: 'delegate_agent' } as const
/** delegate_agent brief: at most this many characters (longer is refused, never cut). */
export const BRIDGE_BRIEF_MAX_CHARS = 32_000
/** A bridged report's final text handed back to its parent: cut to this many characters with a note. */
export const BRIDGE_RESULT_MAX_CHARS = 16_000

// ---------- App settings (global) ----------

/** 'system' follows the OS (Electron nativeTheme); the renderer resolves it with matchMedia('(prefers-color-scheme: dark)'). */
export type ThemeMode = 'dark' | 'light' | 'system'
export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
/** Canvas background. 'blueprint', 'paper', 'isometric', 'circuit', 'terminal' and 'starfield' are themed backdrops. */
export type CanvasPattern = 'dots' | 'grid' | 'none' | 'blueprint' | 'paper' | 'isometric' | 'circuit' | 'terminal' | 'starfield'
export const CANVAS_PATTERNS: readonly CanvasPattern[] = ['dots', 'grid', 'none', 'blueprint', 'paper', 'isometric', 'circuit', 'terminal', 'starfield']
/** How the org chart is arranged. 'top-down' and 'left-right' are dagre rank directions; 'radial' puts the root at the centre with each depth on a ring. */
export type CanvasLayout = 'top-down' | 'left-right' | 'radial'
export const CANVAS_LAYOUTS: readonly CanvasLayout[] = ['top-down', 'left-right', 'radial']
/**
 * How an agent is drawn. 'card' is the 240x112 card; 'compact' is a name-tag pill with the state ring, details on
 * select; 'station' is a subway-map circle on one coloured line per lead; 'hex' is a honeycomb tile.
 */
export type CanvasNodeStyle = 'card' | 'compact' | 'station' | 'hex'
export const CANVAS_NODE_STYLES: readonly CanvasNodeStyle[] = ['card', 'compact', 'station', 'hex']
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
    /** Chart arrangement. Main fills 'top-down' for settings saved before it existed. */
    layout: CanvasLayout
    /** Agent drawing. Main fills 'card' for settings saved before it existed. */
    nodeStyle: CanvasNodeStyle
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
  /**
   * Model for a new project's root role (ModelSetting: a tier name or a concrete model id). Default 'deep'. A tier
   * maps through the new project's connection tierModels. Settings saved with the old default 'opus' load as 'deep'.
   */
  defaultRootModel: ModelSetting
  /** Model for a new project's other roles (ModelSetting). Default 'everyday' (an old saved 'sonnet' loads as 'everyday'). */
  defaultReportModel: ModelSetting
  /**
   * Model for setup runs (the Architect: setup, revision, retrospective). A ModelSetting: a tier name maps to the
   * run's connection tierModels (a legacy Claude alias stands for its tier); a concrete model id must be usable on the
   * run's connection and run on the same adapter, otherwise the run falls back to the deep tier and logs a warning.
   * Default 'deep' (an old saved 'opus' loads as 'deep').
   */
  setupModel: ModelSetting
  /** Model for MCP assistant runs; resolved like setupModel. Default 'deep'. */
  mcpAssistModel: ModelSetting
  /** Model for Skill assistant runs; resolved like setupModel. Default 'deep' (normalized; an old 'opus' loads as 'deep'). */
  skillAssistModel?: ModelSetting
  /**
   * Model of the Chat's single assistant (quick runs with team 'single'); resolved like setupModel but falls back
   * to the everyday tier. Default 'everyday' (normalized).
   */
  quickRunModel?: ModelSetting
  /**
   * Legacy Anthropic auth, kept as a mirror of connections.anthropic.auth so older code keeps working.
   * settings:set keeps the two in sync (whichever one the caller changed wins).
   */
  providerAuth: ProviderAuth
  /** App-wide connection records (no secrets). Filled with defaults for settings saved before connections existed. */
  connections: ProviderConnections
  /**
   * Proxy connections, in display order (at most PROXIES_MAX). Main-owned like `connections`: settings:set keeps the
   * stored list; change it only through connections:createProxy / update / removeProxy / setSecret. A settings.json
   * saved before proxies existed holds `connections.litellm`; store/settings.ts loads it as the first proxy (id
   * 'litellm', name "LiteLLM", kind 'litellm', anthropicBaseUrl = its old baseUrl) and drops the old key on the next save.
   */
  proxies: ProxyConnection[]
  /**
   * Connection new projects, Chat and the MCP and Skill assistants use. Default 'anthropic'. Consumers read the
   * effective value (ConnectionService `effectiveDefault()`, defaults.ts `effectiveDefaultConnection`), never this
   * field alone. While defaultConnectionChosen is false, the main process rewrites it to the effective connection
   * (only after a definite 'disconnected' of the stored one, or when the replaced one connects again) and broadcasts
   * settings:changed. Main-owned: settings:set always keeps the stored value; change it with connections:setDefault.
   */
  defaultConnection: ConnectionId
  /**
   * The user picked defaultConnection explicitly (connections:setDefault with an id). false = automatic (written
   * explicitly by connections:setDefault(null) and every automatic rewrite). Main-owned, settings:set keeps the stored
   * value. Normalized by store/settings.ts: a file saved before the field existed loads as
   * `defaultConnection !== 'anthropic'` (a non-default value there was the user's pick).
   */
  defaultConnectionChosen?: boolean
  /**
   * The connection the first automatic rewrite replaced, while the default is automatic. When it reports 'connected'
   * again the default moves back to it and the field is cleared. Main-owned (settings:set keeps the stored value);
   * cleared by connections:setDefault.
   */
  defaultConnectionReplaced?: ConnectionId
  /**
   * OS attention notifications on or off. The single source of truth: the main process reads it every time it
   * decides to notify. Default true.
   */
  notifications?: boolean
  /** Theme, accent, canvas and motion. Filled with defaults for settings saved before it existed. */
  appearance: AppearanceSettings
  /**
   * Weekly-window utilization (percent) at or above which projects with preferEverydayNearLimit spawn deep- and
   * top-tier reports on the everyday tier. (The name predates tiers.)
   */
  opusGuardThreshold: number
  /**
   * @deprecated Was "preferEverydayNearLimit for new projects". New projects now leave preferEverydayNearLimit unset
   * (automatic, `planGuardOf`); kept and normalized for old settings files only.
   */
  defaultPreferEverydayNearLimit: boolean
  /**
   * @deprecated Mirror of defaultPreferEverydayNearLimit for older renderer code; settings:set keeps the two in step
   * (whichever one the caller changed wins).
   */
  defaultPreferSonnetNearLimit: boolean
  /**
   * Fetch the community price list (LiteLLM's model_prices_and_context_window.json on GitHub, MIT) at most once a
   * day and use it as the last price fallback, behind overrides, proxy prices and the built-in table. Missing = on.
   */
  communityPrices?: boolean
  /** autoContinue for new projects. */
  defaultAutoContinue: boolean
  /** maxAutoContinues for new projects. */
  defaultMaxAutoContinues: number
  /**
   * The user's per-model prices; they win over every other price (provider-reported included). Normalized on load and
   * save (store/settings.ts): invalid entries dropped, at most MODEL_PRICE_OVERRIDES_MAX entries, prices finite,
   * >= 0 and at most MODEL_PRICE_MAX_PER_TOKEN. Missing = none. Changes apply to agents priced after the save (live
   * runs re-price on their next usage update); persisted runs keep the cost they were saved with.
   */
  modelPrices?: ModelPriceOverride[]
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
  /**
   * The kind the profile was taken for. Missing = 'code' (and on profiles taken before engagements existed). An
   * engagement profile (setup/profile.ts) has no git log and no manifests; `languages` then counts file types,
   * keyFiles holds only .md / .txt notes (README, brief, notes), and the two fields below are set.
   */
  kind?: ProjectKind
  /** Engagement profiles: top-level folder names (at most 50). */
  topFolders?: string[]
  /**
   * Engagement profiles: project-relative paths of documents found (.docx .xlsx .pptx .pdf .md .txt .csv), at most
   * PROFILE_DOCUMENTS_MAX; `documentsTruncated` when more were found.
   */
  documents?: string[]
  documentsTruncated?: boolean
}

/** Most document paths an engagement ProjectProfile lists. */
export const PROFILE_DOCUMENTS_MAX = 200

/**
 * The approved charter. Code projects: the architecture (summary, stack, modules, conventions, commands, risks),
 * written to .orgai/ARCHITECTURE.md. Engagements reuse the fields with engagement meaning, written to
 * .orgai/ENGAGEMENT.md: summary = engagement summary; stack = platforms and systems involved; modules = workstreams
 * with their folders; conventions = working agreements and deliverable standards; commands = recurring procedures
 * (may be empty); risks.
 */
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
  /**
   * Repo-relative path of the architecture document written on approval (code projects). Unset for engagements: their
   * document is in OrgAI's data folder (`<data>/projects/<id>/ENGAGEMENT.md`) and is never written to the folder.
   */
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
  /**
   * Permission rules to save as project allow rules, e.g. "Bash(npm:*)". Saved where the project keeps its rules
   * (defaults.ts `projectRulesLocation`): .claude/settings.local.json for code projects, OrgAI's data folder for
   * engagements.
   */
  allowRules?: string[]
  /** Engagements: the client's name in the user's own words (Project.client rules; '' clears it). */
  client?: string
  rationale: string
}

/**
 * One server of an mcpServers proposal. Project scope: `libraryId` links that existing library entry (its other
 * fields are a display snapshot); otherwise a new server that is also saved to the library and linked, unless
 * `projectOnly`. Library scope: a library entry (enabled, roles, libraryId and projectOnly are ignored).
 */
/**
 * `configOnly` (main-written, work runs): a name-only item that only switches an existing project server on or off or
 * changes its roles. It lists the fields the item sets; at approval main applies just those onto the server as stored
 * then, and the rest of the spec (a snapshot for the card) is never written back.
 */
export type McpProposalServer = McpServerSpec & { projectOnly?: boolean; configOnly?: ('enabled' | 'roles')[] }

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

/** At most this many items in one propose_skills proposal. */
export const SKILL_PROPOSAL_MAX_ITEMS = 10

/**
 * One skill change in a skills proposal (propose_skills: the Skill assistant, and a work run's orchestrator for its
 * own project). 'create' writes a new skill; 'update' rewrites SKILL.md of an existing one (resource files kept).
 * scope 'library' targets the skill library (libraryId names the entry on update); scope 'project' targets the
 * session's project (libraryId unused; the skill is matched by draft.name on update). The draft follows the skill
 * limits (name [a-z0-9-] at most 64, never "anthropic" or "claude"; description 1..1024 without < or >; body at most
 * SKILL_BODY_MAX_CHARS; no shell injection).
 *
 * Configuration actions, scope 'project' only, never write a SKILL.md: draft.body is '' and the harness fills
 * draft.name / draft.description with the target skill's (a library entry's for 'link'), so a card can name it.
 * - 'link': link the library entry `libraryId` into the project; `roles` are the slugs that load it.
 * - 'grant': change which roles load the project skill named draft.name and/or whether it is enabled. `roles` is
 *   the complete slug list after the change ([] = no role); omitted keeps the grants. `enabled` omitted keeps the
 *   state. At least one of the two is set.
 * - 'remove': remove the project skill named draft.name (a link is unlinked; the library entry stays) and its grants.
 */
export interface SkillProposalItem {
  action: 'create' | 'update' | 'link' | 'grant' | 'remove'
  /** Library entry id: 'update' with scope 'library', and 'link'. */
  libraryId?: string
  draft: SkillDraft
  /**
   * Role slugs to grant the skill to after the change. Project scope only; ignored for the library. On 'grant' it is
   * the complete list after the change.
   */
  roles?: string[]
  /** 'grant' only: enable (true) or disable (false) the project skill; omitted keeps the state. */
  enabled?: boolean
  scope: 'library' | 'project'
}

/** Actions of SkillProposalItem that change configuration only (no SKILL.md is written; draft.body is ''). */
export const SKILL_CONFIG_ACTIONS = ['link', 'grant', 'remove'] as const

/** Skill proposal (propose_skills, from the Skill assistant): at most SKILL_PROPOSAL_MAX_ITEMS items. */
export interface SkillsProposalPayload {
  items: SkillProposalItem[]
  rationale: string
}

export type ProposalKind = 'architecture' | 'orgChart' | 'settings' | 'mcpServers' | 'skills' | 'appSettings'

interface ProposalBase {
  id: string
  runId: string
  agentId: string
  title: string
  createdAt: number
  /**
   * When an approved proposal takes effect, set by the harness (runManager.ts proposalEffect) so the card can say so:
   * 'now' (the live run sees it from the next tool call), 'after-turn' (once the current turn ends and the session is
   * re-attached), 'next-run' (this run keeps its configuration). Work-run 'mcpServers' / 'skills' proposals:
   * 'after-turn' on Claude and Codex, 'now' on the mock; everything else 'next-run'. Missing on older events.
   */
  effect?: ProposalEffect
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
  /**
   * The stored project a Chat proposal changes (section "Self-knowledge and self-configuration"): set on a 'settings'
   * proposal from propose_project_settings, whose run (a quick run) has no project of its own. Main fills it from the
   * stored project (never from agent text); the card names `projectName`. Absent = the run's own project.
   */
  target?: ProposalTarget
}

/** When an approved proposal takes effect (Proposal.effect). */
export type ProposalEffect = 'now' | 'after-turn' | 'next-run'

export type Proposal =
  | (ProposalBase & { kind: 'architecture'; payload: ArchitectureSpec })
  | (ProposalBase & { kind: 'orgChart'; payload: OrgChartProposalPayload })
  | (ProposalBase & { kind: 'settings'; payload: SettingsProposalPayload })
  | (ProposalBase & { kind: 'mcpServers'; payload: McpServersProposalPayload })
  | (ProposalBase & { kind: 'skills'; payload: SkillsProposalPayload })
  | (ProposalBase & { kind: 'appSettings'; payload: AppSettingsProposalPayload })

/**
 * The user's answer to a proposal card (setup:decide). 'approve' applies it; 'revise' sends feedback and the agent may
 * propose again; 'decline' applies nothing and tells the agent not to propose the same change again in this run.
 * `secrets` (kind 'mcpServers' approvals only, like McpInstallDecision.secrets): values for the payload's secret
 * slots, keyed by proposalSecretKey(slot) = '<serverId>:<env|header>:<name>'; a key that names no slot of the payload
 * is ignored. Stored in SecretStore on apply under the server's owner (the project server, or its library entry when
 * linked; the library entry in a library session) and never put in any event or tool result.
 */
export type ProposalDecision =
  | { behavior: 'approve'; secrets?: Record<string, string> }
  | { behavior: 'revise'; feedback: string }
  | { behavior: 'decline'; note?: string }

/**
 * The secret-free outcome of a proposal, carried by the proposal.resolved event and returned to the harness tool.
 * `waitingForSecrets` (approved 'mcpServers' only): names of servers that still have an empty secret slot and do
 * not start until the user sets it in Settings.
 */
export type ProposalOutcome =
  | { behavior: 'approve'; waitingForSecrets?: string[] }
  | { behavior: 'revise'; feedback: string }
  | { behavior: 'decline'; note?: string }

/** At most this many characters in a proposal decision's feedback or note (longer text is cut in main). */
export const PROPOSAL_NOTE_MAX_CHARS = 4000

/** The key of one secret slot of an MCP proposal in ProposalDecision.secrets. */
export function proposalSecretKey(slot: { serverId: string; kind: McpSecretKind; name: string }): string {
  return `${slot.serverId}:${slot.kind}:${slot.name}`
}

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
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
}

/** The user's answer: chosen option labels plus optional free text. Empty when the run ended unanswered. */
export interface QuestionAnswer {
  selected: string[]
  text?: string
}

// ---------- Usage metrics and pricing ----------

/**
 * Token counts split the way providers price them. `input` is UNCACHED input only: cache reads and cache writes are
 * separate (Claude reports them separately; Codex/OpenAI `inputTokens` include cached tokens, so the adapter
 * subtracts `cachedInputTokens`). OpenAI reports no cache writes (always 0). Reasoning tokens count as output.
 * Total prompt tokens = input + cacheRead + cacheWrite. Cache hit rate: cacheHitRate() in defaults.ts.
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Where a model's cost came from. Resolution order per model (pricing.ts): 'override' (AppSettings.modelPrices) >
 * 'provider' (the provider reported a cost > 0, e.g. the Claude SDK's costUSD) > 'proxy' (the LiteLLM proxy's
 * /model/info price) > 'builtin' (OrgAI's price table) > 'community' (the cached community price list,
 * AppSettings.communityPrices) > 'unknown' (tokens but no price: cost is null, never $0).
 */
export type PriceSource = 'override' | 'provider' | 'proxy' | 'builtin' | 'community' | 'unknown'

/**
 * How trustworthy an aggregated cost is. 'provider': every priced token was priced by the provider. 'computed': at
 * least one model was priced by OrgAI (override, proxy or built-in table). 'unknown': tokens were spent but no model
 * had a price (costUsd null; show "unknown", not $0). 'none': nothing spent yet (costUsd 0).
 * When some models are priced and some are not, the source is the priced ones' and `costPartial` is true: the cost
 * is a lower bound.
 */
export type CostSource = 'provider' | 'computed' | 'unknown' | 'none'

/** A user's price for one model (AppSettings.modelPrices). */
export interface ModelPriceOverride {
  /**
   * The model id as runs report it (e.g. 'claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5', 'gpt-5'). Matched
   * case-insensitively; a trailing date stamp (-20250929) or [1m] suffix is ignored on both sides. At most
   * MODEL_PRICE_ID_MAX_CHARS characters.
   */
  model: string
  /** Only for runs on this connection. Missing = every connection. A connection-scoped entry wins. */
  connection?: ConnectionId
  price: ModelPrice
}

/** One model's effective price, as listed by models:prices for a settings table. */
export interface ModelPriceInfo {
  model: string
  /** Set for proxy prices and connection-scoped overrides. */
  connection?: ConnectionId
  price: ModelPrice
  /** 'override' | 'proxy' | 'builtin' (never 'provider' or 'unknown'; community prices are resolved per model, never listed). */
  source: Exclude<PriceSource, 'provider' | 'unknown' | 'community'>
}

/** models:prices input. Omit `connection` for every connection. */
export interface ModelPricesQuery {
  connection?: ConnectionId
}

/** One model's share of an agent's (or run's, or role's) usage. */
export interface ModelUsageEntry {
  /**
   * The model id actually used, as the provider reported it (Claude: assistant message.model, which already is the
   * tier-remapped id on LiteLLM; Codex: the thread's model). An alias ('opus') only when nothing better was reported;
   * pricing then resolves it through the run connection's ANTHROPIC_DEFAULT_*_MODEL / tierModels.
   */
  model: string
  tokens: TokenUsage
  /**
   * Adapter-reported cost for these tokens, when the provider gives one (> 0). Written by adapters; RunManager
   * reads it during pricing. Absent on Codex and on LiteLLM Claude runs (the CLI reports 0 there).
   */
  providerCostUsd?: number
  /** Filled by RunManager (pricing.ts): null when no price is known. */
  costUsd: number | null
  /** Filled by RunManager (pricing.ts). */
  priceSource: PriceSource
}

/**
 * Usage of one agent. Adapters write `models[].model`, `models[].tokens`, `models[].providerCostUsd`, `turns`,
 * `toolCalls` and `retries` (putting `costUsd: null, priceSource: 'unknown'` on new model entries); RunManager prices
 * it on every agent.upsert and fills `tokens`, `costUsd`, `costSource`, `costPartial` and the model entries' cost
 * fields, and mirrors `costUsd ?? 0` into AgentInstance.costUsd. Persisted with the agent in the run record.
 */
export interface AgentUsage {
  /** Sum over `models`. */
  tokens: TokenUsage
  models: ModelUsageEntry[]
  /** null = unknown (tokens spent, no price). */
  costUsd: number | null
  costSource: CostSource
  /** Some models had no price: costUsd is a lower bound. */
  costPartial?: true
  /**
   * Model responses. Claude: distinct assistant message ids (one per API request). Codex: completed turns of the
   * agent's thread (app-server reports no per-request count). Granularity therefore differs by adapter.
   */
  turns: number
  /** Tool calls the agent made (tool_use blocks / Codex tool items), harness tools included. */
  toolCalls: number
  /** API retries the provider reported (Claude system api_retry; Codex error with willRetry). */
  retries: number
  /**
   * A report (never the root) ended (state done or error) without result text: its tokens count as RunUsage.noResultTokens. Filled by
   * RunManager on every agent.upsert (absent = false); agentProducedNothing() in defaults.ts derives the same from an
   * AgentInstance. Drives the UI's "no result" dim.
   */
  producedNothing?: true
  /**
   * Normalized from a record saved before usage tracking: tokens.input holds the old inputTokens (cache included,
   * cacheRead/cacheWrite 0), turns/toolCalls/retries are 0 and cost is the stored costUsd (> 0: 'provider') or
   * unknown. Show such numbers as approximate.
   */
  legacy?: true
}

/** Usage of one role within a run, or across runs (UsageStats.roles). */
export interface RoleUsage {
  /** null for agents without a role (built-in roles, unknown subagent types). */
  roleId: string | null
  roleSlug: string
  /** The role's display name as the agents carried it (AgentInstance.name of the first agent, without a -n suffix). */
  roleName: string
  /** Agent instances of this role. */
  agents: number
  tokens: TokenUsage
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
  turns: number
  toolCalls: number
  retries: number
  /** Sum of the agents' wall time (endedAt or now, minus startedAt), ms. Agents overlap, so this can exceed the run's. */
  agentWallMs: number
  /** Agents that ended (state done or error) with no result text. */
  agentsWithoutResult: number
  /** Tokens (all four kinds) those agents spent. */
  noResultTokens: number
  /** Distinct models used. */
  models: string[]
}

/**
 * Usage of one run, computed by RunManager (runUsage.ts) from its agents and its own timers. Lives on
 * RunSummary.usage (index and record), so it survives restarts and trend queries read only the index.
 */
export interface RunUsage {
  tokens: TokenUsage
  /**
   * Best known cost of the run. 'provider': the provider's run total when it reported one (Claude total_cost_usd,
   * resume base subtracted), else the agents' sum. Otherwise the sum of the agents' costs. null = unknown.
   */
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
  /**
   * The adapter's last run.cost total (the provider's own figure for this run, resume base subtracted), when it sent
   * one. RunManager passes it as resumeBaseCostUsd when the session is continued. Informational for the UI.
   */
  providerCostUsd?: number
  /** Per model across all agents. */
  models: ModelUsageEntry[]
  /** Per role. */
  roles: RoleUsage[]
  /** endedAt (or now while live) minus startedAt, ms. */
  wallMs: number
  turns: number
  toolCalls: number
  retries: number
  /** Agent instances in the run, root included. */
  agents: number
  agentsWithoutResult: number
  noResultTokens: number
  /**
   * Cost of the agents counted in agentsWithoutResult (mergeCosts over them): null = unknown, never 0 for spent tokens;
   * noResultCostPartial = a lower bound. Absent when no agent ended without a result, and on runs saved before
   * 2026-11-07 (computeRunUsage fills it on the next update of a live run only).
   */
  noResultCostUsd?: number | null
  noResultCostPartial?: true
  /** Those agents, in agent order, at most RUN_NO_RESULT_AGENTS_MAX (20). Absent when none, and on older runs. */
  noResultAgents?: NoResultAgent[]
  /** Automatic continues the harness sent (RunPlan.autoContinues of this run; 0 without a plan). */
  nudges: number
  /** Time with at least one decision card open (permission, question, proposal, rules, merge, MCP install), ms. */
  waitingMs: number
  /** Time held on a usage limit (from the provider's limit report until the user's next send or the run's end), ms. */
  limitHoldMs: number
  /** Time the run spent in status 'idle' (the orchestrator's turn ended, waiting for the user), ms. */
  idleMs: number
  /** See AgentUsage.legacy: computed from a record saved before usage tracking. */
  legacy?: true
  /** Skills loaded in the run (skill.used events), most loaded first. Missing = none (or a run before skills existed). */
  skills?: SkillUseCount[]
  /** Knowledge graph reads served to agents (knowledge_recall and auto context). Missing = none (or an older run). */
  knowledge?: KnowledgeServedUsage
  /**
   * Multi-provider runs only (at least one agent with AgentInstance.connection other than the run's): cost and agent
   * count per connection, each agent priced with its own connection's pricing. costUsd null = unknown (never $0).
   * Missing = every agent ran on the run's connection. `costPartial` (absent = false): some of that connection's agents
   * had no price, so costUsd is a lower bound (records saved before it existed never carry it).
   */
  connections?: Partial<Record<ConnectionId, { costUsd: number | null; agents: number; costPartial?: true }>>
  updatedAt: number
}

/** RunUsage.noResultAgents cap per run. */
export const RUN_NO_RESULT_AGENTS_MAX = 20

/** A report that ended (done or error) without result text (RunUsage.noResultAgents). */
export interface NoResultAgent {
  agentId: string
  /** The agent's label as the canvas shows it: its handle, else its name (agentTree.ts agentLabel). */
  name: string
  /** The role's display name (the agent's name without a -n suffix). */
  roleName: string
  tokens: TokenUsage
  /** The agent's cost: null = unknown. */
  costUsd: number | null
}

/** RunUsage.knowledge: counted by RunManager, never by an adapter. */
export interface KnowledgeServedUsage {
  /** knowledge_recall calls answered. */
  recalls: number
  /** knowledgeContext blocks added to what an agent received (nulls are not counted). */
  autoContexts: number
  /** Entities served in full across both paths ("already shown" lines are not counted). */
  itemsServed: number
  /** Characters of tool results and context blocks served. */
  charsServed: number
}

/** runs:usageStats input. */
export interface UsageStatsQuery {
  projectId: string
  /** Only runs started at or after this time (epoch ms). */
  since?: number
  /** Only runs started before this time (epoch ms). */
  until?: number
  /** A local calendar month (UsageStatsRange); replaces since / until when set. */
  range?: UsageStatsRange
  /** Run kinds to include. Default ['work']; pass every RunKind to count setup and assistant runs too. */
  kinds?: RunKind[]
  /** Trend bucket size, by local calendar day or ISO week (Monday start). Default 'day'. */
  bucket?: 'day' | 'week'
  /**
   * Most rows in UsageStats.runs (the newest runs win). Default USAGE_STATS_DEFAULT_LIMIT (500), clamped to
   * 1..USAGE_STATS_MAX_LIMIT (2000). Roles, trend and totals cover only the returned rows.
   */
  limit?: number
}

export const USAGE_STATS_DEFAULT_LIMIT = 500
export const USAGE_STATS_MAX_LIMIT = 2000

/** One run in UsageStats.runs. */
export interface RunUsageRow {
  runId: string
  kind: RunKind
  /**
   * 'single' when RunSummary.team is 'single' (an Ask run); absent otherwise. The CSV `kind` column is then 'ask'
   * instead of 'work'; its values are the RunKind values plus 'ask'.
   */
  team?: 'single'
  status: RunStatus
  /** RunSummary.title when set. */
  title?: string
  /** The prompt on one line, at most 120 characters. */
  prompt: string
  startedAt: number
  endedAt?: number
  resumedFrom?: string
  usage: RunUsage
}

/** One trend bucket in UsageStats.trend. */
export interface UsageTrendPoint {
  /** Local date of the bucket start, YYYY-MM-DD (a Monday for 'week'). */
  bucket: string
  /** Epoch ms of the bucket start (local midnight). */
  start: number
  runs: number
  tokens: TokenUsage
  /** Sum of the known run costs in the bucket; null when no run in it had a known cost. */
  costUsd: number | null
  /** Runs in the bucket whose cost is unknown or partial. */
  costUnknownRuns: number
  turns: number
  toolCalls: number
  nudges: number
  retries: number
  wallMs: number
  waitingMs: number
  noResultTokens: number
}

/**
 * runs:usageStats result: per-run rows (newest first), per-role rows across those runs, trend buckets (oldest
 * first, only buckets with runs) and totals. Built from persisted summaries; summaries saved before usage tracking
 * are normalized from their records once (RunUsage.legacy) and written back to the index.
 */
export interface UsageStats {
  projectId: string
  runs: RunUsageRow[]
  /** RoleUsage summed across runs, keyed by roleId (else roleSlug); `agents` counts instances across runs. */
  roles: (RoleUsage & { runs: number })[]
  trend: UsageTrendPoint[]
  /** Everything in `runs` summed (roles/models merged; wallMs summed). */
  totals: RunUsage
  generatedAt: number
  /** More runs matched than `limit`; the oldest were left out. */
  truncated?: true
}

// ---------- App-wide usage overview (runs:usageOverview, runs:usageOverviewCsv) ----------

/**
 * runs:usageOverview input: usage across every project (stored projects, the three virtual assistant projects and
 * runs left behind by a removed project). Every field is optional; main rebuilds the input (sanitizeUsageOverviewQuery
 * in runUsage.ts) and refuses a malformed month or project id list.
 */
export interface UsageOverviewQuery {
  /** Only runs started at or after this time (epoch ms). */
  since?: number
  /** Only runs started before this time (epoch ms). */
  until?: number
  /** A local calendar month; replaces since / until when set (UsageStatsRange). A malformed month is refused. */
  range?: UsageStatsRange
  /** Run kinds to include. Default (absent or empty): every RunKind, so assistant runs count. Unknown kinds are dropped. */
  kinds?: RunKind[]
  /**
   * Trend bucket size: local calendar day, ISO week (Monday start) or local calendar month. Default 'day'. A 'month'
   * bucket's label is the 1st of the month (YYYY-MM-01).
   */
  bucket?: 'day' | 'week' | 'month'
  /**
   * Only these projects (ids, virtual ids such as QUICK_PROJECT_ID included; a removed project's id still matches its
   * leftover runs). Absent or empty = every project. At most USAGE_OVERVIEW_MAX_PROJECT_IDS; each must match
   * [A-Za-z0-9_-]{1,128}, else the query is refused. Duplicates are dropped.
   */
  projectIds?: string[]
  /**
   * Most rows in UsageOverview.runs (the newest runs win). Default USAGE_STATS_DEFAULT_LIMIT (500), clamped to
   * 1..USAGE_STATS_MAX_LIMIT (2000). Unlike UsageStats, the rollups (projects, models, roles, connections, trend,
   * totals) always cover EVERY matched run, not only the returned rows.
   */
  limit?: number
}

/** UsageOverviewQuery.projectIds cap. */
export const USAGE_OVERVIEW_MAX_PROJECT_IDS = 200

/**
 * What a usage row's project is: a stored project's ProjectKind, or 'assistant' for the virtual projects (Chat, MCP
 * assistant, Skill assistant; isVirtualProjectId). A removed project reads as 'code' with `projectRemoved: true`.
 */
export type UsageProjectKind = ProjectKind | 'assistant'

/**
 * The display name main gives runs whose project no longer exists (`projectRemoved`). Run records do not keep the
 * project's name, so this is the best name available.
 */
export const USAGE_REMOVED_PROJECT_NAME = 'Removed project'

/**
 * How many runs of a rollup have a cost the UI can state ("cost from 3 of 4 runs"). Known: the run's costUsd is
 * non-null and not partial (a run that spent nothing, costSource 'none', counts as known). Unknown: costUsd null or
 * costPartial. costKnownRuns + costUnknownRuns = the runs counted by that rollup. For a model or role the run's own
 * share of that model or role decides; for a connection, its part of a multi-provider run.
 */
export interface UsageCostCoverage {
  costKnownRuns: number
  costUnknownRuns: number
}

/**
 * One run in UsageOverview.runs: a RunUsageRow plus its project and connection. Per-model rows (tokens incl.
 * cacheRead / cacheWrite, costUsd | null, priceSource) are `usage.models`; the reports that ended without a result are
 * `usage.noResultAgents` (absent on older runs); `usage.legacy` is mirrored as `legacy`.
 *
 * Cache tokens: adapters write 0 when the provider reports nothing, so 0 and "not reported" cannot be told apart from
 * the data. What is known: Claude runs report both cacheRead and cacheWrite; Codex runs (the openai connection, and a
 * proxy root on a GPT family) report cached input as cacheRead and never report cacheWrite; legacy runs carry 0 for
 * both (their input already includes cache).
 */
export interface UsageOverviewRow extends RunUsageRow {
  projectId: string
  /** The project's name now (Chat / MCP assistant / Skill assistant for virtual ids; USAGE_REMOVED_PROJECT_NAME when gone). */
  projectName: string
  projectKind: UsageProjectKind
  /** Project.client of an engagement; absent otherwise. */
  client?: string
  /** The project was removed; its runs were kept. */
  projectRemoved?: true
  /** RunSummary.connection (absent on runs recorded before it existed). */
  connection?: ConnectionId
  /** The run is live in this host right now (RunManager holds it; endedAt is then absent). */
  live?: true
  /** RunSummary.endedBy (who ended it). */
  endedBy?: RunEndedBy
  /** RunSummary.quick (Chat runs only). */
  quick?: QuickRunInfo
  /** usage.legacy mirrored: figures from a record saved before usage tracking, approximate. */
  legacy?: true
}

/** Per-project rollup in UsageOverview.projects, over every matched run of that project. */
export interface UsageProjectRollup extends UsageCostCoverage {
  projectId: string
  projectName: string
  projectKind: UsageProjectKind
  client?: string
  projectRemoved?: true
  runs: number
  /** Runs per kind; 'ask' counts work runs with team 'single' (and they are not counted under 'work'). Zero counts are absent. */
  runsByKind: Partial<Record<RunKind | 'ask', number>>
  /** Oldest and newest run start among the matched runs (epoch ms). */
  firstStartedAt: number
  lastStartedAt: number
  tokens: TokenUsage
  /** mergeCosts over the runs: null = unknown (never 0 for spent tokens); costPartial = a lower bound. */
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
  turns: number
  toolCalls: number
  retries: number
  nudges: number
  wallMs: number
  waitingMs: number
  idleMs: number
  limitHoldMs: number
  /** Agent instances across the runs, roots included. */
  agents: number
  agentsWithoutResult: number
  noResultTokens: number
  /**
   * Cost of the agents that ended without a result, summed over the runs that record it (RunUsage.noResultCostUsd):
   * null = unknown; noResultCostPartial = a lower bound, also set when a run with such agents predates the field.
   * 0 when no agent ended without a result.
   */
  noResultCostUsd: number | null
  noResultCostPartial?: true
  /** Distinct RunSummary.connection values of the runs (plus RunUsage.connections keys of multi-provider runs). */
  connections: ConnectionId[]
}

/** One model across every matched run (UsageOverview.models). Coverage counts runs that used the model. */
export interface UsageOverviewModel extends UsageCostCoverage {
  model: string
  tokens: TokenUsage
  /** Sum of the known costs; null when no run priced this model's tokens. */
  costUsd: number | null
  /** Some runs' tokens of this model had no price: costUsd is a lower bound. */
  costPartial?: true
  /** The best price source seen (override > proxy > builtin > community > provider > unknown). */
  priceSource: PriceSource
  /** Provider-reported cost summed, when any (> 0). */
  providerCostUsd?: number
  /** Runs that used this model. */
  runs: number
  /** Distinct projects that used this model. */
  projects: number
}

/** One role of one project across its matched runs (UsageOverview.roles); keyed by projectId + (roleId ?? roleSlug). */
export interface UsageOverviewRole extends RoleUsage, UsageCostCoverage {
  projectId: string
  projectName: string
  /** Runs in which the role had at least one agent. */
  runs: number
}

/**
 * One connection across every matched run (UsageOverview.connections). A multi-provider run (RunUsage.connections
 * set) splits its cost and agents per connection; any other run counts whole under RunSummary.connection. `connection`
 * null = runs recorded before RunSummary.connection existed.
 */
export interface UsageOverviewConnection extends UsageCostCoverage {
  connection: ConnectionId | null
  /** Display name: Anthropic, OpenAI, a proxy's name, "Removed proxy" for an id no longer configured, "Unknown connection" for null. */
  name: string
  /** 'builtin' (anthropic, openai), 'proxy' (any other id, configured or removed), null for `connection` null. */
  kind: 'builtin' | 'proxy' | null
  /** Runs with at least one agent on this connection. */
  runs: number
  agents: number
  costUsd: number | null
  costSource: CostSource
  costPartial?: true
}

/** One project's share of a trend bucket (UsageOverviewTrendPoint.byProject). */
export interface UsageTrendProjectSlice extends UsageCostCoverage {
  projectId: string
  runs: number
  /** Tokens of the project's runs in the bucket, all four kinds (cache included). */
  tokens: TokenUsage
  /** Sum of the project's known run costs in the bucket; null when none of its runs there had a known cost. */
  costUsd: number | null
  wallMs: number
  waitingMs: number
}

/**
 * A trend bucket of the overview: UsageTrendPoint (bucket = local date of the start, start = local midnight epoch ms in
 * the main process's zone) plus coverage and the per-project breakdown for a stacked chart.
 */
export interface UsageOverviewTrendPoint extends UsageTrendPoint, UsageCostCoverage {
  /** Projects with runs in the bucket, highest known cost first, then most tokens. */
  byProject: UsageTrendProjectSlice[]
}

/**
 * runs:usageOverview result. Built from persisted summaries (legacy ones normalized once and written back, as in
 * runs:usageStats) and, for live runs, their current usage. Unknown cost is null, never 0; costPartial marks a lower
 * bound everywhere. Rollups cover every matched run; only `runs` is limited.
 */
export interface UsageOverview extends UsageCostCoverage {
  /** Newest first, at most the query's limit. */
  runs: UsageOverviewRow[]
  /** Highest known cost first, then most tokens, then name. */
  projects: UsageProjectRollup[]
  /** Most tokens first. */
  models: UsageOverviewModel[]
  /** Highest known cost first, then most tokens. */
  roles: UsageOverviewRole[]
  /** Highest known cost first, then most agents. */
  connections: UsageOverviewConnection[]
  /** Oldest first, only buckets with runs. */
  trend: UsageOverviewTrendPoint[]
  /** Every matched run summed (sumRunUsage; totals.roles merges roles by id across projects, use `roles` instead). */
  totals: RunUsage
  /** Runs that matched (before the limit). */
  matchedRuns: number
  /** The query main actually ran (after defaults and clamping), so the UI can show what it is looking at. */
  query: {
    since?: number
    until?: number
    kinds: RunKind[]
    bucket: 'day' | 'week' | 'month'
    projectIds?: string[]
    limit: number
  }
  generatedAt: number
  /** More runs matched than `limit`; the oldest rows were left out of `runs` (the rollups still count them). */
  truncated?: true
  /** startedAt of the oldest row in `runs` (absent when `runs` is empty); with `truncated`, older runs are rolled up only. */
  oldestIncludedAt?: number
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
  /** Total prompt tokens (uncached input + cache read + cache write). Kept for older readers; see `usage`. */
  inputTokens: number
  outputTokens: number
  /** usage.costUsd, or 0 when unknown. Kept for older readers; use usage.costUsd / usage.costSource to say "unknown". */
  costUsd: number
  /**
   * Token, cost, turn and tool-call metrics (see AgentUsage for who fills what). Always present on agents read
   * through runs:get and on agent.upsert events from RunManager; optional because adapters may omit it before their
   * first usage report.
   */
  usage?: AgentUsage
  startedAt: number
  endedAt?: number
  /** Last text the agent produced (truncated for the node card). */
  lastText?: string
  result?: string
  /** Present when the agent works in an isolated git worktree. */
  worktree?: WorktreeInfo
  /** Name other agents use to address it (SendMessage), e.g. "implementer-2". */
  handle?: string
  /**
   * The connection this agent ran on. Set by RunManager on every agent.upsert (adapter values are replaced): the
   * root and native reports get the run's connection (RunSummary.connection), a bridged report and the agents of its
   * child session get the bridged role's connection. Missing on older records (= the run's connection).
   */
  connection?: ConnectionId
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
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
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
 * changes through the proposal mechanism (kind 'mcpServers'); 'skill-assist' runs the built-in Skill assistant
 * (setup-like as well) that proposes skill library or project skill changes (proposal kind 'skills').
 * A quick run (RunSummary.quick) is a 'work' run.
 */
export type RunKind = 'work' | 'setup' | 'mcp-assist' | 'skill-assist'

/** Plain words for each RunKind (History kind chips and filters). Never show the raw kind. */
export const RUN_KIND_LABELS: Record<RunKind, string> = {
  work: 'Run',
  setup: 'Setup',
  'mcp-assist': 'MCP assistant',
  'skill-assist': 'Skill assistant'
}

// ---------- Assistants: virtual projects ----------

/**
 * Project id of the virtual harness project that owns harness-level runs (the library MCP assistant). It is built
 * in the main process (name "OrgAI", path = the data dir), never stored in projects.json and never listed by
 * projects:list; projects:get(HARNESS_PROJECT_ID) returns it so a run window can render it.
 */
export const HARNESS_PROJECT_ID = 'harness'

/**
 * Project id of the virtual project that owns quick runs (the "Chat" assistant: project-less work runs, see
 * QuickRunInput). Built in the main process per run (the run's folder, default chart or a single assistant).
 */
export const QUICK_PROJECT_ID = 'quick'

/** Project id of the virtual project that owns library-scope Skill assistant runs (RunKind 'skill-assist'). */
export const SKILLS_PROJECT_ID = 'skills'

/**
 * The virtual projects behind the sidebar "Assistants" section. None is ever stored in projects.json or listed by
 * projects:list; projects:get(id) returns a display project for each (no stored roles); projects:save and
 * projects:remove refuse them. The ids pass SAFE_ID; every guard compares by value (isVirtualProjectId).
 */
export const VIRTUAL_PROJECT_IDS = [HARNESS_PROJECT_ID, QUICK_PROJECT_ID, SKILLS_PROJECT_ID] as const
export type VirtualProjectId = (typeof VIRTUAL_PROJECT_IDS)[number]

/** True for HARNESS_PROJECT_ID, QUICK_PROJECT_ID and SKILLS_PROJECT_ID. */
export function isVirtualProjectId(id: string): id is VirtualProjectId {
  return (VIRTUAL_PROJECT_IDS as readonly string[]).includes(id)
}

/** Display names of the virtual projects (sidebar Assistants rows, Needs-you locations, display projects). */
export const VIRTUAL_PROJECT_LABELS: Record<VirtualProjectId, string> = {
  harness: 'MCP assistant',
  quick: 'Chat',
  skills: 'Skill assistant'
}

// ---------- Assistants: quick runs (Chat) ----------

/**
 * Who works on a quick run: 'single' = one built-in assistant (default, model AppSettings.quickRunModel);
 * 'default' = the app's default org chart (defaultRoles), each role with its own tools (see quickRunTools).
 */
export type QuickRunTeam = 'single' | 'default'
export const QUICK_RUN_TEAMS: readonly QuickRunTeam[] = ['single', 'default']
/** A longer QuickRunInput.prompt is refused, never cut. */
export const QUICK_RUN_MAX_PROMPT_CHARS = 100_000

/**
 * runs:startQuick input. A project-less work run on the virtual project QUICK_PROJECT_ID (RunSummary.kind 'work',
 * RunSummary.quick set). Permission mode always 'default' (see quickRunPermissionMode), so every edit and command
 * asks; the roles keep their edit and command tools whatever allowEdits says. No project MCP servers, plugins or
 * skills (run-scoped installs through request_mcp_install only, McpInstallRequest.runOnly); run messaging off.
 */
export interface QuickRunInput {
  prompt: string
  /**
   * Absolute folder to work in (must exist, a directory, not the data dir or under it, no UNC or device path).
   * Missing = a fresh scratch dir under `<data>/quick/`.
   */
  folder?: string
  /** Default 'single'. */
  team?: QuickRunTeam
  /**
   * The user's up-front declaration. false (default, "read-only start"): the assistant is told the chat is read-only
   * by default, but an edit or command may still be needed; it makes the call, OrgAI asks the user (the card carries
   * PermissionRequest.quickReadOnly) and the user may decline. true ("edits allowed"): the assistant is told it may
   * change files and run commands here; each edit or command still asks, and a git folder isolates writers.
   * Either way the tools are the same and nothing runs without a card or a grant the user gave in this run.
   */
  allowEdits?: boolean
  images?: ImageAttachment[]
  /** Headless exec overrides (cli-spec 6.2(1)). Honoured only from socket / inproc host clients; the desktop handler drops it. */
  overrides?: RunOverrides
}

/** RunSummary.quick: how a quick run was started. Kept by continuations. */
export interface QuickRunInfo {
  /** The real working dir, the scratch dir included. */
  folder: string
  /** The folder is a scratch dir OrgAI made (cannot be promoted to a project). */
  scratch?: true
  team: QuickRunTeam
  allowEdits: boolean
  /** The folder was a git repository at start. */
  gitRepo: boolean
}

/** runs:promoteQuick input: save a quick run's session chain as a new project named `name` (default chart). */
export interface QuickRunPromoteInput {
  runId: string
  name: string
}

/**
 * runs:promoteQuick result. 'created': the project was created and the whole run chain moved into it (one
 * run.moved event per run); `run` is the promoted run's summary with its new projectId. 'existing': the folder is
 * already a project; nothing moved (the UI offers "Open <name>"). Refused (rejects) for a scratch run or while any
 * run of the chain is live.
 */
export type QuickRunPromoteResult =
  | { kind: 'created'; project: Project; run: RunSummary }
  | { kind: 'existing'; projectId: string; name: string }

/**
 * Harness tools of a quick run's root (bare names). list_projects is read-only: every stored project's id, name,
 * folder path, brief excerpt, roles (slug: name), connection and its newest run's status, title and time. Never
 * virtual projects, never secrets. The tool answers text; ProjectPeek is its data shape.
 */
export const CHAT_HARNESS_TOOLS = ['list_projects'] as const
export type ChatHarnessToolName = (typeof CHAT_HARNESS_TOOLS)[number]
/** list_projects: at most this many characters of each project's brief. */
export const PROJECT_PEEK_BRIEF_CHARS = 400

/** One project as list_projects reports it (secret-free, structured-clone safe). */
export interface ProjectPeek {
  id: string
  name: string
  path: string
  /** The brief on one line, at most PROJECT_PEEK_BRIEF_CHARS characters. */
  brief: string
  /** "slug: Name" per role. */
  roles: string[]
  connection: ConnectionId
  lastRun?: { runId: string; status: RunStatus; title?: string; startedAt: number }
}

// ---------- Assistants: Skill assistant ----------

/**
 * Harness tools of the Skill assistant (bare names; adapters expose them under their harness server).
 * list_skill_library: the library entries (and, in a project session, the project's skills with the roles that
 * load them). read_library_skill: one entry's SKILL.md and file list. propose_skills: a 'skills' proposal that
 * blocks until the user decides (APPROVED / REVISE).
 */
export const SKILL_ASSIST_HARNESS_TOOLS = {
  list: 'list_skill_library',
  read: 'read_library_skill',
  propose: 'propose_skills'
} as const
export type SkillAssistHarnessToolName = (typeof SKILL_ASSIST_HARNESS_TOOLS)[keyof typeof SKILL_ASSIST_HARNESS_TOOLS]

/**
 * skills:startAssist input. scope 'project' (default when projectId is given) starts the Skill assistant on that
 * project; scope 'library' (default without projectId) runs it on the virtual project SKILLS_PROJECT_ID, where it
 * proposes library entries only.
 */
export interface SkillAssistInput {
  projectId?: string
  scope?: 'project' | 'library'
  /** What the user wants, e.g. "review our skills" or "write a skill for our release checklist". */
  instruction?: string
}

/**
 * Where a run is hosted in the UI when it is not a Live-view run. 'team' = an Architect (setup) session started from
 * the Team tab's assistant tray (setup.start with surface 'team'): the renderer keeps such runs off the Live run
 * strip and History and shows them in the Team tray. Missing = the default surfaces.
 */
export type RunSurface = 'team'

/** setup.start input. `surface` is accepted only as the literal 'team' (anything else is dropped). */
export interface SetupStartInput {
  projectId: string
  instruction?: string
  surface?: RunSurface
}

export interface RunSummary {
  id: string
  projectId: string
  kind: RunKind
  prompt: string
  status: RunStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  /** usage.costUsd, or 0 when unknown. Kept for older readers; use usage.costUsd / usage.costSource. */
  totalCostUsd: number
  /**
   * Run usage metrics (RunUsage), kept current by RunManager while the run is live and persisted with the summary.
   * Absent until the first computation, and on summaries saved before usage tracking until runs:get or
   * runs:usageStats normalizes them.
   */
  usage?: RunUsage
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
   * Who ended the run. 'user': End session (RunManager.stop). 'app': OrgAI quit or crashed while it was live (stopAll on
   * quit, or the store's boot normalization). 'policy' / 'budget': a host-finalized headless exec run (decision policy,
   * completion or stall; or its budget cap); these read 'Finished', never 'Stopped'. Absent: the run ended on its own
   * (finished, error, paused). Structured-clone safe.
   */
  endedBy?: RunEndedBy
  /** Only with endedBy 'app': what the run was doing when OrgAI cut it. 'waiting': status idle or a decision card open (the user's turn). 'working': starting, running or stopping. Absent for a paused run. */
  endedWhile?: 'working' | 'waiting'
  /** Headless exec overrides (cli-spec 6.2). Host-set only, never from the renderer; RunStore rebuilds them on read and drops unknown keys or bad types. */
  overrides?: RunOverrides
  /** How a headless exec run ended. Host-set (RunManager.finalizeExecRun); RunStore keeps only EXEC_OUTCOMES values on read. */
  execOutcome?: ExecOutcome
  /**
   * Work runs: a short AI summary of the run's first message (one line, at most RUN_TITLE_MAX_CHARS characters),
   * written by the connection's fast model shortly after the run starts (a run.title event announces it). Absent
   * until generated, and for good when generation failed or was skipped (setup-like runs, image-only prompts).
   * Advisory only: the UI falls back to `prompt`.
   */
  title?: string
  /**
   * The connection the run reached its models through (RunConnection.connection, set at start). Lets the UI label
   * totalCostUsd per run: on 'anthropic' it is the CLI's own estimate, on 'litellm' it is computed from the proxy's
   * /model/info prices (0 when a model has no price), on 'openai' it is 0 (ChatGPT plan, no per-token price).
   * Missing on runs recorded before it existed.
   */
  connection?: ConnectionId
  /**
   * Setup runs only: the UI surface that hosts the run (RunSurface). Set at start from setup.start and kept by
   * continuations (runs:continue) and auto-resume. Missing = shown in the Live run strip and History as usual.
   */
  surface?: RunSurface
  /** Quick runs only (projectId QUICK_PROJECT_ID, kind 'work'): where and how it works. Kept by continuations. */
  quick?: QuickRunInfo
  /**
   * MCP assistant runs started with McpAssistInput.allowBuild only: the per-run scratch dir under `<data>/quick/`
   * the session works in (absolute). Continuations keep it, so the session reopens in the same folder; the boot
   * sweep keeps a scratch dir any run record points to (quick.folder or buildWorkspace).
   */
  buildWorkspace?: string
  /** Work runs of a real project started with StartRunInput.team 'single' (RunTeam). Kept by continuations and auto-resume. */
  team?: RunTeam
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
  /**
   * The reference folder (Project.referenceDirectories, read only) this call touches, as the run resolved it: a shell
   * command whose effective cwd is inside one or whose words name a path at, under or above one
   * (runtime/referenceDirectories.ts `commandTouchesReference`), or a Read / Glob / Grep of a path under one. Set by
   * every adapter. Such a request carries no suggestions or ruleLabels and RunManager narrows any allow to 'once', so
   * the card offers Allow once and Deny only ("Touches a reference folder (read only)").
   */
  referenceFolder?: string
  /**
   * Set by RunManager (never by an adapter; an adapter's value is dropped) on a Chat (quick) run started read-only
   * (`QuickRunInfo.allowEdits` false) when the call is an edit or a command (QUICK_WRITE_TOOLS: Edit, Write,
   * MultiEdit, NotebookEdit, Bash, PowerShell), so the card can say the chat started read-only. Nothing else about the
   * card changes: the same Allow once / Allow for session / Deny answers apply.
   */
  quickReadOnly?: true
  /**
   * The widest scope an allow can have, set by RunManager (an adapter's value is dropped): 'session' on
   * trust-restricted runs (Chat runs and MCP build sessions: a 'project' answer is narrowed to 'session', nothing is
   * saved), 'once' when `referenceFolder` is set. Absent = 'project' is possible. The card must not offer a scope
   * wider than this or claim a saved rule.
   */
  maxScope?: 'once' | 'session'
  /**
   * Chat (quick) runs only, set by RunManager: the chat's working folder (QuickRunInfo.folder, the scratch dir
   * included; `workingFolderScratch: true` when it is a scratch dir OrgAI made), so the card can say where the call
   * runs. Agents in a worktree still work under this folder.
   */
  workingFolder?: string
  workingFolderScratch?: true
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
}

/**
 * Tools whose calls count as "an edit or a command" on a Chat (quick) run: PermissionRequest.quickReadOnly is set only
 * for these.
 */
export const QUICK_WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']

/** How long an allow decision lasts: this call only, the rest of this run, or every future run of the project. */
export type PermissionScope = 'once' | 'session' | 'project'

/** One permission rule: a tool name plus optional content, written as `Tool(content)`. */
/**
 * A saved allow rule OrgAI ignores (permissions:ignored): `reason` is OrgAI's own sentence, never file text. `rule` is
 * the stored text, cut at 1,000 chars (`cut: true`, then not removable); `hiddenChar` when it holds a hidden character.
 */
export interface IgnoredPermissionRule {
  rule: string
  reason: string
  hiddenChar?: true
  cut?: true
}

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
  /** Card revision, set by RunManager when the card is created (1 for now). Decision calls may send expectedRevision. */
  revision?: number
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

/** USD spent in one calendar period as the proxy's daily spend rows sum up (UTC calendar days). */
export interface SpendPeriod {
  usd: number
  /** Start of the period, epoch ms (UTC day start / ISO week Monday 00:00 UTC / first of the month 00:00 UTC). */
  since: number
}

/**
 * How many UTC days back the daily spend probe asks for at most. The probe asks from the earlier of the month start
 * and the ISO week's Monday (at most 30 days back), so the cap only guards the arithmetic.
 */
export const SPEND_PERIOD_DAYS = 40

/**
 * The fixed sentences `UsageSpend.periodsNote` may carry (never proxy error text; the proxy body is untrusted).
 * The UI may switch on them.
 */
export const SPEND_PERIOD_NOTES = {
  /** The daily route answered 403: the key has no user (a service-account key). */
  noUser: 'This key is not bound to a user, so the proxy refuses its daily spend.',
  /** 404 / 405 on both daily routes, or a paginated answer with more pages than the one read. */
  unsupported: 'This proxy does not report daily spend (needs LiteLLM 1.65 or newer).',
  /** Any other failure: 5xx, network, timeout, redirect, non-JSON, oversized body, junk shape, non-finite sums. */
  failed: 'The proxy did not answer its daily spend request.'
} as const
export type SpendPeriodsNote = (typeof SPEND_PERIOD_NOTES)[keyof typeof SPEND_PERIOD_NOTES]

/**
 * Spend of a LiteLLM virtual key as the proxy reports it (GET {base}/key/info with the key as Bearer; UNVERIFIED
 * against a live proxy). Only the key's own budget: a team budget that may also govern the key is not read.
 */
export interface UsageSpend {
  /** USD spent so far in the current budget period (info.spend). */
  usd: number
  /** USD budget of the key (info.max_budget); null = no budget set. */
  budgetUsd: number | null
  /** When the budget resets (info.budget_reset_at), epoch ms; null = never or unknown. */
  resetsAt: number | null
  /** The budget period as the proxy writes it, e.g. "30d", "1h" (info.budget_duration); null = none. */
  budgetDuration: string | null
  /** The key's alias (info.key_alias); null when unset. Never the key itself. */
  keyAlias: string | null
  /**
   * Lifetime spend of the key (info.total_spend, which keeps counting when `usd` resets at `resetsAt`); null when the
   * proxy does not report it. Optional only so records and fixtures written before it was read still type-check.
   */
  totalUsd?: number | null
  /**
   * Spend by period from GET {base}/user/daily/activity/aggregated (older proxies: /user/daily/activity) filtered to
   * this key by its SHA-256 hash (the proxy's stored key id, which LiteLLM also accepts as a credential, so it goes
   * only to the proxy that already holds the key and never into this record), summed over UTC calendar days: `day` =
   * the UTC day containing `UsageStatus.updatedAt`,
   * `week` = the ISO week (Monday 00:00 UTC) containing it, `month` = its calendar month. Never rolling windows, and
   * all three are present or none. Absent when the proxy did not report daily spend; `periodsNote` then says why.
   * UNVERIFIED against a live proxy (read from LiteLLM source, v1.108.0).
   */
  periods?: { day: SpendPeriod; week: SpendPeriod; month: SpendPeriod }
  /** Why `periods` is absent: one of the fixed `SPEND_PERIOD_NOTES` sentences, never proxy error text. */
  periodsNote?: SpendPeriodsNote
}

/**
 * The plan limits that constrain a subscription login, or a key's spend, as last reported by the provider.
 * Reports come per connection ('anthropic' Claude plan windows, 'openai' Codex windows, 'litellm' key spend), each
 * as its own usage.status event with runId ''. The renderer keeps the latest report per `connection` (missing =
 * 'anthropic'); a report never clears another connection's.
 */
export interface UsageStatus {
  /**
   * The adapter that reported it. Missing on older records = 'claude'. LiteLLM spend reports (connection 'litellm')
   * leave it unset: the spend belongs to the key, not to an adapter.
   */
  provider?: ProviderId
  /** The connection the limits belong to. Missing = 'anthropic'. Lets Codex (ChatGPT) limits show beside Claude's. */
  connection?: ConnectionId
  authMode: 'subscription' | 'apiKey' | 'unknown'
  /** e.g. 'pro', 'max'; null for API keys or when unknown. */
  subscriptionType: string | null
  /**
   * Plan windows (or, for 'litellm', `spend`) were reported. False for API keys and before the first report.
   * A LiteLLM report has authMode 'apiKey', available true, windows {} and `spend` set.
   */
  available: boolean
  /** LiteLLM: the virtual key's spend and budget. Absent on plan-window reports. */
  spend?: UsageSpend
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
      /** Only on the 'starting' status of a run with RunSummary.surface: lets the renderer route it before runs:list. */
      surface?: RunSurface
      error?: string
      /** status 'paused' (and later updates to a paused run). */
      pausedUntil?: number
      pauseReason?: string
      autoResume?: boolean
      /**
       * Who ended the run (RunSummary.endedBy). 'user': End session (RunManager.stop). 'app': OrgAI quit or crashed while
       * it was live. 'policy' / 'budget': a host-finalized headless exec run (reads Stopped with a policy or budget note, never Finished). Set by RunManager on a
       * terminal status ('finished' / 'error') of a cut run, and on 'stopping' with 'user'. Absent: the run ended on its
       * own. Adapters never set it. Structured-clone safe.
       */
      endedBy?: RunEndedBy
      /** Only with endedBy 'app' (RunSummary.endedWhile): 'waiting' (idle or a card open) or 'working' when OrgAI cut it. */
      endedWhile?: 'working' | 'waiting'
    }
  /**
   * A headless exec run reached its outcome (RunSummary.execOutcome). Emitted exactly once per run by
   * RunManager.finalizeExecRun (cli-spec Wave 3), after the final summary is persisted; never by adapters.
   */
  | { type: 'run.finalized'; runId: string; execChainId?: string; outcome: ExecOutcome; summary: RunSummary }
  /**
   * The run's AI-generated title (RunSummary.title) arrived. Sent at most once per run, work runs only, possibly
   * after the run ended. The summary in runs:list / runs:get carries it from then on.
   */
  | { type: 'run.title'; runId: string; title: string }
  /**
   * A run moved to another project (a quick run promoted with runs:promoteQuick). One event per moved run; from now
   * on runs:list(projectId) returns it and RunSummary.projectId is `projectId`.
   */
  | { type: 'run.moved'; runId: string; fromProjectId: string; projectId: string }
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
  | {
      type: 'permission.resolved'
      runId: string
      requestId: string
      cancelled?: true
      /**
       * Set when the user's allow decision had project scope after RunManager's narrowing, so the project's saved
       * rules, allowed folders or permission mode may have changed. Absent on deny, once, session and cancelled.
       */
      savedToProject?: true
      /**
       * The allow's scope after RunManager's narrowing ('once', 'session' or 'project'); absent on deny and cancelled.
       * A Chat card answered "Allow for project" reads 'session' here.
       */
      scope?: PermissionScope
      /** Who decided (cli-spec 3.4(4)); absent on cancelled cards and older events. */
      decidedBy?: DecidedBy
    }
  /** Adapters report the provider's run total here; RunManager stores the priced total on the summary. Kept for older readers. */
  | { type: 'run.cost'; runId: string; totalCostUsd: number }
  /**
   * The run's usage metrics changed (RunSummary.usage). Emitted by RunManager only (adapters never send it), at most
   * about once per second while live, and once more when the run ends. Agent-level usage rides agent.upsert.
   */
  | { type: 'run.usage'; runId: string; usage: RunUsage }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'proposal.request'; runId: string; proposal: Proposal }
  | { type: 'proposal.resolved'; runId: string; proposalId: string; decision: ProposalOutcome; cancelled?: true; decidedBy?: DecidedBy }
  | { type: 'question.request'; runId: string; question: UserQuestion }
  | { type: 'question.resolved'; runId: string; questionId: string; answer: QuestionAnswer; cancelled?: true; decidedBy?: DecidedBy }
  /** An agent asked for permission rules (request_permission_rules); the run waits for permissions:decideRequest. */
  | { type: 'rules.request'; runId: string; request: PermissionRuleRequest }
  | { type: 'rules.resolved'; runId: string; requestId: string; decision: PermissionRuleDecision; cancelled?: true; decidedBy?: DecidedBy }
  | { type: 'merge.request'; runId: string; review: MergeReview }
  | { type: 'merge.resolved'; runId: string; reviewId: string; decision: MergeDecision; cancelled?: true; decidedBy?: DecidedBy }
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
  /**
   * An agent loaded a skill (Claude: an allowed Skill tool call; Codex and mock: load_skill). Emitted by the adapter
   * (or the load_skill harness tool); RunManager counts it into RunUsage.skills and writes a harness transcript row
   * ("Loaded skill <name>", source 'harness') on that agent. `at` is epoch ms.
   */
  | { type: 'skill.used'; runId: string; agentId: string; skillId: string; name: string; at: number }
  /**
   * Knowledge graph items just reached an agent, so the renderer can light those nodes up. RunManager emits it (at most
   * one per agent per second, trailing, ids merged, at most KNOWLEDGE_RECALLED_IDS_MAX ids). `via` 'recall' =
   * knowledge_recall, 'auto' = knowledgeContext; a merged event carries the newest call's `via`. `at` is epoch ms.
   */
  | { type: 'knowledge.recalled'; runId: string; agentId: string; nodeIds: string[]; at: number; via: 'recall' | 'auto' }
  /** An agent produced or registered a deliverable (types.ts "Run outputs"); RunManager emits it after the index write. */
  | { type: 'output.created'; runId: string; output: RunOutput }
  /** An agent added a version to an output it (or another run) made before (outputs-2 identity rule); `output` is the entry after it. */
  | { type: 'output.versioned'; runId: string; output: RunOutput }
  /** An agent asked to install an MCP server (request_mcp_install); the run waits for mcp:answerInstall. */
  | { type: 'mcpInstall.request'; runId: string; request: McpInstallRequest }
  /** The install request was answered (or dropped when the run ended: approved false). Never carries secrets. */
  | { type: 'mcpInstall.resolved'; runId: string; requestId: string; outcome: McpInstallOutcome; cancelled?: true; decidedBy?: DecidedBy }

/**
 * Payload of the main -> renderer `app:focusRun` message sent when a notification is clicked, and of
 * `window:openRun`. A window opened for a run loads the renderer with the hash `#/run/<projectId>/<runId>`
 * (both encodeURIComponent'd; see RUN_WINDOW_HASH_PREFIX and runWindowHash).
 */
export interface FocusRunTarget {
  projectId: string
  runId: string
}

/**
 * Application menu items that the renderer handles. Main pushes `{ action }` on `menu:action` (IPC.menuAction) to
 * the focused window (else the first live one); the renderer routes on the name. A fixed enum: main never puts a
 * renderer-supplied string into the menu, and the renderer must ignore names it does not know.
 */
export const MENU_ACTIONS = [
  'new-project',
  'new-chat',
  'open-chat',
  'open-mcp-assistant',
  'open-skill-assistant',
  'new-run',
  'interrupt-run',
  'end-session',
  'org-retrospective',
  'show-live',
  'show-history',
  'show-team',
  'show-project-settings',
  'open-app-settings',
  'open-connections',
  'open-connectors',
  'open-skill-library',
  'open-about',
  'toggle-sidebar',
  'toggle-hide-finished',
  'canvas-fit',
  'keyboard-shortcuts',
  'close-tab',
  'go-to-decision',
  'show-needs-you',
  'toggle-conversation',
  'save-chat-as-project',
  'open-run-window',
  'canvas-zoom-in',
  'canvas-zoom-out',
  /** Help > "Ask OrgAI about itself…": opens Chat ready for a question about the app (section "Self-knowledge"). */
  'ask-about-orgai',
  /** View > Usage: the app-wide Usage page (docs/design/usage-app.md). No accelerator; always enabled. */
  'show-usage'
] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

/** Payload of the main -> renderer `menu:action` push. Structured-clone safe. */
export interface MenuActionEvent {
  action: MenuAction
}

/**
 * What the window's renderer is showing, sent on `menu:setState` (renderer -> main) whenever it changes. Main keeps
 * one per sender window, validates it (booleans only, anything else false) and rebuilds the application menu from
 * the focused window's state, greying out items that do not apply. Structured-clone safe.
 */
export interface MenuState {
  /** A real or virtual project is open (section items, New run). */
  hasProject: boolean
  /** A run tab is shown (Close tab, Open in new window, Show conversation, canvas items). */
  hasRun: boolean
  /** The shown run is live (Interrupt, End session). */
  runLive: boolean
  /** The shown run is a Chat run that Save as project applies to. */
  chatRun: boolean
  /** At least one decision card is open (Go to decision, Show what needs you). */
  hasDecision: boolean
}

export const EMPTY_MENU_STATE: MenuState = { hasProject: false, hasRun: false, runLive: false, chatRun: false, hasDecision: false }

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value)
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
  /** What the project is for; missing = 'code'. Any other value is dropped (the project is 'code'). */
  kind?: ProjectKind
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
  /**
   * Start the project from this saved team template (OrgTemplateInfo.id) instead of the default chart: the 'replace'
   * apply, models mapped to the connection the project is created on. importAgents wins when both are set; an unknown
   * id keeps the default chart.
   */
  templateId?: string
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
  /** Ignored by previewImport. applyImport takes AgentImportApplyInput, where it is required. */
  digest?: string
}

/** Most choices one preview or apply accepts; more are refused. */
export const AGENT_IMPORT_MAX_CHOICES = 200

/**
 * projects:applyImport input. `digest` is required: the AgentImportPreview.digest of the preview the user reviewed.
 * When the folder's definitions changed since (another prompt, tool list, model, responsibilities or color under the
 * same name), apply refuses, and it refuses outright without a digest. The digest covers the folder only: apply
 * recomputes against the project's current roles, mode and choices, so the UI should re-preview after an org chart edit.
 */
export interface AgentImportApplyInput extends AgentImportInput {
  digest: string
}

/** Tools that change files or run commands. AgentImportItem.elevatedTools lists the ones an imported role gets. */
export const AGENT_IMPORT_ELEVATED_TOOLS: readonly ToolName[] = ['Bash', 'Edit', 'Write', 'NotebookEdit']

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
  /**
   * The whole prompt the role gets (the imported prompt, capped at 20,000 characters, or its description when the
   * definition has none). Untrusted repo text: render it as plain text and let the user read all of it before applying.
   */
  prompt: string
  /**
   * The role's elevated grants, for the UI to flag: its tools among AGENT_IMPORT_ELEVATED_TOOLS (Bash, Edit, Write,
   * NotebookEdit), plus 'canSpawn' when it may spawn agents and 'mcp' when it keeps a replaced role's MCP grants.
   * Empty for a read-only role.
   */
  elevatedTools: string[]
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
  /** 'single': one assistant instead of the org chart (RunTeam). Any other value is dropped. */
  team?: RunTeam
  /** Headless exec overrides (cli-spec 6.2(1)). Honoured only from socket / inproc host clients; the desktop handler drops it. */
  overrides?: RunOverrides
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
  /** Headless exec overrides (cli-spec 6.2(1)). Honoured only from socket / inproc host clients; the desktop handler drops it. */
  overrides?: RunOverrides
  /**
   * `orgai resume --exec`: keep the chain's execMode / execChainId / waitForReset / decisionPolicy. Without it a
   * continuation strips them (narrowing overrides are kept). Socket / inproc clients only.
   */
  exec?: boolean
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

// ---------- Capabilities: the Team assistant (src/main/capabilities/) ----------
//
// Token-free discovery of skills and MCP servers from local and outside sources, a one-shot recommendation
// completion (never a run: nothing appears in Live or History), and least-privilege apply with one undo per
// project. Every string that came from a file, a registry or GitHub is untrusted data: render it as plain text.

/** What a candidate becomes when applied: a project skill, a project MCP server, or a connector (library entry + link). */
export type CapabilityKind = 'skill' | 'mcp' | 'connector'

/**
 * Where a candidate was found. 'repo' = this project's folder (SKILL_REPO_ROOTS, .mcp.json, .cursor/mcp.json,
 * .vscode/mcp.json); 'local' = another tool's config or skill folder on this computer (outside the repo); 'library' =
 * the app-wide MCP or skill library; 'project' = already in this project; 'registry' = the official MCP Registry;
 * 'github' = the allowlisted GitHub skills repo (CAPABILITY_GITHUB_SKILLS_REPO); 'catalog' = the curated connectors.
 * 'registry' and 'github' are outside sources: fetched only with includeOutside, unverified.
 */
export type CapabilityOrigin = 'repo' | 'local' | 'library' | 'project' | 'registry' | 'github' | 'catalog'
export const CAPABILITY_OUTSIDE_ORIGINS: readonly CapabilityOrigin[] = ['registry', 'github']

/**
 * Risk flags shown on a candidate. 'runsCode' = a stdio MCP server (runs code on this machine); 'scripts' = a skill
 * that ships script-looking files; 'remote' = an MCP server reached over the network; 'canChange' = a connector
 * variant or server with write tools; 'unverified' = outside origin or a connector preset not yet verified;
 * 'partial' = a GitHub skill whose resource files were not fetched (SKILL.md only).
 */
export type CapabilityFlag = 'runsCode' | 'scripts' | 'remote' | 'canChange' | 'unverified' | 'partial'

/** The access a recommendation grants. Connectors: picks the read-only or the full variant. Others: advisory only. */
export type CapabilityAccess = 'read' | 'full'

/**
 * Stable source ids for progress and "What I looked at". Local ones are read-only file reads; 'registry' and
 * 'github' are network fetches (outside only).
 */
export type CapabilitySourceId =
  | 'repo-skills'
  | 'repo-mcp'
  | 'claude-skills'
  | 'agents-skills'
  | 'copilot-skills'
  | 'claude-plugins'
  | 'claude-code-mcp'
  | 'claude-desktop-mcp'
  | 'cursor-mcp'
  | 'codex-mcp'
  | 'library'
  | 'project'
  | 'catalog'
  | 'registry'
  | 'github'

/** found = read with results; empty = read, nothing usable; missing = not present; skipped = not asked (outside off); error / rateLimited = failed. */
export type CapabilitySourceState = 'found' | 'empty' | 'missing' | 'skipped' | 'error' | 'rateLimited'

/** One row of "What I looked at". */
export interface CapabilitySourceStatus {
  source: CapabilitySourceId
  /** Plain label, e.g. "Claude Code skills". */
  label: string
  /** Display locations (home shortened to ~, URLs without query), at most 10. */
  locations: string[]
  state: CapabilitySourceState
  /** Candidates this source contributed. */
  count: number
  /** One readable line for error / rateLimited / skipped (e.g. "GitHub rate limit reached. Try again in about 60 s."). */
  message?: string
  /** rateLimited: seconds until a retry is worth it, when known. */
  retryAfterSec?: number
}

/** A file that could not be used (bad JSON, too large, a symlink). Never an exception. */
export interface CapabilityWarning {
  source: CapabilitySourceId
  /** Display path or URL. */
  location?: string
  message: string
}

/** The candidate is already in this project: which project skill or server, and the roles granted it. */
export interface CapabilityInProject {
  kind: 'skill' | 'mcp'
  /** SkillSpec.id or McpServerSpec.id. */
  id: string
  /** Role ids that can use it now (MCP: spec.roles undefined counts as every role). */
  grantedTo: string[]
  enabled: boolean
}

/**
 * One candidate. Secret-free and structured-clone safe: env and header VALUES are never read into it, only key names.
 * name, description, target and notes are untrusted text (clamped, control characters removed).
 */
export interface CapabilityItem {
  /** Stable across discoveries of the same thing: `cap-<24 hex>` (sha256 of origin, kind, source key and name). */
  id: string
  kind: CapabilityKind
  origin: CapabilityOrigin
  source: CapabilitySourceId
  /** Plain label for the source badge, e.g. "Claude Code", "This repository", "MCP Registry", "anthropics/skills". */
  sourceLabel: string
  /** Display path (home as ~) or URL (origin and path only), e.g. "~/.claude/skills/code-review". */
  location?: string
  name: string
  /** At most CAPABILITY_DESCRIPTION_MAX chars. */
  description: string
  /** Pinned version (registry, a pinned package in args; connectors: undefined). */
  version?: string
  /** Skills: sha256 of the files OrgAI would store. */
  digest?: string
  /** MCP: transport and a display target ("npx -y pkg@1.2.3" with key-like args removed, or the URL origin + path). */
  transport?: McpTransport
  target?: string
  flags: CapabilityFlag[]
  /** Env var and header names whose values the user must enter after applying (never values). */
  needsSecrets: string[]
  /** Connectors: the catalog id, its state, and whether a read-only variant exists. */
  connectorId?: string
  connectorState?: ConnectorState
  readOnlyAvailable?: boolean
  /** Set when it is already in this project. */
  inProject?: CapabilityInProject
  /** Set when it cannot be applied as found (unpinned package, invalid skill, deprecated). Never recommended. */
  blockedReason?: string
  /** Short notes: dropped keys, removed key-like args, "SKILL.md only". */
  notes: string[]
}

/** capabilities:discover input. */
export interface CapabilityDiscoverInput {
  projectId: string
  /** Also fetch outside sources (registry, GitHub). Default false: local sources only, no network. */
  includeOutside?: boolean
  /** Extra registry search words (at most 100 chars). Default: words derived from the roles and the repo. */
  query?: string
  /** Renderer-chosen id (SAFE_ID) for capabilities:progress events and capabilities:cancel. */
  requestId?: string
}

/** capabilities:discover output. Never rejects for a missing or bad file; a bad file is a warning. */
export interface CapabilityDiscovery {
  projectId: string
  items: CapabilityItem[]
  sources: CapabilitySourceStatus[]
  warnings: CapabilityWarning[]
  includeOutside: boolean
  /** sha256 binding every item (id, kind, digest/target, blockedReason). capabilities:apply requires it. */
  digest: string
  /** True when it was cut short (cancel, a cap reached). */
  partial?: true
  /** ISO timestamp. */
  createdAt: string
}

/** Who a recommendation is for: one role, or the whole team when roleId is missing. */
export interface CapabilityScope {
  roleId?: string
}

/** capabilities:recommend input. */
export interface CapabilityRecommendInput extends CapabilityDiscoverInput {
  scope?: CapabilityScope
}

/** One recommended candidate for some roles. */
export interface CapabilityRecommendation {
  /** `rec-<12 hex>`, unique within its TeamRecommendations. */
  id: string
  /** A CapabilityItem.id of the discovery. */
  candidateId: string
  kind: CapabilityKind
  /** Role ids (existing roles only; the scoped role only when scope.roleId is set). Never "every role". */
  roleIds: string[]
  /** One plain sentence: why (untrusted model text, at most 300 chars). */
  reason: string
  /** Default 'read'; 'full' only when every role in roleIds has a write tool (CAPABILITY_WRITE_TOOLS). */
  access: CapabilityAccess
}

/** A need no candidate fits ("Implementer can run Bash but has no test skill"). No apply of its own. */
export interface CapabilityGap {
  roleId: string
  /** One plain sentence, at most 300 chars. */
  need: string
}

/** capabilities:recommend output. A one-shot completion, never a run. */
export interface TeamRecommendations {
  projectId: string
  scope: CapabilityScope
  discovery: CapabilityDiscovery
  recommendations: CapabilityRecommendation[]
  gaps: CapabilityGap[]
  /** Equal to discovery.digest; pass it to capabilities:apply. */
  digest: string
  /** 'model' = the completion answered; 'fallback' = deterministic keyword matching (fallbackReason says why). */
  mode: 'model' | 'fallback'
  fallbackReason?: 'error' | 'timeout' | 'cancelled' | 'noCandidates' | 'invalidAnswer'
  /** The model id that answered, when known. */
  model?: string
  /** True when cancelled: recommendations cover what was found so far. */
  partial?: true
  createdAt: string
}

/**
 * capabilities:apply input. Name a recommendation (its roleIds and access are the defaults) or a candidate directly.
 * `roleIds` and `access` are the user's edits; main re-reads the candidate from its own snapshot for `digest` (the
 * renderer never sends paths, specs or file content) and refuses a stale or missing digest.
 * The renderer should send `candidateId` together with `recommendationId`: recommendations from capabilities:recommend
 * live only in main's in-memory snapshot (a persisted TeamReview's survive a restart), so after a restart or a
 * re-discovery main falls back to the candidate. When both are sent they must name the same candidate.
 * `access` omitted = the recommendation's own access (else 'read'); 'full' is still refused unless every chosen role
 * has a write tool (CAPABILITY_WRITE_TOOLS).
 */
export interface CapabilityApplyInput {
  projectId: string
  digest: string
  recommendationId?: string
  candidateId?: string
  /** Roles to grant (Role ids, at least one). Only these roles get access. */
  roleIds: string[]
  /** Default 'read'. 'full' is refused when a chosen role has no write tool. */
  access?: CapabilityAccess
}

/** What one apply did. */
export interface CapabilityApplied {
  kind: 'skill' | 'mcp'
  /** The project SkillSpec.id or McpServerSpec.id that now holds it. */
  id: string
  name: string
  /** 'added' = new in the project; 'linked' = linked from the library (connectors too); 'granted' = already there, grants only. */
  action: 'added' | 'linked' | 'granted'
  roleIds: string[]
  access: CapabilityAccess
}

/** capabilities:apply output. */
export interface CapabilityApplyResult {
  project: Project
  applied: CapabilityApplied
  /** Pass to capabilities:undo. Valid until the next apply in this project or the app quits. */
  undoId: string
  /**
   * The server needs the user before runs get it: secret names without a value and/or a sign-in. Until then it is
   * saved with its grants but left out of runs (McpServerInfo.missingSecrets / auth say the same). Route to sign-in.
   */
  needsSetup?: { secrets: string[]; signIn: boolean; connectorId?: string; libraryId?: string }
  notes: string[]
}

/** capabilities:undo input. */
export interface CapabilityUndoInput {
  projectId: string
  undoId: string
}

/** capabilities:undo output: the project with the apply reversed (added items removed, previous grants restored). */
export interface CapabilityUndoResult {
  project: Project
}

/** capabilities:progress push: one discovery phase or the model step changed state. */
export interface CapabilityProgressEvent {
  projectId: string
  requestId: string
  /** A source, or 'model' for the recommendation completion. */
  phase: CapabilitySourceId | 'model'
  state: 'running' | 'done' | CapabilitySourceState
  count?: number
  message?: string
}

/** The one allowlisted GitHub skills repo (unauthenticated contents API, SKILL.md only). */
export const CAPABILITY_GITHUB_SKILLS_REPO = 'anthropics/skills'
/** Tools that make a role able to change things; 'full' access needs one of them on every granted role. */
export const CAPABILITY_WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'Bash']
export const CAPABILITY_DESCRIPTION_MAX = 300
export const CAPABILITY_MAX_ITEMS = 500
export const CAPABILITY_MAX_RECOMMENDATIONS = 12
export const CAPABILITY_MAX_GAPS = 8
export const CAPABILITY_RECOMMEND_TIMEOUT_MS = 60_000

// ---------- Team setup review (phase 2): re-checked on demand and as work happens ----------

/**
 * Project.teamReview. 'off' = only the manual re-check; 'free' = proactive token-free discovery and run evidence;
 * 'ai' (default) = also the one-shot recommend completion (everyday tier) within tokenBudget, at most once per
 * everyRuns finished work runs and only when there is new evidence or new candidates.
 */
export type TeamReviewAuto = 'off' | 'free' | 'ai'
export interface TeamReviewSettings {
  auto: TeamReviewAuto
  /** Most tokens (input + output) one proactive model step may spend. Clamped TEAM_REVIEW_MIN_BUDGET..MAX. */
  tokenBudget: number
  /** The proactive model step runs at most once per this many finished work runs (>= 1). */
  everyRuns: number
}

/** What started a review. 'opened' = the Team tab opened (throttled); 'runEnded' = a work run reached an outcome. */
export type TeamReviewTrigger = 'manual' | 'runEnded' | 'opened'

/**
 * Token-free signals from finished work runs (permission denials, rule requests, tools or connections a role asked
 * for or lacked, repeated tool sequences, repeated corrections). summary is redacted and untrusted.
 */
export type TeamEvidenceKind = 'permissionDenied' | 'ruleRequest' | 'missingTool' | 'missingConnection' | 'repeatedSequence' | 'repeatedCorrection'
export interface TeamEvidence {
  /** Stable for the same signal: `ev-<16 hex>`. */
  id: string
  kind: TeamEvidenceKind
  roleId?: string
  /** Runs it was seen in, newest first, at most 5. */
  runIds: string[]
  /** One plain sentence, redacted (no keys, tokens or long ids), at most 300 chars. */
  summary: string
  count: number
  /** ISO timestamp of the newest sighting. */
  lastSeenAt: string
}

/** A dismissed recommendation: never offered again while the candidate's fingerprint (digest, version, target) is unchanged. */
export interface TeamDismissal {
  candidateId: string
  fingerprint: string
  /** ISO timestamp. */
  at: string
  /**
   * For the "Dismissed (n)" list: the candidate's display name and kind when it was dismissed (clamped untrusted
   * text, no targets or paths). Missing on dismissals saved before 2026-11-01 when the review no longer lists the item.
   */
  name?: string
  kind?: CapabilityKind
  /** The recommendation that was dismissed, when there was one: capabilities:restore puts it back in the pending list. */
  recommendation?: CapabilityRecommendation
}

/** Why the review's model step did not run. */
export type TeamReviewModelSkip = 'autoOff' | 'autoFree' | 'noChange' | 'everyRuns' | 'budget' | 'error' | 'timeout' | 'cancelled' | 'mockFree' | 'pendingFull'

/**
 * The persisted review (<data>/team-reviews/<projectId>.json). recommendations are the pending ones only: applied
 * and dismissed ones are removed. Apply them with capabilities:apply and `digest`; main re-discovers when its
 * in-memory snapshot is gone (after a restart) and refuses when the sources changed. A complete (not partial)
 * capabilities:recommend result is merged in as pending too (newest first, rebinding the review to its discovery), so
 * it survives a restart; `dismissed` is the list the UI can offer to restore (capabilities:restore).
 */
export interface TeamReview {
  projectId: string
  /** ISO timestamp. */
  checkedAt: string
  trigger: TeamReviewTrigger
  /** 'model' when this check ran the recommend completion, else 'free'. */
  mode: 'free' | 'model'
  modelSkipped?: TeamReviewModelSkip
  /** The discovery this review is bound to (secret-free; items capped at CAPABILITY_MAX_ITEMS). */
  discovery: CapabilityDiscovery
  /** Equal to discovery.digest; pass it to capabilities:apply with a recommendation id. */
  digest: string
  /** Items not seen at the previous review. */
  newCandidateIds: string[]
  recommendations: CapabilityRecommendation[]
  gaps: CapabilityGap[]
  evidence: TeamEvidence[]
  dismissed: TeamDismissal[]
  /** recommendations.length: the Team tab badge. */
  pendingCount: number
  /** Finished work runs since the last model step (drives everyRuns). */
  runsSinceModel: number
  /** Tokens the last model step spent, when known. */
  tokensUsed?: number
  /**
   * What the model step of this review was sent (missing = no model step ran). 'proactive' = an automatic review
   * (runEnded): repo, project, library and catalog items in full, but local-machine items (origin 'local') only as
   * kind, name and redacted target, never their descriptions or paths. 'full' = the user's manual Re-check: every item.
   */
  modelInput?: TeamReviewModelInput
  /**
   * Written only to hold a dismissal made on a fresh capabilities:recommend result before any review ran: nothing
   * was checked, so the 'opened' throttle never returns it and the next review runs in full.
   */
  stub?: true
}

/** TeamReview.modelInput: which data classes the review's model step was sent. */
export type TeamReviewModelInput = 'proactive' | 'full'

/** capabilities:reviewUpdated push and the badge source. */
export interface TeamReviewSummary {
  projectId: string
  checkedAt: string
  trigger: TeamReviewTrigger
  mode: 'free' | 'model'
  pendingCount: number
  newCount: number
  evidenceCount: number
}

/** capabilities:review input: the manual "Re-check setup" (trigger 'manual') or the Team tab opening ('opened', throttled). */
export interface TeamReviewInput {
  projectId: string
  trigger?: 'manual' | 'opened'
  requestId?: string
  /** Manual only: also fetch outside sources. Proactive reviews never go outside. */
  includeOutside?: boolean
  /** Manual only: run the recommend completion now (the user's explicit call; not gated by auto or everyRuns). */
  useModel?: boolean
}

/**
 * capabilities:dismiss input: a recommendation id (from the persisted review or a fresh capabilities:recommend
 * result still held in main) and/or a candidate id; at least one. Main fingerprints the candidate it finds there and
 * persists the dismissal in the project's review (starting one bound to that discovery when none exists yet).
 */
export interface TeamDismissInput {
  projectId: string
  recommendationId?: string
  candidateId?: string
}

/**
 * capabilities:restore input: forget the dismissal of `candidateId` so it can be offered again. When the dismissal
 * held a recommendation whose candidate is unchanged and still useful, it returns to the pending list.
 */
export interface TeamRestoreInput {
  projectId: string
  candidateId: string
}

/**
 * Most recommendations an automatic review (runEnded, opened) adds to the pending list: it never drops pending
 * ones, and adds new ones only while fewer than this are pending (at least one when nothing is). Manual Re-check and
 * capabilities:recommend results are not capped by it (CAPABILITY_MAX_RECOMMENDATIONS).
 */
export const TEAM_REVIEW_PROACTIVE_LIMIT = 5
export const TEAM_REVIEW_MIN_BUDGET = 1_000
export const TEAM_REVIEW_MAX_BUDGET = 500_000
export const TEAM_REVIEW_MAX_EVERY_RUNS = 100
/** An 'opened' review with nothing changed is skipped when the last check is newer than this. */
export const TEAM_REVIEW_OPEN_THROTTLE_MS = 10 * 60_000
/** Dismissals kept per project (oldest dropped). */
export const TEAM_REVIEW_MAX_DISMISSED = 500

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
    /** A project id string or ProjectRemoveInput (removeRuns default true; engagements always remove their runs). */
    remove(input: string | ProjectRemoveInput): Promise<ProjectRemoveResult>
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
    applyImport(input: AgentImportApplyInput): Promise<AgentImportApplyResult>
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
    /** Store or clear one proxy's key in safeStorage. Write-only: the key never comes back. */
    setSecret(input: ConnectionSecretInput): Promise<ConnectionInfo>
    /** Add a proxy connection (see ProxyCreateInput). Resolves to its ConnectionInfo (not yet connected). */
    createProxy(input: ProxyCreateInput): Promise<ConnectionInfo>
    /** Delete a proxy connection (see ProxyRemoveResult for what is refused and what goes). */
    removeProxy(id: string): Promise<ProxyRemoveResult>
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
    /**
     * Pick the default connection (marks it chosen) or, with null, return to automatic. Resolves to connections:list
     * after the change; rejects with a readable message naming the connection when it is not usable.
     */
    setDefault(id: ConnectionDefaultInput): Promise<ConnectionInfo[]>
  }
  models: {
    /** The model catalog: builtin plus discovered, for one connection or every enabled one. */
    list(query?: ModelsQuery): Promise<ProviderModel[]>
    /** Re-discover models (LiteLLM /v1/models and /model/info, Codex model/list) and return the new catalog. */
    refresh(query?: ModelsQuery): Promise<ProviderModel[]>
    /**
     * Every price OrgAI knows, for a pricing table: user overrides, LiteLLM proxy prices from the catalog and the
     * built-in table, each with its source. An overridden model is listed once per source.
     */
    prices(query?: ModelPricesQuery): Promise<ModelPriceInfo[]>
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
  /**
   * Connectors: curated presets (src/shared/connectors.ts) that become MCP library entries. Authorize, test,
   * link, revoke and remove reuse mcp.authorize ({ libraryId }), mcpLibrary.test, mcp.linkLibrary, mcp.revokeAuth
   * and mcpLibrary.remove. Changes arrive through onMcpLibraryChanged (re-read connectors.list then).
   */
  connectors: {
    /** Every preset in catalog order, with its library entry and state. */
    list(): Promise<ConnectorInfo[]>
    /**
     * Create the library entry from the preset (main builds url, headers and secret slots; nothing else is taken
     * from the renderer). Idempotent: an existing entry for that connector is returned unchanged, except that while
     * it is not connected a different valid variant switches it in place (the old variant's token or OAuth state is
     * dropped); a connected entry keeps its variant until disconnected. Broadcasts mcpLibrary:changed when it
     * creates or switches one.
     */
    add(input: ConnectorAddInput): Promise<McpLibraryInfo>
    /** 'token' connectors: store (or clear) the token as the entry's secret header. Rejects before add. */
    setToken(input: ConnectorTokenInput): Promise<McpLibraryInfo>
  }
  /** Project skills, repo import and skill evaluation. Every mutation returns the saved project. */
  skills: {
    /** The project's skills (linked ones refreshed from the library) with their role grants. */
    list(projectId: string): Promise<SkillInfo[]>
    /** SKILL.md and the file list of one project skill (a linked one reads the library entry's files). */
    read(input: { projectId: string; skillId: string }): Promise<SkillContent>
    /** Write a new project skill (source 'user'). Rejects on an invalid or duplicate name, or a too long body. */
    create(input: SkillCreateInput): Promise<SkillMutationResult>
    /** Rewrite SKILL.md, toggle enabled or replace the granted roles. A linked skill takes only enabled and roleIds. */
    update(input: SkillUpdateInput): Promise<SkillMutationResult>
    /** Remove a project skill and its files and drop it from every Role.skills. A linked skill is only unlinked. */
    remove(input: { projectId: string; skillId: string }): Promise<SkillMutationResult>
    /** Add a library entry to the project by reference. Rejects when the project already has a skill of that name. */
    linkLibrary(input: SkillLinkLibraryInput): Promise<SkillMutationResult>
    /** Copy a project-only skill into the library and relink it. Rejects when the library already has that name. */
    promote(input: { projectId: string; skillId: string }): Promise<SkillMutationResult>
    /**
     * Scan the project's folder (SKILL_REPO_ROOTS, untrusted, read-only, token-free) and show what an import would do.
     * Saves nothing. Never rejects for a missing root.
     */
    previewImport(input: SkillImportInput): Promise<SkillImportPreview>
    /** Re-scan, check the preview's digest, copy the chosen skills into OrgAI and grant them. */
    applyImport(input: SkillImportApplyInput): Promise<SkillImportApplyResult>
    /** Restore the skills, files and grants an applyImport replaced. Rejects when the undo expired. */
    undoImport(input: { projectId: string; undoId: string }): Promise<SkillMutationResult>
    /**
     * Start the Skill assistant session (RunKind 'skill-assist'); its proposals (kind 'skills') are answered with
     * setup.decide. scope 'library' runs it on the virtual project SKILLS_PROJECT_ID.
     */
    startAssist(input: SkillAssistInput): Promise<RunSummary>
    /**
     * Run the skill evaluation now: deterministic checks over the skills and the newest runs, plus (only with
     * Project.skillEvaluation.enabled and within its tokenBudget) a one-shot model call drafting up to 3 suggestions.
     * Persists and returns the report. Never applies anything.
     */
    evaluate(projectId: string): Promise<SkillEvaluationReport>
    /** The last persisted report, or null. */
    lastEvaluation(projectId: string): Promise<SkillEvaluationReport | null>
    /** Create a project skill (source 'suggestion') from a suggestion of the last report, on the user's explicit call. */
    applySuggestion(input: SkillApplySuggestionInput): Promise<SkillMutationResult>
  }
  /** The app-wide skill library. Every mutation also broadcasts skillLibrary:changed. */
  skillLibrary: {
    list(): Promise<SkillLibraryInfo[]>
    read(input: { libraryId: string }): Promise<SkillContent>
    /** Write a new library entry from a draft. Name unique within the library. */
    create(draft: SkillDraft): Promise<SkillLibraryInfo[]>
    /**
     * Copy one skill folder (SKILL.md at its top; untrusted, same caps and checks as the repo import) into the library.
     * `path` must be a folder the user just chose with projects.pickDirectory() (main remembers the last 20 picks);
     * any other path is refused, as are UNC and device paths.
     */
    addFromFolder(input: SkillLibraryFolderInput): Promise<SkillLibraryInfo[]>
    /** Rewrite an entry's SKILL.md (resource files kept). Linked projects see it on their next read. */
    update(input: { libraryId: string; draft: SkillDraft }): Promise<SkillLibraryInfo[]>
    /** Delete an entry and its files, unlink it from every project and drop the Role.skills grants to those links. */
    remove(input: { libraryId: string }): Promise<SkillLibraryInfo[]>
  }
  /** The skill library changed. Returns an unsubscribe function. */
  onSkillLibraryChanged(cb: (entries: SkillLibraryInfo[]) => void): () => void
  /**
   * The Team assistant (src/main/capabilities/). discover and recommend never write; recommend is a one-shot completion
   * (everyday tier, 60 s) and never a run. Mutations broadcast a project.updated RunEvent so every Role tab updates.
   */
  capabilities: {
    /** Read-only discovery over local sources (and outside ones with includeOutside). Never rejects for a bad file. */
    discover(input: CapabilityDiscoverInput): Promise<CapabilityDiscovery>
    /** Discovery plus per-role recommendations and gaps. Falls back to keyword matching (mode 'fallback') on error. */
    recommend(input: CapabilityRecommendInput): Promise<TeamRecommendations>
    /** Stop a running discover/recommend by requestId: it resolves with what it has (partial). */
    cancel(input: { requestId: string }): Promise<void>
    /** Apply one recommendation or candidate to the chosen roles only. Refuses a stale or missing digest. */
    apply(input: CapabilityApplyInput): Promise<CapabilityApplyResult>
    /** Reverse the project's last apply. Rejects when the undo expired. */
    undo(input: CapabilityUndoInput): Promise<CapabilityUndoResult>
    /**
     * Re-check the team setup and persist the review. trigger 'manual' (default) always runs; 'opened' is throttled
     * (TEAM_REVIEW_OPEN_THROTTLE_MS when nothing changed) and returns the last review instead. Never goes outside
     * unless includeOutside on a manual check; spends tokens only with useModel (manual) or Project.teamReview.auto 'ai'.
     */
    review(input: TeamReviewInput): Promise<TeamReview>
    /** The persisted review, or null. */
    lastReview(projectId: string): Promise<TeamReview | null>
    /** Drop one pending recommendation and remember it so it never returns while its candidate is unchanged. */
    dismiss(input: TeamDismissInput): Promise<TeamReview>
    /** Undo a dismissal (TeamReview.dismissed): the candidate may be offered again; its recommendation returns when still useful. */
    restore(input: TeamRestoreInput): Promise<TeamReview>
  }
  /** A review was saved (manual, proactive or after apply/dismiss). Returns an unsubscribe function. */
  onTeamReviewUpdated(cb: (summary: TeamReviewSummary) => void): () => void
  /** Progress of a discover/recommend started with a requestId. Returns an unsubscribe function. */
  onCapabilityProgress(cb: (event: CapabilityProgressEvent) => void): () => void
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
    start(input: SetupStartInput): Promise<RunSummary>
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
    /**
     * Usage per run, per role and as trend buckets for one project, from persisted run summaries. Rejects for an
     * unknown project. Never spends tokens.
     */
    usageStats(query: UsageStatsQuery): Promise<UsageStats>
    /** The same rows as usageStats as CSV text (USAGE_CSV_COLUMNS), at most USAGE_STATS_MAX_LIMIT rows. */
    usageCsv(query: UsageStatsQuery): Promise<string>
    /**
     * Usage across every project (stored, virtual assistant projects and a removed project's leftover runs): per-run
     * rows (newest first, limited), rollups per project, model, role and connection, trend buckets with a per-project
     * breakdown, and totals over every matched run (see UsageOverview). Rejects a malformed month or project id list.
     * Never spends tokens. The query may be omitted (every project, every kind, all time).
     */
    usageOverview(query?: UsageOverviewQuery): Promise<UsageOverview>
    /**
     * The overview's runs as CSV text (USAGE_OVERVIEW_CSV_COLUMNS, same quoting as usageCsv), each row with its own
     * project and client names, newest first, at most USAGE_STATS_MAX_LIMIT rows (the query's limit is ignored).
     */
    usageOverviewCsv(query?: UsageOverviewQuery): Promise<string>
    /**
     * Start a quick run (the Chat assistant): a project-less work run on QUICK_PROJECT_ID (RunSummary.quick set).
     * Rejects on an empty or too long prompt (QUICK_RUN_MAX_PROMPT_CHARS) or an invalid folder.
     */
    startQuick(input: QuickRunInput): Promise<RunSummary>
    /** Save a quick run's session chain as a new project (see QuickRunPromoteResult). */
    promoteQuick(input: QuickRunPromoteInput): Promise<QuickRunPromoteResult>
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
    /** Saved rules OrgAI ignores (too broad, destructive or with a hidden character) with why; remove() deletes them. */
    ignored(projectId: string): Promise<IgnoredPermissionRule[]>
    /** Remove one saved allow rule (also an ignored one, by its exact text); returns the remaining usable rules. */
    remove(input: { projectId: string; rule: string }): Promise<string[]>
    /** Save one allow rule (validated); returns the full list. Live runs of the project honour it at once. */
    add(input: { projectId: string; rule: string }): Promise<string[]>
    /** Answer a request_permission_rules card. */
    decideRequest(input: { runId: string; requestId: string; decision: PermissionRuleDecision }): Promise<void>
  }
  onRunEvent(cb: (event: RunEvent) => void): () => void
  /** A clicked OS notification asks the renderer to show this run. */
  onFocusRun(cb: (target: FocusRunTarget) => void): () => void
  /**
   * An application menu item routed to the renderer was chosen (File / View / Run / Help ...). Only names in
   * MENU_ACTIONS are delivered. Returns an unsubscribe function.
   */
  onMenuAction(cb: (action: MenuAction) => void): () => void
  menu: {
    /** Tell main what this window shows so the application menu greys out items that do not apply. Send on change. */
    setState(state: MenuState): Promise<void>
  }
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
    /** The orgai command shim's state (cli-spec 7(3)). Never rejects. */
    cliShimStatus(): Promise<CliShimStatus>
    /** Write or refresh the orgai command shim. Never rejects; failures come back as ok: false with a message. */
    installCliShim(): Promise<CliShimResult>
    /** Remove the orgai command shim (only OrgAI's own). Never rejects; failures come back as ok: false. */
    uninstallCliShim(): Promise<CliShimResult>
    /**
     * app:reference: search or read OrgAI's own reference (the atlas of screens and settings, menus, shortcuts,
     * harness tools, host channels, CLI commands, connectors and bundled docs), locate a setting or feature, or a
     * secret-free status snapshot. Everything in `text` is fenced data.
     */
    reference(query: AppReferenceQuery): Promise<AppReferenceResult>
  }
}

// ---- Team templates, single-agent runs, engagement context, usage export ----

/** Most saved team templates (`<data>/org-templates/templates.json`). Saving one more is refused. */
export const ORG_TEMPLATES_MAX = 100
/** Template name: 1..80 characters, no control or hidden characters. */
export const ORG_TEMPLATE_NAME_MAX_CHARS = 80
/** Template description: at most 500 characters (tab and line breaks allowed, other hidden characters refused). */
export const ORG_TEMPLATE_DESCRIPTION_MAX_CHARS = 500

/**
 * One saved team template (templates:list). The chart itself lives in `<data>/org-templates/<id>/org.json`, format
 * 'orgai.org/1' (the same document projects:exportOrg writes and the agent importer reads): roles with slug
 * references, no ids, positions, secrets, MCP or skill grants.
 */
export interface OrgTemplateInfo {
  id: string
  name: string
  description: string
  /** The kind of the project the template was saved from. */
  kind: ProjectKind
  roleCount: number
  /** Role names in chart order (root first), at most ORG_TEMPLATE_ROLE_NAMES_MAX. */
  roleNames: string[]
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
}

/** Most role names kept on an OrgTemplateInfo. */
export const ORG_TEMPLATE_ROLE_NAMES_MAX = 40

/** templates:saveFromProject input. */
export interface OrgTemplateSaveInput {
  projectId: string
  name: string
  description?: string
}

/**
 * templates:apply input: the template's chart through the agent-import convert path (models mapped to the project's
 * connection). 'replace' drops the chart, 'merge' adds under its root. Result: AgentImportApplyResult (Undo = save
 * previousRoles through projects:save).
 */
export interface OrgTemplateApplyInput {
  projectId: string
  templateId: string
  mode: 'replace' | 'merge'
}

/**
 * Who works on a work run of a real project. 'single' = one root role "Assistant" built from the project (no
 * spawning, the union of the project's role tools, every enabled MCP server, every project skill, the project's
 * permission mode; plan nudges and run messaging off). Missing = the project's org chart. Never on setup-like runs.
 * StartRunInput.team / RunSummary.team; continuations keep it.
 */
export type RunTeam = 'single'

/**
 * Harness tool of engagement work runs (every role) and single-agent runs: lists context notes, reads one, or saves
 * an agent-written note (`action: 'list' | 'read' | 'save'`; no action and no noteId = list, a noteId alone = read).
 */
export const ENGAGEMENT_CONTEXT_TOOL = 'engagement_context'
/** engagement_context: at most this many characters of a note per call (the rest is reported as cut). */
export const ENGAGEMENT_CONTEXT_TOOL_MAX_CHARS = 20_000

/** projects:updateEngagementDocument: the longest engagement document accepted (longer is refused, never cut). */
export const ENGAGEMENT_DOCUMENT_MAX_CHARS = 100_000

/** projects:engagementDocument result. Empty text and no updatedAt when there is none (always for code projects). */
export interface EngagementDocumentInfo {
  text: string
  /** Epoch ms of the file's last write. */
  updatedAt?: number
  /** Who wrote it last: the user (editor) or setup (the approved charter). Present whenever updatedAt is. */
  updatedBy?: 'user' | 'setup'
}

/** projects:updateEngagementDocument input (engagements only). Hidden characters other than tab, LF and CR are refused. */
export interface EngagementDocumentUpdate {
  projectId: string
  text: string
  /**
   * The updatedAt the editor loaded (0 or undefined = no document yet). The save is refused when the stored document
   * changed since; omitted while a document exists is refused too.
   */
  expectedUpdatedAt?: number
}

/** Context notes per project (`<data>/projects/<id>/context/<noteId>.md` plus an index). Agents write notes too (see EngagementNote.source). */
export const ENGAGEMENT_NOTES_MAX = 200
export const ENGAGEMENT_NOTE_MAX_CHARS = 50_000
export const ENGAGEMENT_NOTE_TITLE_MAX_CHARS = 120

/** Who wrote a context note: the user (missing = user, notes saved before the field existed) or an agent through engagement_context. */
export type EngagementNoteSource = 'user' | 'agent'

/**
 * Who is saving a note (store/projectData.ts saveNote): the user (IPC; default) or an agent (engagement_context save,
 * with the run id and the role name or slug RunManager resolved). An agent may replace only an agent-written note.
 */
export type EngagementNoteWriter = { by: 'user' } | { by: 'agent'; runId?: string; role?: string }

/** Longest note excerpt kept in the index. */
export const ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS = 120

/**
 * One context note in the index (projects:listNotes). The renderer orders by `createdAt`, so agent writes never
 * reshuffle the list. Rows saved before these fields existed read as: excerpt and createdAt from the file (createdAt
 * = updatedAt), source user, no recordedBy / updatedBy / retired.
 */
export interface EngagementNote {
  id: string
  /** 1..120 characters, no control or hidden characters. */
  title: string
  /** The first non-empty line of the text, at most ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS, hidden characters stripped. */
  excerpt: string
  /** Epoch ms of the first save (stable). */
  createdAt: number
  /** Epoch ms of the last save. */
  updatedAt: number
  /** Length of the note's text. */
  chars: number
  /**
   * Who created it; missing = 'user'. Main fills it, never the renderer or the agent. An agent may replace only a
   * note whose source is 'agent' and that the user has not edited since (updatedBy !== 'user'); any other note is
   * read-only to agents ("Only the user can change that note; save a new one instead.").
   */
  source?: EngagementNoteSource
  /** The creating run and the writing agent's role name or slug (agent notes only; main fills it from the run's agent record). */
  recordedBy?: { runId?: string; role?: string }
  /** Who saved it last (absent until the first save after creation). */
  updatedBy?: EngagementNoteSource
  /**
   * A user-set flag (projects:saveNote `retired`), reversible: the note stays, lists mark it, reads still return it,
   * the tool's list marks it. Agents cannot set or clear it.
   */
  retired?: boolean
}

/** projects:getNote result. */
export interface EngagementNoteContent extends EngagementNote {
  text: string
}

/** projects:getNote / projects:removeNote input. */
export interface EngagementNoteRef {
  projectId: string
  noteId: string
}

/**
 * projects:saveNote input. Without noteId a new note is created (refused at ENGAGEMENT_NOTES_MAX: "A project keeps at
 * most 200 notes. Remove or merge notes first."); with one, that note is replaced (a user save of an agent note keeps
 * source 'agent' and sets updatedBy 'user', which makes it read-only to agents).
 */
export interface EngagementNoteSaveInput {
  projectId: string
  noteId?: string
  title: string
  /** At most ENGAGEMENT_NOTE_MAX_CHARS; hidden characters other than tab, LF and CR are refused. */
  text: string
  /** Sets or clears the user's retired flag (omitted = unchanged). */
  retired?: boolean
  /**
   * Only with noteId: refuse the save when the stored note's updatedAt differs (compare-and-set, code
   * 'stale_revision'; cli-spec Wave 5 `orgai notes edit`). Omitted = no check (the app's note dialog).
   */
  expectedUpdatedAt?: number
}

/**
 * main -> renderer push (IPC projectsEngagementChanged) after the document, a note or the knowledge graph was written
 * or removed, by the user (IPC) or by an agent (engagement_context save, engagement_knowledge writes). `ids` names the
 * note ids ('notes') or the node / edge ids ('knowledge') the write touched, so the renderer can refresh one row and
 * announce it; absent for the document and for knowledge:clear.
 */
export interface EngagementChangedEvent {
  projectId: string
  what: 'document' | 'notes' | 'knowledge'
  ids?: string[]
}

/**
 * projects:remove input (a bare project id string is still accepted). `removeRuns` default true for both kinds
 * (the behaviour before this flag existed). An engagement always removes its runs ("forget engagement"): false is
 * ignored there. A code project with removeRuns false keeps its run records (orphaned, still in RunStore).
 */
export interface ProjectRemoveInput {
  projectId: string
  removeRuns?: boolean
}

/** projects:remove result: what was deleted, for the renderer's notice. Best effort: a failed delete is not counted. */
export interface ProjectRemoveResult {
  projectId: string
  kind: ProjectKind
  /** Run records deleted (index entries with their transcripts). */
  runsRemoved: number
  /** Run records left in place (code project with removeRuns false). */
  runsKept: number
  /** Context notes deleted. */
  notesRemoved: number
  /** Project skills whose stored files were deleted. */
  skillsRemoved: number
  /** `<data>/projects/<id>/ENGAGEMENT.md` existed and was deleted. */
  documentRemoved: boolean
  /** App-folder saved rules (`<data>/projects/<id>/permission-rules.json`) existed and were deleted. */
  rulesRemoved: boolean
  /** The Team review file (`<data>/team-reviews/<id>.json`) existed and was deleted. */
  teamReviewRemoved: boolean
  /** The skill evaluation file (`<data>/skill-evaluations/<id>.json`) existed and was deleted. */
  skillEvaluationRemoved: boolean
  /** Knowledge graph nodes deleted with `<data>/projects/<id>/knowledge.json` (0 when there was no graph). */
  knowledgeRemoved: number
}

/**
 * UsageStatsQuery.range: a local calendar month as 'YYYY-MM' (months 01..12, years 2000..2999). Sugar over
 * since / until (local midnight of the 1st to local midnight of the next month's 1st); it wins over both. A malformed
 * month is refused.
 */
export interface UsageStatsRange {
  month: string
}

/**
 * runs:usageCsv columns, in order. One row per run (UsageStats.runs, newest first, at most USAGE_STATS_MAX_LIMIT rows);
 * project is the project name and client is Project.client (blank for code projects), the same on every row (the
 * query is one project). started / ended are local time as ISO 8601 with the UTC offset (2026-11-04T09:15:00-05:00),
 * started_utc is the start as ISO 8601 UTC; cost blank when unknown, cost_partial 'true' / ''. RFC 4180 quoting (CRLF
 * line ends, a header row); a cell starting with = + - @ (or tab / CR) gets a leading single quote (formula injection).
 * There is no run id column.
 */
export const USAGE_CSV_COLUMNS = [
  'project',
  'client',
  'started',
  'started_utc',
  'ended',
  'kind',
  'status',
  'title',
  'roles',
  'tokens_in',
  'tokens_out',
  'tokens_cache_read',
  'tokens_cache_write',
  'cost_usd',
  'cost_partial'
] as const

/**
 * runs:usageOverviewCsv columns, in order: USAGE_CSV_COLUMNS (unchanged; cache is already in tokens_cache_read /
 * tokens_cache_write) followed by project_kind (UsageProjectKind), connection (the id, blank when unknown), retries,
 * nudges, no_result_tokens and idle_ms. One row per UsageOverview.runs entry with its own project and client; same
 * quoting, time formats and BOM as runs:usageCsv. Declared after USAGE_CSV_COLUMNS on purpose (module order).
 */
export const USAGE_OVERVIEW_CSV_COLUMNS = [...USAGE_CSV_COLUMNS, 'project_kind', 'connection', 'retries', 'nudges', 'no_result_tokens', 'idle_ms'] as const
/** Channels of this section; spread into IPC. */
export const TEMPLATE_ENGAGEMENT_IPC = {
  templatesList: 'templates:list',
  templatesSaveFromProject: 'templates:saveFromProject',
  templatesRemove: 'templates:remove',
  templatesApply: 'templates:apply',
  projectsEngagementDocument: 'projects:engagementDocument',
  projectsUpdateEngagementDocument: 'projects:updateEngagementDocument',
  projectsListNotes: 'projects:listNotes',
  projectsGetNote: 'projects:getNote',
  projectsSaveNote: 'projects:saveNote',
  projectsRemoveNote: 'projects:removeNote',
  /** main -> renderer push channel carrying EngagementChangedEvent. */
  projectsEngagementChanged: 'projects:engagementChanged',
  runsUsageCsv: 'runs:usageCsv',
  /** Same input as projects:remove; returns the counts it would produce, deleting nothing. */
  projectsRemovePreview: 'projects:removePreview'
} as const

/** window.orgai additions of this section (declaration-merged into OrgAIApi). */
export interface OrgAIApi {
  templates: {
    list(): Promise<OrgTemplateInfo[]>
    /** Save the project's chart (no ids, positions, secrets or grants) as a new template. Rejects at ORG_TEMPLATES_MAX. */
    saveFromProject(input: OrgTemplateSaveInput): Promise<OrgTemplateInfo>
    /** Resolves to the remaining templates. */
    remove(templateId: string): Promise<OrgTemplateInfo[]>
    apply(input: OrgTemplateApplyInput): Promise<AgentImportApplyResult>
  }
  engagement: {
    document(projectId: string): Promise<EngagementDocumentInfo>
    updateDocument(input: EngagementDocumentUpdate): Promise<EngagementDocumentInfo>
    listNotes(projectId: string): Promise<EngagementNote[]>
    getNote(ref: EngagementNoteRef): Promise<EngagementNoteContent>
    saveNote(input: EngagementNoteSaveInput): Promise<EngagementNote>
    /** Resolves to the remaining notes. */
    removeNote(ref: EngagementNoteRef): Promise<EngagementNote[]>
  }
  onEngagementChanged(cb: (event: EngagementChangedEvent) => void): () => void
  projectRemoval: {
    /** What projects:remove would delete for the same input (counts), without deleting anything. */
    preview(input: string | ProjectRemoveInput): Promise<ProjectRemoveResult>
  }
}

// ---- Engagement knowledge graph ----
//
// Per engagement, agents and the user build a graph of the engagement: entities of free-form kinds (person,
// organisation, system, document, decision, risk, ...), relations of free-form types between them, and facts on each
// entity, every item with provenance. Stored at `<data>/projects/<id>/knowledge.json` (version 1, atomic writes, junk
// dropped on read, never in the working folder). Agents reach it through the `engagement_knowledge` harness tool on
// engagement work runs; the user through the knowledge:* channels (reads for any project, writes for engagements only).
// Every write, by whom ever, pushes projects:engagementChanged with what 'knowledge'.
// Pure helpers (normalisation, vocabulary, search, identity matching) live in src/shared/knowledge.ts.

/** Most nodes one graph keeps; a save past it is refused ("The knowledge graph is full ..."). */
export const KNOWLEDGE_NODES_MAX = 2000
/** Most edges one graph keeps. */
export const KNOWLEDGE_EDGES_MAX = 5000
/** Most facts one node keeps (append-only for agents; the user may remove facts). */
export const KNOWLEDGE_NODE_FACTS_MAX = 50
/** Most writes (node upserts, links, retirements and saved notes) one run may make through the harness tools. */
export const KNOWLEDGE_RUN_WRITES_MAX = 500
/** Most hits engagement_knowledge search returns (also its default). */
export const KNOWLEDGE_SEARCH_LIMIT = 50
/**
 * Largest knowledge.json the store reads or writes (64 MB; the file is compact JSON). A larger file reads as empty
 * and every write refuses ("could not be read"); a write whose serialized graph would cross it is refused ("The
 * knowledge graph file is full ..."), nothing written. A full graph (2,000 nodes with 50 facts of 1,000 characters)
 * could exceed it, so the cap is real, not theoretical.
 */
export const KNOWLEDGE_FILE_MAX_BYTES = 64 * 1024 * 1024
/** Node name: 1..120 characters, one line, no hidden characters. Aliases the same. */
export const KNOWLEDGE_NAME_MAX_CHARS = 120
/** Most aliases per node. */
export const KNOWLEDGE_ALIASES_MAX = 10
/** Node summary: at most 2,000 characters (tab, LF and CR allowed; other hidden characters refused). */
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 2000
/** Fact text: 1..1,000 characters (tab, LF and CR allowed). */
export const KNOWLEDGE_FACT_MAX_CHARS = 1000
/** Edge note: at most 500 characters (tab, LF and CR allowed). */
export const KNOWLEDGE_EDGE_NOTE_MAX_CHARS = 500
/** Most context notes a node links to. */
export const KNOWLEDGE_NODE_NOTES_MAX = 20
/**
 * A node kind or edge relation after normalisation (knowledge.ts `normalizeKnowledgeKey`: trim, lower-case, runs of
 * whitespace and underscores to '-'): 1..40 characters of a-z, 0-9 and '-', starting with a letter or digit.
 */
export const KNOWLEDGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/**
 * Kinds the tool suggests so agents pick consistent names (data, not a closed list: any key that matches
 * KNOWLEDGE_KEY_RE is accepted).
 */
export const KNOWLEDGE_COMMON_KINDS = ['person', 'organisation', 'system', 'document', 'decision', 'risk', 'requirement', 'deadline', 'meeting', 'open-question'] as const
/**
 * Relations the tool suggests so agents pick consistent names (a hint like KNOWLEDGE_COMMON_KINDS, not a closed list).
 * The judgement-based connections of docs/design/knowledge-connections.md are recorded by agents under these names.
 */
export const KNOWLEDGE_COMMON_RELATIONS = ['works-at', 'reports-to', 'owns', 'depends-on', 'affects', 'decided-by', 'evidence-for', 'mitigates', 'supersedes', 'contradicts', 'can-answer', 'raised-by'] as const
/** Harness tool of engagement work runs (every role): vocabulary, search, get, upsert_node, link, retire. */
export const KNOWLEDGE_TOOL = 'engagement_knowledge'
/**
 * Read-only harness tool of engagement work runs and single (Ask) engagement runs, every role: one budgeted, ranked
 * answer in place of vocabulary + search + get. On no other kind of run.
 */
export const KNOWLEDGE_RECALL_TOOL = 'knowledge_recall'
/** knowledge_recall budget in characters of the whole result: default, floor and ceiling. */
export const KNOWLEDGE_RECALL_BUDGET_DEFAULT = 1500
export const KNOWLEDGE_RECALL_BUDGET_MIN = 400
export const KNOWLEDGE_RECALL_BUDGET_MAX = 6000
/** Longest knowledge_recall query; longer is refused, never cut. */
export const KNOWLEDGE_RECALL_QUERY_MAX_CHARS = 500
/** The standing index in the prompt (knowledgeBrief): at most this many characters, omitted for an empty graph. */
export const KNOWLEDGE_BRIEF_MAX_CHARS = 600
/** One knowledgeContext block, framing and fences included. */
export const KNOWLEDGE_CONTEXT_MAX_CHARS = 800
/** knowledgeContext reads at most this many characters of the incoming text when it looks for names. */
export const KNOWLEDGE_CONTEXT_SCAN_MAX_CHARS = 64 * 1024
/** Most node ids on one knowledge.recalled event (the newest are kept). */
export const KNOWLEDGE_RECALLED_IDS_MAX = 50
/** Most links inferKnowledgeLinks returns, strongest first. */
export const KNOWLEDGE_INFERRED_LINKS_MAX = 500
/** A name or alias of more tokens than this is not matched as a mention of its entity (it stays searchable and resolvable). */
export const KNOWLEDGE_NAME_TOKENS_MAX = 8
/** Most characters between two tokens of a name in matched text ("Billing - Core"); a longer gap breaks the name. */
export const KNOWLEDGE_NAME_GAP_MAX = 8
/** Most entities one name matches at a span (past it the span is ambiguous anyway and is never suggested). */
export const KNOWLEDGE_SAME_NAME_MAX = 16
/**
 * Work one inference pass may do on the main thread, in tokens scanned plus trie steps plus matches (a pair seen for the
 * first time counts more: it costs an evidence snippet). Past it the pass stops and KnowledgeInferredResult.partial says so.
 */
export const KNOWLEDGE_MATCH_BUDGET = 4_000_000
/** Most dismissed inferred link ids a graph keeps (oldest dropped). */
export const KNOWLEDGE_DISMISSED_LINKS_MAX = 2000
/** An inferred link id: stable hash of basis and endpoints. */
export const KNOWLEDGE_LINK_ID_RE = /^kl_[a-f0-9]{16}$/
/** engagement_knowledge actions. */
export const KNOWLEDGE_TOOL_ACTIONS = ['vocabulary', 'search', 'get', 'upsert_node', 'link', 'retire'] as const
export type KnowledgeToolAction = (typeof KNOWLEDGE_TOOL_ACTIONS)[number]

/**
 * Who wrote an item. `by: 'user'` comes from the knowledge:* channels (no run); `by: 'agent'` from the harness tool,
 * with the run, the agent id and the agent's role (the role name or slug as recorded on the run; main fills every
 * field, the agent never names itself). `at` is epoch ms.
 */
export interface KnowledgeSource {
  by: 'user' | 'agent'
  runId?: string
  agentId?: string
  role?: string
  at: number
}

/**
 * One fact on a node. Ids are `kf_<hex>`. Facts are append-only for agents (they may only retire their own or other
 * agents' facts); the user may edit, remove or retire any fact through knowledge:saveNode.
 */
export interface KnowledgeFact {
  id: string
  /** 1..KNOWLEDGE_FACT_MAX_CHARS, tab / LF / CR allowed, other hidden characters refused, never cut. */
  text: string
  source: KnowledgeSource
  /** Marked retired (kept for history, shown as such, left out of search). */
  retired?: boolean
}

/** One entity of the engagement. Ids are `kn_<hex>`. */
export interface KnowledgeNode {
  id: string
  /** A normalised key (KNOWLEDGE_KEY_RE), e.g. 'person', 'organisation', 'system', 'decision'. */
  kind: string
  /** 1..KNOWLEDGE_NAME_MAX_CHARS, one line. Unique per kind together with the aliases, case-insensitively. */
  name: string
  /** At most KNOWLEDGE_ALIASES_MAX, each like a name; identity matching uses them like the name. */
  aliases?: string[]
  /** At most KNOWLEDGE_SUMMARY_MAX_CHARS. */
  summary?: string
  /** At most KNOWLEDGE_NODE_FACTS_MAX. */
  facts: KnowledgeFact[]
  /**
   * Context notes this entity links to (EngagementNote ids): validated against the note index on write, and an id
   * whose note is gone is dropped on read. At most KNOWLEDGE_NODE_NOTES_MAX.
   */
  noteIds?: string[]
  /** Who created it. */
  source: KnowledgeSource
  /** Who last changed it (absent until the first change after creation). */
  updatedBy?: KnowledgeSource
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
  /** Marked retired: kept, listed as retired, left out of search unless asked for; its edges stay. */
  retired?: boolean
}

/**
 * One relation between two nodes. Ids are `ke_<hex>`. `from` and `to` are existing node ids (removing a node removes
 * its edges); (from, to, relation) is unique: linking the same triple again updates the note, never duplicates.
 */
export interface KnowledgeEdge {
  id: string
  from: string
  to: string
  /** A normalised key (KNOWLEDGE_KEY_RE), e.g. 'works-at', 'owns', 'depends-on', 'decided-in'. */
  relation: string
  /** At most KNOWLEDGE_EDGE_NOTE_MAX_CHARS. */
  note?: string
  source: KnowledgeSource
  /** Epoch ms. */
  createdAt: number
  retired?: boolean
}

/** The whole graph (knowledge:get). Empty (no nodes, no edges, no updatedAt) for code projects and before the first write. */
export interface KnowledgeGraph {
  version: 1
  nodes: KnowledgeNode[]
  edges: KnowledgeEdge[]
  /**
   * Inferred link ids (KnowledgeInferredLink.id) the user dismissed: ids only, shape KNOWLEDGE_LINK_ID_RE, at most
   * KNOWLEDGE_DISMISSED_LINKS_MAX (oldest dropped). Tolerant on read: junk entries are dropped, an id whose link no
   * longer exists is harmless. Absent when none.
   */
  dismissedLinks?: string[]
  /** Epoch ms of the last write. */
  updatedAt?: number
}

/** Kinds and relations in use with counts (live, non-retired items), most used first (knowledge.ts `knowledgeVocabulary`). */
export interface KnowledgeVocabulary {
  kinds: { kind: string; count: number }[]
  relations: { relation: string; count: number }[]
}

/** knowledge:saveNode fact input: an id keeps that fact's source (and text edits are the user's); no id = a new user fact. */
export interface KnowledgeFactInput {
  id?: string
  text: string
  retired?: boolean
}

/**
 * knowledge:saveNode input (the user's editor; engagements only). Without nodeId a node is created, and a (kind, name)
 * or (kind, alias) match with an existing node is refused ("... already exists; edit it instead."). With nodeId that
 * node is replaced field by field: `facts` given = the full list afterwards (a fact whose id is left out is removed),
 * omitted = unchanged; `aliases`, `summary`, `noteIds` given replace, omitted keep. Unknown noteIds are refused.
 * `kind` is normalised and must match KNOWLEDGE_KEY_RE.
 */
export interface KnowledgeNodeSaveInput {
  projectId: string
  nodeId?: string
  /**
   * Required without nodeId. With nodeId, omitted keeps the stored value, so an append-only save
   * (`{ projectId, nodeId, appendFacts }`, `orgai knowledge upsert --fact`; cli-spec 3.6) needs no client-side read
   * and never reverts a concurrent rename.
   */
  kind?: string
  /** As `kind`: required without nodeId, omitted with nodeId keeps the stored name. */
  name?: string
  aliases?: string[]
  summary?: string
  facts?: KnowledgeFactInput[]
  noteIds?: string[]
  retired?: boolean
  /** User facts appended atomically inside the store (deduplicated against the node's facts and each other); cli-spec 3.6. */
  appendFacts?: string[]
  /**
   * Only with nodeId: refuse the save when the stored node's updatedAt differs (compare-and-set). Any write to the
   * node bumps updatedAt (an agent's fact append included), so leave it out of a pure append: appends commute.
   */
  expectedUpdatedAt?: number
}

/**
 * Agent-side node write (engagement_knowledge upsert_node, RuntimeContext.knowledge.upsertNode). Identity: nodeId
 * when given (its `kind` must then equal the stored kind, else refused: "That entity is a <stored kind>, not a
 * <given kind> ..."), else a (kind, name) or (kind, alias) match, case-insensitive, else a new node ("created" vs
 * "merged"). On a merge: `aliases` are added (deduped; one another entity of the kind already uses is skipped and
 * reported in `aliasesSkipped`), `summary` replaces when given unless the node is user-created (then it is appended as
 * a fact and `summaryKept` is true), `facts` are appended as new facts with the caller's source (a text already on
 * the node is not appended twice), `noteIds` are added. Nothing is removed.
 */
export interface KnowledgeNodeUpsertInput {
  nodeId?: string
  kind: string
  name: string
  aliases?: string[]
  summary?: string
  facts?: string[]
  noteIds?: string[]
}

/**
 * knowledge:saveNode / upsert result: the node and whether it was created (false = an existing node was updated or
 * merged). The optional fields are filled by the agent upsert only (absent on the user's save).
 */
export interface KnowledgeNodeWriteResult {
  node: KnowledgeNode
  created: boolean
  /** Facts the store actually appended on this call (deduped against the node's live facts). */
  factsAdded?: number
  /** Aliases (the input name included on a merge) dropped because another entity of the kind already uses them. */
  aliasesSkipped?: string[]
  /** The node is user-created, so the agent's summary was appended as a fact instead of replacing the user's summary. */
  summaryKept?: boolean
}

/**
 * knowledge:saveEdge input (engagements only) and the agent link write after name resolution: from / to are node ids.
 * Without edgeId: a (from, to, relation) match updates that edge's note (and un-retires it when `retired` is false),
 * else a new edge. With edgeId: that edge's note / retired change; from, to and relation must equal the stored edge's
 * (a different value is refused: "That relation id names <from> <relation> <to>; from, to and relation cannot
 * change. Remove it and link again.").
 */
export interface KnowledgeEdgeSaveInput {
  projectId: string
  edgeId?: string
  from: string
  to: string
  relation: string
  note?: string
  retired?: boolean
}

export interface KnowledgeEdgeWriteResult {
  edge: KnowledgeEdge
  created: boolean
  /** An agent's note was not applied because the relation is the user's: the user's note stands (same rule as summaryKept). */
  noteKept?: boolean
}

/** knowledge:removeNode / knowledge:removeEdge input. Removing a node removes its edges. Unknown ids are refused. */
export interface KnowledgeItemRef {
  projectId: string
  nodeId?: string
  edgeId?: string
}

/**
 * Agent-side retire (engagement_knowledge retire): exactly one of nodeId / edgeId / factId. Marks the item retired,
 * never deletes. Refused on an item whose source.by is 'user' ("Only the user can change that."). `reason` is kept
 * in the harness transcript row only.
 */
export interface KnowledgeRetireInput {
  nodeId?: string
  edgeId?: string
  factId?: string
  reason?: string
}

/** What an agent retire marked: the item kind, its id and a label for the transcript row (node: "<kind> <name>"; edge: "<from> <relation> <to>"; fact: its text). */
export interface KnowledgeRetireResult {
  item: 'node' | 'edge' | 'fact'
  id: string
  label: string
  /** True when it was already retired (nothing changed, no write counted). */
  alreadyRetired: boolean
}

/** engagement_knowledge search input (knowledge.ts `searchKnowledge`). */
export interface KnowledgeSearchQuery {
  /**
   * Matched per word over name, aliases, kind, summary and live fact texts, ranked (knowledgeIndex.ts rankKnowledge),
   * with the old whole-query case-insensitive substring match only when the ranked result is empty. Empty = no text filter.
   */
  query?: string
  /** A normalised kind; empty = every kind. */
  kind?: string
  /** 1..KNOWLEDGE_SEARCH_LIMIT, default KNOWLEDGE_SEARCH_LIMIT. */
  limit?: number
  /** Include retired nodes (default false). */
  includeRetired?: boolean
}

/** One search hit: name / alias hits sort first, then the most recently updated. */
export interface KnowledgeSearchHit {
  node: KnowledgeNode
  /** The query matched the name or an alias (not only the summary or a fact). */
  nameHit: boolean
  /** Live edges touching the node, both directions. */
  edgeCount: number
}

/** knowledge_recall input (RuntimeContext.knowledgeRecall). */
export interface KnowledgeRecallInput {
  query: string
  /** Characters of the whole result, clamped to KNOWLEDGE_RECALL_BUDGET_MIN..MAX. Default KNOWLEDGE_RECALL_BUDGET_DEFAULT. */
  budget?: number
  /** Show entities this agent already received in full again (it may have lost context). */
  fresh?: boolean
}

/**
 * What an inferred link rests on. See docs/design/knowledge-connections.md for the evaluation; only what passed it is
 * built. 'mention': the `from` entity's summary or a live fact names `to`. 'same-name': equal name or alias across
 * different kinds, a possible duplicate or a pair worth linking. Shared context notes and same-relation siblings were
 * evaluated and rejected (they are not offered).
 */
export type KnowledgeLinkBasis = 'mention' | 'same-name'

/**
 * A connection OrgAI derived from the graph (src/shared/knowledgeLinks.ts). Never stored as an edge and never reported
 * as a fact: the user can confirm it (an ordinary user edge through knowledge:saveEdge) or dismiss it
 * (knowledge:dismissLink). Pairs that already have an edge are not suggested: any live edge and a retired edge the user
 * wrote. A retired edge an agent wrote does not hold a suggestion back (an agent could otherwise silence one by linking
 * and retiring).
 */
export interface KnowledgeInferredLink {
  /** `kl_` + a stable hash of basis and endpoints (KNOWLEDGE_LINK_ID_RE); survives edits to the evidence text. */
  id: string
  /** Node ids. For the symmetric basis (same-name) `from` is the smaller id. */
  from: string
  to: string
  basis: KnowledgeLinkBasis
  /** A suggested relation word for confirming (a KNOWLEDGE_KEY_RE key), when the kind pair has one. */
  suggestedRelation?: string
  /** One short line of plain text saying why (at most 200 characters). User- or agent-written text: render as text only. */
  evidence: string
  /** The fact the evidence came from ('mention' in a fact). */
  evidenceFactId?: string
  /** Reserved: the context note the evidence came from. No current basis sets it (shared-note was rejected). */
  evidenceNoteId?: string
  /** 0..1, comparable within a result; higher is stronger. Not a probability. */
  strength: number
  /** How many separate texts or shared items back it (1 or more). */
  count: number
}

/**
 * How often an entity shows up, for sizing graph nodes. Derived only, never stored, and agent recalls are not counted.
 * `relations`: live edges touching it whose other end is live. `mentions`: live entities' summaries and live facts that
 * name it, with no hub cutoff (a large client organisation being the largest node is correct); dismissed mentions do
 * not count. `notes`: context notes it links. `total` is their sum.
 */
export interface KnowledgeAppearance {
  relations: number
  mentions: number
  notes: number
  total: number
}

/**
 * The name-matching pass stopped at KNOWLEDGE_MATCH_BUDGET (a graph with more text than one pass may scan on the main
 * thread): entities are scanned in graph order, so `links` and the mention counts in `appearances` cover only the first
 * `scannedEntities` of `totalEntities` live entities. The UI should say the list is partial.
 */
export interface KnowledgeInferencePartial {
  scannedEntities: number
  totalEntities: number
}

/** knowledge:inferredLinks result, computed once per graph revision. `appearances` has one entry per node id. */
export interface KnowledgeInferredResult {
  links: KnowledgeInferredLink[]
  appearances: Record<string, KnowledgeAppearance>
  /** Only when the pass stopped early; absent = every live entity's text was scanned. */
  partial?: KnowledgeInferencePartial
}

/** knowledge:dismissLink input (engagements only). The id must have the KNOWLEDGE_LINK_ID_RE shape; dismissing twice is a no-op. */
export interface KnowledgeDismissLinkInput {
  projectId: string
  linkId: string
}

/** Channels of this section; spread into IPC. */
export const KNOWLEDGE_IPC = {
  /** (projectId) -> KnowledgeGraph. Empty for code projects. */
  knowledgeGet: 'knowledge:get',
  /** (KnowledgeNodeSaveInput) -> KnowledgeNode. Engagements only. */
  knowledgeSaveNode: 'knowledge:saveNode',
  /** (KnowledgeItemRef with nodeId) -> KnowledgeGraph. Engagements only. */
  knowledgeRemoveNode: 'knowledge:removeNode',
  /** (KnowledgeEdgeSaveInput) -> KnowledgeEdge. Engagements only. */
  knowledgeSaveEdge: 'knowledge:saveEdge',
  /** (KnowledgeItemRef with edgeId) -> KnowledgeGraph. Engagements only. */
  knowledgeRemoveEdge: 'knowledge:removeEdge',
  /** (projectId) -> KnowledgeGraph (empty): the user's "start over". Engagements only. */
  knowledgeClear: 'knowledge:clear',
  /** (projectId) -> KnowledgeInferredResult. Empty for code projects. */
  knowledgeInferredLinks: 'knowledge:inferredLinks',
  /** (KnowledgeDismissLinkInput) -> KnowledgeInferredResult afterwards. Engagements only. */
  knowledgeDismissLink: 'knowledge:dismissLink'
} as const

/** window.orgai additions of this section (declaration-merged into OrgAIApi). Every write pushes onEngagementChanged 'knowledge'. */
export interface OrgAIApi {
  knowledge: {
    get(projectId: string): Promise<KnowledgeGraph>
    saveNode(input: KnowledgeNodeSaveInput): Promise<KnowledgeNode>
    /** Resolves to the graph afterwards. */
    removeNode(ref: KnowledgeItemRef): Promise<KnowledgeGraph>
    saveEdge(input: KnowledgeEdgeSaveInput): Promise<KnowledgeEdge>
    /** Resolves to the graph afterwards. */
    removeEdge(ref: KnowledgeItemRef): Promise<KnowledgeGraph>
    /** Removes every node and edge; resolves to the empty graph. */
    clear(projectId: string): Promise<KnowledgeGraph>
    /** Derived connections and appearance counts for the current graph; nothing is written. */
    inferredLinks(projectId: string): Promise<KnowledgeInferredResult>
    /** Resolves to the result afterwards. */
    dismissLink(input: KnowledgeDismissLinkInput): Promise<KnowledgeInferredResult>
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

// ---- orgai command shim (cli-spec 7(3), Wave 6) ----

/**
 * Where the orgai command shim stands. 'unavailable': this OrgAI cannot install it (a dev build, ORGAI_DATA_DIR set,
 * a translocated / disk-image / AppImage / portable copy; `reason` says which). 'not-installed': no file at `path`.
 * 'installed': OrgAI's shim runs this install's launcher. 'outdated': OrgAI's shim runs another launcher (`target`).
 * 'foreign': a file at `path` that OrgAI did not write; OrgAI never overwrites or removes it.
 */
export type CliShimState = 'unavailable' | 'not-installed' | 'installed' | 'outdated' | 'foreign'

/** The orgai command shim (app:cliShimStatus). Structured-clone safe. */
export interface CliShimStatus {
  state: CliShimState
  /** The shim file (~/.local/bin/orgai or %LOCALAPPDATA%\OrgAI\bin\orgai.cmd); '' when unknown. */
  path: string
  /** The shim's folder; '' when unknown. */
  binDir: string
  /** The launcher an OrgAI shim runs now (for 'outdated': the other install's). */
  target?: string
  /** True when binDir is on the login shell PATH; undefined when unknown. */
  onPath?: boolean
  /** One plain sentence for 'unavailable' and 'foreign'. */
  reason?: string
  /**
   * Wave 7 (cli-standalone.md 8.2, 9.2): the first `orgai` on the login shell PATH that is not this install's shim (an
   * npm install, an archive, another app's shim); unset when there is none or PATH could not be read. The Terminal row
   * then says "The orgai command from npm (<version>) is on your PATH" and offers no Install.
   */
  otherCli?: { path: string; channel?: InstallChannel; version?: string }
}

/** The answer of app:installCliShim / app:uninstallCliShim. Never a rejection: failures are ok: false. */
export interface CliShimResult {
  ok: boolean
  /** One plain sentence for the user. */
  message: string
  /** The status after the change (or the unchanged status after a failure). */
  status: CliShimStatus
}

/**
 * Channels of "Start a project from a repository" (section near the end of this file). Declared here because IPC
 * spreads it and a const must be initialised first.
 */
export const REPO_CLONE_IPC = {
  projectsParseRepoSource: 'projects:parseRepoSource',
  projectsRepoTools: 'projects:repoTools',
  projectsCloneRepo: 'projects:cloneRepo',
  projectsCancelClone: 'projects:cancelClone',
  /** main -> renderer push channel carrying RepoCloneProgress. */
  projectsCloneProgress: 'projects:cloneProgress'
} as const

/** Channels of "Folder config trust" (section near the end of this file). Declared here for the same reason. */
export const FOLDER_CONFIG_IPC = {
  /** Project id -> FolderConfigReview. Rejects only for an unknown project. */
  projectsFolderConfig: 'projects:folderConfig',
  /** FolderConfigTrustInput -> FolderConfigTrustResult. Rejects with a readable sentence (missing or stale digest...). */
  projectsSetFolderConfigTrust: 'projects:setFolderConfigTrust'
} as const

/** Channels of "Self-knowledge and self-configuration" (section at the end of this file). Declared here for the same reason. */
export const SELF_KNOWLEDGE_IPC = {
  /** AppReferenceQuery -> AppReferenceResult (host scope 'read'). Rejects only for a malformed query. */
  appReference: 'app:reference',
  /** main -> renderer push of AppNavigateEvent (desktop only): an agent's open_in_app, sent to the live main window. */
  appNavigate: 'app:navigate'
} as const

export const IPC = {
  ...SELF_KNOWLEDGE_IPC,
  ...TEMPLATE_ENGAGEMENT_IPC,
  ...KNOWLEDGE_IPC,
  ...REPO_CLONE_IPC,
  ...FOLDER_CONFIG_IPC,
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
  /** main -> renderer push of MenuActionEvent when a renderer-routed application menu item is chosen. */
  menuAction: 'menu:action',
  /** renderer -> main: the sender window's MenuState (validated in main, never echoed). */
  menuSetState: 'menu:setState',
  appSetNotifications: 'app:setNotifications',
  usageRefresh: 'usage:refresh',
  appOpenLogs: 'app:openLogs',
  appLogPath: 'app:logPath',
  appInfo: 'app:info',
  /** Desktop only (cli-spec 7(3)): the orgai command shim's CliShimStatus. Refused over the socket. */
  appCliShimStatus: 'app:cliShimStatus',
  /** Desktop only (cli-spec 7(3)): write or refresh the orgai command shim; answers CliShimResult. */
  appInstallCliShim: 'app:installCliShim',
  /** Desktop only (cli-spec 7(3)): remove the orgai command shim when it is OrgAI's; answers CliShimResult. */
  appUninstallCliShim: 'app:uninstallCliShim',
  permissionsList: 'permissions:list',
  permissionsIgnored: 'permissions:ignored',
  permissionsRemove: 'permissions:remove',
  permissionsAdd: 'permissions:add',
  permissionsDecideRequest: 'permissions:decideRequest',
  projectsRemapModels: 'projects:remapModels',
  projectsPreviewRemap: 'projects:previewRemap',
  connectionsList: 'connections:list',
  connectionsUpdate: 'connections:update',
  connectionsSetSecret: 'connections:setSecret',
  connectionsCreateProxy: 'connections:createProxy',
  connectionsRemoveProxy: 'connections:removeProxy',
  connectionsTest: 'connections:test',
  connectionsConnect: 'connections:connect',
  connectionsLogin: 'connections:login',
  connectionsCancelLogin: 'connections:cancelLogin',
  connectionsLogout: 'connections:logout',
  connectionsSetDefault: 'connections:setDefault',
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
  connectorsList: 'connectors:list',
  connectorsAdd: 'connectors:add',
  connectorsSetToken: 'connectors:setToken',
  pluginsUpsert: 'plugins:upsert',
  pluginsRemove: 'plugins:remove',
  runsListLive: 'runs:listLive',
  runsPendingCards: 'runs:pendingCards',
  runsUsageStats: 'runs:usageStats',
  /** UsageOverviewQuery -> UsageOverview (read scope). */
  runsUsageOverview: 'runs:usageOverview',
  /** UsageOverviewQuery -> CSV text (USAGE_OVERVIEW_CSV_COLUMNS, one row per run with its own project / client) (read scope). */
  runsUsageOverviewCsv: 'runs:usageOverviewCsv',
  runsStartQuick: 'runs:startQuick',
  runsPromoteQuick: 'runs:promoteQuick',
  modelsPrices: 'models:prices',
  windowOpenRun: 'window:openRun',
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  skillsCreate: 'skills:create',
  skillsUpdate: 'skills:update',
  skillsRemove: 'skills:remove',
  skillsLinkLibrary: 'skills:linkLibrary',
  skillsPromote: 'skills:promote',
  skillsPreviewImport: 'skills:previewImport',
  skillsApplyImport: 'skills:applyImport',
  skillsUndoImport: 'skills:undoImport',
  skillsEvaluate: 'skills:evaluate',
  skillsLastEvaluation: 'skills:lastEvaluation',
  skillsApplySuggestion: 'skills:applySuggestion',
  skillsStartAssist: 'skills:startAssist',
  skillLibraryList: 'skillLibrary:list',
  skillLibraryRead: 'skillLibrary:read',
  skillLibraryCreate: 'skillLibrary:create',
  skillLibraryAddFromFolder: 'skillLibrary:addFromFolder',
  skillLibraryUpdate: 'skillLibrary:update',
  skillLibraryRemove: 'skillLibrary:remove',
  /** main -> renderer push channel carrying SkillLibraryInfo[] after every library change. */
  skillLibraryChanged: 'skillLibrary:changed',
  capabilitiesDiscover: 'capabilities:discover',
  capabilitiesRecommend: 'capabilities:recommend',
  capabilitiesCancel: 'capabilities:cancel',
  capabilitiesApply: 'capabilities:apply',
  capabilitiesUndo: 'capabilities:undo',
  /** main -> renderer push channel carrying CapabilityProgressEvent. */
  capabilitiesProgress: 'capabilities:progress',
  capabilitiesReview: 'capabilities:review',
  capabilitiesLastReview: 'capabilities:lastReview',
  capabilitiesDismiss: 'capabilities:dismiss',
  capabilitiesRestore: 'capabilities:restore',
  /** main -> renderer push channel carrying TeamReviewSummary. */
  capabilitiesReviewUpdated: 'capabilities:reviewUpdated'
} as const

// ---- MCP per-project secrets and custom connector presets ----
//
// Engagement kind, phase 2. A vendor-platform MCP server is a practice asset (one library entry); the tenant values
// and credentials are client assets (per project). The interfaces below MERGE into the declarations of the same name
// above (TypeScript declaration merging), so every field here is part of McpServerSpec / McpServerInfo / ... .

/** Most names McpLibraryEntry.perProjectEnv may list. */
export const MCP_PER_PROJECT_ENV_MAX = 20
/** Longest value of one envOverrides / headerOverrides entry. */
export const MCP_OVERRIDE_VALUE_MAX = 2000

export interface McpServerSpec {
  /**
   * Library entries only (set by the user through mcpLibrary:upsert; a linked spec carries the entry's value as part of
   * its snapshot). True = every project that links the entry keeps its OWN env / header secret values under the
   * project key `mcp:<projectId>:<serverId>:{env|header}:<name>`; the entry's own values are never used for those
   * links (no fallback: one client's credential never reaches another client's runs). Missing = the link uses the
   * entry's values (unchanged behaviour). OAuth tokens stay with the entry either way. Refused on connector entries.
   * Proposals and installs never set or clear it (an approved redefinition keeps the stored value). On
   * mcpLibrary:upsert: true sets it, false clears it, absent KEEPS the stored value (a form that does not know the
   * field never turns it off). Stored and returned only as true. While set, the entry takes no env / header values of
   * its own (mcpLibrary:setSecret and library-scope proposal secrets refuse them; turning it on deletes any stored
   * ones) and its McpLibraryInfo.missingSecrets is empty (see projectSecrets).
   */
  perProjectSecrets?: boolean
  /**
   * Library entries only (user-set, like perProjectSecrets): names of NON-secret env vars (stdio) or headers (http /
   * sse) a linking project may override, e.g. a tenant base URL. At most MCP_PER_PROJECT_ENV_MAX valid env / header
   * names, none a secret slot, none credential-like (authorization, cookie, *token*, *secret*, *password*, *key*...)
   * and none that changes what runs (NODE_OPTIONS, PATH, LD_*, *_PROXY ...). Refused on connector entries. On
   * mcpLibrary:upsert: absent KEEPS the stored list, [] clears it.
   */
  perProjectEnv?: string[]
  /**
   * Linked project servers only: this project's values for names in the entry's perProjectEnv (stdio env). Set
   * through mcp:upsert on the linked server (present = replace, `{}` clears, absent = keep). Names not in the entry's
   * list are dropped; a value with control or hidden characters, or longer than MCP_OVERRIDE_VALUE_MAX, is refused.
   * Merged over the entry's env at resolve, filtered again against the entry's current list (secret values still win).
   * Plain text in projects.json: never put a credential here. Proposals and installs never carry it.
   */
  envOverrides?: Record<string, string>
  /** Linked project servers only: like envOverrides for http / sse headers (single-line values). */
  headerOverrides?: Record<string, string>
  /**
   * Written by the main process only, with connectorId: the entry was made from a custom preset (UserConnectorDef in
   * <data>/connector-presets.json), so connectorId is looked up there and never in the curated catalog.
   */
  connectorCustom?: true
}

export interface McpServerInfo {
  /**
   * Where envSet / headersSet / missingSecrets were read: 'project' for a project-only server or a link whose entry
   * sets perProjectSecrets (this project's own values); 'library' for any other link (the entry's values).
   */
  secretScope?: 'project' | 'library'
}

export interface McpLibraryInfo {
  /**
   * Entries with perProjectSecrets only: every linking project with the secret slot names still empty there (empty
   * list = all set). The entry's own envSet / headersSet / missingSecrets then describe values no run uses.
   */
  projectSecrets?: { projectId: string; projectName: string; serverId: string; missingSecrets: string[] }[]
}

/**
 * mcp:copyFromLibrary input: replace a linked server with a project-only copy (new id, source 'user', same
 * definition with this project's overrides baked into env / headers, enabled and roles kept, Role.mcpServers grants
 * moved to the new id). OAuth state is never copied (the copy starts unauthorized). copySecrets true copies the
 * library entry's env / header values into the copy's project slots; false leaves them empty. A link whose entry sets
 * perProjectSecrets always moves this project's own values to the copy. Refused for a missing entry or a built
 * server (buildDigest: its files live with the entry). Returns the saved project and refreshed list.
 */
export interface McpCopyFromLibraryInput {
  projectId: string
  serverId: string
  copySecrets: boolean
}

/** Most custom connector presets (<data>/connector-presets.json). */
export const USER_CONNECTOR_PRESETS_MAX = 100

/**
 * How a custom preset's variant authenticates: a subset of ConnectorAuth (no oauthClient, no OAuth overrides).
 * 'token' on a stdio variant: `header` names the secret ENV var (the slot goes into secretEnv), else a secret header.
 * 'oauth' only on http / sse variants.
 */
export type UserConnectorAuth =
  | { kind: 'none' }
  | { kind: 'oauth'; scopes?: string[] }
  | { kind: 'token'; header: string; prefix?: string; label: string; help: string; link?: string }

/** One variant of a custom preset: http / sse with an https url, or stdio with a command (pinned like any stdio server). */
export interface UserConnectorVariant {
  /** Kebab-case, unique within the preset. */
  id: string
  label: string
  description?: string
  transport: McpTransport
  /** http / sse only: https. */
  url?: string
  /** http / sse only: non-secret headers. */
  headers?: Record<string, string>
  /** stdio only. */
  command?: string
  args?: string[]
  /** stdio only: non-secret env. */
  env?: Record<string, string>
  readOnly: boolean
  auth: UserConnectorAuth
}

/**
 * A user-defined connector preset: a tile in the Connectors gallery like a curated one. Validated on every write and
 * read: kebab-case id (also the library entry name) that is not a curated id, every string field single line (the
 * description prose) without hidden characters and length-capped, category from CONNECTOR_CATEGORIES, 1-5 variants,
 * defaultVariant one of them, at most USER_CONNECTOR_PRESETS_MAX presets. publisher is always 'user' and verified
 * always false (main sets both).
 */
export interface UserConnectorDef {
  id: string
  name: string
  vendor: string
  publisher: 'user'
  category: ConnectorCategory
  description: string
  status?: 'preview' | 'stable'
  /** https. */
  docsUrl?: string
  variants: UserConnectorVariant[]
  defaultVariant: string
  setup?: string[]
  notes?: string[]
  /** Lowercase search words. */
  aliases?: string[]
  verified: false
  /** Reserved for the practice-kit importer, which sets 'kit'. Kept as stored; connectorPresets:upsert drops any other value. */
  origin?: 'kit'
}

/**
 * mcp:setProjectOverrides input: this project's non-secret values for a linked server's perProjectEnv names (env for
 * stdio, headers for http / sse). Each map given replaces the stored one (`{}` clears it; an omitted map is kept).
 * Names outside the entry's perProjectEnv are dropped; a value with control or hidden characters, or longer than
 * MCP_OVERRIDE_VALUE_MAX, is refused. Refused for a project-only server or a missing entry. Returns the saved project
 * and refreshed list. (mcp:upsert on a linked server still accepts envOverrides / headerOverrides the same way.)
 */
export interface McpProjectOverridesInput {
  projectId: string
  serverId: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface ConnectorInfo {
  /**
   * A custom preset: `connector` is its ConnectorDef projection (publisher 'user', status 'stable' and setup [] when
   * unset, docsUrl '' when unset (show no link), stdio variants with url '') and `preset` the stored definition.
   * connectors:list lists curated presets in catalog order, then custom ones in store order.
   */
  custom?: true
  preset?: UserConnectorDef
}

/**
 * Editing a custom preset (connectorPresets:upsert) never rewrites a library entry already added from it: the entry
 * keeps its own definition and secrets, and the tile shows the current preset. When the entry's variant id is no
 * longer in the preset, its card state is derived from the entry alone (secrets set and OAuth authorized if it uses
 * OAuth = connected). connectors:add with a new variant follows the curated rules (a not-yet-connected entry switches).
 *
 * connectorPresets:remove input. Refused while a library entry made from the preset exists.
 */
export interface ConnectorPresetRemoveInput {
  id: string
}

/** IPC channels of this section (kept apart from IPC so the two phase-2 branches merge cleanly). */
export const MCP_SCOPE_IPC = {
  mcpCopyFromLibrary: 'mcp:copyFromLibrary',
  mcpSetProjectOverrides: 'mcp:setProjectOverrides',
  connectorPresetsList: 'connectorPresets:list',
  connectorPresetsUpsert: 'connectorPresets:upsert',
  connectorPresetsRemove: 'connectorPresets:remove'
} as const

export interface OrgAIApi {
  /** Per-project handling of linked MCP servers. */
  mcpProject: {
    /** Replace a linked server with a project-only copy (McpCopyFromLibraryInput). Rejects for a project-only server, a missing entry or a built server. */
    copyFromLibrary(input: McpCopyFromLibraryInput): Promise<McpMutationResult>
    /** Set this project's non-secret values for the entry's perProjectEnv names (McpProjectOverridesInput). */
    setOverrides(input: McpProjectOverridesInput): Promise<McpMutationResult>
  }
  /** Custom connector presets. Every mutation broadcasts mcpLibrary:changed (re-read connectors.list then). */
  connectorPresets: {
    list(): Promise<UserConnectorDef[]>
    /** Add (new id) or replace one preset. Rejects with a readable message. Existing library entries made from it are never rewritten. */
    upsert(def: UserConnectorDef): Promise<UserConnectorDef[]>
    /** Rejects while a library entry made from it exists ("Remove <name> from the MCP library first."). */
    remove(input: ConnectorPresetRemoveInput): Promise<UserConnectorDef[]>
  }
}

// ---- Practice kit ----

/** The practice-kit file format (`*.orgai-kit.json`, UTF-8 JSON, one file). */
export const KIT_FORMAT = 'orgai.kit/1'
/** Largest kit file main writes or reads. */
export const KIT_MAX_BYTES = 50 * 1024 * 1024
/** Most items of one kind in a kit, and most items in all. */
export const KIT_MAX_ITEMS_PER_KIND = 200
export const KIT_MAX_ITEMS = 500
/** Most choices kit:applyImport accepts. */
export const KIT_MAX_CHOICES = 500

export type KitItemKind = 'skill' | 'server' | 'preset' | 'template'

/** What to export from one group: the stored ids (library entry ids, preset ids, template ids) or every item. Absent = none. */
export type KitSelection = string[] | 'all'

/** kit:export input. `path` must come from kit:pickExportPath (main refuses any other path). */
export interface KitExportInput {
  path: string
  include: {
    /** Skill library entry ids. */
    skills?: KitSelection
    /** MCP library entry ids. */
    mcpServers?: KitSelection
    /** Custom connector preset ids. */
    connectorPresets?: KitSelection
    /** Team template ids. */
    templates?: KitSelection
  }
}

/** Items per group. */
export interface KitCounts {
  skills: number
  mcpServers: number
  connectorPresets: number
  templates: number
}

export interface KitExportResult {
  path: string
  /** What went into the file. */
  counts: KitCounts
  /** Bytes written. */
  bytes: number
  /** Plain-language notes: items left out and why, what the file does not carry (secrets, sign-ins). */
  notes: string[]
}

/** kit:previewImport input. `path` must come from kit:pickImportPath. */
export interface KitPreviewInput {
  path: string
}

/** new = not in your data; same = identical to yours; different = same name (id for presets), other content; refused = main will not import it. */
export type KitItemStatus = 'new' | 'same' | 'different' | 'refused'

/** add (status new), replace / copy (status different), skip (always). */
export type KitAction = 'add' | 'replace' | 'copy' | 'skip'

export interface KitPreviewItem {
  /** Opaque, stable for one file digest ("skill:0"); choices refer to it. */
  key: string
  kind: KitItemKind
  /** Display name (control and hidden characters replaced, at most 80 characters). */
  name: string
  description?: string
  status: KitItemStatus
  /** The action to preselect: 'add' for new, otherwise 'skip'. */
  action: KitAction
  /** Why it is `different` ("A skill with this name exists with other content") or why a replace is blocked. */
  conflict?: string
  /** False when a replace is not possible (a connector entry or a built server of yours has that name). */
  canReplace: boolean
  /** Bytes the item takes in the file. */
  size: number
  notes: string[]
  /** status refused: the reason. */
  refusal?: string
  /** Servers and presets: what would run or connect, in full (command and arguments, or address). Never clamped. */
  command?: string
  /** Servers: secret slot names the user must fill in after importing (env, then headers). */
  secretSlots?: string[]
  /** Servers: every project that links it keeps its own secrets. */
  perProjectSecrets?: boolean
  /** Skills: files the skill carries other than SKILL.md. */
  files?: string[]
  /** Skills: files that look like scripts (the skill may ask agents to run them). */
  scripts?: string[]
  /** Templates: role names. */
  roleNames?: string[]
  /** Templates: each role's whole prompt (at most 20,000 characters) and elevated grants, so they can be read before apply. */
  roles?: KitPreviewRole[]
}

/** One template role as the preview shows it. */
export interface KitPreviewRole {
  name: string
  slug: string
  prompt: string
  elevatedTools: ('Bash' | 'Edit' | 'Write' | 'NotebookEdit' | 'canSpawn' | 'mcp')[]
}

export interface KitImportPreview {
  /** The picked file's path; '' for a kit:previewBundle preview (the bytes came over the socket). */
  path: string
  fileName: string
  /** sha256 hex of the file's bytes; kit:applyImport refuses a missing or different one. */
  digest: string
  bytes: number
  exportedAt?: string
  appVersion?: string
  platform?: string
  items: KitPreviewItem[]
  /** Whole-file notes ("3 items refused"). */
  notes: string[]
  /**
   * sha256 hex over the destination library state the items would touch (cli-spec 3.6). Set by kit:previewBundle;
   * kit:applyBundle refuses with stale_target_digest when it no longer matches.
   */
  targetDigest?: string
}

export interface KitImportChoice {
  key: string
  action: KitAction
}

export interface KitApplyInput {
  path: string
  digest: string
  /** Only these items are applied; an item without a choice is skipped. At most KIT_MAX_CHOICES. */
  choices: KitImportChoice[]
}

export interface KitNeedsSecrets {
  /** The library server's name. */
  name: string
  /** Secret environment variable names to set in Settings > Connectors. */
  env: string[]
  /** Secret header names. */
  headers: string[]
  /** Each project that links it enters its own values. */
  perProject: boolean
}

export interface KitApplyResult {
  added: number
  replaced: number
  copied: number
  skipped: number
  /** Added + replaced + copied per group. */
  counts: KitCounts
  /** Items that could not be applied (the rest were). */
  failed: { key: string; name: string; reason: string }[]
  /** Imported servers that cannot start until their secrets are set. */
  needsSecrets: KitNeedsSecrets[]
  notes: string[]
}

/** IPC channels of this section. */
export const KIT_IPC = {
  /** Opens the save dialog; resolves to the path or null. Only that path is accepted by kit:export (once). */
  kitPickExportPath: 'kit:pickExportPath',
  /** Opens the file dialog; resolves to the path or null. Only that path is accepted by the import channels. */
  kitPickImportPath: 'kit:pickImportPath',
  kitExport: 'kit:export',
  kitPreviewImport: 'kit:previewImport',
  kitApplyImport: 'kit:applyImport'
} as const

export interface OrgAIApi {
  /** Practice kit: skills, custom servers, presets and templates in one file. Secret values and sign-ins never go in it. No undo. */
  kit: {
    pickExportPath(): Promise<string | null>
    pickImportPath(): Promise<string | null>
    export(input: KitExportInput): Promise<KitExportResult>
    previewImport(input: KitPreviewInput): Promise<KitImportPreview>
    applyImport(input: KitApplyInput): Promise<KitApplyResult>
  }
}

// ---------- CLI and host (cli-spec Wave 0) ----------
//
// Contracts for the local host daemon, its socket wire protocol, headless exec runs and the host-validated bundle
// channels (docs/design/cli-spec.md sections 3.2, 3.3, 3.4(4), 3.6 and 6.2). Wave 0 only lands the shapes: no socket
// server, dispatcher or IPC handler uses them yet. Everything here is structured-clone and JSON safe.

/**
 * Socket-only host channels (cli-spec 3.3(3)). Deliberately NOT spread into IPC: no ipcMain handler exists for them,
 * and Wave 1 wires them into the host channel registry.
 */
export const HOST_IPC = {
  runsSubscribe: 'runs:subscribe',
  skillLibraryAddFromBundle: 'skillLibrary:addFromBundle',
  kitExportBundle: 'kit:exportBundle',
  kitPreviewBundle: 'kit:previewBundle',
  kitApplyBundle: 'kit:applyBundle',
  /**
   * `orgai decide` lookup (cli-spec 6.3): which run holds a pending card, or how a recently resolved one ended
   * (RunManager tombstones). Scope 'read', socket only, params `[requestId]`, result DecisionLookup.
   */
  runsFindDecision: 'runs:findDecision'
} as const

export type HostIpcChannel = (typeof HOST_IPC)[keyof typeof HOST_IPC]

/** Who ended a run (RunSummary.endedBy, run.status). 'policy' and 'budget' are host-finalized exec runs. */
export type RunEndedBy = 'user' | 'app' | 'policy' | 'budget'

/** Wire protocol version of the host socket (host.challenge / host.hello). */
export const HOST_PROTOCOL_VERSION = 1

/** What an authenticated client may do. 'read' < 'operate' < 'decide' < 'configure' by convention; each is granted explicitly. */
export type HostScope = 'read' | 'operate' | 'decide' | 'configure'
export const HOST_SCOPES: readonly HostScope[] = ['read', 'operate', 'decide', 'configure']

/** The most a socket client may be granted: 'operate' is read + operate, 'full' every scope. */
export type TerminalAccessLevel = 'operate' | 'full'

/**
 * Who says host.hello. 'cli' and 'tui': the orgai command (the terminal UI counts as interactive). 'desktop' (Wave 7,
 * docs/design/cli-standalone.md 4.4): the OrgAI app asking a Node host to hand over the data folder; such a connection
 * gets the handoff grant only (RpcHelloResult.handoff, HOST_HANDOFF_METHODS), whatever Terminal access is.
 */
export type HostClientKind = 'tui' | 'cli' | 'desktop'

/**
 * 'desktop': the Electron app with a window. 'headless-host': the Electron app started with --headless-host. 'inproc':
 * pure Node inside the CLI command that started it. 'node' (Wave 7, cli-standalone.md 4.2): a detached pure-Node
 * background host (started by the desktop app; the orgai CLI never starts one). Capabilities per kind:
 * HOST_KIND_CAPABILITIES.
 */
export type HostKind = 'desktop' | 'headless-host' | 'inproc' | 'node'

export type HostState = 'starting' | 'ready' | 'draining'

/** `<dataDir>/run/daemon.json`: the live host's advertisement (cli-spec 3.2). Written atomically by the owner only. */
export interface DaemonInfo {
  /** 12 lowercase hex chars (src/main/host/identity.ts). */
  hostInstanceId: string
  pid: number
  /** The owner's process start time as processStartTime() reports it; guards against PID reuse. */
  processStartTime?: string
  /** Socket path (unix) or pipe name (win32). */
  endpoint: string
  /**
   * false while the host binds no listener and has no daemon.secret (Terminal access off, review M11): clients answer
   * "Terminal access is off" without connecting. Absent = listening.
   */
  listening?: false
  state: HostState
  /** Epoch ms. */
  startedAt: number
  hostKind?: HostKind
  appVersion?: string
  /** The owning process's cwd at boot (written by the orgai CLI; absent for older records and the desktop). */
  ownerCwd?: string
}

/** Step 1 of the handshake: host -> client, sent immediately on socket connect. */
export interface RpcChallengeFrame {
  jsonrpc: '2.0'
  method: 'host.challenge'
  params: {
    protocolVersion: 1
    hostInstanceId: string
    /** 32-byte hex random nonce. */
    hostNonce: string
  }
}

/** host.hello params (step 2: client -> host). */
export interface RpcHelloParams {
  protocolVersion: 1
  clientKind: HostClientKind
  clientVersion: string
  pid: number
  cwd: string
  /** 32-byte hex random nonce. */
  clientNonce: string
  requestedScopes: HostScope[]
  /**
   * Canonical structured full-transcript HMAC (binds all client fields including cwd):
   * HMAC-SHA256(daemon.secret,
   *   JSON.stringify(['client:v1', protocolVersion, hostInstanceId, hostNonce, clientNonce, clientKind, clientVersion, pid, cwd, requestedScopes]))
   */
  clientProof: string
  /**
   * Only from the CLI process that started its in-process host: HMAC-SHA256(that host's in-memory owner key,
   * JSON.stringify(['owner:v1', hostInstanceId, hostNonce, clientNonce, clientProof])) (protocol.ts ownerProof). A
   * matching one is granted every requested scope; any other client of that host is refused not_owner before any
   * method runs. Never on disk, so a process that read daemon.secret still cannot make it.
   */
  ownerProof?: string
}

/** Step 2: client -> host. */
export interface RpcHelloRequest {
  jsonrpc: '2.0'
  id: 1
  method: 'host.hello'
  params: RpcHelloParams
}

/** Step 3: host -> client (the result of host.hello). */
export interface RpcHelloResult {
  protocolVersion: 1
  hostInstanceId: string
  hostKind: HostKind
  appVersion: string
  dataDir: string
  mock: boolean
  grantedScopes: HostScope[]
  /** Populated when clientVersion !== appVersion; 'read', 'operate', and 'decide' still work when protocolVersion matches. */
  versionSkewWarning?: string
  /**
   * Wave 7 (cli-standalone.md 4.4 step 5, D8): true for a `clientKind: 'desktop'` hello, absent otherwise. Such a
   * connection is granted exactly ['read', 'configure'] (host.status needs 'read', host.stop 'configure'), whatever
   * Terminal access is (off, 'operate' or 'full'), and the socket server refuses every method other than
   * HOST_HANDOFF_METHODS (host.status, host.stop, forced included) before gateRequest runs. Bound into hostProof only
   * when true (protocol.ts hostProof appends it), so a hello without it keeps its existing proof; hostClient.ts
   * parseHelloResult keeps it and checks the proof with it.
   */
  handoff?: true
  /**
   * Canonical structured full-transcript HMAC (binds all host fields):
   * HMAC-SHA256(daemon.secret,
   *   JSON.stringify(['host:v1', protocolVersion, hostInstanceId, clientNonce, hostNonce, hostKind, appVersion, dataDir, mock, grantedScopes]))
   * with `true` appended after grantedScopes when `handoff` is true.
   */
  hostProof: string
}

export type HostRpcErrorCode =
  | 'host_starting'
  | 'host_draining'
  | 'terminal_server_disabled'
  | 'unknown_channel'
  | 'desktop_unavailable'
  | 'agent_descendant_refused'
  /** host.hello: an in-process (orgai CLI) host serves only the process that started it; no valid owner proof. */
  | 'not_owner'
  | 'stale_target_digest'
  | 'stale_revision'
  | 'scope_denied'
  | 'frame_too_large'
  | 'bad_request'
  /** host.hello: the clientProof did not verify (or the daemon secret could not be read). */
  | 'auth_failed'
  /** host.hello: protocolVersion differs from HOST_PROTOCOL_VERSION. */
  | 'protocol_mismatch'
  /** Socket quota (RPC_MAX_UNAUTH_SOCKETS / RPC_MAX_CLIENT_SOCKETS) reached. */
  | 'too_many_connections'
  /** More than RPC_MAX_INFLIGHT_PER_SOCKET requests in flight on one socket. */
  | 'too_many_requests'

/** The `data` of a JSON-RPC error answered by the host. */
export interface HostRpcError {
  code: HostRpcErrorCode
  message: string
  /** host_starting / host_draining: when to try again. */
  retryAfterMs?: number
}

/** Max line length until host.hello succeeds. */
export const RPC_PRE_AUTH_FRAME_MAX_BYTES = 16 * 1024
/** Standard control channel request cap. */
export const RPC_CONTROL_REQUEST_MAX_BYTES = 2 * 1024 * 1024
/** Standard control channel response cap (runs:subscribe snapshots must fit). */
export const RPC_CONTROL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
/** Request / response cap of RPC_BULK_CHANNELS. */
export const RPC_BULK_FRAME_MAX_BYTES = 80 * 1024 * 1024
/** Host-wide cap on concurrent in-flight bulk frames (> 2 MB) across all sockets. */
export const RPC_BULK_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024
/** Deadline for an unauthenticated socket to finish host.hello. */
export const RPC_HANDSHAKE_TIMEOUT_MS = 2000
export const RPC_MAX_UNAUTH_SOCKETS = 16
export const RPC_MAX_CLIENT_SOCKETS = 32
export const RPC_MAX_INFLIGHT_PER_SOCKET = 4

/** Channels whose frames may reach RPC_BULK_FRAME_MAX_BYTES (base64 images, kit bundles, knowledge graphs). */
export const RPC_BULK_CHANNELS: readonly string[] = [
  'runs:start',
  'runs:startQuick',
  'runs:continue',
  'runs:send',
  'runs:get',
  'kit:exportBundle',
  'kit:previewBundle',
  'kit:applyBundle',
  'knowledge:get',
  'skillLibrary:addFromBundle'
]

/** host.subscribe topics: non-run push channels a socket client may receive. */
export type HostSubscribeTopic = 'settings' | 'connections' | 'mcpLibrary' | 'skillLibrary' | 'capabilities' | 'engagement'

/** runs:subscribe input (cli-spec 3.3(4).1). */
export interface RunsSubscribeInput {
  projectIds?: string[]
  runIds?: string[]
  /** Run id whose RunRecord the snapshot carries (images replaced by OmittedImage). */
  includeActiveRunRecord?: string
  /** Follow continuations / auto-resumes and run.moved promotions of subscribed runs. */
  followChains?: boolean
  /**
   * true: this subscriber never counts toward the host's interactiveClients, even with includeActiveRunRecord
   * (headless `orgai exec` followers must not hold a decision policy's humanGraceMs window). Not part of filterKey.
   */
  nonInteractive?: boolean
  /** Last seq the client applied; a valid one in the ring buffer gets a replay. */
  sinceSeq?: number
  filterKey?: string
  hostInstanceId?: string
}

/** Stands in for an image's base64 data in snapshots and oversized push frames; the bytes come only via runs:get. */
export interface OmittedImage {
  mediaType: ImageMediaType
  byteLength: number
  omittedBase64: true
}

/** A durable RunEvent with its host event bus sequence number. */
export interface SequencedHostEvent {
  seq: number
  event: RunEvent
}

/** runs:subscribe result: a snapshot XOR a replay, never both. */
export type RunsSubscribeResult =
  | {
      mode: 'snapshot'
      hostInstanceId: string
      seq: number
      filterKey: string
      snapshot: {
        liveRuns: RunSummary[]
        /** Open cards of each live run, keyed by run id (runs:pendingCards per run). */
        pendingCards: Record<string, PendingCards>
        /**
         * The includeActiveRunRecord run, images scrubbed. Past ACTIVE_RUN_SNAPSHOT_MAX_BYTES its oldest transcript
         * entries (and logs) are left out so the answer stays under the response cap; activeRunOmitted counts them.
         */
        activeRun?: RunRecord
        /** Oldest transcript entries left out of activeRun to fit (absent when nothing was left out). */
        activeRunOmitted?: number
        /** Runs ended within the last 10 minutes. */
        recentEndedRuns: RunSummary[]
      }
    }
  | {
      mode: 'replay'
      hostInstanceId: string
      fromSeq: number
      toSeq: number
      filterKey: string
      events: SequencedHostEvent[]
    }

// Headless exec (cli-spec 6.2(1)).

export interface HeadlessDecisionPolicy {
  permission: 'deny' | 'fail' | 'wait' // default: 'deny'
  rules: 'deny' | 'fail' | 'wait' // default: 'deny'
  mcpInstall: 'deny' | 'fail' | 'wait' // default: 'deny'
  question: 'fail' | 'conservative' | 'wait' // default: 'fail'
  proposal: 'decline' | 'fail' | 'wait' // default: 'decline'
  merge: 'hold' | 'fail' | 'wait' // default: 'hold'
  /** Max auto-denials/declines before ending the run as 'needs-decision' (default 5). */
  maxAutoDenials?: number
  /** Timeout in ms when a policy is 'wait' (default 900_000 = 15 min). */
  waitTimeoutMs?: number
  /** Grace window in ms before auto-resolving while an interactive Desktop/TUI client is open (default 60_000). */
  humanGraceMs?: number
}

export const DEFAULT_HEADLESS_DECISION_POLICY: Readonly<Required<HeadlessDecisionPolicy>> = {
  permission: 'deny',
  rules: 'deny',
  mcpInstall: 'deny',
  question: 'fail',
  proposal: 'decline',
  merge: 'hold',
  maxAutoDenials: 5,
  waitTimeoutMs: 900_000,
  humanGraceMs: 60_000
}

export interface RunOverrides {
  /** Overrides Project.permissionMode. Under 'operate' scope, must satisfy canNarrowPermissionMode(projectMode, overrideMode). */
  permissionMode?: PermissionMode
  /** Overrides Project.autoContinue for this run (under 'operate', cannot change false -> true). */
  autoContinue?: boolean
  /** Overrides Project.maxAutoContinues (0..MAX_AUTO_CONTINUES_LIMIT = 500; under 'operate', <= project.maxAutoContinues). */
  maxAutoContinues?: number
  /** Overrides Project.maxBudgetUsd (finite >= 0 USD estimated cap across the execChainId; under 'operate', <= project.maxBudgetUsd). */
  maxBudgetUsd?: number
  /** Allow starting/continuing with maxBudgetUsd even when an effective role model has no known price (requires 'configure' if project sets maxBudgetUsd). */
  allowUnpricedBudget?: boolean
  /** Allow ending as 'completed' even if conflict worktree branches remain unmerged (--allow-unmerged, default false). */
  allowUnmerged?: boolean
  /** Allow inbound cross-run `message_run` deliveries during an execMode run (default false; requires 'configure' if enabled). */
  allowPeerMessages?: boolean
  /** Host-enforced headless lifecycle & decision policy. */
  execMode?: boolean
  /** Stable identifier linking all continuation/auto-resume RunSummaries belonging to one headless invocation. */
  execChainId?: string
  /** Keep paused run alive with an auto-resume timer on rate-limit hit in execMode (default false). */
  waitForReset?: boolean
  /** Stall timeout in ms when idle with non-quiescent state and no activityGen progress (default 300_000 = 5 min). */
  execStallTimeoutMs?: number
  /** Executed inside RunManager under `decidedBy: { surface: 'policy' }` (requires no client 'decide' scope). */
  decisionPolicy?: HeadlessDecisionPolicy
}

/** RunOverrides.execStallTimeoutMs default (5 min). */
export const DEFAULT_EXEC_STALL_TIMEOUT_MS = 300_000

/** How a headless exec run ended (RunSummary.execOutcome, run.finalized). */
export type ExecOutcome =
  | 'completed'
  | 'completed-unplanned'
  | 'unmerged-conflicts'
  | 'blocked'
  | 'incomplete-plan'
  | 'needs-decision'
  | 'budget-exceeded'
  | 'rate-limited'
  | 'auth-error'
  | 'failed'
  | 'stalled'
  | 'interrupted'

export const EXEC_OUTCOMES: readonly ExecOutcome[] = [
  'completed',
  'completed-unplanned',
  'unmerged-conflicts',
  'blocked',
  'incomplete-plan',
  'needs-decision',
  'budget-exceeded',
  'rate-limited',
  'auth-error',
  'failed',
  'stalled',
  'interrupted'
]

/** CLI exit code per outcome (cli-spec 6.2(3)). */
export const EXEC_OUTCOME_EXIT_CODE: Record<ExecOutcome, number> = {
  completed: 0,
  'completed-unplanned': 0,
  'unmerged-conflicts': 3,
  blocked: 3,
  'incomplete-plan': 3,
  'needs-decision': 3,
  'budget-exceeded': 3,
  'rate-limited': 4,
  'auth-error': 5,
  failed: 1,
  stalled: 1,
  interrupted: 130
}

/** Who resolved a decision card (cli-spec 3.4(4)). */
export interface DecidedBy {
  surface: 'desktop' | 'tui' | 'cli' | 'policy'
  reportedPid?: number
}

/** The result of a decision method (decide, decideRules, decideProposal, answerQuestion, decideMerge, answerMcpInstall). */
export interface DecisionOutcome {
  status: 'applied' | 'already-resolved' | 'stale-revision' | 'cancelled' | 'not-found'
  runId?: string
  requestId: string
  /** e.g. 'allow', 'deny', 'grant', 'approve', 'revise', 'decline', 'hold', 'merge', 'discard' */
  effectiveDecision?: string
  /** Populated when a proposal approval was turned into a 'revise' outcome due to a validation/apply error. */
  applyError?: string
  decidedBy?: DecidedBy
}

/** The six decision card kinds (RunManager pending maps, runs:findDecision). */
export type CardKind = 'permission' | 'question' | 'proposal' | 'rules' | 'merge' | 'mcpInstall'

/** Last-parameter options of the RunManager decision methods (cli-spec 3.4(4), 5.3). */
export interface DecisionOptions {
  /** Refused as 'stale-revision' when it does not match the card's revision. */
  expectedRevision?: number
  decidedBy?: DecidedBy
}

/** runs:findDecision result: a pending card, a recently resolved one (tombstone), or nothing. */
export type DecisionLookup =
  | { status: 'pending'; requestId: string; runId: string; projectId: string; kind: CardKind; revision: number }
  | {
      status: 'applied' | 'cancelled'
      requestId: string
      runId: string
      kind: CardKind
      effectiveDecision?: string
      decidedBy?: DecidedBy
      at: number
    }
  | { status: 'not-found'; requestId: string }

/** Resolved-card tombstones RunManager keeps for runs:findDecision / 'already-resolved' answers. */
export const DECISION_TOMBSTONES_MAX = 1000
/** finalizeExecRun: how long it waits for session.finished and teardown before force-closing. */
export const EXEC_FINALIZE_STOP_TIMEOUT_MS = 5000
/** finalizeExecRun: how long it waits for an in-flight run title before cancelling it. */
export const EXEC_TITLE_JOIN_MS = 2000
/** trySettleExecRun debounce. */
export const EXEC_SETTLE_DEBOUNCE_MS = 50
/**
 * The longest delay a Node / Electron timer honours (2^31 - 1 ms, about 24.8 days): setTimeout runs a longer one after
 * 1 ms. Exec timer overrides (execStallTimeoutMs, decisionPolicy.waitTimeoutMs / humanGraceMs) are refused above it.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
/** The deny message a headless decision policy sends to the agent. */
export const HEADLESS_POLICY_DENY_MESSAGE = 'Denied by the headless decision policy (orgai exec).'
/** A question option whose label or description starts with this is the conservative policy's pick. */
export const RECOMMENDED_OPTION_PREFIX = '(Recommended)'

// Host-validated bundles (cli-spec 3.6).

/** One file of a skill bundle: a relative POSIX path and its bytes as base64. */
export interface SkillBundleFile {
  relPath: string
  base64: string
}

/** skillLibrary:addFromBundle input. The host decodes and validates every file like skillLibrary:addFromFolder. */
export interface SkillBundleInput {
  name: string
  files: SkillBundleFile[]
}

export const SKILL_BUNDLE_MAX_FILES = 50
export const SKILL_BUNDLE_SKILL_MD_MAX_BYTES = 256 * 1024
export const SKILL_BUNDLE_FILE_MAX_BYTES = 64 * 1024
export const SKILL_BUNDLE_MAX_BYTES = 1024 * 1024

/** kit:exportBundle input: like kit:export, but the bytes come back instead of going to a picked path. */
export interface KitBundleExportInput {
  include: KitExportInput['include']
  fileName?: string
}

export interface KitBundleExportResult {
  fileName: string
  rawBytesBase64: string
  counts: KitCounts
  bytes: number
  notes: string[]
}

/** kit:previewBundle input. The result is a KitImportPreview with `path: ''` and a `targetDigest`. */
export interface KitBundlePreviewInput {
  fileName: string
  rawBytesBase64: string
}

/** kit:applyBundle input. Refused when `digest` does not match the bytes or `targetDigest` the destination state (stale_target_digest). */
export interface KitBundleApplyInput {
  rawBytesBase64: string
  digest: string
  targetDigest: string
  choices: KitImportChoice[]
}

// ---------- CLI and host (cli-spec Wave 1) ----------
//
// Host protocol methods, activity leases and host.status / host.stop shapes (cli-spec 3.2(4), 3.3(3)). Outside IPC:
// the preload API is unchanged, and none of these is an ipcMain channel.
//
// RPC params convention: a channel method's JSON-RPC `params` is the positional argument array, exactly what
// ipcRenderer.invoke passes after the channel (`runs:get` with `["run_1"]`, `settings:set` with `[settings]`, a
// zero-argument channel with `[]`). A host.* method also accepts a single object as `params`; the host normalizes it
// to `[object]` before validation.

/** JSON-RPC methods of the host protocol itself (not channels; never in IPC). */
export const HOST_METHODS = {
  hostChallenge: 'host.challenge',
  hostHello: 'host.hello',
  hostStatus: 'host.status',
  hostSubscribe: 'host.subscribe',
  hostStop: 'host.stop'
} as const

export type HostMethod = (typeof HOST_METHODS)[keyof typeof HOST_METHODS]

/** What keeps a host from going idle (cli-spec 3.2(4) "Tracked Leases"). */
export type ActivityLeaseKind =
  | 'liveRuns'
  | 'pausedAutoResumes'
  | 'inFlightRpcMutations'
  | 'activeWorktreeOps'
  | 'backgroundTasks'
  | 'activeOAuthFlows'
  | 'interactiveClients'

export const ACTIVITY_LEASE_KINDS: readonly ActivityLeaseKind[] = [
  'liveRuns',
  'pausedAutoResumes',
  'inFlightRpcMutations',
  'activeWorktreeOps',
  'backgroundTasks',
  'activeOAuthFlows',
  'interactiveClients'
]

/** HostActivityTracker's view at one moment: held leases plus polled sources, per kind. */
export interface HostActivitySnapshot {
  counts: Record<ActivityLeaseKind, number>
  /** Sum of counts. */
  total: number
  /** total === 0. */
  idle: boolean
  /** Epoch ms since which the host has been idle (absent while busy). */
  idleSince?: number
  state: HostState
}

/** host.status result (scope 'read'). */
export interface HostStatusResult {
  protocolVersion: 1
  hostInstanceId: string
  hostKind: HostKind
  state: HostState
  appVersion: string
  dataDir: string
  mock: boolean
  pid: number
  /** Epoch ms. */
  startedAt: number
  activity: HostActivitySnapshot
  /**
   * Wave 7 (cli-standalone.md 4.4 step 4): what a `host.stop({ handoff: true })` would wait for, for the app's waiting
   * window. Absent from hosts older than Wave 7 (and until WP-F fills it).
   */
  handoff?: HostHandoffFacts
}

/** host.stop input (scope 'configure'). Without force the host refuses while any lease is held. */
export interface HostStopInput {
  force?: boolean
  /**
   * Wave 7 (cli-standalone.md 4.4 step 4): the OrgAI app asks a Node host to hand over the data folder. Without force
   * the stricter handoff predicate applies: refused while any run is live in any form (working, idle, waiting on a
   * card, held, paused with a resume pending) or any card is open, besides the leases. Ignored with force.
   */
  handoff?: boolean
}

export interface HostStopResult {
  stopping: boolean
  /** Set when the stop was refused: the non-zero lease counts that blocked it. */
  refusedBecause?: Partial<Record<ActivityLeaseKind, number>>
  /** Wave 7: set when a handoff stop was refused: the non-zero HostHandoffFacts counts that blocked it. */
  handoffBlockers?: Partial<Record<HostHandoffBlocker, number>>
}

/** host.subscribe input (scope 'read'). */
export interface HostSubscribeInput {
  topics: HostSubscribeTopic[]
}

/** host.subscribe result: the topics the socket is now subscribed to (deduped, known topics only). */
export interface HostSubscribeResult {
  topics: HostSubscribeTopic[]
}

/**
 * Params of a socket `runs:event` notification (pushed after runs:subscribe). Durable events carry `seq` (their slot
 * in the host's replay ring); a transient agent.partial carries `atSeq` instead (the current durable watermark, not a
 * ring slot). Exactly one of the two is set.
 */
export interface RunsEventParams {
  seq?: number
  atSeq?: number
  event: RunEvent
}

/** ORGAI_DAEMON_IDLE_MINUTES default: an idle background host exits after this long. */
export const DEFAULT_DAEMON_IDLE_MINUTES = 30

// ---------- Wave 7 (standalone CLI) ----------
//
// Contracts of docs/design/cli-standalone.md (cli-spec Wave 7): the Node background host, host capabilities, the
// app's handoff from a Node host, the install channel and secure storage's host channels. Everything here is
// structured-clone and JSON safe; no secret value or data key ever appears in these shapes. The vault file format,
// the key custodians and the SecretStore API live in src/main/store/vaultTypes.ts (main only).

/** Every HostKind, in a stable order (ownership.ts parseDaemonInfo, hostClient.ts parseHelloResult). */
export const HOST_KINDS: readonly HostKind[] = ['desktop', 'headless-host', 'inproc', 'node']

/** Every HostClientKind (socketServer.ts helloProblem). */
export const HOST_CLIENT_KINDS: readonly HostClientKind[] = ['cli', 'tui', 'desktop']

/**
 * Hosts that run in the background, detached from the command that asked for them (cli-standalone.md 4.1): what
 * an app-side launcher waits for. Never 'inproc', whose daemon.json belongs to the CLI command that started it.
 */
export const BACKGROUND_HOST_KINDS: readonly HostKind[] = ['headless-host', 'desktop', 'node']

/** What a host kind can do (cli-standalone.md 4.2): replaces `hostKind === 'inproc'` checks. */
export interface HostKindCapabilities {
  /** It can open an OrgAI window: registry entries with `desktopRequired` (window:openRun) are served. */
  canOpenWindows: boolean
  /** It is the CLI command's own host: it lives only as long as that command and serves it every scope. */
  inProcess: boolean
}

export const HOST_KIND_CAPABILITIES: Readonly<Record<HostKind, HostKindCapabilities>> = {
  desktop: { canOpenWindows: true, inProcess: false },
  'headless-host': { canOpenWindows: true, inProcess: false },
  inproc: { canOpenWindows: false, inProcess: true },
  node: { canOpenWindows: false, inProcess: false }
}

/** HOST_KIND_CAPABILITIES[kind].canOpenWindows; false for an unknown value. */
export function hostCanOpenWindows(kind: HostKind): boolean {
  return Object.prototype.hasOwnProperty.call(HOST_KIND_CAPABILITIES, kind) ? HOST_KIND_CAPABILITIES[kind].canOpenWindows : false
}

// ---- Install channel (cli-standalone.md 3.5) ----

/**
 * How this orgai was installed: 'npm' (`npm i -g orgai`), 'app' (bundled with the OrgAI app), 'archive' (the portable
 * archive, phase C), 'dev' (no install.json: a checkout or a hand-made bundle).
 */
export type InstallChannel = 'npm' | 'app' | 'archive' | 'dev'

export const INSTALL_CHANNELS: readonly InstallChannel[] = ['npm', 'app', 'archive', 'dev']

/** The file each builder writes next to the CLI bundle: `out/cli/install.json`. Absent means channel 'dev'. */
export const INSTALL_INFO_FILE = 'install.json'

/** `out/cli/install.json` as read (src/cli/installInfo.ts readInstallInfo). */
export interface InstallInfo {
  channel: InstallChannel
  /** The version the builder stamped (the app's version of the same commit). */
  version?: string
  /** The commit the builder stamped (short or full sha). */
  commit?: string
  /**
   * 'file': read from install.json. 'absent': no file (channel 'dev'). 'invalid': a file that could not be read or
   * did not validate (channel 'dev' with `problem`): HostLauncher must not treat that as a dev checkout (4.1 step 3).
   */
  source: 'file' | 'absent' | 'invalid'
  /** Why an 'invalid' file was refused. */
  problem?: string
}

// ---- Handoff from a Node host to the app (cli-standalone.md 4.4) ----

/**
 * The only methods a handoff connection (RpcHelloResult.handoff) may call. socketServer.ts applies this filter before
 * gateRequest (anything else answers scope_denied without reaching the registry); the connection's grantedScopes are
 * exactly HOST_HANDOFF_SCOPES, so both methods pass the gate's scope check whatever Terminal access is.
 */
export const HOST_HANDOFF_METHODS: readonly HostMethod[] = ['host.status', 'host.stop']

/** The grantedScopes of every handoff connection: host.status needs 'read', host.stop 'configure'. */
export const HOST_HANDOFF_SCOPES: readonly HostScope[] = ['read', 'configure']

/** The peer-check budget of a `clientKind: 'desktop'` hello (the others keep the shorter default). */
export const DESKTOP_HELLO_PEER_CHECK_MS = 2_000

/** What a non-forced `host.stop({ handoff: true })` waits for, besides the activity leases. */
export type HostHandoffBlocker = 'workingRuns' | 'waitingRuns' | 'heldRuns' | 'pausedRuns' | 'openCards'

export const HOST_HANDOFF_BLOCKERS: readonly HostHandoffBlocker[] = ['workingRuns', 'waitingRuns', 'heldRuns', 'pausedRuns', 'openCards']

/** host.status `handoff`: every count the app's waiting window shows. */
export interface HostHandoffFacts {
  /** Runs starting, running or stopping. */
  workingRuns: number
  /** Live runs waiting on the user: idle or with a card open. */
  waitingRuns: number
  /** Live runs held by an interrupt or a usage limit. */
  heldRuns: number
  /** Paused runs with an auto-resume pending. */
  pausedRuns: number
  /** Open decision cards across every run. */
  openCards: number
  /** Authenticated terminal sessions (cli and tui sockets), handoff connections excluded. */
  terminalSessions: number
}

// ---- Secret vault (cli-standalone.md 5) ----

/**
 * The vault's state on this host (5.4). 'absent': no vault.json. 'open': the data key is in memory and `check`
 * passed. 'locked': the custodian answered locked, timeout or unavailable. 'missing-key': missing or denied.
 * 'key-mismatch': a key was found but `check` failed (another key, or a damaged check record). 'corrupt': vault.json
 * does not parse or validate.
 */
export type VaultState = 'absent' | 'open' | 'locked' | 'missing-key' | 'key-mismatch' | 'corrupt'

export const VAULT_STATES: readonly VaultState[] = ['absent', 'open', 'locked', 'missing-key', 'key-mismatch', 'corrupt']

/** Who holds the vault's data key (5.3). A vault opens only with its recorded scheme. */
export type VaultCustodyScheme = 'keychain' | 'dpapi-user' | 'secret-service' | 'key-file'

export const VAULT_CUSTODY_SCHEMES: readonly VaultCustodyScheme[] = ['keychain', 'dpapi-user', 'secret-service', 'key-file']

/** A custodian's classified failure (5.3 CustodyFailure.kind). */
export type CustodyFailureKind = 'unavailable' | 'locked' | 'missing' | 'denied' | 'timeout'

/**
 * SecretStore.status(key) (5.4): 'set' (readable here), 'unset' (stored nowhere, or deleted), or unreadable with the
 * reason to show ("Saved by the OrgAI app and not yet shared with the orgai command: quit orgai, open the OrgAI app once, then start orgai again", "The secret
 * vault is locked: ..."). Never the value.
 */
export type SecretStatus = 'set' | 'unset' | { unreadable: string }

/**
 * The legacy `<data>/secrets.json` (5.5 Legacy file states): 'ok' parses with a `secrets` object, 'missing' no file,
 * 'corrupt' anything else (never rewritten by a host of this wave), 'retired' gone after retirement
 * (`legacyRetired` set; retirement stays off this release).
 */
export type LegacySecretsFileState = 'ok' | 'missing' | 'corrupt' | 'retired'

/** A deleted secret kept for `orgai secrets undelete` (key name only, never a value). */
export interface SecretsSoftDelete {
  key: string
  /** 'vault': a delete made through this wave. 'legacy': it disappeared from secrets.json (an older app). */
  by: 'vault' | 'legacy'
  /** Epoch ms of the delete. */
  at: number
  /**
   * 'here': this host can restore it. 'app': only the OrgAI app can (the kept value is a secrets.json ciphertext,
   * `prevLegacy`). 'none': nothing restorable is kept.
   */
  restorable: 'here' | 'app' | 'none'
  /** Epoch ms after which a `by: 'vault'` delete's kept value goes (30 days); absent for 'legacy' (never on a timer). */
  expiresAt?: number
}

/** An OS key item left behind by `secrets reset` (5.6): the moved-aside vault names it. Never a key. */
export interface SecretsOrphanVault {
  vaultId: string
  scheme: VaultCustodyScheme
  /** The moved-aside file's name in the data folder (`vault.json.reset-<time>` / `vault.json.corrupt-<time>`). */
  file: string
}

/** secrets:status input (optional). */
export interface SecretsStatusInput {
  /** Also run the custodian's probe (a child process, up to 10 s) and report it in `probe`. */
  probe?: boolean
}

/** secrets:status (scope 'read'): everything `orgai secrets status` and doctor print. Never a value or a key. */
export interface SecretsStatusResult {
  state: VaultState
  /** The vault's recorded scheme; for an absent vault the scheme a new one would use; null when none is usable. */
  scheme: VaultCustodyScheme | null
  /** Why the vault is not open (states other than 'open' and 'absent'); a sentence to show as is. */
  reason?: string
  /** The custodian's probe for `scheme`, when this call ran one. */
  probe?: { ok: true } | { ok: false; kind: CustodyFailureKind; reason: string }
  /** custody.keyFile (canonical) or ORGAI_VAULT_KEY_FILE, for the key-file scheme. A path, never the key. */
  keyFile?: string
  /** The vault id, when vault.json parses. */
  vaultId?: string
  counts: {
    /** Entries in vault.json. */
    vault: number
    /** Keys in secrets.json (0 when it is missing, corrupt or retired). */
    legacy: number
    /** Keys whose status() is unreadable here (pending-legacy included). */
    unreadable: number
    /** ORGAI_SECRET_* / --secret-env values in memory (inproc only). */
    overlay: number
  }
  /** Keys in secrets.json this host cannot read and the vault does not hold yet ("open the app once"). */
  pendingLegacy: number
  /** Deleted secrets kept for undelete, newest first. Key names only. */
  softDeletes: SecretsSoftDelete[]
  /** Keys a removal had to leave where they were (5.5 Deletes), counted by doctor. */
  orphanedKeys: number
  /** OS key items of moved-aside vaults (5.6 Reset). */
  orphanedVaults: SecretsOrphanVault[]
  legacyFile: LegacySecretsFileState
  /**
   * vault.json or secrets.json could not be read just now (an I/O error such as EIO or EACCES, not damage; WP-G1 review
   * round 2): the sentence to show. An unreadable vault.json reports `state` 'locked' with this reason; an unreadable
   * secrets.json reports `legacyFile` 'corrupt' (never written while it lasts). The store reads both again on the next
   * save and on secrets:status / init; secrets:reset refuses (nothing is moved aside) while either cannot be read.
   */
  readError?: string
  /** This host can encrypt with the app's safeStorage (5.5 "can write back"). */
  canWriteBack: boolean
}

/**
 * secrets:init (scope 'configure'): create a vault (absent), or retry opening it (locked, or missing-key with a key
 * file). Without keyFile the platform's OS scheme (or ORGAI_VAULT_KEY_FILE when set).
 */
export interface SecretsInitInput {
  /** Absolute path of a key file (5.3.1). Created new (O_EXCL) unless `importKeyFile`. */
  keyFile?: string
  /** `--import`: use an existing key file instead of creating one. Only with keyFile. */
  importKeyFile?: boolean
}

export interface SecretsInitResult {
  /** 'created' a new vault, 'opened' an existing one that was not open, 'unchanged' it was already open. */
  action: 'created' | 'opened' | 'unchanged'
  status: SecretsStatusResult
}

/** secrets:reset (scope 'configure', served in every vault state). The CLI asks first (`--yes`). */
export interface SecretsResetInput {
  /** Must be true: the caller confirmed that secrets saved only through the orgai command are lost. */
  confirm: true
}

export interface SecretsResetResult {
  /** The moved-aside file's name (`vault.json.reset-<time>` or `vault.json.corrupt-<time>`), or null when no vault existed. */
  movedTo: string | null
  /**
   * A secrets.json that did not parse is moved aside too (`secrets.json.corrupt-<time>`, WP-G1 review round 1), so the
   * app can save again in legacy-only mode; absent when the file was fine or missing.
   */
  legacyMovedTo?: string
  status: SecretsStatusResult
}

/** secrets:undelete (scope 'configure'): restore one soft-deleted key. */
export interface SecretsUndeleteInput {
  key: string
}

export interface SecretsUndeleteResult {
  restored: boolean
  /** Why it was not restored ("This deleted secret was saved by the OrgAI app; open the app to restore it"). */
  reason?: string
}

/**
 * secrets:confirmDelete (scope 'configure'): the "Keep removed" answer to soft deletes (5.5 Deletes; the app notice
 * "N saved secrets were removed by an older version of OrgAI. Restore / Keep removed"). Each named key's soft delete
 * is confirmed: its kept value (`prev` / `prevLegacy`) is dropped, it no longer lists in `softDeletes`, it can no longer
 * be undeleted, and a confirmed `by: 'legacy'` delete no longer holds back Retirement. A key with no soft delete is
 * skipped (left out of `confirmed`). The store may keep a `by: 'vault'` tombstone's metadata (`legacyHash`) that rows 1
 * and 2 of 5.5 still need. Metadata only: served in every state in which vault.json parses, no data key needed.
 */
export interface SecretsConfirmDeleteInput {
  /** Key names (never values), as listed in SecretsStatusResult.softDeletes. */
  keys: string[]
}

export interface SecretsConfirmDeleteResult {
  /** The keys whose soft delete was confirmed, in input order. */
  confirmed: string[]
}

/**
 * Channels of secure storage (cli-standalone.md 5.6). Served by the host dispatcher on every surface (the app's
 * window and the socket); `secrets:status` needs 'read', the others 'configure'. None ever returns a value.
 */
export const SECRETS_IPC = {
  secretsStatus: 'secrets:status',
  secretsInit: 'secrets:init',
  secretsReset: 'secrets:reset',
  secretsUndelete: 'secrets:undelete',
  secretsConfirmDelete: 'secrets:confirmDelete'
} as const

export type SecretsIpcChannel = (typeof SECRETS_IPC)[keyof typeof SECRETS_IPC]

/** A secret slot that holds a value this host cannot read (5.4), with the reason to show instead of "unset". */
export interface UnreadableSecretSlot {
  /** The slot name (an env var or header name). Never a value. */
  name: string
  /** SecretStatus.unreadable: "Saved by the OrgAI app and not yet shared with the orgai command: quit orgai, open the OrgAI app once, then start orgai again", ... */
  reason: string
}

export interface McpServerInfo {
  /**
   * Wave 7 (5.4): slots whose stored value cannot be read on this host, with why. They are also in missingSecrets
   * (a run cannot use them) and never in envSet / headersSet. Absent when there are none.
   */
  unreadableSecrets?: UnreadableSecretSlot[]
}

export interface McpLibraryInfo {
  /** Wave 7 (5.4): as McpServerInfo.unreadableSecrets, for the entry's own slots. */
  unreadableSecrets?: UnreadableSecretSlot[]
}

// ---- Start a project from a repository (clone or fork) ----
//
// The renderer asks main to clone a repository into a folder, optionally forking it first through the user's own gh
// login, then creates the project through the existing projects:create with that folder. Renderer only: agents get no
// tool for this. Service: src/main/repoClone.ts. Main re-parses `source` itself and never takes a URL from the renderer.

/** Longest repository source text accepted, and longest destination path. */
export const REPO_SOURCE_MAX_CHARS = 512
export const REPO_DESTINATION_MAX_CHARS = 1024
/** How many clones may run at once; one more is refused with a sentence. */
export const REPO_CLONES_MAX = 3

/** projects:parseRepoSource when the text names a repository OrgAI can clone. */
export interface RepoSourceOk {
  ok: true
  /**
   * The canonical URL git receives: https://github.com/<owner>/<repo>.git for an https URL or the shorthand; the
   * ssh forms stay ssh (git@github.com:<owner>/<repo>.git, ssh://git@github.com/<owner>/<repo>.git). No password or token, ever.
   */
  url: string
  /** Lowercase host, with the port when one was given. 'github.com' when canFork. */
  host: string
  /** Absent only when another host's path has a single segment; on those hosts it may hold several segments (group/sub). */
  owner?: string
  /** Repository name without `.git`. */
  repo: string
  /** What to show: `owner/repo` on GitHub, `host/group/repo` elsewhere. */
  display: string
  /** A folder name for the repository, safe on every platform. Never a path. */
  suggestedFolder: string
  /** True only for github.com. */
  canFork: boolean
}
/** `problem` is a fixed sentence. It never quotes the input, so a pasted token is not echoed. */
export interface RepoSourceRefused {
  ok: false
  problem: string
}
export type RepoSourceParse = RepoSourceOk | RepoSourceRefused

/**
 * projects:repoTools. Never rejects. Spends no model tokens, but `gh auth status` DOES reach the network: it tests the
 * account against api.github.com (seen on gh 2.93.0 through a dead proxy: state 'error', "Get https://api.github.com/ ...").
 * When GitHub cannot be reached the account still counts as logged in and `detail` says the check could not finish.
 */
export interface RepoTools {
  git: { available: boolean; version?: string }
  gh: {
    available: boolean
    loggedIn: boolean
    /** The active github.com account. */
    login?: string
    /** A sentence for the user: how to install or sign in, or why the check could not finish. */
    detail?: string
  }
}

export type RepoCloneMode = 'clone' | 'fork'

/** projects:cloneRepo input. Rebuilt field by field in ipc.ts. */
export interface RepoCloneInput {
  /** Chosen by the renderer: 1 to 64 of letters, digits, '_' and '-'. The same id is refused while it is running. */
  requestId: string
  /** The text the user typed; main parses it again. */
  source: string
  mode: RepoCloneMode
  /**
   * The new folder: absolute, on this computer (no UNC or device path), not a drive root, outside OrgAI's data folder,
   * and either missing or an empty real directory.
   */
  destination: string
}

/** What is known about the fork when mode was 'fork'. */
export interface RepoCloneFork {
  /** `owner/repo` of the fork (GitHub may have renamed it to avoid a clash). */
  fullName: string
  htmlUrl: string
  /** The source repository, as remote `upstream`. */
  upstreamUrl: string
  /** False when `git remote add upstream` failed; the clone is still good. */
  upstreamAdded: boolean
  /** True when GitHub returned a fork older than this request, so nothing new was made. A best guess from created_at. */
  alreadyExisted?: boolean
}

export interface RepoCloneResult {
  /** The folder that now holds the clone; pass it to projects:create. */
  path: string
  /** The URL it was cloned from. */
  url: string
  /** The checked-out branch; absent when it could not be read. */
  branch?: string
  fork?: RepoCloneFork
  /**
   * What the clone contains from REPO_CONFIG_PATHS, as '/'-relative paths in that order. These come from whoever wrote
   * the repository. See REPO_CONFIG_PATHS for what each does.
   */
  repoConfig: string[]
}

/** What a repository file can do once a run works in the folder. */
export type RepoConfigEffect =
  /** Can run commands on this computer or change what agents may do without asking. */
  | 'runs-commands'
  /** Starts tool servers or defines agents, skills or commands for the run. */
  | 'tools'
  /** Text agents read as instructions. */
  | 'instructions'

/**
 * Files in a repository that agents would load or that can run commands, checked in this order. A file or folder that
 * is a link still counts: it is listed, never followed. A code project whose folder holds any of these at creation is
 * gated (section "Folder config trust"); once allowed, Claude runs load `.claude/settings.json`
 * (settingSources ['project']), so its hooks can run on the user's computer. From the docs, not confirmed by a live
 * run: `.mcp.json` does not load on Claude runs (strictMcpConfig) and is listed because Codex and the importers may
 * read it; `.claude/settings.local.json` is listed because OrgAI itself reads its permission rules
 * (permissionRules listRules), not because the CLI loads it; nested CLAUDE.md files and `@` imports inside
 * instruction files cannot be listed here.
 */
export const REPO_CONFIG_PATHS: readonly { path: string; effect: RepoConfigEffect }[] = [
  { path: '.claude/settings.json', effect: 'runs-commands' },
  { path: '.claude/settings.local.json', effect: 'runs-commands' },
  { path: '.claude/hooks', effect: 'runs-commands' },
  { path: '.codex', effect: 'runs-commands' },
  { path: '.mcp.json', effect: 'tools' },
  { path: '.claude/agents', effect: 'tools' },
  { path: '.claude/commands', effect: 'tools' },
  { path: '.claude/skills', effect: 'tools' },
  { path: '.claude/rules', effect: 'tools' },
  { path: '.claude/workflows', effect: 'tools' },
  { path: '.claude/routines', effect: 'tools' },
  { path: '.claude/output-styles', effect: 'tools' },
  { path: '.orgai/org.json', effect: 'tools' },
  // Team files (src/main/teamFiles/): roles, skills and servers a project would take on, behind an approval card.
  { path: '.orgai/team.json', effect: 'tools' },
  { path: '.orgai/mcp.json', effect: 'tools' },
  { path: '.orgai/agents', effect: 'tools' },
  { path: '.orgai/skills', effect: 'tools' },
  { path: '.agents', effect: 'tools' },
  { path: 'CLAUDE.md', effect: 'instructions' },
  { path: 'CLAUDE.local.md', effect: 'instructions' },
  { path: '.claude/CLAUDE.md', effect: 'instructions' },
  { path: 'AGENTS.md', effect: 'instructions' },
  { path: 'AGENTS.override.md', effect: 'instructions' },
  // prompts.ts tells agents to read .orgai/ARCHITECTURE.md and follow it.
  { path: '.orgai/ARCHITECTURE.md', effect: 'instructions' }
]

export type RepoClonePhase = 'forking' | 'waiting-for-fork' | 'cloning' | 'finishing'

/**
 * main -> the renderer that asked, at most about 4 a second per request (a phase change always goes through). `percent`
 * is 0-100 over the whole cloning phase and never moves back within an attempt; `text` is a fixed label, never remote text.
 */
export interface RepoCloneProgress {
  requestId: string
  phase: RepoClonePhase
  percent?: number
  text?: string
}

/** A cancelled projects:cloneRepo rejects with a message starting with this. */
export const REPO_CLONE_CANCELLED_PREFIX = 'Cancelled.'

// ---- Folder config trust ----

/**
 * What a project's own agent config may do, seen by the renderer:
 *   'none'       no gate: Project.folderConfigTrust is absent (stored before this feature, or no config at creation).
 *   'untrusted'  the folder held config at creation and the user has not accepted it. Runs still work and ignore it.
 *   'trusted'    the user accepted it and what is on disk still has that digest. Runs load it.
 *   'changed'    accepted once, but the digest on disk differs now. Runs ignore it until accepted again.
 */
export type FolderConfigState = 'none' | 'untrusted' | 'trusted' | 'changed'

/** Project.folderConfigTrust as stored. 'changed' is never stored: it is 'trusted' whose digest no longer matches. */
export interface FolderConfigTrust {
  state: 'untrusted' | 'trusted'
  /** Lowercase sha256 hex of the accepted config (folderConfigTrust.ts). Only on 'trusted'. */
  digest?: string
  /** ISO time of the user's last accept or revoke. */
  decidedAt?: string
  /**
   * Allow rules copied from the folder's settings.local.json into OrgAI's data folder on accept. Revoking removes them,
   * and a later accept never re-adds one the user removed. Main only.
   */
  importedRules?: string[]
}

/** Longest text of one file in a review, in characters; longer text is cut and marked `truncated`. */
export const FOLDER_CONFIG_FILE_TEXT_MAX = 64 * 1024
/** All file text of one review together, in characters; files past it are listed with no text and `truncated`. */
export const FOLDER_CONFIG_TOTAL_TEXT_MAX = 1024 * 1024
/** Most entries of each list in a review (files, commands, env, allowRules, mcpServers); past it `truncated` is set. */
export const FOLDER_CONFIG_LIST_MAX = 500

/**
 * One path in a review. All text is untrusted and comes from whoever wrote the folder: render it as plain text. It is
 * not stripped: `hiddenChar` names the first control, zero-width, bidi or other invisible character ("U+202E"; tab and
 * line breaks do not count), the way an import preview's text is badged. Secret-looking values are already masked.
 */
export interface FolderConfigFile {
  /** '/'-relative to the project folder. */
  path: string
  effect: RepoConfigEffect
  kind: 'file' | 'link' | 'other'
  /** Only with kind 'link': where it points, as stored in the link. */
  linkTarget?: string
  sizeBytes: number
  /** Absent for a link, a binary file or a file past FOLDER_CONFIG_TOTAL_TEXT_MAX. */
  text?: string
  truncated?: boolean
  hiddenChar?: string
  /** False for text the digest does not bind: 'instructions' files and .orgai/org.json can change while trusted. */
  digested: boolean
}

/** Something the folder's config would run: a hook, or a helper setting such as apiKeyHelper or statusLine. */
export interface FolderConfigCommand {
  /** The file it is declared in. */
  source: string
  kind: 'hook' | 'helper'
  /** Hook: its event and matcher ("PreToolUse Bash"). Helper: the setting's name ("apiKeyHelper"). */
  label: string
  /**
   * The command, or the handler as JSON when it is not a command handler (an http or prompt hook). Only the
   * credential-looking part is replaced by '[masked]' (URL userinfo, a key-shaped word, "Bearer x", the value of
   * `API_KEY=...` or `--token=...`); everything else, including code after it, always shows.
   */
  command: string
  /** Something in `command` was replaced by '[masked]'. */
  masked?: boolean
  hiddenChar?: string
}

export interface FolderConfigEnv {
  source: string
  name: string
  /** '[masked]' when `masked`. */
  value: string
  /** The name or the value looked like a secret. */
  masked: boolean
  /** The name redirects where requests go or which model or account is used (a name Claude runs strip, or ending _BASE_URL). */
  routing?: boolean
  hiddenChar?: string
}

/**
 * A setting that redirects or runs things but is not a hook, env value, allow rule or MCP server of its own:
 * `.claude/settings*.json` enabledPlugins, extraKnownMarketplaces, permissions.defaultMode,
 * permissions.additionalDirectories, enableAllProjectMcpServers, enabledMcpjsonServers, mcpServers; and
 * `.codex/config.toml` notify, hooks, model_provider, model_providers, profile, profiles, approval_policy, sandbox_mode.
 */
export interface FolderConfigOtherSetting {
  /** The file it is declared in. */
  source: string
  /** The setting's name, dotted for a nested one ("permissions.defaultMode"). */
  key: string
  /** The value as compact JSON, secret-looking parts masked. Never cut: a value over the field cap makes the review unreviewable. */
  value: string
  /** Something in `value` was replaced by '[masked]'. */
  masked?: boolean
  hiddenChar?: string
}

export interface FolderConfigAllowRule {
  source: string
  rule: string
  /** OrgAI's reason for refusing this rule (allowRuleRefusal), else absent. A refused rule is never read as a saved rule. */
  refused?: string
  hiddenChar?: string
}

export interface FolderConfigMcpServer {
  source: string
  name: string
  /** The whole command line or URL as it would run; only credential-looking parts are replaced by '[masked]'. */
  target: string
  /** Something in `target` was replaced by '[masked]'. */
  masked?: boolean
  hiddenChar?: string
}

/** projects:folderConfig. What accepting would approve, read from disk at call time. */
export interface FolderConfigReview {
  projectId: string
  state: FolderConfigState
  /** Lowercase sha256 hex of what the digest binds right now. Send it back through the write channel. */
  digest: string
  files: FolderConfigFile[]
  commands: FolderConfigCommand[]
  env: FolderConfigEnv[]
  allowRules: FolderConfigAllowRule[]
  mcpServers: FolderConfigMcpServer[]
  /** Settings that redirect or run things beyond the lists above (see FolderConfigOtherSetting). */
  otherSettings: FolderConfigOtherSetting[]
  /** A list hit FOLDER_CONFIG_LIST_MAX or the total text cap. A file of 'tools' may be cut; anything that runs may not (see unreviewable). */
  truncated: boolean
  /**
   * Why this config cannot be accepted (too many files, too large, a link leaving the project folder, a settings file
   * too large to read, a command / helper / MCP target / env value / allow rule over 4,000 characters, a list that
   * reached FOLDER_CONFIG_LIST_MAX, or a file that runs commands whose text could not be shown in full). Nothing is
   * ever accepted unseen. The trust channel then refuses trust: true.
   */
  unreviewable?: string
}

/** projects:setFolderConfigTrust. `digest` is FolderConfigReview.digest of the review the user read. */
export interface FolderConfigTrustInput {
  projectId: string
  trust: boolean
  digest: string
}

export interface FolderConfigTrustResult {
  /** The saved project; the renderer replaces its copy. */
  project: Project
  review: FolderConfigReview
}

export interface OrgAIApi {
  /** Whether a project's own agent config may load. Takes effect from the next run; a live run keeps what it started with. */
  folderConfig: {
    review(projectId: string): Promise<FolderConfigReview>
    setTrust(input: FolderConfigTrustInput): Promise<FolderConfigTrustResult>
  }
  /** Start a project from a repository. Create the project afterwards with projects.create and the returned path. */
  repos: {
    /** Never rejects. */
    parseSource(text: string): Promise<RepoSourceParse>
    /** Never rejects. Reaches GitHub when gh is logged in (see RepoTools). */
    tools(): Promise<RepoTools>
    /**
     * Rejects with one readable line. A failure removes only what this call created; a pre-existing empty folder stays,
     * empty. When the fork was made and the clone failed, the message names the fork's URL: a fork is never rolled back.
     */
    clone(input: RepoCloneInput): Promise<RepoCloneResult>
    /** Unknown ids are ignored. The clone call then rejects with REPO_CLONE_CANCELLED_PREFIX. */
    cancelClone(requestId: string): Promise<void>
  }
  onRepoCloneProgress(cb: (event: RepoCloneProgress) => void): () => void
}

// ---- Team files ----
//
// A code project's team as plain files under `.orgai/` in its folder, so git carries it between computers. The
// ProjectStore's Project stays the cache every reader and adapter uses; files win, through an approval gate because the
// repository is untrusted. Logic: src/main/teamFiles/. Never for engagements or the virtual assistant projects. Nothing
// in the files is secret: names of secrets only, and no ids, timestamps or absolute paths.

/** team.json and mcp.json `format`. Another value is a problem naming the file, never a guess. */
export const TEAM_FILES_FORMAT = 'orgai.team/1'
/** Folder-relative, '/'-separated. */
export const TEAM_FILES_JSON = '.orgai/team.json'
export const TEAM_FILES_MCP_JSON = '.orgai/mcp.json'
export const TEAM_FILES_AGENTS_DIR = '.orgai/agents'
export const TEAM_FILES_SKILLS_DIR = '.orgai/skills'
/** Most roles read from `.orgai/agents`. */
export const TEAM_FILES_MAX_ROLES = 200
/** Largest role file, bytes. */
export const TEAM_FILES_MAX_ROLE_BYTES = 1024 * 1024
/** Largest team.json or mcp.json, bytes. */
export const TEAM_FILES_MAX_JSON_BYTES = 1024 * 1024
/** Most servers read from mcp.json. */
export const TEAM_FILES_MAX_SERVERS = 200
/** Largest whole team (every file together), bytes. Past it the team files are a problem and nothing is read or written. */
export const TEAM_FILES_MAX_TOTAL_BYTES = 32 * 1024 * 1024
/**
 * How many entries one status lists per list (changes, problems, notes, ...). Changes are sorted power first, so the cut
 * only ever drops the least risky ones, and `omittedChanges` counts them: approve and create-from-folder refuse while
 * anything is omitted, because the user could not have seen it.
 */
export const TEAM_FILES_LIST_MAX = 200

/**
 * 'off': the project does not use team files (see offReason). 'in-sync': the team in use is what the files say.
 * 'pending': the files hold changes that need approval; runs use the last approved team and get one warning.
 * 'rejected': the user refused the files' current content; runs quietly keep the last approved team until the files
 * change. 'problem': something in the folder could not be read (problems names it); the last approved team stays and
 * the file is not overwritten. A folder with both a problem and pending changes is 'problem' (approve refuses until it
 * is fixed) and still lists `changes`.
 */
export type TeamFilesState = 'off' | 'in-sync' | 'pending' | 'rejected' | 'problem'

/**
 * Why state is 'off'. 'engagement' and 'virtual': never. 'shared-folder': another OrgAI project owns this folder's team
 * files (the oldest project with that folder, TeamFilesStatus.sharedWith), so this one neither reads nor writes them
 * and its team stays in OrgAI's data folder. 'removed': the user ran "Remove OrgAI files" (teamFiles:enable turns it
 * back on). 'no-folder': the folder does not exist yet. 'not-written': a code project not opened since team files
 * landed; teamFiles:status writes its files, teamFiles:listAttention never does.
 */
export type TeamFilesOffReason = 'engagement' | 'virtual' | 'shared-folder' | 'removed' | 'no-folder' | 'not-written'

export type TeamFileChangeKind = 'role' | 'skill' | 'mcp' | 'settings'

/**
 * One difference between the last approved team and the files, in plain words. Text comes from the repository:
 * untrusted, show it as data (every string is length-capped and has hidden characters replaced).
 */
export interface TeamFileChange {
  /** Stable for one digest, e.g. "role:reviewer:tools". */
  id: string
  kind: TeamFileChangeKind
  /** What the change is about: a role name, skill name, server name or setting label. */
  name: string
  /** Folder-relative path of the file that holds it, e.g. ".orgai/agents/reviewer.md". */
  file: string
  action: 'added' | 'removed' | 'changed'
  /** One sentence, e.g. "Reviewer gains Bash and Write." */
  summary: string
  /** Needs teamFiles:approve before use. False: applied at once, undoable. */
  needsApproval: boolean
  /** With needsApproval: why, e.g. "New tools", "First time this repository's team is seen on this computer". */
  reason?: string
  /** Prompts and other text: the old and new whole text. Absent on an added or removed side. */
  before?: string
  after?: string
  /** Roles: the whole tool list on each side, and what is new. */
  toolsBefore?: string[]
  toolsAfter?: string[]
  toolsAdded?: string[]
  /** Tools newly held among Bash, Edit, Write, NotebookEdit, plus 'canSpawn'. */
  elevatedAdded?: string[]
  /** Skills: files that look like scripts. */
  scripts?: string[]
  /** MCP: what would run or connect, in full (never clamped; capabilities/sanitize.ts reviewTarget form). */
  target?: string
  /** MCP: secret slot names this computer must fill in before the server starts. */
  secretNames?: string[]
  /**
   * MCP: the file names a connector or a library server, so approving links this computer's stored entry and its stored
   * sign-in. `target` is then the ENTRY's real target, not the file's address.
   */
  usesStoredSignIn?: true
  /** MCP: the role slugs the server is limited to once approved. Absent: every role (the `summary` says so). */
  reachesRoles?: string[]
}

/** A file or folder that could not be used. The last approved content stays and the file is never overwritten. */
export interface TeamFileProblem {
  /** Folder-relative path. */
  file: string
  /** Plain words, e.g. "It has merge conflict markers." Never quotes file text. */
  message: string
}

/** Text that looks like a key and would be committed. Names the file, never the value. */
export interface TeamFileWarning {
  file: string
  message: string
}

/** What Undo would restore, or last restored. */
export interface TeamFilesUndoInfo {
  /** ISO time of the change it reverts (or of the undo, on lastUndo). */
  at: string
  /** Plain words, e.g. "Undo the 3 changes applied from the files". */
  label: string
  /** Folder-relative paths Undo rewrites (or rewrote): undoing changes the files, which then show as uncommitted. */
  files: string[]
}

/** teamFiles:status, the teamFiles:changed payload and every action's result. Readable with no run open. */
export interface TeamFilesStatus {
  projectId: string
  projectName: string
  state: TeamFilesState
  offReason?: TeamFilesOffReason
  /** offReason 'shared-folder': the project that owns this folder's team files. */
  sharedWith?: { projectId: string; projectName: string }
  /** The files' content digest (parsed content, never bytes). teamFiles:approve and teamFiles:reject send it back. */
  digest?: string
  /** No team of this folder was ever approved on this computer, so every difference needs approval. */
  firstSeen?: true
  /** The folder holds a .git. False: teamFiles:commit refuses. */
  isGitRepo: boolean
  /** Team files have changes git has not committed. Always false outside git. */
  uncommitted: boolean
  /** Those files, folder-relative, at most TEAM_FILES_LIST_MAX. */
  uncommittedFiles: string[]
  /** The changes waiting for approval (or refused, on 'rejected'). Empty when in sync. Most powerful first. */
  changes: TeamFileChange[]
  /** Changes beyond TEAM_FILES_LIST_MAX that are not listed. Greater than 0: approve is refused ("Too many changes to review at once"). */
  omittedChanges?: number
  /** The changes last applied at once from the files; what `undo` reverts. */
  applied: TeamFileChange[]
  problems: TeamFileProblem[]
  /** Plain-language notes: items left out of the files and why, plugins staying on this computer. */
  notes: string[]
  warnings: TeamFileWarning[]
  /** One level of Undo, when there is something to undo. */
  undo?: TeamFilesUndoInfo
  /** The last Undo that ran: which files it rewrote. */
  lastUndo?: TeamFilesUndoInfo
}

/** teamFiles:approve and teamFiles:reject input. A digest other than the current one is refused ("Review them again."). */
export interface TeamFilesDecisionInput {
  projectId: string
  digest: string
}

/** Input of teamFiles:status, teamFiles:undo, teamFiles:commit and teamFiles:enable. */
export interface TeamFilesProjectInput {
  projectId: string
}

/** approve, reject, undo and enable: the saved project (its team is the cache) and the fresh status. */
export interface TeamFilesActionResult {
  project: Project
  status: TeamFilesStatus
}

/** teamFiles:commit never rejects for a folder that is not git or a git refusal: ok false with a readable message. */
export interface TeamFilesCommitResult {
  ok: boolean
  message: string
  /** Folder-relative paths committed. */
  committed: string[]
  status: TeamFilesStatus
}

/** ProjectPathCheck.teamFiles: a team found in the folder, read without touching anything. Untrusted text, as above. */
export interface TeamFilesFound {
  /** Send back as ProjectCreateInput.teamFiles.digest. Absent when problems make the team unusable. */
  digest?: string
  roleCount: number
  /** Whole list, root first, at most TEAM_FILES_MAX_ROLES. */
  roles: { name: string; slug: string; prompt: string; tools: string[]; elevated: string[]; reportsTo: string | null }[]
  skills: { name: string; description: string; scripts: string[] }[]
  mcpServers: { name: string; target: string; secretNames: string[]; connectorId?: string }[]
  /** Every difference from nothing, for a review that matches the approval card. Most powerful first. */
  changes: TeamFileChange[]
  /** Changes beyond TEAM_FILES_LIST_MAX that are not listed. Greater than 0: `digest` is absent and creating is refused. */
  omittedChanges?: number
  /** The team's settings as the files hold them, in plain words (permission mode, limits, switches). */
  settings?: { label: string; value: string }[]
  problems: TeamFileProblem[]
  warnings: TeamFileWarning[]
}

/** ProjectCreateInput.teamFiles: start from the folder's team as previewed. Refused when the digest is stale. */
export interface TeamFilesCreateInput {
  digest: string
}

export interface ProjectCreateInput {
  /**
   * Start from the team in the folder's `.orgai/` as shown in ProjectPathCheck.teamFiles, approved by this call: the
   * project is stored with that team and never holds the default chart. Wins over importAgents and templateId. Code
   * projects only. Rejects with a readable message when the digest is stale or the files have a problem.
   */
  teamFiles?: TeamFilesCreateInput
}

export interface ProjectPathCheck {
  /**
   * A team in the folder (`.orgai/team.json` exists). While it is set, agentSources leaves out source 'orgai', so
   * `.orgai/` agents are never counted twice next to other sources.
   */
  teamFiles?: TeamFilesFound
}

export const TEAM_FILES_IPC = {
  /** Checks the folder (and writes a code project's files the first time) and returns TeamFilesStatus. Call it when a project opens. */
  teamFilesStatus: 'teamFiles:status',
  /** Every project with state 'pending' or 'problem', without a run and without writing anything: for Needs-you at boot. */
  teamFilesListAttention: 'teamFiles:listAttention',
  teamFilesApprove: 'teamFiles:approve',
  teamFilesReject: 'teamFiles:reject',
  teamFilesUndo: 'teamFiles:undo',
  teamFilesCommit: 'teamFiles:commit',
  /** Turn team files back on after "Remove OrgAI files": writes them from the current team. */
  teamFilesEnable: 'teamFiles:enable',
  /** main -> renderer push carrying TeamFilesStatus whenever a project's status changes. */
  teamFilesChanged: 'teamFiles:changed'
} as const

export interface OrgAIApi {
  /** A code project's team as files under `.orgai/`. Everything here works with no run open. */
  teamFiles: {
    status(input: TeamFilesProjectInput): Promise<TeamFilesStatus>
    listAttention(): Promise<TeamFilesStatus[]>
    /** Use the files' team. Rejects for a stale digest or while state is 'problem'. */
    approve(input: TeamFilesDecisionInput): Promise<TeamFilesActionResult>
    /** Keep the last approved team until the files change. Rejects for a stale digest. */
    reject(input: TeamFilesDecisionInput): Promise<TeamFilesActionResult>
    /** One level: rewrites the files back. Rejects when there is nothing to undo. */
    undo(input: TeamFilesProjectInput): Promise<TeamFilesActionResult>
    /** Stage and commit only the team files. Never pushes. */
    commit(input: TeamFilesProjectInput): Promise<TeamFilesCommitResult>
    enable(input: TeamFilesProjectInput): Promise<TeamFilesActionResult>
  }
  onTeamFilesChanged(cb: (status: TeamFilesStatus) => void): () => void
  /** The secure storage's notices (Dashboard): status, restore, keep removed, try again, start over. Never a value. */
  secrets: {
    status(input?: SecretsStatusInput): Promise<SecretsStatusResult>
    undelete(input: SecretsUndeleteInput): Promise<SecretsUndeleteResult>
    confirmDelete(input: SecretsConfirmDeleteInput): Promise<SecretsConfirmDeleteResult>
    /** Open a locked vault again (or create an absent one). */
    init(input?: SecretsInitInput): Promise<SecretsInitResult>
    /** Move a damaged vault (and a damaged secrets.json) aside. The caller confirms first. */
    reset(input: SecretsResetInput): Promise<SecretsResetResult>
  }
}

// ---- Self-knowledge and self-configuration ----
//
// OrgAI answers questions about itself and configures itself from its own registries, so the answers stay true as the
// app grows. The atlas (src/shared/view/atlas.ts: every screen with its path and how to reach it, a doc per AppSettings
// and Project field, a doc per MenuAction) is typed against these contracts, so a new field, screen or menu action
// without a doc fails typecheck or atlas.test.ts. The main-process reference service (src/main/reference/) builds a
// fenced corpus from the atlas and the code's registries (harness tool defs, HOST_CHANNEL_REGISTRY, CLI COMMANDS,
// CONNECTORS) plus bundled docs. Channels: SELF_KNOWLEDGE_IPC (declared before IPC and spread into it).

/** The atlas surface id union (the literal ids of ATLAS_SURFACE_IDS in src/shared/view/atlas.ts). */
export type { AtlasSurfaceId } from './view/atlas'

/** Harness tool: read OrgAI's own reference. Audience 'all', read-only, non-blocking, every run kind. */
export const APP_REFERENCE_TOOL = 'app_reference'
/** Harness tool: show the user a place in the app (an atlas surface). Chat, setup, MCP and Skill assistant roots only. */
export const OPEN_IN_APP_TOOL = 'open_in_app'
/** Harness tool: propose app-wide settings changes (Proposal kind 'appSettings'). Chat only. */
export const PROPOSE_APP_SETTINGS_TOOL = 'propose_app_settings'
/** Harness tool: propose a stored project's settings (Proposal kind 'settings' with `target`). Chat only. */
export const PROPOSE_PROJECT_SETTINGS_TOOL = 'propose_project_settings'
/** The self-knowledge and self-configuration tools Chat (quick runs) gets, in addition to list_projects. */
export const CHAT_CONFIG_TOOLS = [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL] as const

/** app_reference / app:reference actions. 'status' is answered only on Chat, MCP and Skill assistant runs and over IPC. */
export const APP_REFERENCE_ACTIONS = ['search', 'read', 'locate', 'status'] as const
export type AppReferenceAction = (typeof APP_REFERENCE_ACTIONS)[number]

/** Default and largest character budget of a search or locate answer (`AppReferenceResult.text.length <= budget`). */
export const APP_REFERENCE_BUDGET_DEFAULT = 2000
export const APP_REFERENCE_BUDGET_MIN = 400
export const APP_REFERENCE_BUDGET_MAX = 8000
/** Longest `query`; longer is refused (never cut). */
export const APP_REFERENCE_QUERY_MAX_CHARS = 500
/** Longest `id` (a section id, e.g. 'surface:app-settings-general-appearance', 'doc:how-it-works#asking-orgai'). */
export const APP_REFERENCE_ID_MAX_CHARS = 200
/** Most characters one `read` returns; a longer section is cut and says so. */
export const APP_REFERENCE_READ_MAX_CHARS = 8000

/**
 * A request to the reference. search: `query` required, ranked sections within `budget` (default
 * APP_REFERENCE_BUDGET_DEFAULT, clamped to APP_REFERENCE_BUDGET_MIN..APP_REFERENCE_BUDGET_MAX). read: `id` required (a
 * section id from a hit). locate: `query` required, answered with atlas paths ("App settings › General › Appearance")
 * and how to reach them plus the setting fields there. status: no other field. Hidden characters in `query` or `id`
 * are refused. Inputs are rebuilt in main (host/args.ts appReferenceArgs); unknown fields are dropped.
 */
export interface AppReferenceQuery {
  action: AppReferenceAction
  query?: string
  id?: string
  budget?: number
}

/** What a reference section is built from. */
export type AppReferenceSectionKind = 'surface' | 'setting' | 'menu' | 'shortcut' | 'tool' | 'channel' | 'command' | 'connector' | 'doc' | 'status'

/** One ranked section of a search or locate answer. `id` is what `read` takes. */
export interface AppReferenceHit {
  id: string
  kind: AppReferenceSectionKind
  title: string
  /** Relative score, 0 < score <= 1 (1 = the best hit of this answer). */
  score: number
}

/**
 * The answer. `text` is the whole answer for a model or a reader: ids, counts and the service's own sentences outside
 * fences, every value from a registry or doc inside a fence (`<<<` `>>>`, look-alike substitution, like harnessTools
 * `datum` / `fencedBlock`). Never secrets, keys, tokens or URLs with credentials. `hits` (search, locate) in rank order.
 */
export interface AppReferenceResult {
  text: string
  hits?: AppReferenceHit[]
}

/**
 * main -> renderer push on SELF_KNOWLEDGE_IPC.appNavigate (desktop only): an agent asked to show the user a place.
 * index.ts sends it to the live unscoped main window (restored and focused, created when closed), like menu actions.
 * The renderer opens `surfaceId` (for project / engagement / run surfaces, in `projectId`) and announces "<agentLabel>
 * opened <path>". `runId` is the run that asked (the renderer may link back to it). Main validated every field.
 */
export interface AppNavigateEvent {
  surfaceId: AtlasSurfaceId
  /** A stored (never virtual) project; present for project, engagement and (optionally) run surfaces, else absent. */
  projectId?: string
  runId: string
  /** Who asked, for the announcement: the calling role's name ("Assistant", "Architect"), plain text, at most 80 chars. */
  agentLabel: string
}

/** open_in_app limits per run (RunManager): at most this many navigations, and at most one per interval. */
export const OPEN_IN_APP_PER_RUN_MAX = 20
export const OPEN_IN_APP_MIN_INTERVAL_MS = 2000

/** open_in_app's answer from RuntimeContext.navigate. `path` is atlasPath(surfaceId). */
export type AppNavigateOutcome = { ok: true; path: string } | { ok: false; refusal: string }

/**
 * AppSettings fields an agent may propose (propose_app_settings), as dotted paths into AppSettings. Never main-owned
 * fields, connections, proxies, auth, terminal access, model prices or the default connection (change those in App
 * settings). Each path's top-level key has `proposable: true` in APP_SETTING_DOCS (atlas.test.ts checks).
 */
export const APP_SETTINGS_PROPOSABLE_FIELDS = [
  'appearance.theme',
  'appearance.accent',
  'appearance.reduceMotion',
  'appearance.canvas.pattern',
  'appearance.canvas.tint',
  'appearance.canvas.edges',
  'appearance.canvas.layout',
  'appearance.canvas.nodeStyle',
  'appearance.canvas.minimap',
  'notifications',
  'defaultPermissionMode',
  'defaultMaxBudgetUsd',
  'defaultKeepRuns',
  'defaultIsolateWriters',
  'defaultRootModel',
  'defaultReportModel',
  'setupModel',
  'mcpAssistModel',
  'skillAssistModel',
  'quickRunModel',
  'opusGuardThreshold',
  'communityPrices',
  'defaultAutoContinue',
  'defaultMaxAutoContinues'
] as const
export type AppSettingsProposableField = (typeof APP_SETTINGS_PROPOSABLE_FIELDS)[number]

export function isAppSettingsProposableField(value: unknown): value is AppSettingsProposableField {
  return typeof value === 'string' && (APP_SETTINGS_PROPOSABLE_FIELDS as readonly string[]).includes(value)
}

/** A proposable setting's value: null only clears an optional number (defaultMaxBudgetUsd = no cap). */
export type AppSettingValue = string | number | boolean | null

/** At most this many changes in one appSettings proposal. */
export const APP_SETTINGS_PROPOSAL_MAX_CHANGES = 20

/**
 * One change of an appSettings proposal. `from` is the stored value when the card was created (main reads it; never
 * the agent's), `to` the proposed value (validated per field by src/shared/appSettingsProposal.ts
 * `appSettingValueProblem`), `label` the field's human name (from the atlas doc, never agent text).
 */
export interface AppSettingChange {
  field: AppSettingsProposableField
  from: AppSettingValue
  to: AppSettingValue
  label: string
}

/**
 * Proposal kind 'appSettings' (propose_app_settings, Chat only): app-wide settings changes, each field at most once.
 * Approval applies them through the settings:set path (args.ts settingsSetArgs, SettingsStore normalization, theme,
 * settings:changed broadcast); Proposal.effect 'now'.
 */
export interface AppSettingsProposalPayload {
  changes: AppSettingChange[]
  rationale: string
}

/** ProposalBase.target: the stored project a Chat proposal changes, filled by main from the stored project. */
export interface ProposalTarget {
  projectId: string
  /** The stored project's name when the card was created (display only). */
  projectName: string
}

/**
 * SettingsProposalPayload fields propose_project_settings may set (Chat). Not allowRules (saved permission rules are
 * granted on permission cards and in Settings only), and permissionMode never 'bypassPermissions'.
 */
export const PROJECT_SETTINGS_PROPOSABLE_FIELDS = [
  'brief',
  'permissionMode',
  'maxBudgetUsd',
  'maxSubagentDepth',
  'maxConcurrentSubagents',
  'isolateWriters',
  'reviewMerges',
  'autoContinue',
  'maxAutoContinues',
  'client'
] as const satisfies readonly (keyof SettingsProposalPayload & keyof Project)[]
export type ProjectSettingsProposableField = (typeof PROJECT_SETTINGS_PROPOSABLE_FIELDS)[number]

export interface OrgAIApi {
  /** An agent's open_in_app asked to show a place (SELF_KNOWLEDGE_IPC.appNavigate). Returns an unsubscribe function. */
  onAppNavigate(cb: (event: AppNavigateEvent) => void): () => void
}

// ---- Run outputs ----
//
// Deliverables agents make for the user (documents, workbooks, diagrams, text files, images, any file they wrote) and
// that OrgAI shows inside its window. Produced files are written by main into `<project folder>/outputs/`; registered
// files stay where the agent wrote them. The index lives in OrgAI's data folder (`<data>/projects/<id>/outputs.json`),
// so an engagement's working folder holds only the deliverables. Agents reach this through the produce_output and
// register_output harness tools (work runs of stored projects, team 'default' and 'single'; never quick, setup-like or
// trust-restricted runs); the user through the outputs:* channels. Everything here is structured-clone safe.

/**
 * What an output is. docx, xlsx, pptx, mermaid, markdown, text, csv, json, svg and image preview inline; pdf and other
 * are open-only. pptx (outputs-2 Phase B) is a PowerPoint deck: produced from a SlideDeckInput or registered.
 */
export type OutputKind = 'docx' | 'xlsx' | 'pptx' | 'mermaid' | 'markdown' | 'text' | 'csv' | 'json' | 'svg' | 'image' | 'pdf' | 'other'

export const OUTPUT_KINDS: readonly OutputKind[] = ['docx', 'xlsx', 'pptx', 'mermaid', 'markdown', 'text', 'csv', 'json', 'svg', 'image', 'pdf', 'other']

/** Kinds the renderer previews inline (outputs:preview answers kind 'none' for the rest). */
export const OUTPUT_PREVIEW_KINDS: readonly OutputKind[] = ['docx', 'xlsx', 'pptx', 'mermaid', 'markdown', 'text', 'csv', 'json', 'svg', 'image']

/** Kinds produce_output writes (main renders docx / xlsx / pptx; the rest are the text written as the file). */
export const OUTPUT_PRODUCE_KINDS = ['docx', 'xlsx', 'pptx', 'mermaid', 'markdown', 'text', 'csv', 'json', 'svg'] as const
export type OutputProduceKind = (typeof OUTPUT_PRODUCE_KINDS)[number]

/** Kinds the user edits as text inside OrgAI (outputs:readSource / outputs:saveEdit). */
export const OUTPUT_EDITABLE_KINDS: readonly OutputKind[] = ['markdown', 'text', 'csv', 'json', 'mermaid', 'svg']

/** File extension main forces per produced kind (without the dot). */
export const OUTPUT_PRODUCE_EXTENSIONS: Readonly<Record<OutputProduceKind, string>> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  mermaid: 'mmd',
  markdown: 'md',
  text: 'txt',
  csv: 'csv',
  json: 'json',
  svg: 'svg'
}

/** Folder (inside the project folder) produced files land in. */
export const OUTPUTS_DIR_NAME = 'outputs'
/** Index entries per project; past it the oldest entry is forgotten (its file stays) with a log line. */
export const OUTPUTS_MAX = 2000
/** produce_output + register_output successes per run; past it both answer REFUSED. */
export const OUTPUTS_RUN_MAX = 200
/** Largest file register_output accepts. */
export const OUTPUT_FILE_MAX_BYTES = 50 * 1024 * 1024
/** RunOutput.title length (1..this), one line, no hidden characters. */
export const OUTPUT_TITLE_MAX_CHARS = 120
/** RunOutput.description length, no hidden characters (prose: line breaks allowed). */
export const OUTPUT_DESCRIPTION_MAX_CHARS = 500
/** Path length cap for a registered path and for the produced `fileName`. */
export const OUTPUT_PATH_MAX_CHARS = 1024
/** produce_output text content cap (mermaid, markdown, text, csv, json, svg and the docx Markdown source), UTF-8 bytes. */
export const OUTPUT_TEXT_MAX_BYTES = 1024 * 1024
/** produce_output xlsx caps. A string cell starting with '=' is written as text (never a formula). */
export const OUTPUT_XLSX_MAX_SHEETS = 20
export const OUTPUT_XLSX_MAX_ROWS = 10_000
export const OUTPUT_XLSX_MAX_COLUMNS = 256
export const OUTPUT_XLSX_CELL_MAX_CHARS = 32 * 1024
/** Excel's own sheet name limit; forbidden characters (: \ / ? * [ ]) are replaced. */
export const OUTPUT_XLSX_SHEET_NAME_MAX_CHARS = 31
/** Preview caps. */
export const OUTPUT_PREVIEW_TEXT_MAX_BYTES = 256 * 1024
export const OUTPUT_PREVIEW_SHEETS_MAX = 20
export const OUTPUT_PREVIEW_ROWS_MAX = 500
export const OUTPUT_PREVIEW_COLUMNS_MAX = 64
/** One embedded image in a document preview, and all of them together. */
export const OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024
/** An image (or svg) file previewed whole. */
export const OUTPUT_PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** RunOutput.id shape. */
export const OUTPUT_ID_RE = /^out_[0-9a-f]{16}$/

// Outputs 2 (docs/design/outputs-2.md section 16): versions, notes, revise, decks, compare, watch.
/** Versions kept per output; past it the oldest version that is not v1, not current and not named is dropped (log line). */
export const OUTPUT_VERSIONS_MAX = 100
/** Snapshot bytes kept per project; past it the oldest droppable versions across outputs go first (same rule). */
export const OUTPUT_VERSIONS_BYTES_MAX = 500 * 1024 * 1024
/** OutputVersion.label length (a user name for a version; a named version is never pruned). */
export const OUTPUT_VERSION_LABEL_MAX_CHARS = 60
/** OutputNote.text length (1..this), no hidden characters (prose: line breaks allowed). */
export const OUTPUT_NOTE_TEXT_MAX = 2000
/** Notes per output (all versions together). */
export const OUTPUT_NOTES_MAX = 500
/** Quote / label caps inside a note anchor (untrusted document text; cut, never refused). */
export const OUTPUT_NOTE_QUOTE_MAX_CHARS = 400
export const OUTPUT_NOTE_LABELS_MAX = 20
export const OUTPUT_NOTE_LABEL_MAX_CHARS = 80
/** OutputReviseInput.instruction length, no hidden characters (prose). */
export const OUTPUT_REVISE_TEXT_MAX = 4000
/** Revision requests kept per output (oldest dropped). */
export const OUTPUT_REVISIONS_MAX = 50
/** produce_output pptx caps (SlideDeckInput). */
export const OUTPUT_PPTX_MAX_SLIDES = 100
export const OUTPUT_PPTX_ELEMENTS_PER_SLIDE = 40
export const OUTPUT_PPTX_TEXT_MAX_CHARS = 5000
export const OUTPUT_PPTX_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const OUTPUT_PPTX_TOTAL_MAX_BYTES = 40 * 1024 * 1024
export const OUTPUT_PPTX_FONT_MAX_CHARS = 64
/** pptx preview caps (SlidePreview). */
export const OUTPUT_PREVIEW_SLIDES_MAX = 200
export const OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES = 8 * 1024 * 1024
export const OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024
/** Shapes drawn per previewed slide (more are dropped; the slide carries truncatedShapes). */
export const OUTPUT_PREVIEW_SLIDE_SHAPES_MAX = 200
/** In-OrgAI text editing cap (outputs:readSource / outputs:saveEdit). */
export const OUTPUT_EDIT_MAX_BYTES = OUTPUT_TEXT_MAX_BYTES
/** outputs:saveImage payload cap (decoded bytes). */
export const OUTPUT_EXPORT_IMAGE_MAX_BYTES = 25 * 1024 * 1024
/** An external change is accepted once size and mtime held still this long. */
export const OUTPUT_EXTERNAL_SETTLE_MS = 1500
/** Outputs one window may watch at once, and how long a watch lives after its last outputs:watch / outputs:open. */
export const OUTPUT_WATCH_MAX = 8
export const OUTPUT_WATCH_TTL_MS = 600_000
/** outputs:compare caps. */
export const OUTPUT_DIFF_TEXT_LINES_MAX = 5000
export const OUTPUT_DIFF_SLIDES_MAX = 200
/** Thumbnail caps (OutputThumb). */
export const OUTPUT_THUMB_IMAGE_MAX_BYTES = 24 * 1024
export const OUTPUT_THUMB_LINES_MAX_CHARS = 240
/** OutputNote.id / OutputRevisionRequest.id shapes. */
export const OUTPUT_NOTE_ID_RE = /^note_[0-9a-f]{16}$/
export const OUTPUT_REVISION_ID_RE = /^rev_[0-9a-f]{16}$/

/** Who made a version: an agent (produce / register, a revision too: then `answers` is set), the user's save in OrgAI, a change seen on disk, a restore. */
export type OutputVersionSource = 'agent' | 'edit' | 'external' | 'restore'

/**
 * One version of an output (newest has the highest n). Versions are never edited (except `label`); each has a snapshot
 * in OrgAI's data folder (`<data>/projects/<id>/outputs/<outputId>/v<n>.<ext>`). runId / agentId / role only for
 * source 'agent' (from the run's agent record, never the agent). `title` is the output title when this version was made.
 */
export interface OutputVersion {
  n: number
  source: OutputVersionSource
  createdAt: number
  runId?: string
  agentId?: string
  role?: string
  title: string
  label?: string
  bytes: number
  /** sha256 hex of the snapshot. */
  digest: string
  /** The revision request (rev_...) this version answers. */
  answers?: string
  /** source 'restore': the version restored. */
  restoredFrom?: number
  noteCount: number
  openNoteCount: number
}

/** Where a note points (offsets and fractions are of the version it belongs to). quote / labels are untrusted document text. */
export type OutputNoteAnchor =
  /** text, markdown (source offsets), json, csv as text, mermaid / svg source: UTF-16 offsets, end exclusive. */
  | { type: 'text'; start: number; end: number; quote: string }
  /** docx: a preview block index and a character range inside that block's text. */
  | { type: 'block'; index: number; start: number; end: number; quote: string }
  /** sheet / csv grid, 0-based inclusive; sheet '' for csv. */
  | { type: 'cells'; sheet: string; r1: number; c1: number; r2: number; c2: number; quote?: string }
  /** slide (1-based `slide`), image, svg, diagram: x, y, w, h fractions 0..1 of the drawing; labels are shape texts the region covers. */
  | { type: 'region'; slide?: number; shape: 'box' | 'ellipse'; x: number; y: number; w: number; h: number; labels?: string[] }
  /** A whole slide (1-based). */
  | { type: 'slide'; slide: number }
  | { type: 'whole' }

export type OutputNoteStatus = 'open' | 'resolved' | 'sent'

/** A user's note on one version of an output. Agents never write notes. */
export interface OutputNote {
  id: string
  outputId: string
  version: number
  anchor: OutputNoteAnchor
  text: string
  status: OutputNoteStatus
  createdAt: number
  resolvedAt?: number
  /** The revision request (rev_...) it was sent in. */
  sentIn?: string
}

/** A request to the team to revise an output (outputs:revise), kept per output (at most OUTPUT_REVISIONS_MAX). */
export interface OutputRevisionRequest {
  id: string
  outputId: string
  /** The version the user looked at when asking. */
  version: number
  /** The run that got the request (a continuation's new run id for 'continued', the new run for 'started'). */
  runId: string
  mode: 'sent' | 'continued' | 'started'
  scope: 'whole' | 'selection' | 'notes'
  noteIds?: string[]
  createdAt: number
  /** The version that answered it (set when that run produced or registered a version of this output). */
  answeredBy?: number
  /** Set when the run reached an outcome without answering. */
  endedAt?: number
}

/**
 * One deliverable in the project's index. `path` is absolute (inside the project folder or one of
 * Project.allowedDirectories; produced ones under `<project>/outputs/`); `relPath` is what the user sees (relative to
 * the project folder, or the absolute path for an allowed folder outside it), forward slashes. `agentId` / `role` come
 * from RunManager (the run's agent record), never from the agent. `missing` is set by outputs:list when the file is
 * gone; the entry is kept until the user forgets it.
 *
 * Outputs 2: an output is one file (identity = the case-folded real path on win32 / darwin). `runId` / `agentId` /
 * `role` are of the run that made v1; the current version's maker is in `current` and outputs:versions. The version
 * fields are optional in the type only so older renderer fixtures compile: main always sets them (index format 2).
 */
export interface RunOutput {
  id: string
  projectId: string
  runId: string
  agentId?: string
  role?: string
  kind: OutputKind
  title: string
  description?: string
  /** Base name of the file (for a produced file with a sub-path: the last segment only). */
  fileName: string
  path: string
  relPath: string
  bytes: number
  /** Epoch ms of the first index write (a new version keeps it and sets updatedAt). */
  createdAt: number
  /** The current version's createdAt. */
  updatedAt?: number
  source: 'produced' | 'registered'
  missing?: true
  /** Current version number (1-based). */
  version?: number
  /** Versions kept (after pruning; can be lower than `version`). */
  versionCount?: number
  /** sha256 hex of the current version's snapshot (equality only). */
  contentDigest?: string
  /** Open notes over all versions. */
  openNoteCount?: number
  /** Who made the current version and when. */
  current?: { source: OutputVersionSource; at: number; runId?: string; agentId?: string; role?: string }
  /** Set once versions were pruned by a cap. */
  versionsPruned?: true
}

/** produce_output xlsx content: one entry per sheet. */
export interface OutputSheetInput {
  name: string
  columns?: { header: string; width?: number }[]
  rows: (string | number | boolean | null)[][]
  /** Excel number formats by column index (e.g. '#,##0.00', '0%', 'yyyy-mm-dd'); a missing entry = General. */
  numberFormat?: (string | null)[]
}

export interface OutputWorkbookInput {
  sheets: OutputSheetInput[]
}

/**
 * produce_output input (what the tool hands RuntimeContext.outputs.produce after its own shape checks). `content` is
 * Markdown (docx; a subset: headings, paragraphs, bold, italic, code, lists one level deep, GFM tables, fenced code,
 * rules), an OutputWorkbookInput (xlsx), a SlideDeckInput (pptx), or the file's text (the rest). `fileName` is
 * relative to `<project>/outputs/` (sub-folders allowed, never `..`, absolute, device or UNC; the kind's extension is
 * forced); missing = a safe name from the title.
 *
 * Identity rule (outputs-2 section 3): a target path that is an indexed output of this project (any run) adds a version
 * to it (no version when the content digest is unchanged); a path that exists but is not indexed gets a " (2)" style
 * suffix and becomes a new output; `separate: true` always takes the suffix route. `overwrite` is accepted and ignored.
 */
export interface OutputProduceInput {
  kind: OutputProduceKind
  title: string
  fileName?: string
  description?: string
  /** Ignored since outputs 2 (kept so older prompts validate). */
  overwrite?: boolean
  separate?: boolean
  content: string | OutputWorkbookInput | SlideDeckInput
}

/** A colour in deck input and slide previews: lowercase or uppercase `#rrggbb` only. */
export const OUTPUT_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** A block in a two-content slide column. */
export type SlideBlock =
  | { type: 'bullets'; bullets: { text: string; level?: 0 | 1 | 2 }[] }
  | { type: 'body'; text: string }
  | { type: 'image'; path: string; alt: string; caption?: string }
  | { type: 'table'; rows: string[][]; header?: boolean }

/**
 * One slide of produce_output pptx. Strings are plain text (never markup). `image.path` follows register_output's
 * confinement (inside the project or an allowed folder, regular file, no link, png / jpeg / gif / webp, at most
 * OUTPUT_PPTX_IMAGE_MAX_BYTES); no URLs.
 */
export interface SlideInput {
  layout: 'title' | 'section' | 'content' | 'two-content' | 'image' | 'blank'
  title?: string
  subtitle?: string
  bullets?: { text: string; level?: 0 | 1 | 2 }[]
  body?: string
  left?: SlideBlock[]
  right?: SlideBlock[]
  image?: { path: string; alt: string; caption?: string }
  table?: { rows: string[][]; header?: boolean }
  /** Speaker notes. */
  notes?: string
}

/** produce_output pptx content. Fonts are names only (printable, at most OUTPUT_PPTX_FONT_MAX_CHARS). */
export interface SlideDeckInput {
  size?: '16:9' | '4:3'
  theme?: { accent?: string; fontHeading?: string; fontBody?: string }
  slides: SlideInput[]
}

/**
 * register_output input: a file the agent wrote itself. `path` absolute or relative to the project folder; it must
 * be a regular file (no link or junction) whose real path is inside the project folder or an allowed folder, never a
 * reference folder, OrgAI's data folder or under `.git`, at most OUTPUT_FILE_MAX_BYTES. `kind` missing = from the
 * extension (outputKindForPath). A path already in the index (any run) adds a version when its content changed, else
 * changes nothing but title / description. `.pptm` (macro-bearing) is refused.
 */
export interface OutputRegisterInput {
  path: string
  title: string
  kind?: OutputKind
  description?: string
}

/** outputs:preview input. `version` missing = the current version (read from its snapshot when not current). */
export interface OutputPreviewInput {
  projectId: string
  outputId: string
  version?: number
}

/** outputs:open / reveal / saveAs / forget / delete input. */
export interface OutputRef {
  projectId: string
  outputId: string
}

/** outputs:readSource / thumb / restore input. */
export interface OutputVersionRef {
  projectId: string
  outputId: string
  version: number
}

/** A run of text in a document preview. `href` only http:, https: or mailto:. */
export interface DocumentRun {
  text: string
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  code?: true
  href?: string
}

/** A block of a document preview. Never HTML: the renderer builds elements from these. */
export type DocumentBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: DocumentRun[] }
  | { type: 'paragraph'; runs: DocumentRun[] }
  | { type: 'list'; ordered: boolean; items: DocumentRun[][] }
  /** rows -> cells -> runs. `headerRows` = how many leading rows are header rows. */
  | { type: 'table'; rows: DocumentRun[][][]; headerRows?: number }
  /** dataUrl only data:image/(png|jpeg|gif|webp);base64, within the image caps. */
  | { type: 'image'; dataUrl: string; alt: string }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'pageBreak' }

/** A cell of a sheet preview: the value (a formula cell's cached result), its formula text and number format. Dates are ISO strings. */
export interface SheetCell {
  v: string | number | boolean | null
  f?: string
  fmt?: string
}

export interface SheetPreview {
  name: string
  rows: SheetCell[][]
  /** Rows / columns beyond the preview caps that are not shown (counts). */
  truncatedRows?: number
  truncatedCols?: number
}

/**
 * outputs:preview result. Never raw HTML, never a throw for a bad file: a corrupt, oversized, missing or open-only
 * file answers kind 'none' with a plain sentence. 'text' covers markdown, text, csv, json and mermaid source (the
 * renderer renders markdown and mermaid itself); 'svg' is the SVG source as text (the renderer decides how to show it
 * safely); 'image' is a data URL of a png / jpeg / gif / webp file.
 */
export type OutputPreview =
  | { kind: 'document'; blocks: DocumentBlock[]; truncated?: true }
  | { kind: 'sheets'; sheets: SheetPreview[]; truncatedSheets?: number }
  | { kind: 'text'; text: string; truncated?: true }
  | { kind: 'svg'; text: string }
  | { kind: 'image'; dataUrl: string }
  /** pptx: `size` in points; `truncatedSlides` = slides past OUTPUT_PREVIEW_SLIDES_MAX not shown (a lower bound). */
  | { kind: 'slides'; size: { w: number; h: number }; slides: SlidePreview[]; truncatedSlides?: number }
  | { kind: 'none'; reason: string }

/** A run in a slide preview: DocumentRun plus size (pt), colour (`#rrggbb` only) and a font name used only as a hint. */
export interface SlideRun extends DocumentRun {
  sizePt?: number
  color?: string
  font?: string
}

export interface SlideParagraph {
  runs: SlideRun[]
  level?: number
  bullet?: 'disc' | 'number'
  align?: 'left' | 'center' | 'right'
}

/** Geometry of every shape: fractions (0..1, may overflow slightly) of the slide width / height. */
export interface SlideBox {
  x: number
  y: number
  w: number
  h: number
}

/** One drawable thing on a slide. Colours `#rrggbb` only; images only safe data URLs within the deck image caps. */
export type SlideShape =
  | (SlideBox & { type: 'text'; paragraphs: SlideParagraph[]; anchor?: 'top' | 'middle' | 'bottom'; fill?: string; line?: string })
  | (SlideBox & { type: 'image'; dataUrl: string; alt?: string })
  | (SlideBox & { type: 'shape'; geometry: 'rect' | 'roundRect' | 'ellipse' | 'other'; fill?: string; line?: string })
  | (SlideBox & { type: 'table'; rows: DocumentRun[][][] })
  | (SlideBox & { type: 'placeholder'; label: 'Chart' | 'SmartArt' | 'Video' | 'Picture' | 'Object'; alt?: string })

/** One slide of a deck preview (`n` 1-based). `notes` = speaker notes as plain text. */
export interface SlidePreview {
  n: number
  title?: string
  background?: string
  shapes: SlideShape[]
  notes?: string
  /** Shapes past OUTPUT_PREVIEW_SLIDE_SHAPES_MAX not drawn. */
  truncatedShapes?: number
}

/**
 * outputs:thumb result (small, lazy; the renderer caches it by id + version). 'svg' carries the checked SVG text (the
 * renderer rasterizes it); 'image' a data URL of at most OUTPUT_THUMB_IMAGE_MAX_BYTES (else 'none'); 'lines' at most
 * 4 lines / OUTPUT_THUMB_LINES_MAX_CHARS; 'cells' the top-left 4 x 6 block of the first sheet.
 */
export type OutputThumb =
  | { kind: 'slide'; size: { w: number; h: number }; slide: SlidePreview }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'svg'; text: string }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'cells'; rows: (string | number | boolean | null)[][] }
  | { kind: 'none' }

/** A changed span inside a line or block text: [start, end) UTF-16 offsets. */
export type OutputDiffMark = [number, number]

export interface OutputDiffLine {
  op: 'eq' | 'add' | 'del'
  /** 1-based line numbers in A / B. */
  a?: number
  b?: number
  text: string
  marks?: OutputDiffMark[]
}

export interface OutputDiffHunk {
  aStart: number
  aCount: number
  bStart: number
  bCount: number
  lines: OutputDiffLine[]
}

export interface OutputDiffCellChange {
  r: number
  c: number
  op: 'add' | 'del' | 'chg'
  was?: string | number | boolean | null
  now?: string | number | boolean | null
}

/**
 * outputs:compare result. Data only (no HTML). 'text' for text kinds (3 lines of context; `truncated` past
 * OUTPUT_DIFF_TEXT_LINES_MAX changed lines), 'blocks' for docx (by preview block, word marks on changed ones; a/b are
 * block indexes), 'cells' for xlsx and csv (per sheet, within the preview caps), 'slides' for pptx (aligned pairs, a/b
 * 1-based slide numbers), 'none' for kinds with no text form or a failed read.
 */
export type OutputDiff =
  | { kind: 'text'; hunks: OutputDiffHunk[]; added: number; removed: number; truncated?: true }
  | { kind: 'blocks'; rows: { op: 'eq' | 'add' | 'del' | 'chg'; a?: number; b?: number; marks?: { a?: OutputDiffMark[]; b?: OutputDiffMark[] } }[]; truncated?: true }
  | {
      kind: 'cells'
      sheets: { name: string; status: 'same' | 'changed' | 'added' | 'removed'; changes: OutputDiffCellChange[]; rowOps: { r: number; op: 'add' | 'del' }[]; truncated?: true }[]
    }
  | { kind: 'slides'; pairs: { a?: number; b?: number; status: 'same' | 'changed' | 'added' | 'removed' }[]; truncated?: true }
  | { kind: 'none'; reason: string }

/** outputs:compare input: two version numbers of one output. */
export interface OutputCompareInput {
  projectId: string
  outputId: string
  a: number
  b: number
}

/** outputs:readSource result (editable kinds, at most OUTPUT_EDIT_MAX_BYTES). */
export type OutputSourceResult = { text: string; digest: string } | { refused: string }

/** outputs:saveEdit input: the whole new text of an editable output, based on `baseVersion`. `forceNew` saves even when a newer version exists. */
export interface OutputSaveEditInput {
  projectId: string
  outputId: string
  baseVersion: number
  text: string
  forceNew?: boolean
}

export type OutputSaveEditResult = { ok: true; output: RunOutput; version: number } | { stale: true; currentVersion: number } | { refused: string }

/** outputs:restore result. */
export type OutputRestoreResult = { ok: true; output: RunOutput; version: number } | { refused: string }

/** outputs:update input: rename / describe the output, name a version. No file change, no new version. Absent = unchanged; description '' clears; label '' clears. */
export interface OutputUpdateInput {
  projectId: string
  outputId: string
  title?: string
  description?: string
  versionLabel?: { n: number; label: string }
}

/** outputs:deletePreview result: what a delete would remove, for the renderer's confirm. */
export interface OutputDeletePreview {
  path: string
  relPath: string
  outsideOutputsFolder: boolean
  /** Stored versions (snapshots) the delete removes. */
  versions: number
  /** The OS trash is available (else the file is deleted for good). */
  trash: boolean
  missing: boolean
}

/**
 * outputs:delete input. `expectedVersionCount` is the preview's `versions`; main refuses ("This output changed. Check it
 * and delete again.") when it differs. It may be left out only for a produced output with one version (the pre-outputs-2
 * delete); every other delete must send it.
 */
export interface OutputDeleteInput {
  projectId: string
  outputId: string
  expectedVersionCount?: number
}

/** outputs:noteAdd input. */
export interface OutputNoteAddInput {
  projectId: string
  outputId: string
  version: number
  anchor: OutputNoteAnchor
  text: string
}

/** outputs:noteUpdate input: new text and / or status ('sent' is main-only and refused here). */
export interface OutputNoteUpdateInput {
  projectId: string
  outputId: string
  noteId: string
  text?: string
  status?: 'open' | 'resolved'
}

export interface OutputNoteRemoveInput {
  projectId: string
  outputId: string
  noteId: string
}

/** Where a revise request goes: an existing run (live: a message; ended and continuable: a continuation) or a new run. */
export type OutputReviseTarget = { type: 'run'; runId: string } | { type: 'new' }

/** outputs:revise input. `anchor` with scope 'selection'; `noteIds` with scope 'notes'. instruction may be '' only for 'notes'. */
export interface OutputReviseInput {
  projectId: string
  outputId: string
  version: number
  scope: 'whole' | 'selection' | 'notes'
  anchor?: OutputNoteAnchor
  noteIds?: string[]
  instruction: string
  target: OutputReviseTarget
}

/**
 * outputs:reviseOptions result, in the order the renderer offers them: the run that made the current version when live
 * ('live') or held by an interrupt / limit / open card ('held'; sending is refused until the user answers), or ended
 * and continuable ('continuable'); then other live runs of the project; `newRunAllowed` for "A new run".
 */
export interface OutputReviseOptions {
  runs: { runId: string; label: string; state: 'live' | 'continuable' | 'held'; madeCurrent: boolean }[]
  newRunAllowed: boolean
}

export type OutputReviseResult = { requestId: string; runId: string; mode: 'sent' | 'continued' | 'started' } | { refused: string }

/** outputs:watch / unwatch result: watched = now polled; `refused` a plain sentence (cap, path rules). */
export type OutputWatchResult = { watched: boolean } | { refused: string }

/** outputs:saveImage input (an exported diagram picture). Desktop only; the path comes from the native save dialog. */
export interface OutputSaveImageInput {
  projectId: string
  outputId: string
  suggestedName: string
  mime: 'image/png' | 'image/svg+xml'
  dataBase64: string
}

/** outputs:saveAs result. */
export type OutputSaveAsResult = { path: string } | { cancelled: true }

/**
 * outputs:changed push: an agent or the user changed a project's outputs. 'version' = a new version (agent, edit,
 * external, restore); 'notes' = notes added / changed / removed; 'watch' = a watched output's state changed (a
 * missing file, a watch expired); 'revision' = a revise request was made, answered or ended.
 */
export interface OutputsChangedEvent {
  projectId: string
  ids: string[]
  what: 'added' | 'removed' | 'updated' | 'version' | 'notes' | 'watch' | 'revision'
}

/** The kind a file's extension implies (register_output without a kind). `.pptm`, `.ppt` and `.odp` are 'other'. */
export function outputKindForPath(path: string): OutputKind {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  switch (m ? m[1].toLowerCase() : '') {
    case 'docx':
      return 'docx'
    case 'xlsx':
      return 'xlsx'
    case 'pptx':
      return 'pptx'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'txt':
      return 'text'
    case 'csv':
      return 'csv'
    case 'json':
      return 'json'
    case 'svg':
      return 'svg'
    case 'mmd':
    case 'mermaid':
      return 'mermaid'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return 'image'
    case 'pdf':
      return 'pdf'
    default:
      return 'other'
  }
}

/** Harness tool names. read_output (outputs 2) lets agents read an output's text and its open notes. */
export const OUTPUT_TOOLS = { produce: 'produce_output', register: 'register_output', read: 'read_output' } as const

/** read_output input (RuntimeContext.outputs.read). */
export interface OutputReadInput {
  action: 'list' | 'read' | 'notes'
  outputId?: string
  version?: number
}

/** Channels of this section. Not spread into IPC (declared after it); host lists name OUTPUTS_IPC like TEAM_FILES_IPC. */
export const OUTPUTS_IPC = {
  /** (projectId) -> RunOutput[] newest first; entries whose file is gone carry missing: true. Scope read. */
  outputsList: 'outputs:list',
  /** (OutputPreviewInput) -> OutputPreview. Never rejects for a bad file. Scope read. */
  outputsPreview: 'outputs:preview',
  /** (OutputRef) -> '' or an error sentence (shell.openPath). Path re-checked every call; extends an active watch. Desktop only. */
  outputsOpen: 'outputs:open',
  /** (OutputRef) -> '' or an error sentence (shell.showItemInFolder). Desktop only. */
  outputsReveal: 'outputs:reveal',
  /** (OutputRef) -> OutputSaveAsResult (main save dialog, copies the file). Desktop only. */
  outputsSaveAs: 'outputs:saveAs',
  /** (OutputRef) -> RunOutput[] afterwards; removes the entry, its stored versions, notes and revision requests; the file stays. Scope configure. */
  outputsForget: 'outputs:forget',
  /**
   * (OutputDeleteInput) -> RunOutput[] afterwards. Every source: moves the file to the OS trash (permanent delete when
   * there is none), removes the entry, versions, notes and requests; a missing file just removes the entry. Scope configure.
   */
  outputsDelete: 'outputs:delete',
  /** (OutputRef) -> OutputDeletePreview. Scope read. */
  outputsDeletePreview: 'outputs:deletePreview',
  /** (OutputRef) -> OutputVersion[] newest first. Scope read. */
  outputsVersions: 'outputs:versions',
  /** (OutputVersionRef) -> OutputSourceResult (editable kinds only). Scope read. */
  outputsReadSource: 'outputs:readSource',
  /** (OutputVersionRef) -> OutputThumb (main queue: 2 at a time). Never rejects for a bad file ('none'). Scope read. */
  outputsThumb: 'outputs:thumb',
  /** (OutputCompareInput) -> OutputDiff. Never rejects for a bad file ('none'). Scope read. */
  outputsCompare: 'outputs:compare',
  /** (OutputRef) -> OutputNote[] (all versions, oldest first). Scope read. */
  outputsNotes: 'outputs:notes',
  /** (OutputRef) -> OutputRevisionRequest[] newest first. Scope read. */
  outputsRevisions: 'outputs:revisions',
  /** (OutputRef) -> OutputReviseOptions. Scope read. */
  outputsReviseOptions: 'outputs:reviseOptions',
  /** (OutputSaveEditInput) -> OutputSaveEditResult. Scope configure. */
  outputsSaveEdit: 'outputs:saveEdit',
  /** (OutputVersionRef) -> OutputRestoreResult (a new version with the old content; the file is rewritten). Scope configure. */
  outputsRestore: 'outputs:restore',
  /** (OutputUpdateInput) -> RunOutput. No file change. Scope configure. */
  outputsUpdate: 'outputs:update',
  /** (OutputNoteAddInput) -> OutputNote. Scope operate. */
  outputsNoteAdd: 'outputs:noteAdd',
  /** (OutputNoteUpdateInput) -> OutputNote. Scope operate. */
  outputsNoteUpdate: 'outputs:noteUpdate',
  /** (OutputNoteRemoveInput) -> OutputNote[] afterwards. Scope operate. */
  outputsNoteRemove: 'outputs:noteRemove',
  /** (OutputReviseInput) -> OutputReviseResult (through RunManager send / continue / start; a gate answers { refused }). Scope operate. */
  outputsRevise: 'outputs:revise',
  /** (OutputRef) -> OutputWatchResult: poll the file for outside edits (OUTPUT_WATCH_MAX per caller, OUTPUT_WATCH_TTL_MS). Scope operate. */
  outputsWatch: 'outputs:watch',
  /** (OutputRef) -> OutputWatchResult ({ watched: false }). Scope operate. */
  outputsUnwatch: 'outputs:unwatch',
  /** (OutputSaveImageInput) -> OutputSaveAsResult (native save dialog; PNG magic and SVG active-content checks). Desktop only. */
  outputsSaveImage: 'outputs:saveImage',
  /** main -> renderer push carrying OutputsChangedEvent. */
  outputsChanged: 'outputs:changed'
} as const

/** window.orgai additions of this section (declaration-merged into OrgAIApi). */
export interface OrgAIApi {
  outputs: {
    list(projectId: string): Promise<RunOutput[]>
    preview(input: OutputPreviewInput): Promise<OutputPreview>
    /** '' when opened, else a plain sentence. */
    open(ref: OutputRef): Promise<string>
    /** '' when shown, else a plain sentence. */
    reveal(ref: OutputRef): Promise<string>
    saveAs(ref: OutputRef): Promise<OutputSaveAsResult>
    /** Removes the entry, its versions and notes; the file stays. Resolves to the list afterwards. */
    forget(ref: OutputRef): Promise<RunOutput[]>
    /** Trashes the file and removes the output (send the preview's version count). The renderer confirms first. An OutputRef still works for a produced one-version output. */
    delete(input: OutputDeleteInput): Promise<RunOutput[]>
    deletePreview(ref: OutputRef): Promise<OutputDeletePreview>
    versions(ref: OutputRef): Promise<OutputVersion[]>
    readSource(ref: OutputVersionRef): Promise<OutputSourceResult>
    thumb(ref: OutputVersionRef): Promise<OutputThumb>
    compare(input: OutputCompareInput): Promise<OutputDiff>
    notes(ref: OutputRef): Promise<OutputNote[]>
    revisions(ref: OutputRef): Promise<OutputRevisionRequest[]>
    reviseOptions(ref: OutputRef): Promise<OutputReviseOptions>
    saveEdit(input: OutputSaveEditInput): Promise<OutputSaveEditResult>
    restore(ref: OutputVersionRef): Promise<OutputRestoreResult>
    update(input: OutputUpdateInput): Promise<RunOutput>
    noteAdd(input: OutputNoteAddInput): Promise<OutputNote>
    noteUpdate(input: OutputNoteUpdateInput): Promise<OutputNote>
    noteRemove(input: OutputNoteRemoveInput): Promise<OutputNote[]>
    revise(input: OutputReviseInput): Promise<OutputReviseResult>
    watch(ref: OutputRef): Promise<OutputWatchResult>
    unwatch(ref: OutputRef): Promise<OutputWatchResult>
    saveImage(input: OutputSaveImageInput): Promise<OutputSaveAsResult>
  }
  onOutputsChanged(cb: (event: OutputsChangedEvent) => void): () => void
}
