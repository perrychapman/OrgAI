import type { McpServerSpec, Project, Role } from '@shared/types'
import { cleanRequiredReports } from '@shared/defaults'

/**
 * Merging a proposed org chart (toRoles output: new ids, slugs from names, no grants) into the project's current
 * chart, so an approved org change never wipes Role.mcpServers / Role.skills grants or breaks role ids.
 *
 * Rules:
 * - A proposed role matches an existing role by slug first (the tool sets Role.slug to the draft's explicit `slug`
 *   when it names an existing role), then by name (case-insensitive, trimmed). Each existing role matches at most once;
 *   every slug match is resolved before any name match.
 * - A matched role keeps the existing id, slug, color, effort and any field the proposal does not carry; it takes the
 *   proposal's name, description, responsibilities, prompt, tools, model, tier (removed when the proposal has none),
 *   canSpawn, spawnable, reportsTo and position. Its mcpServers / skills grants are kept unless the proposed role sets
 *   them (not undefined).
 * - reportsTo and spawnable of every role are remapped from proposed ids to the kept ids.
 * - Unmatched proposed roles are new (their toRoles id); slugs are de-duplicated against every kept slug (-2, -3...).
 * - Grants are filtered to ids the project has (mcpServers: project.mcpServers ids; skills: project.skills ids). A
 *   grant list that was set stays an array (possibly empty); an unset one stays unset.
 * - project.mcpServers[].roles loses slugs of removed roles; never widened (a list that becomes [] stays [] =
 *   nobody; undefined stays undefined = everybody). `mcpServers` is returned only when some list changed.
 * - Idempotent: merging an already merged chart against the same project gives the same roles.
 * Pure: never mutates its inputs.
 */
export interface OrgMergeResult {
  roles: Role[]
  /** The project's servers with dead role slugs removed; set only when a server's roles list changed. */
  mcpServers?: McpServerSpec[]
  /** Names of roles kept from the current chart (matched). */
  kept: string[]
  /** Names of proposed roles that are new. */
  added: string[]
  /** Names of current roles the proposal drops. */
  removed: string[]
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '')

export function mergeOrgChart(existing: Pick<Project, 'roles' | 'mcpServers' | 'skills'>, proposed: Role[]): OrgMergeResult {
  const current = existing.roles ?? []
  const taken = new Set<number>() // indexes of existing roles already matched
  const matchOf = new Map<number, number>() // proposed index -> existing index
  proposed.forEach((p, i) => {
    const at = current.findIndex((e, j) => !taken.has(j) && e.slug === p.slug)
    if (at >= 0) {
      taken.add(at)
      matchOf.set(i, at)
    }
  })
  proposed.forEach((p, i) => {
    if (matchOf.has(i) || !norm(p.name)) return
    const at = current.findIndex((e, j) => !taken.has(j) && norm(e.name) === norm(p.name))
    if (at >= 0) {
      taken.add(at)
      matchOf.set(i, at)
    }
  })

  // Proposed id -> id of the role that ends up in the chart.
  const idMap = new Map<string, string>()
  proposed.forEach((p, i) => {
    const at = matchOf.get(i)
    idMap.set(p.id, at === undefined ? p.id : current[at].id)
  })
  const remap = (id: string): string => idMap.get(id) ?? id

  const mcpIds = new Set((existing.mcpServers ?? []).map((s) => s.id))
  const skillIds = new Set((existing.skills ?? []).map((s) => s.id))
  const filtered = (list: string[] | undefined, ok: Set<string>): string[] | undefined =>
    list === undefined ? undefined : [...new Set(list)].filter((id) => ok.has(id))

  // Slugs held by kept roles are fixed; new roles de-duplicate against them.
  const usedSlugs = new Set<string>()
  for (const at of matchOf.values()) usedSlugs.add(current[at].slug)

  const roles: Role[] = proposed.map((p, i) => {
    const at = matchOf.get(i)
    let role: Role
    if (at === undefined) {
      let slug = p.slug
      let n = 1
      while (usedSlugs.has(slug)) slug = `${p.slug}-${++n}`
      usedSlugs.add(slug)
      role = { ...structuredClone(p), slug }
    } else {
      role = {
        ...structuredClone(current[at]),
        name: p.name,
        description: p.description,
        responsibilities: [...p.responsibilities],
        prompt: p.prompt,
        tools: [...p.tools],
        model: p.model,
        canSpawn: p.canSpawn,
        spawnable: [...p.spawnable],
        reportsTo: p.reportsTo,
        position: { ...p.position }
      }
      if (p.tier !== undefined) role.tier = p.tier
      else delete role.tier
      // The proposal owns the required reports too: a proposed role without any clears the kept role's list.
      if (p.requiredReports !== undefined) role.requiredReports = [...p.requiredReports]
      else delete role.requiredReports
      // The proposed model was resolved on the proposed role's connection, so the connection follows the proposal.
      if (p.connection !== undefined) role.connection = p.connection
      else delete role.connection
      if (p.mcpServers !== undefined) role.mcpServers = [...p.mcpServers]
      if (p.skills !== undefined) role.skills = [...p.skills]
    }
    role.reportsTo = role.reportsTo === null ? null : remap(role.reportsTo)
    role.spawnable = [...new Set((role.spawnable ?? []).map(remap))]
    if (role.requiredReports !== undefined) {
      const required = cleanRequiredReports({ ...role, requiredReports: role.requiredReports.map(remap) })
      if (required) role.requiredReports = required
      else delete role.requiredReports
    }
    const mcp = filtered(role.mcpServers, mcpIds)
    if (mcp === undefined) delete role.mcpServers
    else role.mcpServers = mcp
    const skills = filtered(role.skills, skillIds)
    if (skills === undefined) delete role.skills
    else role.skills = skills
    return role
  })

  const removedRoles = current.filter((_, j) => !taken.has(j))
  const removedSlugs = new Set(removedRoles.map((r) => r.slug))
  let changed = false
  const servers = existing.mcpServers?.map((s) => {
    if (!s.roles || !s.roles.some((slug) => removedSlugs.has(slug))) return s
    changed = true
    return { ...s, roles: s.roles.filter((slug) => !removedSlugs.has(slug)) }
  })

  return {
    roles,
    ...(changed && servers ? { mcpServers: servers } : {}),
    kept: [...matchOf.keys()].sort((a, b) => a - b).map((i) => proposed[i].name),
    added: proposed.filter((_, i) => !matchOf.has(i)).map((p) => p.name),
    removed: removedRoles.map((r) => r.name)
  }
}
