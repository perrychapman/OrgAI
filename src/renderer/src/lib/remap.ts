import type { ConnectionId, ModelFamily, ModelRef, ModelTier, ProviderModel, Project, RemapChange, RemapResult } from '@shared/types'
import { MODEL_TIERS } from '@shared/types'
import { adapterForFamily, mixedFamilyRefusal, modelFamily, tierForModel } from '@shared/defaults'

/** One project's predicted or applied model changes, for the notice and the preview dialog. */
export interface ProjectChanges {
  projectId: string
  projectName: string
  changes: { roleId: string; roleName: string; from: ModelRef; to: ModelRef; unmapped?: boolean; reason?: string }[]
}

/** The tier a role expresses: its stored tier, else derived from the model. 'inherit' roles have none. */
export function roleTier(role: { model: ModelRef; tier?: ModelTier }): ModelTier | undefined {
  if (role.model === 'inherit') return undefined
  return role.tier ?? tierForModel(role.model)
}

/** Turn main-process RemapResults into display rows using the renderer's project copies. */
export function describeRemap(results: RemapResult[], projects: Project[]): ProjectChanges[] {
  const out: ProjectChanges[] = []
  for (const r of results) {
    if (r.changes.length === 0) continue
    const p = projects.find((x) => x.id === r.projectId)
    out.push({
      projectId: r.projectId,
      projectName: p?.name ?? r.projectId,
      changes: r.changes.map((c: RemapChange) => ({
        roleId: c.roleId,
        roleName: p?.roles.find((role) => role.id === c.roleId)?.name ?? c.roleId,
        from: c.from,
        to: c.to,
        unmapped: c.to === 'inherit',
        reason: c.to === 'inherit' ? 'No equivalent model on this connection' : undefined
      }))
    })
  }
  return out
}

export interface PreviewInput {
  project: Project
  /** Connection the project will use after the change. */
  connection: ConnectionId
  /** Tier mapping of that connection after the change. */
  tierModels: Partial<Record<ModelTier, ModelRef>>
  /** Tier mapping before the change, for the same connection (undefined when switching). */
  previousTierModels?: Partial<Record<ModelTier, ModelRef>>
  /** Catalog of the target connection. */
  catalog: readonly ProviderModel[]
  /** True when the project moves to another connection: every tiered role is remapped. */
  switching: boolean
}

/**
 * Predict what a remap will do, following the rules in the RemapResult contract: each tiered role gets
 * tierModels[tier]; a role holding a valid catalog model that differs from the tier default is an explicit pick
 * and is kept unless the project is switching. Roles without a tier and 'inherit' roles are not touched.
 * This is an estimate computed in the renderer (there is no dry-run IPC); the real result is shown afterwards.
 */
export function previewRemap(input: PreviewInput): ProjectChanges {
  const { project, tierModels, previousTierModels, catalog, switching } = input
  const known = new Set(catalog.map((m) => m.id))
  const changes: ProjectChanges['changes'] = []
  for (const role of project.roles) {
    const tier = roleTier(role)
    if (!tier) continue
    const target = tierModels[tier]
    if (!target || target === role.model) continue
    const explicit = !switching && known.has(role.model) && role.model !== previousTierModels?.[tier]
    if (explicit) continue
    changes.push({ roleId: role.id, roleName: role.name, from: role.model, to: target })
  }
  return { projectId: project.id, projectName: project.name, changes }
}

/**
 * Roles of a LiteLLM project whose model family differs from the orchestrator's. They are allowed: the orchestrator's
 * family picks the adapter and the proxy serves the rest. Used only to word one informational notice.
 */
export function otherFamilyRoles(
  project: Pick<Project, 'roles'>,
  catalog: readonly ProviderModel[]
): { roleId: string; roleName: string; model: ModelRef }[] {
  const familyOf = (m: ModelRef): ModelFamily => catalog.find((x) => x.id === m)?.family ?? modelFamily(m)
  const root = project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
  if (!root || root.model === 'inherit') return []
  const adapter = adapterForFamily(familyOf(root.model))
  return project.roles
    .filter((r) => r.model !== 'inherit' && adapterForFamily(familyOf(r.model)) !== adapter)
    .map((r) => ({ roleId: r.id, roleName: r.name, model: r.model }))
}

/** "Claude orchestrator; 2 roles on other model families run through the proxy." Null when no role differs. */
export function proxyFamilyNotice(family: ModelFamily | undefined, count: number): string | null {
  if (count <= 0) return null
  const who = family ? FAMILY_LABEL[family] : 'The'
  return `${who} orchestrator; ${count} ${count === 1 ? 'role on another model family runs' : 'roles on other model families run'} through the proxy.`
}

/**
 * Whether a work run with this adapter choice is refused before it exists: the shared rule main applies
 * (`mixedFamilyRefusal` in src/shared/defaults.ts), re-exported so the banner and the start gate cannot drift.
 */
export const startRefusal = mixedFamilyRefusal

/** Danger-banner copy for a refused start (null when the project can start). */
export const START_REFUSAL_COPY: Record<'no-root-family' | 'single-family-connection', string> = {
  'no-root-family': 'This project cannot start: the orchestrator has no model of its own, so the proxy cannot pick an adapter. Give the orchestrator a model in the Team tab.',
  'single-family-connection': 'This project cannot start: some roles use models this connection does not serve. Give them a model from this connection in the Team tab.'
}

export interface TierRow {
  tier: ModelTier
  model: ModelRef | undefined
}

/** Tiers in display order with the mapped model. */
export function tierRows(tierModels: Partial<Record<ModelTier, ModelRef>>): TierRow[] {
  return MODEL_TIERS.map((tier) => ({ tier, model: tierModels[tier] }))
}

export const FAMILY_LABEL: Record<ModelFamily, string> = { claude: 'Claude', openai: 'OpenAI', other: 'Other' }
export const FAMILY_ORDER: ModelFamily[] = ['claude', 'openai', 'other']

export function groupByFamily(models: readonly ProviderModel[]): { family: ModelFamily; models: ProviderModel[] }[] {
  return FAMILY_ORDER.map((family) => ({ family, models: models.filter((m) => m.family === family) })).filter((g) => g.models.length > 0)
}

export function formatContext(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`
  return `${Math.round(tokens / 1000)}k`
}

export function relativeTime(at: number | undefined, now = Date.now()): string | undefined {
  if (!at) return undefined
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
