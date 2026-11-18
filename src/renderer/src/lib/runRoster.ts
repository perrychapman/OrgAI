/**
 * How the run views resolve the role of an agent: the run's roster first (a work run whose org chart changed mid-run
 * keeps one, RunRecord.roster), then the project's roles as before. Pure.
 *
 * The roster also keeps roles removed mid-run, so an agent that started on one still shows its colour. A run without a
 * roster (every older run, and runs without a mid-run org change) resolves from the project's roles only.
 */
import type { Role, RunRosterRole } from '@shared/types'

/** The display fields every view needs of a role. */
export interface RunRoleView {
  id: string
  slug: string
  name?: string
  color?: string
}

/**
 * The roles a run resolves against: its roster first, then the project's roles the roster does not know (by id), so a
 * role saved after the run's last roster event still resolves. Returns the project's own array when there is no roster.
 */
export function rolesForRun(roster: readonly RunRosterRole[] | undefined, projectRoles: readonly Role[] | undefined): readonly RunRoleView[] {
  const project = projectRoles ?? []
  if (!roster || roster.length === 0) return project
  const known = new Set(roster.map((r) => r.id))
  return [...roster, ...project.filter((r) => !known.has(r.id))]
}

/** The role of an agent: by id, else by slug; undefined when neither knows it. */
export function resolveRunRole(
  roster: readonly RunRosterRole[] | undefined,
  projectRoles: readonly Role[] | undefined,
  roleId: string | null | undefined,
  slug: string | undefined
): RunRoleView | undefined {
  const roles = rolesForRun(roster, projectRoles)
  return (roleId ? roles.find((r) => r.id === roleId) : undefined) ?? (slug ? roles.find((r) => r.slug === slug) : undefined)
}

/** The role colour of an agent, or `fallback` when no role (or no colour) is known. */
export function runRoleColor(
  roster: readonly RunRosterRole[] | undefined,
  projectRoles: readonly Role[] | undefined,
  roleId: string | null | undefined,
  slug: string | undefined,
  fallback: string
): string {
  return resolveRunRole(roster, projectRoles, roleId, slug)?.color || fallback
}

/** A stable text of a roster, for change signatures. */
export function rosterSignature(roster: readonly RunRosterRole[] | undefined): string {
  return roster ? roster.map((r) => `${r.id}:${r.slug}:${r.color}${r.removed ? ':x' : ''}`).join(',') : ''
}
