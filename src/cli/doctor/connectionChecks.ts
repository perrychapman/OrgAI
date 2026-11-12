/**
 * Doctor checks of the model catalog (cli-parity.md 3.1, I16): for each enabled connection the last model discovery
 * (modelsError, refresh time), whether every tier is mapped, and whether a tier in use runs on a built-in fallback
 * model or on a model older than the newest of its family in the catalog. Every finding names the command that fixes it.
 * The pure part (`connectionFindings`) takes the host's own answers; `connectionChecks` reads them from a read-scope
 * client. Read only. Never throws; when it cannot tell (an id that does not read as family + version) it does not warn.
 */
import { MODEL_TIERS, type ConnectionInfo, type ModelTier, type Project, type ProviderModel } from '../../shared/types'
import { roleConnection, settingTier } from '../../shared/defaults'
import { newerInFamily } from '../../shared/modelFamily'
import { safeLine } from '../output'
import { labelOfId } from '../commands/connections'
import type { DoctorCheck } from '../commands/doctor'
import { resolveTier } from '../commands/models'
import type { DoctorCheckGroup } from './types'

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The tiers the projects' roles use on `connection`; every tier when no role uses it (nothing says which matter). */
function tiersInUse(connection: string, projects: readonly Project[]): ModelTier[] {
  const used = new Set<ModelTier>()
  for (const p of projects) {
    for (const r of p.roles ?? []) if (r.tier && r.model !== 'inherit' && roleConnection(r, p) === connection) used.add(r.tier)
  }
  return used.size > 0 ? MODEL_TIERS.filter((t) => used.has(t)) : [...MODEL_TIERS]
}

export function connectionFindings(infos: readonly ConnectionInfo[], catalog: readonly ProviderModel[], projects: readonly Project[]): DoctorCheck[] {
  const out: DoctorCheck[] = []
  for (const info of infos) {
    const c = info.connection
    if (!c.enabled) continue
    const id = c.id
    const name = safeLine('name' in c && typeof c.name === 'string' ? c.name : labelOfId(id))
    const ids = catalog.filter((m) => m.connection === id).map((m) => m.id)
    // Last discovery
    if (info.modelsError) {
      out.push({ id: `models-${id}`, status: 'warn', detail: `${name}: the last model discovery failed (${safeLine(info.modelsError).slice(0, 160)}). Fix: orgai models refresh --connection ${id}` })
    } else if (!info.modelsRefreshedAt) {
      out.push({ id: `models-${id}`, status: 'warn', detail: `${name}: models were never discovered (the built-in list is in use, ${info.modelCount} model${info.modelCount === 1 ? '' : 's'}). Fix: orgai models refresh --connection ${id}` })
    } else {
      out.push({ id: `models-${id}`, status: 'ok', detail: `${name}: models discovered ${day(info.modelsRefreshedAt)}, ${info.modelCount} in the catalog` })
    }
    // Tier mapping, built-in fallbacks, older family members
    const problems: string[] = []
    const tierModels = c.tierModels as Partial<Record<ModelTier, string>>
    const unmapped = MODEL_TIERS.filter((t) => !tierModels[t]?.trim())
    for (const t of unmapped) problems.push(`${t} is not mapped (${resolveTier(t, id, tierModels, catalog).model === null ? 'no model at all' : 'a neighbouring tier or the catalog suggestion is used'}); fix: orgai connections tier ${id} ${t}=<model>`)
    for (const t of tiersInUse(id, projects)) {
      const r = resolveTier(t, id, tierModels, catalog)
      if (r.model === null) continue
      // An alias (opus, sonnet, ...) resolves to the CLI's current model: the normal state, not a fallback.
      if (r.source === 'builtin' && settingTier(r.model.replace(/\[[^\]]*\]$/, '')) === undefined) problems.push(`${t} runs on built-in ${safeLine(r.model)}; fix: orgai models refresh --connection ${id}, then orgai connections tier ${id} ${t}=<model>`)
      const newer = newerInFamily(r.model, ids)
      if (newer) problems.push(`${t} runs on ${safeLine(r.model)}, older than ${safeLine(newer)} in the catalog; fix: orgai connections tier ${id} ${t}=${safeLine(newer)}`)
    }
    out.push(problems.length === 0 ? { id: `tiers-${id}`, status: 'ok', detail: `${name}: every tier is mapped to a current model` } : { id: `tiers-${id}`, status: 'warn', detail: `${name}: ${problems.join('; ')}` })
  }
  return out
}

/** The group: needs a client (read scope); without one a single ok-level note says why nothing was checked. */
export const connectionChecks: DoctorCheckGroup = async ({ client }) => {
  if (!client) return [{ id: 'connections', status: 'ok', detail: 'Connections and models were not checked (no host to ask)' }]
  try {
    const [infos, catalog, projects] = await Promise.all([client.call<ConnectionInfo[]>('connections:list', []), client.call<ProviderModel[]>('models:list', []), client.call<Project[]>('projects:list', [])])
    const list = (Array.isArray(infos) ? infos : []).filter((i) => i?.connection)
    if (list.filter((i) => i.connection.enabled).length === 0) return [{ id: 'connections', status: 'warn', detail: 'No connection is enabled. Fix: orgai connections connect <anthropic|openai>' }]
    return connectionFindings(list, Array.isArray(catalog) ? catalog : [], Array.isArray(projects) ? projects : [])
  } catch (e) {
    return [{ id: 'connections', status: 'warn', detail: `Connections could not be checked: ${(e as Error)?.message ?? String(e)}` }]
  }
}
