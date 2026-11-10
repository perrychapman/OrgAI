import type { Effort, ModelTier, Project, ProviderId, ReviewPolicy, Role, RoleStaffing, StaffingGoal, StaffingMode } from '@shared/types'
import { MODEL_TIERS } from '@shared/types'
import { cleanRoleStaffing, compareTier, effectiveRoleStaffing, effortOptionsFor, reviewPolicyOf, staffingGoalOf, staffingModeOf } from '@shared/defaults'
import { roleTier } from './remap'
import { TIER_LABEL } from './roleModels'

/** Effort an automatic role may be picked up to when neither the role nor its staffing sets one (runtime/staffing.ts). */
export const AUTO_EFFORT_CEILING: Effort = 'high'

type StaffingRole = Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'>

/** What the role's model and effort mean now: the line, and a short note when something is left unset. */
export interface StaffingLine {
  text: string
  note?: string
}

/** The model word of a fixed role: its tier, the exact id, or the parent it follows. */
function fixedModelWord(role: Pick<Role, 'model' | 'tier'>): string {
  if (role.model === 'inherit') return 'the model of the agent that started it'
  const tier = roleTier(role)
  return tier ? TIER_LABEL[tier] : role.model
}

/** True when the role is fixed only because it names an exact model and no tier (and has not been set to automatic). */
export function isFixedByNature(role: StaffingRole): boolean {
  if (cleanRoleStaffing(role.staffing)?.mode === 'auto') return false
  return effectiveRoleStaffing({ ...role, staffing: undefined }, null).mode === 'fixed'
}

/** "Automatic, up to Deep / medium" or "Always Deep / medium", from effectiveRoleStaffing. The root always runs as configured. */
export function roleStaffingLine(role: StaffingRole, project: Pick<Project, 'staffing'>, isRoot: boolean): StaffingLine {
  const eff = effectiveRoleStaffing(role, project)
  const fixed = isRoot || eff.mode === 'fixed'
  if (fixed) {
    const effort = role.effort ?? undefined
    return {
      text: `Always ${fixedModelWord(role)} / ${effort ?? 'default effort'}`,
      ...(effort ? {} : { note: 'No effort is set, so it runs at the default.' })
    }
  }
  const effort = eff.maxEffort ?? AUTO_EFFORT_CEILING
  const top = eff.maxTier ? TIER_LABEL[eff.maxTier] : 'the tier of the agent that started it'
  const from = eff.minTier ? `from ${TIER_LABEL[eff.minTier]} ` : ''
  return {
    text: `Automatic, ${from}up to ${top} / ${effort}`,
    ...(eff.maxEffort ? {} : { note: `No effort is set, so automatic picks may go up to ${AUTO_EFFORT_CEILING}.` })
  }
}

export type StaffingModeChoice = 'default' | StaffingMode

export type StaffingControlsKind =
  /** The top of the chart: always as configured, nothing to edit. */
  | 'root'
  /** An exact model and no tier: fixed by nature, automatic is not offered. */
  | 'exact'
  /** Editable. */
  | 'editable'

export interface StaffingControls {
  kind: StaffingControlsKind
  /** One sentence under the line: why there are no controls, or what the project setting does to this role. */
  explanation?: string
  /** An inherit role (not the root) follows the agent that started it. */
  inherits: boolean
  mode: StaffingModeChoice
  modeOptions: { value: StaffingModeChoice; label: string }[]
  /** The lowest-tier select is shown only while the role is automatic. */
  showBounds: boolean
  minTier: ModelTier | ''
  minTierOptions: { value: ModelTier | ''; label: string }[]
  maxEffort: Effort | ''
  maxEffortOptions: { value: Effort | ''; label: string }[]
}

const MODE_LABEL: Record<StaffingMode, string> = { auto: 'Automatic', fixed: 'Always as configured' }

/** Tiers a role may name as its floor: only tiers at or below its own tier (all of them when it has none). */
export function minTierChoices(role: Pick<Role, 'model' | 'tier'>): ModelTier[] {
  const own = roleTier(role)
  return [...MODEL_TIERS].reverse().filter((t) => !own || compareTier(t, own) <= 0)
}

/** Efforts the role's adapter supports, in order. */
export function maxEffortChoices(adapter: ProviderId | null | undefined): Effort[] {
  return effortOptionsFor(adapter)
}

