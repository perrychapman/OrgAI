import type {
  AdapterChoice,
  AgentInstance,
  AppearanceSettings,
  AppSettings,
  ConnectionId,
  ConnectionStatus,
  Effort,
  ImageMediaType,
  McpLibraryEntry,
  McpServerSpec,
  ModelFamily,
  ModelRef,
  ModelTier,
  PermissionMode,
  Project,
  ProviderAuth,
  ProviderConnections,
  ProviderId,
  ProviderModel,
  QuickRunTeam,
  Role,
  SetupKind,
  SkillEvaluationSettings,
  TeamReviewSettings,
  SkillSpec,
  TokenUsage,
  UsageStatus,
  ToolName
} from './types'
import { CONNECTION_IDS, DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES, MODEL_TIERS, SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, TEAM_REVIEW_MAX_BUDGET, TEAM_REVIEW_MAX_EVERY_RUNS, TEAM_REVIEW_MIN_BUDGET, isModelTier } from './types'

/** Run limits for new projects: enough parallel reports for a real team, and room for leads with their own reports. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3
/** Cross-run messaging is on by default; an explicit Project.runMessaging false turns it off. */
export const DEFAULT_RUN_MESSAGING = true

/** Whether a project lets its runs message other runs and be messaged (Project.runMessaging, default on; an explicit false turns it off). */
export function runMessagingOn(project: { runMessaging?: boolean } | null | undefined): boolean {
  return (project?.runMessaging ?? DEFAULT_RUN_MESSAGING) === true
}
/** Upper bounds of the run-limit settings (settings inputs, proposal schema, applying proposals). */
export const MAX_CONCURRENT_SUBAGENTS_LIMIT = 32
export const MAX_SUBAGENT_DEPTH_LIMIT = 5
/** Upper bound of maxAutoContinues (settings inputs, proposal schema, applying proposals). */
export const MAX_AUTO_CONTINUES_LIMIT = 500

