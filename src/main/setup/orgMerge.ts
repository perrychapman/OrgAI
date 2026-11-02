import type { McpServerSpec, Project, Role } from '@shared/types'

/**
 * Merging a proposed org chart (toRoles output: new ids, slugs from names, no grants) into the project's current
 * chart, so an approved org change never wipes Role.mcpServers / Role.skills grants or breaks role ids.
 *
 * CONTRACT STUB (Runtime Lead): the Runtime Engineer replaces the body. Rules:
 * - A proposed role matches an existing role by slug first (the tool sets Role.slug to the draft's explicit `slug`
 *   when it names an existing role), then by name (case-insensitive, trimmed). Each existing role matches at most once.
 * - A matched role keeps the existing id, slug, color, effort and any field the proposal does not carry; it takes the
 *   proposal's name, description, responsibilities, prompt, tools, model, tier, canSpawn, spawnable, reportsTo and
 *   position. Its mcpServers / skills grants are kept unless the proposed role sets them (not undefined).
 * - reportsTo and spawnable of every role are remapped from proposed ids to the kept ids.
 * - Unmatched proposed roles are new (their toRoles id); slugs are de-duplicated against every kept slug.
 * - Grants are filtered to ids the project has (mcpServers: project.mcpServers ids; skills: project.skills ids).
 * - project.mcpServers[].roles loses slugs of removed roles; never widened (a list that becomes [] stays [] =
 *   nobody; undefined stays undefined = everybody). `mcpServers` is returned only when some list changed.
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

export function mergeOrgChart(existing: Pick<Project, 'roles' | 'mcpServers' | 'skills'>, proposed: Role[]): OrgMergeResult {
  void existing
  return { roles: proposed, kept: [], added: proposed.map((r) => r.name), removed: [] }
}
