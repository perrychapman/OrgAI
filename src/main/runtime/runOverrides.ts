/**
 * Headless exec overrides (cli-spec 6.2(1)): the permission-mode narrowing matrix, which override fields widen a
 * project's policy (and therefore need the 'configure' scope), the effective project a run sees, the exec budget, and
 * the strict RPC-boundary builder. Pure and Electron-free.
 *
 * store/runs.ts `cleanRunOverrides` is the lenient on-read twin (bad values are dropped there, refused here); the
 * policy choice sets below must stay in step with its POLICY_CHOICES.
 */
import { MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { DEFAULT_HEADLESS_DECISION_POLICY, DEFAULT_MAX_AUTO_CONTINUES, isPermissionMode } from '@shared/types'
import type { HeadlessDecisionPolicy, PermissionMode, Project, RunOverrides } from '@shared/types'

/** Which project modes each override mode narrows (besides being equal; 'plan' narrows every mode). */
const NARROWS_FROM: Record<PermissionMode, readonly PermissionMode[] | 'any'> = {
  plan: 'any',
  dontAsk: ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
  default: ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
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

/** The override fields that widen the project's policy and so need the 'configure' scope. Empty = all narrowing. */
export function overridesWidening(project: Project, o: RunOverrides): string[] {
  const out: string[] = []
  if (o.permissionMode !== undefined && !canNarrowPermissionMode(project.permissionMode, o.permissionMode)) out.push('permissionMode')
  if (o.autoContinue === true && project.autoContinue === false) out.push('autoContinue')
  if (o.maxAutoContinues !== undefined && o.maxAutoContinues > projectMaxAutoContinues(project)) out.push('maxAutoContinues')
  // With no project budget, any override budget narrows.
  if (o.maxBudgetUsd !== undefined && project.maxBudgetUsd !== undefined && o.maxBudgetUsd > project.maxBudgetUsd) out.push('maxBudgetUsd')
  if (o.allowUnpricedBudget === true && project.maxBudgetUsd !== undefined) out.push('allowUnpricedBudget')
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
    out.maxBudgetUsd = wide || project.maxBudgetUsd === undefined ? o.maxBudgetUsd : Math.min(project.maxBudgetUsd, o.maxBudgetUsd)
  }
  return out
}

/**
 * The budget an exec run enforces: the effective project's maxBudgetUsd (0 allowed) when the run is an exec run or
 * the overrides set a budget, else undefined (a desktop run keeps the adapter's own project budget handling).
 */
export function execBudgetUsd(effective: Project, o?: RunOverrides): number | undefined {
  if (o?.execMode || o?.maxBudgetUsd !== undefined) return effective.maxBudgetUsd
  return undefined
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

function decisionPolicyArgs(raw: unknown): HeadlessDecisionPolicy {
  if (!isPlainObject(raw)) throw badRequest('overrides.decisionPolicy must be an object.')
  const out: Record<string, unknown> = {}
  for (const [key, allowed] of Object.entries(POLICY_CHOICES) as [keyof typeof POLICY_CHOICES, readonly string[]][]) {
    const value = raw[key]
    if (value === undefined) {
      out[key] = DEFAULT_HEADLESS_DECISION_POLICY[key]
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
    out[key] = value
  }
  return out as unknown as HeadlessDecisionPolicy
}

/**
 * RunOverrides from an RPC client, strictly: undefined / null = none; a non-plain object, or a known key with a wrong
 * type or out of range, throws an Error with `code: 'bad_request'`; unknown keys are dropped. A partial
 * decisionPolicy gets the missing choices from DEFAULT_HEADLESS_DECISION_POLICY. Undefined when nothing is left.
 */
export function runOverridesArgs(raw: unknown): RunOverrides | undefined {
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
  if (raw.maxAutoContinues !== undefined) {
    const v = raw.maxAutoContinues
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_AUTO_CONTINUES_LIMIT) {
      throw badRequest(`overrides.maxAutoContinues must be a whole number from 0 to ${MAX_AUTO_CONTINUES_LIMIT}.`)
    }
    out.maxAutoContinues = v
  }
  for (const key of ['maxBudgetUsd', 'execStallTimeoutMs'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (!isNonNegative(value)) throw badRequest(`overrides.${key} must be a finite number >= 0.`)
    out[key] = value
  }
  if (raw.execChainId !== undefined) {
    if (typeof raw.execChainId !== 'string' || !EXEC_CHAIN_ID_RE.test(raw.execChainId)) {
      throw badRequest('overrides.execChainId must be 1 to 100 letters, digits, "_" or "-".')
    }
    out.execChainId = raw.execChainId
  }
  if (raw.decisionPolicy !== undefined) out.decisionPolicy = decisionPolicyArgs(raw.decisionPolicy)
  return Object.keys(out).length ? out : undefined
}