/** Image types the composer accepts and the main process forwards to the provider. */
export const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** Largest image accepted, in decoded bytes (Anthropic's per-image limit). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Most images sent with one user message. */
export const MAX_IMAGES_PER_MESSAGE = 10

export const ROLE_COLORS = ['#7c5cff', '#2bb0ff', '#22c58b', '#f5a524', '#ff6b6b', '#e879f9', '#38bdf8', '#a3e635']

// ---------- Model catalog ----------

const builtin = (
  connection: ConnectionId,
  family: ModelFamily,
  adapter: ProviderId,
  list: { id: string; label: string; hint: string; tier: ModelTier }[]
): ProviderModel[] => list.map((m) => ({ ...m, connection, family, adapter, source: 'builtin' }))

/**
 * Anthropic's models as Claude Code aliases, one per tier: the anthropic connection's cold-start catalog and its
 * default tierModels (aliases float to the newest model of their family in the CLI). Discovery (the Claude adapter's
 * listModels, i.e. the SDK's supportedModels) adds whatever the CLI offers, new families included; these stay in the
 * catalog so roles saved with them remain valid.
 */
export const ANTHROPIC_BUILTIN_MODELS: readonly ProviderModel[] = builtin('anthropic', 'claude', 'claude', [
  { id: 'fable', label: 'Fable', hint: 'Most capable, highest cost', tier: 'top' },
  { id: 'opus', label: 'Opus', hint: 'Deep reasoning, orchestration, architecture', tier: 'deep' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast and capable, everyday coding', tier: 'everyday' },
  { id: 'haiku', label: 'Haiku', hint: 'Cheap and quick, lookups and summaries', tier: 'fast' }
])

/**
 * Placeholder OpenAI models until the Codex app-server's model/list answers at runtime. The ids are NOT
 * verified against the live list; discovery replaces them.
 */
export const OPENAI_PLACEHOLDER_MODELS: readonly ProviderModel[] = builtin('openai', 'openai', 'codex', [
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', hint: 'Agentic coding (placeholder id)', tier: 'top' },
  { id: 'gpt-5', label: 'GPT-5', hint: 'Deep reasoning (placeholder id)', tier: 'deep' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', hint: 'Everyday work (placeholder id)', tier: 'everyday' },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', hint: 'Cheap and quick (placeholder id)', tier: 'fast' }
])

/** The builtin catalog of one connection. LiteLLM has none: its models are discovered from the proxy. */
export function builtinModels(connection: ConnectionId): ProviderModel[] {
  if (connection === 'anthropic') return ANTHROPIC_BUILTIN_MODELS.map((m) => ({ ...m }))
  if (connection === 'openai') return OPENAI_PLACEHOLDER_MODELS.map((m) => ({ ...m }))
  return []
}

/**
 * Fill a tier mapping from a catalog: for each tier, the first model the provider marks recommended, else the first
 * model suggested for it (catalog order: discovered lists come newest or most recommended first). Tiers with none are
 * left out.
 */
export function defaultTierModels(models: readonly ProviderModel[]): Partial<Record<ModelTier, ModelRef>> {
  const out: Partial<Record<ModelTier, ModelRef>> = {}
  for (const m of models) if (m.tier && m.recommended && !out[m.tier]) out[m.tier] = m.id
  for (const m of models) if (m.tier && !out[m.tier]) out[m.tier] = m.id
  return out
}

/** Tiers ordered by closeness to `tier`, the tier itself first (ties: the more capable one first). */
export function nearestTiers(tier: ModelTier): ModelTier[] {
  const i = MODEL_TIERS.indexOf(tier)
  return [...MODEL_TIERS].sort((a, b) => Math.abs(MODEL_TIERS.indexOf(a) - i) - Math.abs(MODEL_TIERS.indexOf(b) - i))
}

/** What tier resolution needs from one connection. */
export interface TierContext {
  connection: ConnectionId
  /** The connection's tier mapping (AppSettings.connections[connection].tierModels). */
  tierModels: Partial<Record<ModelTier, ModelRef>>
  /** The connection's catalog, when known; entries of other connections are ignored. Default: its builtin list. */
  catalog?: readonly ProviderModel[]
}

/**
 * The model a tier gets on a connection: its tierModels entry, else the catalog's suggestion for the tier (recommended
 * first, then catalog order; the builtin list when no catalog is given), trying the nearest tiers in turn. undefined
 * when nothing at all maps. `tier` is the tier actually used.
 */
export function modelForTier(tier: ModelTier, ctx: TierContext): { model: ModelRef; tier: ModelTier } | undefined {
  const catalog = (ctx.catalog ?? builtinModels(ctx.connection)).filter((m) => m.connection === ctx.connection)
  const suggested = defaultTierModels(catalog)
  for (const t of nearestTiers(tier)) {
    const model = ctx.tierModels[t]?.trim() || suggested[t]
    if (model) return { model, tier: t }
  }
  return undefined
}

/** The tier a model setting names: a tier name, or a legacy Claude alias (fable, opus, sonnet, haiku). */
export function settingTier(value: string | undefined): ModelTier | undefined {
  const v = value?.trim().toLowerCase() ?? ''
  if (isModelTier(v)) return v
  return Object.hasOwn(CLAUDE_ALIAS_TIERS, v) ? CLAUDE_ALIAS_TIERS[v] : undefined
}

/**
 * Resolve a ModelSetting (AppSettings.defaultRootModel and friends) on a connection. A tier name, or a legacy Claude
 * alias standing for its tier, maps through modelForTier (the nearest mapped tier when its own is unmapped; on the
 * anthropic connection an alias that maps nowhere stays as it is). 'inherit' stays. A concrete id is returned as it is,
 * with its catalog tier (or tierForModel). undefined only for an empty value or a tier nothing maps.
 */
export function resolveModelSetting(value: string | undefined, ctx: TierContext): { model: ModelRef; tier?: ModelTier } | undefined {
  const v = value?.trim() ?? ''
  if (!v) return undefined
  if (v === 'inherit') return { model: 'inherit' }
  const tier = settingTier(v)
  if (tier) {
    const hit = modelForTier(tier, ctx)
    if (hit) return hit
    return isModelTier(v.toLowerCase()) ? undefined : { model: v, tier }
  }
  const entry = (ctx.catalog ?? []).find((m) => m.connection === ctx.connection && m.id === v)
  const known = entry?.tier ?? tierForModel(v)
  return { model: v, ...(known ? { tier: known } : {}) }
}

/**
 * Whether a project explicitly turned the plan guard on (legacy field honoured). Only an explicit true counts: an unset
 * value is 'auto' (see planGuardOf), which this returns false for. Prefer planGuardOf in new code.
 */
export function preferEverydayNearLimit(project: Pick<Project, 'preferEverydayNearLimit' | 'preferSonnetNearLimit'> | null | undefined): boolean {
  return (project?.preferEverydayNearLimit ?? project?.preferSonnetNearLimit) === true
}

/** The plan guard setting of a project: 'on' / 'off' when set explicitly (legacy preferSonnetNearLimit honoured), else 'auto'. */
export type PlanGuardMode = 'on' | 'off' | 'auto'

/**
 * Project.preferEverydayNearLimit as a mode: explicit true = 'on', explicit false = 'off', unset (and no legacy value)
 * = 'auto'. Adapters decide 'auto' per run with planGuardEngaged.
 */
export function planGuardOf(project: Pick<Project, 'preferEverydayNearLimit' | 'preferSonnetNearLimit'> | null | undefined): PlanGuardMode {
  const v = project?.preferEverydayNearLimit ?? project?.preferSonnetNearLimit
  return v === true ? 'on' : v === false ? 'off' : 'auto'
}

/**
 * Whether a usage report shows a plan with a weekly window: a seven-day window (overall, deep or everyday model) or a
 * per-model weekly window was reported. API-key and LiteLLM spend reports never have one.
 */
export function hasWeeklyPlanWindow(usage: UsageStatus | null | undefined): boolean {
  if (!usage || usage.authMode === 'apiKey') return false
  const w = usage.windows ?? {}
  return !!(w.sevenDay || w.sevenDayOpus || w.sevenDaySonnet || (usage.modelWindows?.length ?? 0) > 0)
}

/**
 * Whether the plan guard is armed for a run: 'on' always, 'off' never, 'auto' exactly when the run's connection
 * reports a weekly plan window or its latest rate-limit status is 'allowed_warning'. Armed is not the same as
 * steering: the adapter still compares the guarding window with AppSettings.opusGuardThreshold. Pure.
 */
export function planGuardEngaged(mode: PlanGuardMode, usage: UsageStatus | null | undefined): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  if (!usage || usage.authMode === 'apiKey') return false
  return hasWeeklyPlanWindow(usage) || usage.status === 'allowed_warning'
}

/** The subagent limits a run actually uses (Project.maxSubagentDepth / maxConcurrentSubagents or the automatic values). */
export interface SubagentLimits {
  /** Levels of reports that may spawn (1 = reports cannot spawn). */
  depth: number
  /** Most reports running at once. */
  concurrency: number
  /** Which value came from the project (an explicit override) rather than the automatic rule. */
  explicit: { depth: boolean; concurrency: boolean }
}

/**
 * Longest reportsTo chain of an org chart, in edges (root alone = 0, root -> lead -> engineer = 2). A reportsTo that
 * names no role ends the chain; cycles are cut. Pure.
 */
export function orgChartDepth(roles: readonly Pick<Role, 'id' | 'reportsTo'>[]): number {
  const byId = new Map(roles.map((r) => [r.id, r]))
  let longest = 0
  for (const role of roles) {
    let edges = 0
    const seen = new Set<string>([role.id])
    let cur = role.reportsTo ? byId.get(role.reportsTo) : undefined
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      edges++
      cur = cur.reportsTo ? byId.get(cur.reportsTo) : undefined
    }
    longest = Math.max(longest, edges)
  }
  return longest
}