/** What the role editor offers for `role`: which controls, their options and current values. */
export function roleStaffingControls(role: Role, project: Project, adapter: ProviderId | null | undefined, adapterName?: string): StaffingControls {
  const isRoot = role.reportsTo === null
  const own = cleanRoleStaffing(role.staffing)
  const eff = effectiveRoleStaffing(role, project)
  const projectMode = staffingModeOf(project)
  const inherits = role.model === 'inherit' && !isRoot
  const kind: StaffingControlsKind = isRoot ? 'root' : isFixedByNature(role) ? 'exact' : 'editable'

  let explanation: string | undefined
  if (kind === 'root') explanation = 'The top of the chart always runs as configured.'
  else if (kind === 'exact') explanation = 'You picked an exact model, so this role always runs on it. Choose a tier under Model to let it be picked automatically.'
  else if (projectMode === 'fixed') explanation = 'This project is set to Always as configured, so this role does not change per assignment.'
  else if (inherits) explanation = 'This role follows the agent that started it, so its tier is never above that agent.'

  const mode: StaffingModeChoice = own?.mode ?? 'default'
  const modeOptions: StaffingControls['modeOptions'] = [
    { value: 'default', label: `Follow the project (${MODE_LABEL[projectMode]})` },
    { value: 'auto', label: MODE_LABEL.auto },
    { value: 'fixed', label: MODE_LABEL.fixed }
  ]

  const minTierOptions: StaffingControls['minTierOptions'] = [
    { value: '', label: 'No lowest tier' },
    ...minTierChoices(role).map((t) => ({ value: t, label: TIER_LABEL[t] }))
  ]
  // A stored floor that is no longer offered (the role's tier went down) stays selected, so nothing changes silently.
  if (own?.minTier && !minTierOptions.some((o) => o.value === own.minTier)) minTierOptions.push({ value: own.minTier, label: `${TIER_LABEL[own.minTier]} (above this role's tier)` })

  const supported = maxEffortChoices(adapter)
  const maxEffortOptions: StaffingControls['maxEffortOptions'] = [
    { value: '', label: role.effort ? `The role's effort (${role.effort})` : `Up to ${AUTO_EFFORT_CEILING} (no effort set)` },
    ...supported.map((e) => ({ value: e, label: e as string }))
  ]
  if (own?.maxEffort && !supported.includes(own.maxEffort)) maxEffortOptions.push({ value: own.maxEffort, label: `${own.maxEffort} (not used on ${adapterName ?? 'this provider'})` })

  return {
    kind,
    explanation,
    inherits,
    mode,
    modeOptions,
    showBounds: kind === 'editable' && eff.mode === 'auto' && projectMode !== 'fixed',
    minTier: own?.minTier ?? '',
    minTierOptions,
    maxEffort: own?.maxEffort ?? '',
    maxEffortOptions
  }
}

/** Role.staffing after the mode select changes. 'default' clears the field; 'fixed' keeps no bounds; 'auto' keeps them. */
export function withStaffingMode(role: Pick<Role, 'staffing'>, value: StaffingModeChoice): RoleStaffing | undefined {
  if (value === 'default') return undefined
  if (value === 'fixed') return { mode: 'fixed' }
  const own = cleanRoleStaffing(role.staffing)
  return { mode: 'auto', ...(own?.minTier ? { minTier: own.minTier } : {}), ...(own?.maxEffort ? { maxEffort: own.maxEffort } : {}) }
}

/** Role.staffing after the lowest-tier select changes ('' removes the floor). The role becomes explicitly automatic. */
export function withMinTier(role: Pick<Role, 'staffing'>, value: ModelTier | ''): RoleStaffing {
  const own = cleanRoleStaffing(role.staffing)
  return { mode: 'auto', ...(value ? { minTier: value } : {}), ...(own?.maxEffort ? { maxEffort: own.maxEffort } : {}) }
}

/** Role.staffing after the highest-effort select changes ('' removes the cap). The role becomes explicitly automatic. */
export function withMaxEffort(role: Pick<Role, 'staffing'>, value: Effort | ''): RoleStaffing {
  const own = cleanRoleStaffing(role.staffing)
  return { mode: 'auto', ...(own?.minTier ? { minTier: own.minTier } : {}), ...(value ? { maxEffort: value } : {}) }
}

