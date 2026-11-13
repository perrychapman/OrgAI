/**
 * Main-side schedule checks beyond the shape checks of `cleanScheduleInput` (src/shared/schedule.ts): the merge of a
 * save input onto a stored schedule, the target project, the permission-mode choices of the target, the clock (a `once`
 * or an end date in the past) and that a next run exists. Pure apart from the injected environment, so the service
 * (schedules:save, applyProposal) and the propose_schedule harness tool give the same answer.
 */
import { nextScheduleRun } from '@shared/schedule'
import { canNarrowPermissionMode } from '../runtime/runOverrides'
import { SCHEDULE_PERMISSION_MODES, isVirtualProjectId } from '@shared/types'
import type { ConnectionId, PermissionMode, Project, Schedule, ScheduleMissedPolicy, ScheduleSaveInput, ScheduleTarget, ScheduleTiming } from '@shared/types'

/** What the checks may look at. */
export interface ScheduleCheckEnv {
  now: number
  /** A stored, non-virtual project by id; undefined when there is none. */
  project(projectId: string): Project | undefined
  /** An ask target's folder: a plain sentence when it cannot be used (validateQuickFolder), else null. Missing = not checked. */
  folderProblem?(folder: string): string | null
}

/** The user-owned fields of a schedule after a save input was merged onto the stored one (or onto nothing). */
export interface ScheduleUserFields {
  name: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  enabled: boolean
  missed: ScheduleMissedPolicy
  modelSelection?: { model: string; connection: ConnectionId }
  permissionMode?: PermissionMode
  budgetUsd?: number
  expiresAt?: number
}

/** Permission modes an ask (Chat) run accepts (runPermissionModeChoices for a quick run). */
export const ASK_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'dontAsk', 'plan']

