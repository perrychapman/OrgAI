/**
 * Headless exec overrides (cli-spec 6.2(1)): the permission-mode narrowing matrix, which override fields widen a
 * project's policy (and therefore need the 'configure' scope), the effective project a run sees, the exec budget, and
 * the strict RPC-boundary builder. Pure and Electron-free.
 *
 * store/runs.ts `cleanRunOverrides` is the lenient on-read twin (bad values are dropped there, refused here); the
 * policy choice sets below must stay in step with its POLICY_CHOICES.
 */
import { MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { DEFAULT_HEADLESS_DECISION_POLICY, DEFAULT_MAX_AUTO_CONTINUES, MAX_TIMER_DELAY_MS, STAFFING_GOALS, isPermissionMode, isStaffingGoal } from '@shared/types'
import type { HeadlessDecisionPolicy, PermissionMode, Project, RunOverrides } from '@shared/types'

/**
 * Which project modes each override mode narrows (besides being equal; 'plan' narrows every mode). 'default' does NOT
 * narrow 'dontAsk' (review M1): "never ask" denies anything not pre-approved, while 'default' asks, and an operate
 * client that can answer its own cards could then approve what the project denies. Moving a dontAsk project to
 * 'default' therefore needs 'configure'.
 */
const NARROWS_FROM: Record<PermissionMode, readonly PermissionMode[] | 'any'> = {
  plan: 'any',
  dontAsk: ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
  default: ['acceptEdits', 'auto', 'bypassPermissions'],
  acceptEdits: ['auto', 'bypassPermissions'],
  auto: ['bypassPermissions'],
  bypassPermissions: []
}

/** True when `overrideMode` is no more permissive than `projectMode` (spec 6.2(1) matrix). */
export function canNarrowPermissionMode(projectMode: PermissionMode, overrideMode: PermissionMode): boolean {
  if (overrideMode === projectMode) return true
  const from = NARROWS_FROM[overrideMode]
  if (!from) return false
  return from === 'any' || from.includes(projectMode)
}

const projectMaxAutoContinues = (project: Project): number => project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES

/**
 * A project's own spend cap: a stored value <= 0 (or not finite) means no cap, as it always did for desktop runs (the
 * Limits field can store 0 for "No cap"). Only an override budget of 0 is a real $0 budget.
 */
export function projectBudgetUsd(project: Pick<Project, 'maxBudgetUsd'>): number | undefined {
  const v = project.maxBudgetUsd
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** The override fields that widen the project's policy and so need the 'configure' scope. Empty = all narrowing. */
export function overridesWidening(project: Project, o: RunOverrides): string[] {
  const out: string[] = []
  if (o.permissionMode !== undefined && !canNarrowPermissionMode(project.permissionMode, o.permissionMode)) out.push('permissionMode')
  if (o.autoContinue === true && project.autoContinue === false) out.push('autoContinue')
  if (o.maxAutoContinues !== undefined && o.maxAutoContinues > projectMaxAutoContinues(project)) out.push('maxAutoContinues')
  // With no project budget, any override budget narrows.
  const budget = projectBudgetUsd(project)
  if (o.maxBudgetUsd !== undefined && budget !== undefined && o.maxBudgetUsd > budget) out.push('maxBudgetUsd')
  if (o.allowUnpricedBudget === true && budget !== undefined) out.push('allowUnpricedBudget')
  if (o.allowPeerMessages === true) out.push('allowPeerMessages')
  return out
}

/**
 * The project a run sees: a shallow copy with permissionMode, autoContinue, maxAutoContinues and maxBudgetUsd taken
 * from `o`. Without `allowWidening` a widening value is ignored and the project's value kept, so calling it again on a
 * tightened project re-clamps; maxBudgetUsd is then the lower of both when both are set. With `allowWidening` (the
 * caller holds 'configure') the override wins.
 */
export function effectiveRunProject(project: Project, o: RunOverrides | undefined, opts: { allowWidening?: boolean } = {}): Project {
  const out: Project = { ...project }
  // A stored cap <= 0 is "no cap" (projectBudgetUsd).
  const budget = projectBudgetUsd(project)
  if (budget === undefined) delete out.maxBudgetUsd
  if (!o) return out
  const wide = opts.allowWidening === true
  if (o.permissionMode !== undefined && (wide || canNarrowPermissionMode(project.permissionMode, o.permissionMode))) {
    out.permissionMode = o.permissionMode
  }
  if (o.autoContinue !== undefined && (wide || !(o.autoContinue && project.autoContinue === false))) out.autoContinue = o.autoContinue
  if (o.maxAutoContinues !== undefined && (wide || o.maxAutoContinues <= projectMaxAutoContinues(project))) {
    out.maxAutoContinues = o.maxAutoContinues
  }
  if (o.maxBudgetUsd !== undefined) {
    out.maxBudgetUsd = wide || budget === undefined ? o.maxBudgetUsd : Math.min(budget, o.maxBudgetUsd)
  }
  return out
}

/**
 * The budget an exec run enforces: the effective project's maxBudgetUsd (0 allowed) when the run is an exec run or
 * the overrides set a budget, else undefined (a desktop run keeps the adapter's own project budget handling).
 */
export function execBudgetUsd(effective: Project, o?: RunOverrides): number | undefined {
  if (o?.maxBudgetUsd !== undefined) return effective.maxBudgetUsd
  if (o?.execMode) return projectBudgetUsd(effective)
  return undefined
}

/**
 * The overrides with every `wait` decision choice turned into `fail` (cli-standalone-default.md 4.3). A host whose cards
 * only this process could answer (the orgai command's own host) has nobody to wait for, so a policy that waits would hang
 * until its timeout; this holds for any path that reaches the host, not only the exec flag parser. Returns `o` itself
 * when nothing waits.
 */
export function withoutWaitPolicy(o: RunOverrides): RunOverrides {
  const policy = o.decisionPolicy
  if (!policy || !Object.values(policy).includes('wait')) return o
  const out: Record<string, unknown> = { ...policy }
  for (const [k, v] of Object.entries(out)) if (v === 'wait') out[k] = 'fail'
  return { ...o, decisionPolicy: out as unknown as HeadlessDecisionPolicy }
}

// ---------- RPC-boundary builder ----------

const POLICY_CHOICES = {
  permission: ['deny', 'fail', 'wait'],
  rules: ['deny', 'fail', 'wait'],
  mcpInstall: ['deny', 'fail', 'wait'],
  question: ['fail', 'conservative', 'wait'],
  proposal: ['decline', 'fail', 'wait'],
  merge: ['hold', 'fail', 'wait']
} as const satisfies { [K in keyof HeadlessDecisionPolicy]?: readonly string[] }

const POLICY_COUNTS = ['maxAutoDenials', 'waitTimeoutMs', 'humanGraceMs'] as const

const EXEC_CHAIN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad_request' as const })
}

function decisionPolicyArgs(raw: unknown, partial: boolean): HeadlessDecisionPolicy {
  if (!isPlainObject(raw)) throw badRequest('overrides.decisionPolicy must be an object.')
  const out: Record<string, unknown> = {}
  for (const [key, allowed] of Object.entries(POLICY_CHOICES) as [keyof typeof POLICY_CHOICES, readonly string[]][]) {
    const value = raw[key]
    if (value === undefined) {
      if (!partial) out[key] = DEFAULT_HEADLESS_DECISION_POLICY[key]
      continue
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw badRequest(`overrides.decisionPolicy.${key} must be one of ${allowed.join(', ')}.`)
    }
    out[key] = value
  }
  for (const key of POLICY_COUNTS) {
    const value = raw[key]
    if (value === undefined) continue
    if (!isNonNegative(value) || (key === 'maxAutoDenials' && !Number.isInteger(value))) {
      throw badRequest(`overrides.decisionPolicy.${key} must be a ${key === 'maxAutoDenials' ? 'whole ' : ''}number >= 0.`)
    }
    // A longer timer would fire after 1 ms (setTimeout's limit).
    if (key !== 'maxAutoDenials' && value > MAX_TIMER_DELAY_MS) throw badRequest(`overrides.decisionPolicy.${key} must be at most ${MAX_TIMER_DELAY_MS} ms.`)
    out[key] = value
  }
  return out as unknown as HeadlessDecisionPolicy
}

/**
 * RunOverrides from an RPC client, strictly: undefined / null = none; a non-plain object, or a known key with a wrong
 * type or out of range, throws an Error with `code: 'bad_request'`; unknown keys are dropped. A partial
 * decisionPolicy gets the missing choices from DEFAULT_HEADLESS_DECISION_POLICY, except with `partialPolicy` (runs:continue:
 * RunManager's continuedOverrides merges the given fields over the chain's policy and fills the rest itself). Undefined
 * when nothing is left.
 */
export function runOverridesArgs(raw: unknown, opts: { partialPolicy?: boolean } = {}): RunOverrides | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) throw badRequest('overrides must be an object.')
  const out: RunOverrides = {}
  if (raw.permissionMode !== undefined) {
    if (!isPermissionMode(raw.permissionMode)) throw badRequest('overrides.permissionMode is not a permission mode.')
    out.permissionMode = raw.permissionMode
  }
  for (const key of ['autoContinue', 'allowUnpricedBudget', 'allowUnmerged', 'allowPeerMessages', 'execMode', 'waitForReset'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw badRequest(`overrides.${key} must be true or false.`)
    out[key] = value
  }
  // Only adds requirements, so every scope may set it (no overridesWidening rule); exactly true or absent.
  if (raw.strictDelegation !== undefined) {
    if (raw.strictDelegation !== true) throw badRequest('overrides.strictDelegation must be true.')
    out.strictDelegation = true
  }
  // Run staffing goal: never widens (picks stay inside the roles' ceilings), so every scope may set it.
  if (raw.goal !== undefined) {
    if (!isStaffingGoal(raw.goal)) throw badRequest(`overrides.goal must be one of ${STAFFING_GOALS.join(', ')}.`)
    out.goal = raw.goal
  }
  if (raw.maxAutoContinues !== undefined) {
    const v = raw.maxAutoContinues
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_AUTO_CONTINUES_LIMIT) {
      throw badRequest(`overrides.maxAutoContinues must be a whole number from 0 to ${MAX_AUTO_CONTINUES_LIMIT}.`)
    }
    out.maxAutoContinues = v
  }
  if (raw.maxBudgetUsd !== undefined) {
    if (!isNonNegative(raw.maxBudgetUsd)) throw badRequest('overrides.maxBudgetUsd must be a finite number >= 0.')
    out.maxBudgetUsd = raw.maxBudgetUsd
  }
  // 0 would end every exec run as 'stalled' at its first turn end (the CLI refuses it too).
  if (raw.execStallTimeoutMs !== undefined) {
    const v = raw.execStallTimeoutMs
    if (!isNonNegative(v) || v <= 0) throw badRequest('overrides.execStallTimeoutMs must be a finite number > 0.')
    if (v > MAX_TIMER_DELAY_MS) throw badRequest(`overrides.execStallTimeoutMs must be at most ${MAX_TIMER_DELAY_MS} ms.`)
    out.execStallTimeoutMs = v
  }
  if (raw.execChainId !== undefined) {
    if (typeof raw.execChainId !== 'string' || !EXEC_CHAIN_ID_RE.test(raw.execChainId)) {
      throw badRequest('overrides.execChainId must be 1 to 100 letters, digits, "_" or "-".')
    }
    out.execChainId = raw.execChainId
  }
  if (raw.decisionPolicy !== undefined) out.decisionPolicy = decisionPolicyArgs(raw.decisionPolicy, opts.partialPolicy === true)
  return Object.keys(out).length ? out : undefined
}