function explicitLimit(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(max, Math.round(v)) : undefined
}

/**
 * The subagent limits of a project. An explicit Project.maxSubagentDepth / maxConcurrentSubagents (a finite number
 * >= 1, clamped to the limits) wins. Otherwise depth = orgChartDepth(roles) + 1 (one level for forks), at least 1, at
 * most MAX_SUBAGENT_DEPTH_LIMIT, and concurrency = DEFAULT_MAX_CONCURRENT_SUBAGENTS. Every reader (env vars, Codex
 * network, prompts, proposals) goes through this. Pure.
 */
export function effectiveSubagentLimits(project: Pick<Project, 'maxSubagentDepth' | 'maxConcurrentSubagents'> & { roles?: readonly Pick<Role, 'id' | 'reportsTo'>[] }): SubagentLimits {
  const depth = explicitLimit(project.maxSubagentDepth, MAX_SUBAGENT_DEPTH_LIMIT)
  const concurrency = explicitLimit(project.maxConcurrentSubagents, MAX_CONCURRENT_SUBAGENTS_LIMIT)
  const auto = Math.min(MAX_SUBAGENT_DEPTH_LIMIT, Math.max(1, orgChartDepth(project.roles ?? []) + 1))
  return {
    depth: depth ?? auto,
    concurrency: concurrency ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    explicit: { depth: depth !== undefined, concurrency: concurrency !== undefined }
  }
}

/** Reasoning effort levels a role can pick on an adapter (Role.effort). Codex passes effort only for low / medium / high. */
export function effortOptionsFor(adapterId: ProviderId | null | undefined): Effort[] {
  return adapterId === 'codex' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max']
}

const CLAUDE_ALIAS_TIERS: Record<string, ModelTier> = { fable: 'top', opus: 'deep', sonnet: 'everyday', haiku: 'fast' }

/**
 * Lowercase a model id, strip a gateway prefix such as "anthropic/" or "openai/", and a Claude Code context
 * suffix such as "[1m]" ("sonnet[1m]", "claude-sonnet-4-5[1m]").
 */
