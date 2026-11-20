import type { Effort, ModelTier, Project, Role } from '@shared/types'
import { effectiveRoleStaffing } from '@shared/defaults'
import { TIER_LABEL, roleModelChoice } from './roleModels'

/**
 * The one sentence the role editor's "Model and effort" section opens with (docs/design/team-tab-overhaul.md 1.6).
 * Pure: the caller passes what it already knows (the picker value, the model the tier maps to, the staffing mode).
 */
export interface RoleModelSentenceInput {
  /** The picker value: 'inherit', a tier word, or 'custom' (an exact model that is no tier's model). */
  choice: 'inherit' | ModelTier | 'custom'
  /** The model id when known: the tier's model on the role's connection, or the exact id of a custom role. */
  model?: string
  /** The role is the root (it has no manager to inherit from). */
  isRoot?: boolean
  /** The manager's name for an inheriting role. */
  managerName?: string
  /** `fixed`: always this model; `auto`: OrgAI chooses per task up to the role's tier. */
  mode: 'auto' | 'fixed'
  /** Fixed: the role's effort. Auto: the most effort a task may use. Unset when none is set. */
  effort?: Effort
  /** The connection's name when the role is pinned to a connection other than the project's. */
  pinnedTo?: string
}

/** "Everyday (sonnet)", "Everyday" when the id is unknown, the bare id for an exact model with no tier. */
function modelWords(choice: RoleModelSentenceInput['choice'], model: string | undefined): string {
  if (choice === 'inherit') return model ?? ''
  if (choice === 'custom') return model ?? 'a model of its own'
  return model ? `${TIER_LABEL[choice]} (${model})` : TIER_LABEL[choice]
}

export function roleModelSentence(input: RoleModelSentenceInput): string {
  const { choice, model, isRoot, managerName, mode, effort, pinnedTo } = input
  const where = pinnedTo ? ` It runs on ${pinnedTo}.` : ''
  if (choice === 'inherit') {
    if (isRoot || !managerName) return `Uses the connection's default model.${where}`
    return `Uses the same model as ${managerName}.${where}`
  }
  const what = modelWords(choice, model)
  if (mode === 'fixed') return `Always runs on ${what}${effort ? ` at ${effort} effort` : ''}.${where}`
  return `Runs on ${what}. OrgAI chooses how much effort per task${effort ? `, up to ${effort}` : ''}.${where}`
}

/**
 * The sentence for a role of a project. `tierModels` maps tiers to model ids on the role's connection; `pinnedTo` is the
 * connection name when the role runs on another connection than the project's. The root always runs as configured.
 */
export function roleModelSentenceFor(
  project: Pick<Project, 'roles' | 'staffing'>,
  role: Role,
  tierModels: Partial<Record<ModelTier, string>>,
  pinnedTo?: string
): string {
  const isRoot = role.reportsTo === null
  const choice = roleModelChoice(role, tierModels)
  const manager = project.roles.find((r) => r.id === role.reportsTo)
  if (choice === 'inherit') return roleModelSentence({ choice, isRoot, managerName: manager?.name, mode: 'auto', pinnedTo })
  const eff = effectiveRoleStaffing(role, project)
  const mode = isRoot || eff.mode === 'fixed' ? 'fixed' : 'auto'
  const model = choice === 'custom' ? role.model : (tierModels[choice] ?? undefined)
  // The effort the staffing code reads: the role's own maximum, else the role's effort (eff.maxEffort covers both).
  return roleModelSentence({ choice, model, isRoot, mode, effort: eff.maxEffort, pinnedTo })
}