const sameTiming = (a: ScheduleTiming, b: ScheduleTiming): boolean => {
  if (a.kind !== b.kind) return false
  // The anchor is main's, so it is not part of the comparison.
  if (a.kind === 'interval' && b.kind === 'interval') return a.everyMinutes === b.everyMinutes
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A cleaned save input merged onto `existing` (an update) or onto the defaults (a create). On update an absent optional
 * field keeps the stored value and `null` clears it. An interval timing gets its anchor here: kept from the stored
 * schedule when the interval did not change, else `now`.
 */
export function mergeScheduleInput(input: ScheduleSaveInput, existing: Schedule | undefined, now: number): ScheduleUserFields {
  let timing: ScheduleTiming = input.timing
  if (timing.kind === 'interval') {
    const keep = existing && existing.timing.kind === 'interval' && sameTiming(existing.timing, timing) ? existing.timing.anchor : undefined
    timing = { kind: 'interval', everyMinutes: timing.everyMinutes, anchor: keep ?? now }
  }
  const pick = <K extends 'modelSelection' | 'permissionMode' | 'budgetUsd' | 'expiresAt'>(k: K): Schedule[K] | undefined => {
    const v = input[k]
    if (v === null) return undefined
    if (v === undefined) return existing?.[k]
    return v as Schedule[K]
  }
  const out: ScheduleUserFields = {
    name: input.name,
    prompt: input.prompt,
    target: input.target,
    timing,
    enabled: input.enabled ?? existing?.enabled ?? true,
    missed: input.missed ?? existing?.missed ?? 'run-once'
  }
  const modelSelection = pick('modelSelection')
  const permissionMode = pick('permissionMode')
  const budgetUsd = pick('budgetUsd')
  const expiresAt = pick('expiresAt')
  if (modelSelection) out.modelSelection = { ...modelSelection }
  if (permissionMode) out.permissionMode = permissionMode
  if (budgetUsd !== undefined) out.budgetUsd = budgetUsd
  if (expiresAt !== undefined) out.expiresAt = expiresAt
  return out
}

/** The mode a target's runs use when the schedule names none: the project's own for a team, 'default' for an ask run. */
export function targetBaseMode(target: ScheduleTarget, project: Project | undefined): PermissionMode {
  if (target.kind === 'ask') return 'default'
  return project?.permissionMode ?? 'default'
}

/**
 * The mode a schedule's runs actually use (review M3): the schedule's own, else the target's (the project's own mode for
 * a team target, read at the moment of the call, so a project changed later is seen at fire time).
 */
export function effectiveScheduleMode(fields: Pick<ScheduleUserFields, 'permissionMode' | 'target'>, project: Project | undefined): PermissionMode {
  return fields.permissionMode ?? targetBaseMode(fields.target, project)
}

/** Save / apply refusal when the effective mode would be bypass (the schedule names no mode, the project bypasses). */
export const SCHEDULE_INHERITS_BYPASS =
  'Its project runs with bypass permissions, which a schedule cannot use. Choose a permission mode for the schedule.'
/** History detail of a fire refused because the effective mode is bypass (the project changed after the save). */
export const SCHEDULE_BYPASS_NOT_STARTED =
  'Not started: its project now runs with bypass permissions, which a schedule cannot use. Choose a permission mode for the schedule.'

/**
 * The spend cap a scheduled run really gets (review L3, L4): min(schedule budget, project cap), ignoring a missing or
 * non-positive value; undefined when neither caps it. Recorded as the run's conversation budget so main enforces it.
 */
export function scheduledRunCap(budgetUsd: number | undefined, projectCapUsd: number | undefined): number | undefined {
  const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const total = Math.min(ok(budgetUsd) ? budgetUsd : Infinity, ok(projectCapUsd) ? projectCapUsd : Infinity)
  return Number.isFinite(total) ? total : undefined
}

/** True when `mode` is no wider than the target's own mode (an agent may only propose such a mode). */
export function modeWithinTarget(mode: PermissionMode, target: ScheduleTarget, project: Project | undefined): boolean {
  return canNarrowPermissionMode(targetBaseMode(target, project), mode)
}

/**
 * Why merged fields cannot be saved, as one plain sentence, or null. Checks: the team target's project exists and is
 * stored; the ask target's folder (env.folderProblem); the permission mode is one the target's runs accept (never
 * bypass; an ask run only Ask / Never ask / Plan); a `once` time and an end date are in the future; and an enabled
 * schedule has a next run before it ends.
 */
export function scheduleFieldsProblem(fields: ScheduleUserFields, env: ScheduleCheckEnv): string | null {
  const t = fields.target
  if (t.kind === 'team') {
    if (isVirtualProjectId(t.projectId) || !env.project(t.projectId)) return 'That project no longer exists. Choose another project.'
  } else if (t.folder !== undefined && env.folderProblem) {
    const problem = env.folderProblem(t.folder)
    if (problem) return problem
  }
  if (fields.permissionMode !== undefined) {
    if (!(SCHEDULE_PERMISSION_MODES as readonly string[]).includes(fields.permissionMode)) return 'A schedule cannot run with bypass permissions. Choose another permission mode.'
    if (t.kind === 'ask' && !ASK_PERMISSION_MODES.includes(fields.permissionMode)) return 'An ask run can only use Ask, Never ask or Plan. Choose one of those permission modes.'
  }
  // No bypass mode, also not inherited from the project (docs/design/schedules.md 6).
  if (t.kind === 'team' && effectiveScheduleMode(fields, env.project(t.projectId)) === 'bypassPermissions') return SCHEDULE_INHERITS_BYPASS
  if (fields.expiresAt !== undefined && fields.expiresAt <= env.now) return 'The end date is in the past. Choose a later date or remove it.'
  if (fields.timing.kind === 'once' && fields.enabled && fields.timing.at <= env.now) return 'That time has already passed. Choose a time in the future.'
  if (fields.enabled) {
    const next = nextScheduleRun(fields.timing, env.now)
    if (next === null) return 'This schedule would never run. Choose another time.'
    if (fields.expiresAt !== undefined && next > fields.expiresAt) return 'The schedule ends before its first run. Choose a later end date.'
  }
  return null
}
