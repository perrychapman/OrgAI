import type {
  AdapterChoice,
  AppearanceSettings,
  AppSettings,
  ConnectionId,
  ImageMediaType,
  McpLibraryEntry,
  McpServerSpec,
  ModelFamily,
  ModelRef,
  ModelTier,
  Project,
  ProviderAuth,
  ProviderConnections,
  ProviderId,
  ProviderModel,
  Role,
  SetupKind,
  ToolName
} from './types'
import { DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES } from './types'

/** Run limits for new projects: enough parallel reports for a real team, and room for leads with their own reports. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3
/** Project.runMessaging when unset: cross-run messaging is opt-in per project. */
export const DEFAULT_RUN_MESSAGING = false

/** Whether a project lets its runs message other runs and be messaged (Project.runMessaging, default off). */
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

/** Anthropic's models as Claude Code aliases, one per tier. Always in the catalog for the anthropic connection. */
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

/** Fill a tier mapping from a catalog: the first model suggested for each tier. Tiers with none are left out. */
export function defaultTierModels(models: readonly ProviderModel[]): Partial<Record<ModelTier, ModelRef>> {
  const out: Partial<Record<ModelTier, ModelRef>> = {}
  for (const m of models) if (m.tier && !out[m.tier]) out[m.tier] = m.id
  return out
}

const CLAUDE_ALIAS_TIERS: Record<string, ModelTier> = { fable: 'top', opus: 'deep', sonnet: 'everyday', haiku: 'fast' }

/** Lowercase a model id and strip a gateway prefix such as "anthropic/" or "openai/". */
function bareModelId(model: string): string {
  const id = model.trim().toLowerCase()
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
 * root role's model family (its catalog entry first, else modelFamily), and every role's model must share it:
 * roles that would need the other adapter are listed in `mismatched`. 'inherit' roles always match.
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
  const { id: _entryId, source: _source, ...rest } = entry
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
  defaultRootModel: 'opus',
  defaultReportModel: 'sonnet',
  providerAuth: { kind: 'subscription' },
  connections: defaultConnections(),
  defaultConnection: 'anthropic',
  notifications: true,
  appearance: DEFAULT_APPEARANCE,
  opusGuardThreshold: 80,
  defaultPreferSonnetNearLimit: false,
  defaultAutoContinue: true,
  defaultMaxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES
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
 * purpose-built reports. The AI drafter can replace or revise it.
 */
export function defaultRoles(): Role[] {
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
    model: 'opus',
    tier: 'deep',
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
    model: 'sonnet',
    tier: 'everyday',
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
    model: 'sonnet',
    tier: 'everyday',
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
    model: 'haiku',
    tier: 'fast',
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
  let roles = defaultRoles()
  if (settings) {
    roles = roles.map((r) => {
      const model = r.reportsTo === null ? settings.defaultRootModel : settings.defaultReportModel
      return { ...r, model, tier: tierForModel(model) }
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
      maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
      maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      isolateWriters: settings.defaultIsolateWriters,
      keepRuns: settings.defaultKeepRuns,
      preferSonnetNearLimit: settings.defaultPreferSonnetNearLimit,
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
    maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
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