function bareModelId(model: string): string {
  const id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/**
 * The tier a model expresses, for migrating roles saved before Role.tier existed. Claude aliases and full
 * Claude ids (claude-opus-..., anthropic/claude-sonnet-...) map by name; 'inherit' and other models have none.
 */
export function tierForModel(model: ModelRef): ModelTier | undefined {
  const id = bareModelId(model)
  if (!id || id === 'inherit') return undefined
  if (Object.hasOwn(CLAUDE_ALIAS_TIERS, id)) return CLAUDE_ALIAS_TIERS[id]
  if (id.includes('claude')) {
    for (const [alias, tier] of Object.entries(CLAUDE_ALIAS_TIERS)) if (id.includes(alias)) return tier
  }
  return undefined
}

/** Extra Claude Code aliases an imported agent may name (opusplan plans with Opus; best = the strongest model). */
const IMPORT_ALIAS_TIERS: Record<string, ModelTier> = { best: 'top', opusplan: 'deep' }

/**
 * The tier a foreign model id expresses, for importing agent definitions from other harnesses
 * (src/main/setup/import). Wider than tierForModel, which it never changes:
 * - Claude aliases and full ids, with any provider prefix ("anthropic/", "bedrock/...") and "[1m]" suffix
 *   stripped, map like tierForModel; also "best" -> top and "opusplan" -> deep.
 * - HEURISTIC (OpenAI naming, not a published contract): "nano" -> fast, "mini" -> everyday, "pro" or
 *   "codex-max" -> top, any other gpt-* / o-series / codex / chatgpt id -> deep.
 * - HEURISTIC (Gemini naming): "flash-lite" -> fast, "flash" -> everyday, "pro" or "ultra" -> deep.
 * Anything else ('inherit', empty, other families) gives undefined.
 */
export function importTierForModel(model: unknown): ModelTier | undefined {
  if (typeof model !== 'string') return undefined
  const known = tierForModel(model)
  if (known) return known
  const id = bareModelId(model)
  if (!id || id === 'inherit') return undefined
  if (Object.hasOwn(IMPORT_ALIAS_TIERS, id)) return IMPORT_ALIAS_TIERS[id]
  if (/^(gpt|o\d|codex|chatgpt)/.test(id)) {
    if (/nano/.test(id)) return 'fast'
    if (/mini/.test(id)) return 'everyday'
    if (/(^|-)pro($|-)/.test(id) || /codex-max/.test(id)) return 'top'
    return 'deep'
  }
  if (id.startsWith('gemini')) {
    if (/flash-lite/.test(id)) return 'fast'
    if (/flash/.test(id)) return 'everyday'
    if (/(^|-)(pro|ultra)($|-)/.test(id)) return 'deep'
    return undefined
  }
  return undefined
}

/** Guess a model's family from its id, for discovered models the proxy does not describe. */
export function modelFamily(model: ModelRef): ModelFamily {
  const id = bareModelId(model)
  if (Object.hasOwn(CLAUDE_ALIAS_TIERS, id) || id.includes('claude')) return 'claude'
  if (/^(gpt|o\d|codex|chatgpt)/.test(id)) return 'openai'
  return 'other'
}

/** The adapter that runs a model family: Claude models on the Claude adapter, everything else on Codex. */
export function adapterForFamily(family: ModelFamily): ProviderId {
  return family === 'claude' ? 'claude' : 'codex'
}

/** The connection a project uses. Projects saved before connections existed are on 'anthropic'. */
export function projectConnection(project: Pick<Project, 'provider'>): ConnectionId {
  return project.provider.connection ?? (project.provider.id === 'codex' ? 'openai' : 'anthropic')
}

/**
 * Pick the adapter for a project's run. 'anthropic' runs on Claude, 'openai' on Codex. 'litellm' follows the
 * root role's model family (its catalog entry first, else modelFamily). Roles whose model would need the other
 * adapter are listed in `mismatched` ('inherit' roles always match): informational on LiteLLM, where reports may run
 * any model the proxy serves (mixedFamilyRefusal), a refusal on the single-family connections.
 * A 'mock' provider always runs on the mock adapter with nothing mismatched.
 */
export function adapterForProject(project: Pick<Project, 'provider' | 'roles'>, catalog: readonly ProviderModel[]): AdapterChoice {
  const connection = projectConnection(project)
  const familyOf = (model: ModelRef): ModelFamily =>
    catalog.find((m) => m.id === model && m.connection === connection)?.family ?? modelFamily(model)
  const root = project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
  const family = root && root.model !== 'inherit' ? familyOf(root.model) : undefined
  if (project.provider.id === 'mock') return { adapter: 'mock', connection, family, mismatched: [] }
  const adapter: ProviderId =
    connection === 'anthropic' ? 'claude' : connection === 'openai' ? 'codex' : adapterForFamily(family ?? 'claude')
  const mismatched = project.roles
    .filter((r) => r.model !== 'inherit' && adapterForFamily(familyOf(r.model)) !== adapter)
    .map((r) => r.id)
  return { adapter, connection, family, mismatched }
}

/**
 * Whether a work run with this adapter choice must be refused before it exists (owner decision 2026-11-03: one
 * connection per project; on a LiteLLM proxy the orchestrator's model picks the adapter and reports may run any model
 * the proxy serves). null = it may start (nothing mismatched, or a LiteLLM root with a known family);
 * 'no-root-family' = LiteLLM, roles on another family and the root has no model of its own ('inherit' or no roles),
 * so no adapter can be picked from it; 'single-family-connection' = Anthropic or OpenAI with a role of another family
 * (cannot come from their single-family catalogs; refused as before). Pure.
 */
export function mixedFamilyRefusal(choice: Pick<AdapterChoice, 'connection' | 'family' | 'mismatched'>): 'no-root-family' | 'single-family-connection' | null {
  if (!choice.mismatched.length) return null
  if (choice.connection !== 'litellm') return 'single-family-connection'
  return choice.family === undefined ? 'no-root-family' : null
}

/** Connection records for fresh settings. The Anthropic connection takes the given (legacy) auth. */
export function defaultConnections(auth: ProviderAuth = { kind: 'subscription' }): ProviderConnections {
  return {
    anthropic: { id: 'anthropic', enabled: true, auth: { ...auth }, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) },
    openai: { id: 'openai', enabled: false, auth: { kind: 'chatgpt' }, tierModels: defaultTierModels(OPENAI_PLACEHOLDER_MODELS) },
    litellm: { id: 'litellm', enabled: false, baseUrl: '', hasApiKey: false, tierModels: {} }
  }
}

// ---------- MCP ----------

/** MCP server names become mcp__<name>__*: lowercase kebab-case, at most 48 characters. */
export function isValidMcpServerName(name: string): boolean {
  return name.length <= 48 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

/** Every secret slot of a spec: secretEnv names followed by secretHeaders names. */
export function mcpSecretNames(spec: Pick<McpServerSpec, 'secretEnv' | 'secretHeaders'>): string[] {
  return [...(spec.secretEnv ?? []), ...(spec.secretHeaders ?? [])]
}

/** Remote transports can use OAuth (mcp:authorize); stdio servers never do. */
export function mcpSupportsOAuth(spec: Pick<McpServerSpec, 'transport'>): boolean {
  return spec.transport === 'http' || spec.transport === 'sse'
}

/** Runs refresh an OAuth access token that expires within this window before they start (and mcp:test before probing). */
export const MCP_OAUTH_REFRESH_SKEW_MS = 5 * 60_000

/** The project-owned fields of a linked server; everything else comes from its library entry. */
export type McpLinkFields = Pick<McpServerSpec, 'id' | 'enabled' | 'roles' | 'addedAt'>

/**
 * The project copy of a linked library entry: the entry's fields plus the project-owned ones, source 'library'
 * and libraryId = entry.id. McpService calls it on every read so a library edit reaches every project.
 */
export function linkedSpec(entry: McpLibraryEntry, own: McpLinkFields): McpServerSpec {
  const { id: _entryId, source: _source, connectedAt: _connectedAt, ...rest } = entry
  return {
    ...rest,
    id: own.id,
    enabled: own.enabled,
    ...(own.roles ? { roles: [...own.roles] } : {}),
    source: 'library',
    libraryId: entry.id,
    addedAt: own.addedAt
  }
}

/**
 * A library entry built from a project server (promote, or a proposal that saves a new server to the library):
 * the project-owned fields are dropped, and a linked spec's 'library' source becomes 'user'.
 */
export function libraryEntryFromSpec(spec: McpServerSpec, id: string): McpLibraryEntry {
  const { enabled: _enabled, roles: _roles, libraryId: _libraryId, ...rest } = spec
  return { ...rest, id, source: spec.source === 'library' ? 'user' : spec.source }
}

/**
 * The enabled MCP servers a role may use: those with no `roles` list, those listing the role's slug, and
 * those the role is granted explicitly in Role.mcpServers.
 */
export function mcpServersForRole(project: Pick<Project, 'mcpServers'>, role: Pick<Role, 'slug' | 'mcpServers'>): McpServerSpec[] {
  return (project.mcpServers ?? []).filter(
    (s) => s.enabled && (s.roles === undefined || s.roles.includes(role.slug) || (role.mcpServers ?? []).includes(s.id))
  )
}

/** Default look. Theme stays 'dark' until the light theme is signed off, then becomes 'system' (plan.md section 2). */
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'dark',
  accent: '#7c5cff',
  canvas: { pattern: 'dots', tint: true, edges: 'curved', minimap: false },
  reduceMotion: 'system'
}

