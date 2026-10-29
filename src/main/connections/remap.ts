import { projectConnection, tierForModel } from '@shared/defaults'
import type { ConnectionId, ModelRef, ModelTier, Project, ProviderModel, RemapChange, RemapReason, RemapResult } from '@shared/types'

export interface RemapOptions {
  connection: ConnectionId
  /** The connection's tier mapping to apply. */
  tierModels: Partial<Record<ModelTier, ModelRef>>
  /** The connection's catalog (builtin plus discovered). */
  catalog: readonly ProviderModel[]
  /** The mapping before this change. Used to tell a role still on the old default from an explicit user pick. */
  previousTierModels?: Partial<Record<ModelTier, ModelRef>>
  reason: RemapReason
}

/**
 * Remap the tiered role models of a project to a connection's tier mapping. Pure: returns a new project
 * (the input is not mutated) and the change list.
 *
 * - Roles with model 'inherit' or without a tier are never touched.
 * - A tier with no mapping leaves its roles as they are.
 * - A role whose model is a valid catalog model of the connection AND differs from the previous mapping of
 *   its tier (the new mapping when there is no previous one) is an explicit user pick and is kept, except on
 *   'switched', where every tiered role is remapped.
 */
export function remapProject(project: Project, opts: RemapOptions): { project: Project; result: RemapResult } {
  const valid = new Set(opts.catalog.filter((m) => m.connection === opts.connection).map((m) => m.id))
  const changes: RemapChange[] = []
  const roles = project.roles.map((role) => {
    if (!role.tier || role.model === 'inherit') return role
    const target = opts.tierModels[role.tier]
    if (!target || role.model === target) return role
    if (opts.reason !== 'switched') {
      const previous = opts.previousTierModels?.[role.tier] ?? target
      if (valid.has(role.model) && role.model !== previous) return role
    }
    changes.push({ roleId: role.id, from: role.model, to: target })
    return { ...role, model: target }
  })
  return {
    project: changes.length ? { ...project, roles } : project,
    result: { projectId: project.id, connection: opts.connection, reason: opts.reason, changes }
  }
}

/**
 * Fill what projects saved before connections lack: provider.connection (projectConnection) and each role's
 * tier (tierForModel). Pure; returns the migrated project and whether anything changed.
 */
export function migrateProject(project: Project): { project: Project; changed: boolean } {
  let changed = false
  let provider = project.provider
  if (!provider.connection) {
    provider = { ...provider, connection: projectConnection(project) }
    changed = true
  }
  const roles = project.roles.map((role) => {
    if (role.tier) return role
    const tier = tierForModel(role.model)
    if (!tier) return role
    changed = true
    return { ...role, tier }
  })
  return changed ? { project: { ...project, provider, roles }, changed } : { project, changed }
}
