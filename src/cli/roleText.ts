/**
 * Plain-word lines about a role's effort, staffing and connection, for terminal text (`orgai team role`, the role
 * editing commands; `org show` may adopt them). Pure: every value comes from the role, the project and an optional
 * connection-name map. Callers sanitize with safeLine.
 */
import { cleanRoleStaffing, effectiveRoleStaffing, projectConnection, roleConnection } from '../shared/defaults'
import type { Project, Role } from '../shared/types'
import { roleTierWord } from './commands/org'

/** The effort ceiling automatic staffing uses when neither the role nor its staffing names one (runtime/staffing.ts). */
const AUTO_EFFORT_CEILING = 'high'

/** "high", or "default" when the role sets none. */
export function effortWord(role: Pick<Role, 'effort'>): string {
  return role.effort ?? 'default'
}

/**
 * A role's staffing in words: "automatic, from fast up to deep, at most high effort (follows the project)" or "always as
 * configured: everyday at medium effort (an exact model)". The root always runs as configured.
 */
export function staffingWords(role: Role, project: Pick<Project, 'staffing'>): string {
  const own = cleanRoleStaffing(role.staffing)
  const tierWord = roleTierWord(role)
  const fixedText = `always as configured: ${tierWord} at ${role.effort ? `${role.effort} effort` : 'the default effort'}`
  if (role.reportsTo === null) return `${fixedText} (the top of the chart)`
  const eff = effectiveRoleStaffing(role, project)
  if (eff.mode === 'fixed') {
    const why = project.staffing === 'fixed' ? ' (the project is set to always as configured)' : own?.mode === 'fixed' ? '' : ' (an exact model)'
    return `${fixedText}${why}`
  }
  const from = eff.minTier ? `from ${eff.minTier} ` : ''
  const top = eff.maxTier ?? 'the tier of the agent that starts it'
  return `automatic, ${from}up to ${top}, at most ${eff.maxEffort ?? AUTO_EFFORT_CEILING} effort${own ? '' : ' (follows the project)'}`
}

/** "Anthropic (the project's)" or "LiteLLM (pinned; the project runs on Anthropic)". `label` names a connection id. */
export function runsOnWords(role: Role, project: Pick<Project, 'provider'>, label: (id: string) => string): string {
  const on = roleConnection(role, project)
  const base = projectConnection(project)
  if (on === base) return `${label(on)} (the project's connection)`
  return `${label(on)} (pinned; the project runs on ${label(base)})`
}