/** Window background before the renderer paints, per resolved theme (matches --surface-0 in tokens.css). */
export const THEME_BACKGROUND = { dark: '#0b0d12', light: '#f4f5f9' } as const

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultPermissionMode: 'auto',
  defaultMaxBudgetUsd: undefined,
  defaultKeepRuns: DEFAULT_KEEP_RUNS,
  defaultIsolateWriters: true,
  defaultRootModel: 'deep',
  defaultReportModel: 'everyday',
  setupModel: 'deep',
  mcpAssistModel: 'deep',
  skillAssistModel: 'deep',
  quickRunModel: 'everyday',
  providerAuth: { kind: 'subscription' },
  connections: defaultConnections(),
  defaultConnection: 'anthropic',
  notifications: true,
  appearance: DEFAULT_APPEARANCE,
  opusGuardThreshold: 80,
  defaultPreferEverydayNearLimit: false,
  defaultPreferSonnetNearLimit: false,
  communityPrices: true,
  defaultAutoContinue: true,
  defaultMaxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES
}

// ---------- Quick runs (Chat) ----------

/** Role slug of a quick run's single assistant (team 'single'). */
export const QUICK_ASSISTANT_SLUG = 'assistant'

/** Tools a quick run with edits off never gets. */
export const QUICK_EDIT_TOOLS: readonly ToolName[] = ['Edit', 'Write', 'Bash', 'NotebookEdit']

/** A role's tools on a quick run: unchanged with edits on; Edit, Write, Bash and NotebookEdit removed with edits off. */
export function quickRoleTools(tools: readonly ToolName[], allowEdits: boolean): ToolName[] {
  return allowEdits ? [...tools] : tools.filter((t) => !QUICK_EDIT_TOOLS.includes(t))
}

const QUICK_SINGLE_TOOLS: readonly ToolName[] = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']

/**
 * Tools per role slug for a quick run. 'single': { assistant: Read, Glob, Grep, WebSearch, WebFetch, plus Edit,
 * Write and Bash with edits on }. 'default': each defaultRoles() role (orchestrator, implementer, reviewer,
 * researcher) with its tools filtered through quickRoleTools.
 */
export function quickRunTools(team: QuickRunTeam, allowEdits: boolean): Record<string, ToolName[]> {
  if (team === 'single') {
    return { [QUICK_ASSISTANT_SLUG]: allowEdits ? [...QUICK_SINGLE_TOOLS, 'Edit', 'Write', 'Bash'] : [...QUICK_SINGLE_TOOLS] }
  }
  const out: Record<string, ToolName[]> = {}
  for (const role of defaultRoles()) out[role.slug] = quickRoleTools(role.tools, allowEdits)
  return out
}

/**
 * Permission mode of a quick run: always 'default', edits on or off. Never 'auto' (a classifier would approve calls
 * in a folder the user never set up), 'acceptEdits' (edits would land unasked) or 'dontAsk' (a read outside the
 * folder would be silently denied instead of raising a card the user can answer). Every edit and command asks.
 */
export function quickRunPermissionMode(allowEdits: boolean): PermissionMode {
  void allowEdits
  return 'default'
}

/** Provider label matching an auth choice. */
export function claudeProviderLabel(auth: AppSettings['providerAuth']): string {
  return auth.kind === 'apiKey' ? `Claude (API key from ${auth.envVar})` : 'Claude (Claude Code login)'
}

/**
 * The connection a new project starts on: settings.defaultConnection when it is usable (anthropic always; openai
 * when enabled; litellm when enabled with a base URL and an API key), otherwise 'anthropic'.
 */
export function creationConnection(settings: Pick<AppSettings, 'defaultConnection' | 'connections'> | undefined): ConnectionId {
  const want = settings?.defaultConnection
  const c = settings?.connections
  if (!want || !c) return 'anthropic'
  if (want === 'openai') return c.openai?.enabled ? 'openai' : 'anthropic'
  if (want === 'litellm') return c.litellm?.enabled && !!c.litellm.baseUrl?.trim() && c.litellm.hasApiKey ? 'litellm' : 'anthropic'
  return 'anthropic'
}

/**
 * Whether a connection is in use: enabled (anthropic always counts as enabled, as in `creationConnection`) and
 * either the app's default connection or the connection of at least one project (`projectConnection`; mock
 * projects follow the same rule). Idle probes that cost a process spawn or a network call (Codex plan usage,
 * LiteLLM key spend) run only then. Pure.
 */
