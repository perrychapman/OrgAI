import type { AppSettings, Project, Role } from '@shared/types'
import { cleanProjectLimits, cleanRoleLimits } from '../store/projects'
import { normalizeSpendWarnPercent } from '../store/settings'

/**
 * UI overhaul: spend and command settings only the desktop window may widen.
 *
 * A project save from any other surface (a socket client, the in-process CLI / TUI) is the whole project object, so
 * it carries these fields too. This compares the incoming copy with the stored project (after the same cleaning
 * ProjectStore applies, so a junk value counts as "removed") and names every field the save would change beyond
 * narrowing. The dispatcher refuses such a save (scope_denied) before anything is stored.
 *
 * - `maxDailyUsd`, `maxMonthlyUsd`: the cap may be set where there was none, kept, or lowered; never raised or removed.
 * - `schedulesNearPlanLimit`: may be turned off or kept; never turned on.
 * - `onSpendLimit`, `requireTestsPass`, `testCommand`: never changed (a test command is a shell command the user
 *   chose in the window; a gate is not waived from a terminal; pause / stop decides what a limit does).
 * - `branchNamePattern`, `askBeforeStrongerModel`: never changed (a pattern decides which branches a later delete may
 *   treat as OrgAI's; the question gates staffing escalation). A missing flag equals false.
 *
 * - `maxAgentsPerRun`, `Role.maxConcurrent`: a cap may be set where there was none, kept, or lowered; never raised or
 *   removed. A role that carries a cap (or knowledgeWrite false) must stay in the save under its own id: removing it, or
 *   re-adding it under a new id, is refused, and so is any role with the same slug or name that lacks the limit. A role
 *   that carries no limit may be removed, and a role new in the save starts uncapped, as any new role does.
 * - `Role.knowledgeWrite`: may be set to false or kept; a stored false is never removed or turned true.
 * - `keepFailedBranchesDays`: may be raised, cleared or kept; never set where there was none or lowered (the boot sweep
 *   would delete finished copies sooner).
 * - `mainBranch`: never changed (it decides where merges land).
 *
 * Every change that only narrows what a run may do or delete stays allowed from other surfaces; every widening is refused.
 * Team files never carry any of these (teamFiles/parse.ts ignores unknown team.json keys), and the settings proposal
 * lists (PROJECT_SETTINGS_PROPOSABLE_FIELDS) do not name them. Pure.
 */
export function desktopOnlyProjectChanges(stored: Project, incoming: Project): string[] {
  const was = cleanProjectLimits(stored)
  const now = cleanProjectLimits(incoming)
  const refused: string[] = []
  if (was.maxAgentsPerRun !== undefined && (now.maxAgentsPerRun === undefined || now.maxAgentsPerRun > was.maxAgentsPerRun)) refused.push('maxAgentsPerRun')
  if (now.mainBranch !== was.mainBranch) refused.push('mainBranch')
  if (now.keepFailedBranchesDays !== undefined && (was.keepFailedBranchesDays === undefined || now.keepFailedBranchesDays < was.keepFailedBranchesDays)) {
    refused.push('keepFailedBranchesDays')
  }
  const nowRoles: Role[] = []
  for (const r of Array.isArray(incoming.roles) ? incoming.roles : []) if (r && typeof r.id === 'string') nowRoles.push(cleanRoleLimits(r))
  const key = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '')
  let concurrentWidened = false
  let knowledgeWidened = false
  for (const old of Array.isArray(stored.roles) ? stored.roles : []) {
    const before = cleanRoleLimits(old)
    const capped = before.maxConcurrent !== undefined
    const restricted = before.knowledgeWrite === false
    if (!capped && !restricted) continue
    // A role that carries a limit must stay in the save under its own id: dropping it, or dropping it and adding the same
    // role again under a new id (a fresh role starts uncapped), is how a limit would be shed from a terminal.
    // ProjectStore does not stop that (a role's id is whatever the saved copy says), so it is refused here.
    const same = nowRoles.find((r) => r.id === before.id)
    if (!same) {
      if (capped) concurrentWidened = true
      if (restricted) knowledgeWidened = true
      continue
    }
    // Every incoming role that is this role by id, slug or name must keep the limit (a second copy with the same slug
    // or name and no limit is the same bypass without removing the original).
    for (const after of nowRoles) {
      if (after.id !== before.id && key(after.slug) !== key(before.slug) && key(after.name) !== key(before.name)) continue
      if (capped && (after.maxConcurrent === undefined || after.maxConcurrent > before.maxConcurrent!)) concurrentWidened = true
      if (restricted && after.knowledgeWrite !== false) knowledgeWidened = true
    }
  }
  if (concurrentWidened) refused.push('Role.maxConcurrent')
  if (knowledgeWidened) refused.push('Role.knowledgeWrite')
  for (const key of ['maxDailyUsd', 'maxMonthlyUsd'] as const) {
    const before = was[key]
    const after = now[key]
    if (before === undefined) continue // there was no cap: setting one (or none) only narrows
    if (after === undefined || after > before) refused.push(key)
  }
  if (now.schedulesNearPlanLimit === true && was.schedulesNearPlanLimit !== true) refused.push('schedulesNearPlanLimit')
  if ((now.onSpendLimit ?? 'pause') !== (was.onSpendLimit ?? 'pause')) refused.push('onSpendLimit')
  if ((now.requireTestsPass === true) !== (was.requireTestsPass === true)) refused.push('requireTestsPass')
  if (now.testCommand !== was.testCommand) refused.push('testCommand')
  // Branch naming and the staffing question change what the user sees and what runs spend: window only, any change.
  if (now.branchNamePattern !== was.branchNamePattern) refused.push('branchNamePattern')
  if ((now.askBeforeStrongerModel === true) !== (was.askBeforeStrongerModel === true)) refused.push('askBeforeStrongerModel')
  return refused
}

/**
 * App settings only the desktop window may change: openAtLogin (registers the app with the OS), closeBehavior and
 * keepAwakeDuringRuns (change how the host stays alive) and spendWarnPercent (the spend warning). settings:set from a
 * socket client or the in-process CLI is the whole settings object, so this compares the merged result with the stored
 * settings (normalized the way SettingsStore does, so a junk value counts as "off") and names every field it would
 * change, in either direction. The other overhaul fields (playSound, the notify flags, dateFormat) are display
 * preferences and stay allowed. Pure.
 */
export function desktopOnlySettingChanges(stored: AppSettings, incoming: AppSettings): string[] {
  const refused: string[] = []
  if ((incoming.openAtLogin === true) !== (stored.openAtLogin === true)) refused.push('openAtLogin')
  if ((incoming.closeBehavior === 'keepRunning') !== (stored.closeBehavior === 'keepRunning')) refused.push('closeBehavior')
  if ((incoming.keepAwakeDuringRuns === true) !== (stored.keepAwakeDuringRuns === true)) refused.push('keepAwakeDuringRuns')
  if (normalizeSpendWarnPercent(incoming.spendWarnPercent) !== normalizeSpendWarnPercent(stored.spendWarnPercent)) refused.push('spendWarnPercent')
  return refused
}

/** The plain refusal sentence for the names desktopOnlySettingChanges returned. */
export function desktopOnlySettingMessage(fields: readonly string[]): string {
  return `These app settings can be changed in the OrgAI window only: ${fields.join(', ')}.`
}

/** The plain refusal sentence for the names desktopOnlyProjectChanges returned. */
export function desktopOnlyProjectMessage(fields: readonly string[]): string {
  return `These project settings can be changed in the OrgAI window only: ${fields.join(', ')}. Limits can be lowered from here, not raised or removed.`
}
