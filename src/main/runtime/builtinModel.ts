import { ANTHROPIC_BUILTIN_MODELS, adapterForFamily, modelFamily, tierForModel } from '@shared/defaults'
import type { BuiltinRoleModel } from '@shared/setup'
import type { ConnectionId, ModelRef, ModelTier, ProviderId, ProviderModel, Role } from '@shared/types'

/**
 * Resolve AppSettings.setupModel / mcpAssistModel for one run of a built-in role (Architect, MCP assistant).
 * Pure: RunManager supplies the run's connection, adapter, catalog and the connection's tier mapping.
 *
 * - A Claude alias (fable, opus, sonnet, haiku) stands for its tier: the alias itself on anthropic, the
 *   connection's tierModels entry elsewhere.
 * - A full model id is used when the connection can serve it (anthropic: any Claude id; openai and litellm: it is
 *   in that connection's catalog or tier mapping) and its family runs on the run's adapter.
 * - Otherwise the deep tier of the connection, then the project's root role model (same adapter by construction),
 *   then the adapter's default ('opus' on Claude, 'inherit' elsewhere). A non-default setting that falls back gets
 *   a one-line `warning` naming the setting; the default never warns.
 * - The mock adapter takes the setting as it is.
 */
export interface BuiltinModelContext {
  connection: ConnectionId
  /** The adapter the run uses. */
  adapter: ProviderId
  /** Every connection's models; entries of other connections are ignored. */
  catalog: readonly ProviderModel[]
  /** The connection's tier mapping (AppSettings.connections[connection].tierModels). */
  tierModels: Partial<Record<ModelTier, ModelRef>>
  /** The project's root role, the last-resort fallback. */
  root?: Pick<Role, 'model' | 'tier'>
}

export interface ResolvedBuiltinModel extends BuiltinRoleModel {
  /** Set when a non-default setting could not be used; RunManager logs it once as a run warning. */
  warning?: string
}

const DEFAULT_MODEL = 'opus'
/** Setting names used in fallback warnings; the App settings selects use the same labels. */
export const SETUP_MODEL_LABEL = 'Setup model'
export const MCP_ASSIST_MODEL_LABEL = 'MCP assistant model'
const CLAUDE_ALIASES = new Set(ANTHROPIC_BUILTIN_MODELS.map((m) => m.id))
const CONNECTION_LABEL: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

export function resolveBuiltinModel(setting: ModelRef | undefined, settingLabel: string, ctx: BuiltinModelContext): ResolvedBuiltinModel {
  const value = setting?.trim() || DEFAULT_MODEL
  if (ctx.adapter === 'mock') {
    const tier = tierForModel(value)
    return { model: value, ...(tier ? { tier } : {}) }
  }
  const own = ctx.catalog.filter((m) => m.connection === ctx.connection)
  const familyOf = (model: ModelRef) => own.find((m) => m.id === model)?.family ?? modelFamily(model)
  const runsHere = (model: ModelRef): boolean => adapterForFamily(familyOf(model)) === ctx.adapter

  /** The model for a tier on this connection, if one runs on the run's adapter. */
  const forTier = (tier: ModelTier): ModelRef | undefined => {
    if (ctx.connection === 'anthropic') return ctx.adapter === 'claude' ? ANTHROPIC_BUILTIN_MODELS.find((m) => m.tier === tier)?.id : undefined
    const mapped = ctx.tierModels[tier]?.trim()
    return mapped && runsHere(mapped) ? mapped : undefined
  }

  /** The setting as a usable model, or undefined. */
  const direct = (): BuiltinRoleModel | undefined => {
    if (value === 'inherit') return undefined
    if (CLAUDE_ALIASES.has(value.toLowerCase())) {
      const tier = tierForModel(value) as ModelTier
      const model = forTier(tier)
      return model ? { model, tier } : undefined
    }
    if (!runsHere(value)) return undefined
    const known =
      ctx.connection === 'anthropic' ? familyOf(value) === 'claude' : own.some((m) => m.id === value) || Object.values(ctx.tierModels).some((m) => m?.trim() === value)
    if (!known) return undefined
    const tier = own.find((m) => m.id === value)?.tier ?? (Object.entries(ctx.tierModels).find(([, m]) => m?.trim() === value)?.[0] as ModelTier | undefined) ?? tierForModel(value)
    return { model: value, ...(tier ? { tier } : {}) }
  }

  const hit = direct()
  if (hit) return hit

  const deep = forTier('deep')
  const root = ctx.root && ctx.root.model !== 'inherit' && runsHere(ctx.root.model) ? ctx.root : undefined
  const fallback: BuiltinRoleModel = deep
    ? { model: deep, tier: 'deep' }
    : root
      ? { model: root.model, ...(root.tier ? { tier: root.tier } : {}) }
      : ctx.adapter === 'claude'
        ? { model: DEFAULT_MODEL, tier: 'deep' }
        : { model: 'inherit' }
  if (value === DEFAULT_MODEL) return fallback
  const used = deep ? `the deep tier (${deep})` : root ? `the orchestrator's model (${root.model})` : "the connection's default model"
  const adapter = ctx.adapter === 'claude' ? 'Claude' : 'Codex'
  return {
    ...fallback,
    warning: `App setting "${settingLabel}" is ${value}, which this run cannot use on the ${CONNECTION_LABEL[ctx.connection]} connection (${adapter} adapter); using ${used}.`
  }
}