export function connectionInUse(
  id: ConnectionId,
  settings: Pick<AppSettings, 'defaultConnection' | 'connections'>,
  projects: readonly Pick<Project, 'provider'>[]
): boolean {
  const enabled = id === 'anthropic' || settings.connections?.[id]?.enabled === true
  if (!enabled) return false
  if ((settings.defaultConnection ?? 'anthropic') === id) return true
  return projects.some((p) => projectConnection(p) === id)
}

/**
 * Whether a connection's record allows it to be used at all: anthropic unless it was turned off (enabled false, the
 * card's Disconnect); openai when enabled; litellm when enabled with a base URL and a stored key. Says nothing about
 * its live status. Pure.
 */
export function connectionConfigured(id: ConnectionId, connections: Partial<ProviderConnections> | undefined): boolean {
  if (id === 'anthropic') return connections?.anthropic?.enabled !== false
  if (id === 'openai') return connections?.openai?.enabled === true
  const l = connections?.litellm
  return l?.enabled === true && !!l.baseUrl?.trim() && l.hasApiKey === true
}

/** Whether a connection can be the default: configured (connectionConfigured) and its live status is 'connected'. Pure. */
export function connectionUsable(id: ConnectionId, connections: Partial<ProviderConnections> | undefined, state: ConnectionStatus['state'] | undefined): boolean {
  return connectionConfigured(id, connections) && state === 'connected'
}

/**
 * The default connection consumers use (new projects, Chat, the MCP and Skill assistants). `states` holds the live
 * state of every configured connection (connectionConfigured), 'unknown' while it has not been probed yet; leave out
 * connections that are not configured. Pure.
 * - chosen (the user picked it): the stored value whatever its state, so a run fails with that connection's own error
 *   (the honest outcome). Only a chosen connection that is no longer configured (turned off) falls through.
 * - automatic: the connection an automatic rewrite replaced (`replaced`) as soon as it is 'connected' again; else the
 *   stored value unless it is definitely 'disconnected' or not configured ('error', 'connecting' and 'unknown' keep
 *   it: a probe throw, a CLI timeout or a failed discovery never moves the default); else the first connected
 *   connection in CONNECTION_IDS order other than LiteLLM, LiteLLM only when it is the only connected one; else the
 *   stored value when configured, else the first configured connection, else the stored value (anthropic when unset).
 */
export function effectiveDefaultConnection(input: {
  stored: ConnectionId | undefined
  chosen?: boolean
  replaced?: ConnectionId
  states: Partial<Record<ConnectionId, ConnectionStatus['state'] | 'unknown'>>
}): ConnectionId {
  const stored = isConnectionId(input.stored) ? input.stored : 'anthropic'
  const own = input.states[stored]
  if (input.chosen === true && own !== undefined) return stored
  const replaced = input.chosen !== true && isConnectionId(input.replaced) ? input.replaced : undefined
  if (replaced && input.states[replaced] === 'connected') return replaced
  if (own !== undefined && own !== 'disconnected') return stored
  const connected = CONNECTION_IDS.filter((id) => input.states[id] === 'connected')
  const pick = connected.find((id) => id !== 'litellm') ?? (connected.length === 1 ? connected[0] : undefined)
  if (pick) return pick
  if (own !== undefined) return stored
  return CONNECTION_IDS.find((id) => input.states[id] !== undefined) ?? stored
}

/** A known ConnectionId (own property of the id list, never a prototype key). Pure. */
export function isConnectionId(v: unknown): v is ConnectionId {
  return typeof v === 'string' && (CONNECTION_IDS as readonly string[]).includes(v)
}

/** Provider label for a connection. Anthropic follows the auth choice. */
export function connectionProviderLabel(id: ConnectionId, auth: AppSettings['providerAuth']): string {
  return id === 'anthropic' ? claudeProviderLabel(auth) : id === 'openai' ? 'Codex (ChatGPT)' : 'LiteLLM'
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'role'
  )
}

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  const stamp = Date.now().toString(36)
  return prefix ? `${prefix}_${stamp}${rnd}` : `${stamp}${rnd}`
}

const READ_ONLY: ToolName[] = ['Read', 'Glob', 'Grep']
const FULL: ToolName[] = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']

/**
 * A sensible starting org for a coding project: one orchestrator with three
 * purpose-built reports. The AI drafter can replace or revise it. Each role is defined by its tier; the model is that
 * tier's model on the given connection (modelForTier), 'inherit' when the connection maps no tier at all. Default: the
 * anthropic connection's builtin tier mapping.
 */