// ---------- Project level ----------

export const STAFFING_DEFAULTS = { staffing: 'auto', staffingGoal: 'balanced', reviewPolicy: 'risk' } as const satisfies { staffing: StaffingMode; staffingGoal: StaffingGoal; reviewPolicy: ReviewPolicy }

export interface ProjectChoice<T extends string> {
  value: T
  label: string
}

export const PROJECT_STAFFING_OPTIONS: ProjectChoice<StaffingMode>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'fixed', label: 'Always as configured' }
]
export const PROJECT_GOAL_OPTIONS: ProjectChoice<StaffingGoal>[] = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'speed', label: 'Speed' },
  { value: 'cost', label: 'Cost' }
]
export const PROJECT_REVIEW_OPTIONS: ProjectChoice<ReviewPolicy>[] = [
  { value: 'risk', label: 'By risk' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' }
]

/** One-line plain explanations of what each project setting changes. */
export function projectStaffingText(mode: StaffingMode): string {
  return mode === 'auto'
    ? "The orchestrator picks each report's tier and effort per task, never above the ceiling set on its role."
    : "Every agent runs on its role's model and effort exactly as configured."
}
export function projectGoalText(goal: StaffingGoal): string {
  return goal === 'speed'
    ? 'Treats every step as urgent: higher tiers sooner, at a higher cost.'
    : goal === 'cost'
      ? 'Treats no step as urgent: the cheapest tier that does the job.'
      : 'Spends more on the steps that decide how long the run takes and saves on the rest.'
}
export function projectReviewText(policy: ReviewPolicy): string {
  return policy === 'always'
    ? 'The orchestrator asks for a review after every change.'
    : policy === 'never'
      ? 'The orchestrator asks for a review only when a required report demands one.'
      : 'A review is asked for when a role or the brief demands it, the change is sensitive or large, or checks failed once.'
}

export interface ProjectStaffingView {
  staffing: StaffingMode
  goal: StaffingGoal
  review: ReviewPolicy
}

/** The effective values of the three project settings (defaults when unset). */
export function projectStaffingView(project: Pick<Project, 'staffing' | 'staffingGoal' | 'reviewPolicy'>): ProjectStaffingView {
  return { staffing: staffingModeOf(project), goal: staffingGoalOf(project), review: reviewPolicyOf(project) }
}

/** The project patch for a changed setting: choosing the default clears the field instead of writing it. */
export function projectStaffingPatch(field: 'staffing', value: StaffingMode): Pick<Project, 'staffing'>
export function projectStaffingPatch(field: 'staffingGoal', value: StaffingGoal): Pick<Project, 'staffingGoal'>
export function projectStaffingPatch(field: 'reviewPolicy', value: ReviewPolicy): Pick<Project, 'reviewPolicy'>
export function projectStaffingPatch(field: 'staffing' | 'staffingGoal' | 'reviewPolicy', value: string): Partial<Project> {
  return { [field]: value === STAFFING_DEFAULTS[field] ? undefined : value } as Partial<Project>
}

// ---------- Import and kit preview ----------

/** What a previewed role may spend: "Automatic, up to Deep / high" or "Always Deep / medium"; null when nothing is known. */
export function importedRoleSpend(role: (Pick<Role, 'model'> & Partial<Pick<Role, 'tier' | 'effort' | 'staffing' | 'reportsTo'>>) | undefined, project: Pick<Project, 'staffing'>, isRoot: boolean): StaffingLine | null {
  if (!role) return null
  return roleStaffingLine({ model: role.model, tier: role.tier, effort: role.effort, staffing: role.staffing }, project, isRoot)
}

/**
 * A kit template role's spend line. The preview role (KitPreviewRole) carries only name, prompt and elevated grants
 * today, so this is null until main adds `model`, `tier`, `effort` or `staffing` to it; it reads them when they are there.
 */
export function kitRoleSpend(role: object, project: Pick<Project, 'staffing'>): StaffingLine | null {
  const r = role as { model?: unknown; tier?: ModelTier; effort?: Effort; staffing?: RoleStaffing; reportsTo?: string | null }
  if (typeof r.model !== 'string' || !r.model) return null
  return importedRoleSpend({ model: r.model, tier: r.tier, effort: r.effort, staffing: r.staffing }, project, r.reportsTo === null)
}
