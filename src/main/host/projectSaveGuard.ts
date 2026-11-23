import type { AppSettings, Project, Role } from '@shared/types'
import { effectiveSubagentLimits } from '@shared/defaults'
import { cleanProjectLimits, cleanRoleLimits } from '../store/projects'
import { normalizeSpendWarnPercent } from '../store/settings'

/** A per-run budget as the runtime reads it: finite and above 0, else no cap (Infinity). */
const budgetCap = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : Infinity)

/**
 * UI overhaul: spend and command settings only the desktop window may widen.
 *
 * A project save from any other surface (a socket client, the in-process CLI / TUI) is the whole project object, so
 * it carries these fields too. This compares the incoming copy with the stored project (after the same cleaning
 * ProjectStore applies, so a junk value counts as "removed") and names every field the save would change beyond
 * narrowing. The dispatcher refuses such a save (scope_denied) before anything is stored.
 *
 * - `maxDailyUsd`, `maxMonthlyUsd`: the cap may be set where there was none, kept, or lowered; never raised or removed.
 * - `maxBudgetUsd` (the per-run budget): set where there was none, kept or lowered; never raised or removed (<= 0 and absent
 *   both mean no cap, so clearing counts as raising).
 * - `maxSubagentDepth`, `maxConcurrentSubagents`: an explicit stored value may be kept or lowered; never raised, and never
 *   cleared when the automatic value (from the org chart) would allow more. Setting one where there was none is allowed.
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
 * Team files carry three of the spending and agent limits: `maxBudgetUsd`, `maxSubagentDepth` and `maxConcurrentSubagents`
 * (teamFiles/parse.ts, serialize.ts). They do not go through this function: the team-file gate (teamFiles/gate.ts `loosens`,
 * compared as effective values: no budget is no cap, an unset depth or concurrency is automatic) holds any change that raises
 * one of them for the user's review in the window before it is applied, so a file in the folder cannot raise them either.
 * Every other field named here is not a team-file key (parse.ts ignores unknown team.json keys). The settings proposal list
 * (PROJECT_SETTINGS_PROPOSABLE_FIELDS) also names those three (a `maxBudgetUsd: null` removes the cap): approving such a card
 * from any surface but the window applies the same rule (SetupService.applyProposal `nonDesktop`, set by RunManager from the
 * decision's `decidedBy`), as does approving an org chart card, whose merge drops the roles it omits (a role's
 * `maxConcurrent` or `knowledgeWrite: false` cannot be shed that way), and a settings card that turns `reviewMerges` off. The
 * same rule also covers a project removed and created again (`guardedFieldsOf`) and the services that replace roles
 * (templates:apply, projects:applyImport: `widenGuard` in the dispatcher). Pure.
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
  // Project.maxBudgetUsd (the per-run budget, which every adapter now enforces): <= 0, absent and junk all mean "no cap", so a
  // stored cap may be lowered or kept, and a cap may be set where there was none; raising it or removing it is the window's.
  if (budgetCap(incoming.maxBudgetUsd) > budgetCap(stored.maxBudgetUsd)) refused.push('maxBudgetUsd')
  // An explicit subagent limit is a cap on how many reports work at once and how deep they nest: it may be lowered or kept, not
  // raised, and not cleared when automatic would allow more (effective values, as the team-file gate compares them). Setting
  // one where the project was automatic stays allowed, as it always was.
  const limitsWas = effectiveSubagentLimits({ maxSubagentDepth: stored.maxSubagentDepth, maxConcurrentSubagents: stored.maxConcurrentSubagents, roles: Array.isArray(stored.roles) ? stored.roles : [] })
  const limitsNow = effectiveSubagentLimits({ maxSubagentDepth: incoming.maxSubagentDepth, maxConcurrentSubagents: incoming.maxConcurrentSubagents, roles: Array.isArray(incoming.roles) ? incoming.roles : [] })
  if (limitsWas.explicit.depth && limitsNow.depth > limitsWas.depth) refused.push('maxSubagentDepth')
  if (limitsWas.explicit.concurrency && limitsNow.concurrency > limitsWas.concurrency) refused.push('maxConcurrentSubagents')
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
 * The guarded limits a project carries: what removing it and creating a project at the same folder would shed (a new project
 * starts with none). Read by comparing the project with a copy that has every guarded field cleared and every role's limit
 * dropped, through the same rule a save follows, so it names exactly the fields desktopOnlyProjectChanges guards (a spending
 * cap or an agent cap, a role's cap or restriction, the test gate, the main branch, the spend-limit action ...). Empty for a
 * project that carries none. `keepFailedBranchesDays` is deliberately not counted: a new project starts without it, which keeps
 * finished copies longer (the rule above allows clearing it), so removing a project for it sheds no protection. Pure.
 */
export function guardedFieldsOf(project: Project): string[] {
  const {
    maxBudgetUsd: _b,
    maxDailyUsd: _d,
    maxMonthlyUsd: _m,
    maxAgentsPerRun: _a,
    maxSubagentDepth: _depth,
    maxConcurrentSubagents: _conc,
    onSpendLimit: _s,
    requireTestsPass: _t,
    testCommand: _c,
    mainBranch: _mb,
    branchNamePattern: _bp,
    askBeforeStrongerModel: _q,
    schedulesNearPlanLimit: _n,
    ...rest
  } = project
  void [_b, _d, _m, _a, _depth, _conc, _s, _t, _c, _mb, _bp, _q, _n]
  const roles = (Array.isArray(project.roles) ? project.roles : []).map((r) => {
    const { maxConcurrent: _mc, knowledgeWrite: _kw, ...kept } = r
    void [_mc, _kw]
    return kept
  })
  return desktopOnlyProjectChanges(project, { ...rest, roles })
}

/** The plain refusal sentence when a non-desktop surface removes a project that carries limits. */
export function removeCarriedMessage(fields: readonly string[]): string {
  return `This project carries limits (${fields.join(', ')}), so it can be removed in the OrgAI window only: removing it and creating it again would start it without them.`
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