export function defaultRoles(ctx: TierContext = { connection: 'anthropic', tierModels: {} }): Role[] {
  const modelOf = (tier: ModelTier): { model: ModelRef; tier?: ModelTier } => modelForTier(tier, ctx) ?? { model: 'inherit' }
  const orchestrator: Role = {
    id: newId('role'),
    slug: 'orchestrator',
    name: 'Orchestrator',
    description:
      'Lead agent. Plans the work, delegates to specialists, integrates results and reports to the user.',
    responsibilities: [
      'Understand the request and break it into well-scoped tasks',
      'Delegate each task to the most suitable specialist',
      'Review returned work for correctness and integration',
      'Keep the user informed with concise status and a final summary'
    ],
    prompt: `You are the lead engineer and orchestrator for this project.
Plan before acting. Delegate implementation, review and testing to your specialist reports instead of doing everything yourself. Give each delegate a precise brief: the files involved, the acceptance criteria, and anything already decided. Integrate their results, verify the whole, and report back to the user with what changed and what remains.`,
    tools: FULL,
    ...modelOf('deep'),
    canSpawn: true,
    spawnable: [],
    reportsTo: null,
    position: { x: 0, y: 0 },
    color: ROLE_COLORS[0]
  }
  const implementer: Role = {
    id: newId('role'),
    slug: 'implementer',
    name: 'Implementer',
    description:
      'Writes and edits code to complete a precisely scoped task. Use for feature work and bug fixes.',
    responsibilities: [
      'Implement the assigned change end to end',
      'Keep edits minimal and consistent with the codebase',
      'Run the relevant build or tests before reporting'
    ],
    prompt: `You are a senior software engineer. Implement exactly the task you are given. Read the surrounding code first, follow existing conventions, and run the relevant build or tests before you report. Report what you changed, file by file, and anything you could not verify.`,
    tools: FULL,
    ...modelOf('everyday'),
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: -280, y: 200 },
    color: ROLE_COLORS[1]
  }
  const reviewer: Role = {
    id: newId('role'),
    slug: 'reviewer',
    name: 'Reviewer',
    description:
      'Read-only code reviewer. Use to check a change for bugs, security issues and missed cases.',
    responsibilities: [
      'Review diffs for correctness and risk',
      'Call out missing tests and edge cases',
      'Never modify files'
    ],
    prompt: `You are a meticulous code reviewer. You may read anything but must not modify files. Review the described change for correctness bugs, security problems, and missed edge cases. Report findings ranked by severity with file and line references, and say explicitly when you find nothing.`,
    tools: READ_ONLY,
    ...modelOf('everyday'),
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: 0, y: 200 },
    color: ROLE_COLORS[2]
  }
  const researcher: Role = {
    id: newId('role'),
    slug: 'researcher',
    name: 'Researcher',
    description:
      'Explores the codebase or the web to answer a question. Use before planning when context is missing.',
    responsibilities: [
      'Locate relevant code, docs and prior decisions',
      'Summarize findings with references',
      'Never modify files'
    ],
    prompt: `You are a research specialist. Find and summarize the information requested, citing file paths or URLs. Be concise and concrete. Do not modify files.`,
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    ...modelOf('fast'),
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: 280, y: 200 },
    color: ROLE_COLORS[3]
  }
  orchestrator.spawnable = [implementer.id, reviewer.id, researcher.id]
  return [orchestrator, implementer, reviewer, researcher]
}

export function newProject(input: { name: string; path: string; brief: string; setupKind?: SetupKind }, settings?: AppSettings): Project {
  const now = new Date().toISOString()
  if (settings) {
    // New projects start on anthropic; ConnectionService.prepareNewProject then moves them to the default connection
    // (a 'switched' remap re-resolves every tiered role there).
    const ctx: TierContext = { connection: 'anthropic', tierModels: settings.connections.anthropic.tierModels }
    const roles = defaultRoles(ctx).map((r) => {
      const setting = r.reportsTo === null ? settings.defaultRootModel : settings.defaultReportModel
      const resolved = resolveModelSetting(setting, ctx)
      if (!resolved) return r
      const { tier: _tier, ...rest } = r
      return { ...rest, model: resolved.model, ...(resolved.tier ? { tier: resolved.tier } : {}) }
    })
    const auth = settings.providerAuth.kind === 'apiKey' ? { kind: 'apiKey' as const, envVar: settings.providerAuth.envVar } : { kind: 'subscription' as const }
    return {
      id: newId('proj'),
      name: input.name,
      path: input.path,
      brief: input.brief,
      provider: { id: 'claude', label: claudeProviderLabel(auth), auth, connection: 'anthropic' },
      permissionMode: settings.defaultPermissionMode,
      maxBudgetUsd: settings.defaultMaxBudgetUsd,
      isolateWriters: settings.defaultIsolateWriters,
      keepRuns: settings.defaultKeepRuns,
      autoContinue: settings.defaultAutoContinue,
      maxAutoContinues: settings.defaultMaxAutoContinues,
      roles,
      setup: input.setupKind ? { kind: input.setupKind, state: 'pending' } : undefined,
      createdAt: now,
      updatedAt: now
    }
  }
  return {
    id: newId('proj'),
    name: input.name,
    path: input.path,
    brief: input.brief,
    provider: { id: 'claude', label: 'Claude (Claude Code login)', auth: { kind: 'subscription' }, connection: 'anthropic' },
    permissionMode: 'auto',
    isolateWriters: true,
    roles: defaultRoles(),
    setup: input.setupKind ? { kind: input.setupKind, state: 'pending' } : undefined,
    createdAt: now,
    updatedAt: now
  }
}

/** Root orchestrator = the role with no manager. Falls back to the first role. */
export function rootRole(project: Project): Role | undefined {
  return project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
}

/** Ids that become file names, secret-key segments or map keys: a conservative alphabet. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
export function isSafeId(x: unknown): x is string {
  return typeof x === 'string' && SAFE_ID.test(x)
}

// ---------- Usage metrics and pricing ----------

/** Most entries in AppSettings.modelPrices. */
export const MODEL_PRICE_OVERRIDES_MAX = 200
/** Longest model id in a price override. */
export const MODEL_PRICE_ID_MAX_CHARS = 200
/** Highest accepted price, USD per token (0.01 = $10,000 per million tokens; a sanity bound for overrides). */
export const MODEL_PRICE_MAX_PER_TOKEN = 0.01

/** A zeroed TokenUsage (a fresh object each call). */
export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/**
 * A report (never the root orchestrator, which speaks to the user) that ended (state done or error) with no result
 * and no final text: the "no result" signal behind AgentUsage.producedNothing and RunUsage / RoleUsage
 * agentsWithoutResult and noResultTokens. A live agent never counts; neither does an agent with parentId null or id
 * 'root'.
 */
