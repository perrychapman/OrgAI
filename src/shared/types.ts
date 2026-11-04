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
}

/**
 * connections:setDefault input. A ConnectionId makes it the default and marks it chosen
 * (AppSettings.defaultConnectionChosen true); refused with a readable error naming the connection when it is not
 * usable (defaults.ts `connectionUsable`) unless it already is the stored default. null returns to automatic
 * (defaultConnectionChosen false; the stored value is rewritten to the effective one at once). Both clear
 * AppSettings.defaultConnectionReplaced. The only way the renderer changes the default (settings:set keeps it).
 */
export type ConnectionDefaultInput = ConnectionId | null

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
   * Ids of roles whose model family differs from the adapter's. Informational on 'litellm' (show it as a notice);
   * a work run is refused only per mixedFamilyRefusal: on LiteLLM when the root has no family, and on the
   * single-family connections (anthropic, openai), where their catalogs make it unreachable.
   */
  mismatched: string[]
}

/** Push events on the connections:event channel (main -> renderer). */
export type ConnectionEvent =
  | { type: 'connection.status'; connection: ConnectionId; status: ConnectionStatus }
  | { type: 'connection.login'; login: ConnectionLoginUpdate }
  /**
   * A connection's catalog was (re)discovered: boot, the 24 h schedule, connect, login or models:refresh. Sent after
   * every successful discovery, even when the list is unchanged; `changed` says whether the model ids differ.
   * Carries that connection's full list and the discovery time (also on ConnectionInfo.modelsRefreshedAt).
   */
  | { type: 'models.updated'; connection: ConnectionId; models: ProviderModel[]; changed?: boolean; refreshedAt?: number }
  /** A connection change remapped role models. Only projects with at least one change are listed; reload them. */
  | { type: 'projects.remapped'; results: RemapResult[] }

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
  transport: 'http' | 'sse'
  /** https only. */
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
  /** Every preset points at the vendor's own server. */
  publisher: 'official'
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
export type McpLibraryEntry = Omit<McpServerSpec, 'enabled' | 'roles' | 'libraryId'> & {
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

export type ProposalKind = 'architecture' | 'orgChart' | 'settings' | 'mcpServers' | 'skills'

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
}

/** When an approved proposal takes effect (Proposal.effect). */
export type ProposalEffect = 'now' | 'after-turn' | 'next-run'

export type Proposal =
  | (ProposalBase & { kind: 'architecture'; payload: ArchitectureSpec })
  | (ProposalBase & { kind: 'orgChart'; payload: OrgChartProposalPayload })
  | (ProposalBase & { kind: 'settings'; payload: SettingsProposalPayload })
  | (ProposalBase & { kind: 'mcpServers'; payload: McpServersProposalPayload })
  | (ProposalBase & { kind: 'skills'; payload: SkillsProposalPayload })

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
  updatedAt: number
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
 * 'default' = the app's default org chart (defaultRoles), tools filtered through quickRoleTools.
 */
export type QuickRunTeam = 'single' | 'default'
export const QUICK_RUN_TEAMS: readonly QuickRunTeam[] = ['single', 'default']
/** A longer QuickRunInput.prompt is refused, never cut. */
export const QUICK_RUN_MAX_PROMPT_CHARS = 100_000

/**
 * runs:startQuick input. A project-less work run on the virtual project QUICK_PROJECT_ID (RunSummary.kind 'work',
 * RunSummary.quick set). Never permission mode 'auto' (see quickRunPermissionMode); read-only unless allowEdits;
 * no project MCP servers, plugins or skills; run messaging off.
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
  /** Allow Edit, Write and Bash in the folder (each still asks). Default false. A git folder with edits on isolates writers. */
  allowEdits?: boolean
  images?: ImageAttachment[]
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
  /** Who ended the run. 'user': End session (RunManager.stop). 'app': OrgAI quit or crashed while it was live (stopAll on quit, or the store's boot normalization). Absent: the run ended on its own (finished, error, paused). Structured-clone safe. */
  endedBy?: 'user' | 'app'
  /** Only with endedBy 'app': what the run was doing when OrgAI cut it. 'waiting': status idle or a decision card open (the user's turn). 'working': starting, running or stopping. Absent for a paused run. */
  endedWhile?: 'working' | 'waiting'
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
       * it was live. Set by RunManager on a terminal status ('finished' / 'error') of a cut run, and on 'stopping' with
       * 'user'. Absent: the run ended on its own. Adapters never set it. Structured-clone safe.
       */
      endedBy?: 'user' | 'app'
      /** Only with endedBy 'app' (RunSummary.endedWhile): 'waiting' (idle or a card open) or 'working' when OrgAI cut it. */
      endedWhile?: 'working' | 'waiting'
    }
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
  | { type: 'proposal.resolved'; runId: string; proposalId: string; decision: ProposalOutcome; cancelled?: true }
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
  /**
   * An agent loaded a skill (Claude: an allowed Skill tool call; Codex and mock: load_skill). Emitted by the adapter
   * (or the load_skill harness tool); RunManager counts it into RunUsage.skills and writes a harness transcript row
   * ("Loaded skill <name>", source 'harness') on that agent. `at` is epoch ms.
   */
  | { type: 'skill.used'; runId: string; agentId: string; skillId: string; name: string; at: number }
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
  'canvas-zoom-out'
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

/** Harness tool of engagement work runs (every role) and single-agent runs: lists context notes, reads one. */
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

/** Context notes per project (`<data>/projects/<id>/context/<noteId>.md` plus an index). */
export const ENGAGEMENT_NOTES_MAX = 50
export const ENGAGEMENT_NOTE_MAX_CHARS = 50_000
export const ENGAGEMENT_NOTE_TITLE_MAX_CHARS = 120

/** One context note in the index (projects:listNotes). */
export interface EngagementNote {
  id: string
  /** 1..120 characters, no control or hidden characters. */
  title: string
  /** Epoch ms. */
  updatedAt: number
  /** Length of the note's text. */
  chars: number
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

/** projects:saveNote input. Without noteId a new note is created; with one, that note is replaced. */
export interface EngagementNoteSaveInput {
  projectId: string
  noteId?: string
  title: string
  /** At most ENGAGEMENT_NOTE_MAX_CHARS; hidden characters other than tab, LF and CR are refused. */
  text: string
}

/** main -> renderer push (IPC projectsEngagementChanged) after the document or a note was written or removed. */
export interface EngagementChangedEvent {
  projectId: string
  what: 'document' | 'notes'
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
 * started / ended as ISO 8601 UTC, cost blank when unknown, cost_partial 'true' / ''. RFC 4180 quoting (CRLF line
 * ends, a header row); a cell starting with = + - @ (or tab / CR) gets a leading single quote (formula injection).
 */
export const USAGE_CSV_COLUMNS = [
  'started',
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
  ...TEMPLATE_ENGAGEMENT_IPC,
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