export function agentProducedNothing(agent: Pick<AgentInstance, 'state' | 'result'> & Partial<Pick<AgentInstance, 'id' | 'parentId'>>): boolean {
  if (agent.id === 'root' || agent.parentId === null) return false
  return (agent.state === 'done' || agent.state === 'error') && !agent.result?.trim()
}

/** All four token kinds summed. */
export function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** Share of prompt tokens served from the cache: cacheRead / (input + cacheRead + cacheWrite), 0-1. null without prompt tokens. */
export function cacheHitRate(t: TokenUsage): number | null {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt > 0 ? t.cacheRead / prompt : null
}

// ---------- Skills ----------

/**
 * Project.skillEvaluation when unset: `enabled` follows the Team assistant (skillEvaluationOf), with a modest budget
 * for the model-assisted step.
 */
export const DEFAULT_SKILL_EVALUATION: SkillEvaluationSettings = { tokenBudget: 20_000 }
/** Bounds of SkillEvaluationSettings.tokenBudget (settings inputs, store normalization). */
export const SKILL_EVAL_MIN_BUDGET = 1_000
export const SKILL_EVAL_MAX_BUDGET = 500_000
/** How many of a project's newest work runs skills:evaluate reads. */
export const SKILL_EVALUATION_RUNS = 20
/** Most suggestions the model-assisted step may draft. */
export const SKILL_MAX_SUGGESTIONS = 3

/**
 * The project's evaluation settings with defaults filled in and the budget clamped. `enabled` is always set: an
 * explicit boolean wins, else it follows the Team assistant (`teamReviewOf(project).auto === 'ai'`).
 */
export function skillEvaluationOf(project: Pick<Project, 'skillEvaluation' | 'teamReview'> | null | undefined): SkillEvaluationSettings & { enabled: boolean } {
  const s = project?.skillEvaluation
  const budget = typeof s?.tokenBudget === 'number' && Number.isFinite(s.tokenBudget) ? Math.round(s.tokenBudget) : DEFAULT_SKILL_EVALUATION.tokenBudget
  return {
    enabled: typeof s?.enabled === 'boolean' ? s.enabled : teamReviewOf(project).auto === 'ai',
    tokenBudget: Math.min(SKILL_EVAL_MAX_BUDGET, Math.max(SKILL_EVAL_MIN_BUDGET, budget))
  }
}

/**
 * Project.skillEvaluation as stored: the budget clamped and `enabled` kept only when it is an explicit boolean (unset
 * stays unset, so it keeps following the Team assistant). For ProjectStore normalization.
 */
export function storedSkillEvaluation(value: SkillEvaluationSettings | null | undefined): SkillEvaluationSettings {
  const { enabled: _derived, ...rest } = skillEvaluationOf({ skillEvaluation: value ?? undefined, teamReview: { auto: 'off', tokenBudget: 0, everyRuns: 1 } })
  return typeof value?.enabled === 'boolean' ? { enabled: value.enabled, ...rest } : rest
}

/**
 * Project.teamReview when unset (existing projects too): proactive AI review on, bounded by the budget and by
 * everyRuns, and only when a check finds new evidence or new candidates.
 */
export const DEFAULT_TEAM_REVIEW: TeamReviewSettings = { auto: 'ai', tokenBudget: 20_000, everyRuns: 3 }

/** The project's team review settings with defaults filled in and every number clamped. */
export function teamReviewOf(project: Pick<Project, 'teamReview'> | null | undefined): TeamReviewSettings {
  const s = project?.teamReview
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d)
  return {
    auto: s?.auto === 'off' || s?.auto === 'free' || s?.auto === 'ai' ? s.auto : DEFAULT_TEAM_REVIEW.auto,
    tokenBudget: Math.min(TEAM_REVIEW_MAX_BUDGET, Math.max(TEAM_REVIEW_MIN_BUDGET, num(s?.tokenBudget, DEFAULT_TEAM_REVIEW.tokenBudget))),
    everyRuns: Math.min(TEAM_REVIEW_MAX_EVERY_RUNS, Math.max(1, num(s?.everyRuns, DEFAULT_TEAM_REVIEW.everyRuns)))
  }
}

/** Why a SKILL.md `name` is not acceptable, or null. Stricter than the CLIs: [a-z0-9-], no "anthropic" / "claude". */
export function skillNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'A skill needs a name.'
  if (name.length > SKILL_NAME_MAX) return `A skill name has at most ${SKILL_NAME_MAX} characters.`
  if (!/^[a-z0-9-]+$/.test(name)) return 'A skill name uses only lowercase letters, digits and hyphens.'
  if (/anthropic|claude/.test(name)) return 'A skill name may not contain "anthropic" or "claude".'
  return null
}

/** Why a SKILL.md `description` is not acceptable, or null: 1 to SKILL_DESCRIPTION_MAX characters, no < or >. */
export function skillDescriptionProblem(description: unknown): string | null {
  if (typeof description !== 'string' || !description.trim()) return 'A skill needs a description that says when to use it.'
  if (description.length > SKILL_DESCRIPTION_MAX) return `A skill description has at most ${SKILL_DESCRIPTION_MAX} characters.`
  if (/[<>]/.test(description)) return 'A skill description may not contain < or >.'
  return null
}

/** The project skills a role is granted (Role.skills), in project order. Enabled-ness and library links are not checked here. */
export function skillsForRole(project: Pick<Project, 'skills'>, role: Pick<Role, 'skills'>): SkillSpec[] {
  const ids = new Set(role.skills ?? [])
  return (project.skills ?? []).filter((s) => ids.has(s.id))
}
