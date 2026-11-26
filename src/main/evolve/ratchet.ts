import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, cleanRoleStaffing, compareEffort, compareTier, settingTier, tierForModel } from '../../shared/defaults'
import { enforcedStaffingFloor } from '../runtime/staffing'
import { EFFORTS, MODEL_TIERS, SKILL_MAX_PER_PROJECT, TOOL_CATALOG } from '../../shared/types'
import type {
  Effort,
  EvolutionGateViolation,
  EvolutionGeneration,
  EvolutionHistory,
  EvolutionMetrics,
  EvolutionPlan,
  EvolutionRejectedHypothesis,
  EvolutionRolePatch,
  EvolutionSkillPatch,
  ModelTier,
  Project,
  Role,
  RoleStaffing,
  TeamEvolutionDiagnosis,
  ToolName
} from '../../shared/types'
import { writeFileDurable } from '../store/durableFs'
import { redactEvidence } from '../skills/suggest'
import { draftProblem } from '../skills/skillMd'
import {
  MAX_CONCURRENCY_RAISE,
  MAX_EVOLVED_SKILL_BODY,
  MAX_PATCH_PROMPT_CHARS,
  MAX_PLAN_SKILLS,
  MIN_RUNS_FOR_WRITER_FAST,
  compressPrompt,
  PROMPT_BUDGET_PER_ROLE,
  SAFE_ADD_TOOLS,
  WRITE_EXEC_TOOLS,
  applyPlan,
  effectiveConcurrency,
  effectiveTier,
  isFixedRole,
  isPlanEmpty,
  isReviewRole,
  isGuardRole,
  isWriterRole,
  managedBlockEdited,
  patchFingerprint,
  planFingerprint,
  stepEffort,
  stepTier,
  totalPromptChars,
  tierMoves,
  touchedFields,
  upsertScopeBlock,
  type PatchedField
} from './plan'
import { isAdvisoryFinding, isFailedExecOutcome, isInterruptedTrialRun, isMeasuredRun, isTrialRun, measure, type RunLike } from './telemetry'
import { asDigest, digestKey, type DigestAgent, type RunDigest } from '../store/runDigest'

/**
 * The safety gate and the ledger of the Pareto-Ratchet. The gate is a spend and security boundary: it fails closed, it
 * rebuilds the plan field by field (nothing it does not know survives) and every rule has a test with a violating plan.
 */

// ---------- safety gate -------------------------------------------------------------------------------------------------

export interface GateOptions {
  /** Rejected hypotheses: a plan or a patch with one of these fingerprints is refused / trimmed. */
  rejected?: readonly Pick<EvolutionRejectedHypothesis, 'fingerprint'>[]
  /** The diagnosis behind the plan: only roles with a tier_underprovisioned finding may be raised. Absent = no raises. */
  diagnosis?: Pick<TeamEvolutionDiagnosis, 'findings'> & { metrics?: Pick<EvolutionMetrics, 'runs'> }
  /** Roles patched in either of the last two decided generations: no new patch for them (anti-oscillation). */
  cooldownSlugs?: readonly string[]
  /** Keep only the first role patch (rule 'one_patch_per_generation'). The evolve service sets it for every plan it makes or applies. */
  onePatchPerGeneration?: boolean
  /**
   * Drop the sizing part of a patch that lowers a role with reports (rule 'cut_on_lead'). Such a cut acts on its reports
   * through retries the run record does not attribute to it, so a trial cannot judge it. The evolve service sets it.
   */
  noCutsOnLeads?: boolean
}

/** Plan or patch keys that would widen access or spend. Their presence rejects the whole plan. */
const FORBIDDEN_KEYS = ['permissionMode', 'folderConfigTrust', 'allowedDirectories', 'referenceDirectories', 'mcpServers', 'connection', 'provider', 'maxBudgetUsd', 'isolateWriters', 'requiredReports', 'spawnable', 'reportsTo', 'canSpawn', 'model']

const finiteNonNeg = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined)
const cap = (s: unknown, n: number): string => {
  const t = redactEvidence(typeof s === 'string' ? s : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const isTier = (v: unknown): v is ModelTier => typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v)
const isEff = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
const isTool = (v: unknown): v is ToolName => typeof v === 'string' && (TOOL_CATALOG as readonly string[]).includes(v)
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const currentTier = (r: Role): ModelTier | undefined => effectiveTier(r)

/** True when a prompt carries a secret-shaped token the old prompt did not. */
const introducesSecret = (next: string, prev: string): boolean => redactEvidence(next) !== next && redactEvidence(prev) === prev

/**
 * Problems an applied chart would have against the one before it (everything a plan must leave alone): required reports,
 * the reporting graph, tool-independent grants, connections, and the project's permissions and trust. Empty = intact.
 */
export function chartProblems(before: Project, after: Project): EvolutionGateViolation[] {
  const out: EvolutionGateViolation[] = []
  const v = (rule: string, message: string, roleSlug?: string): void => {
    out.push({ rule, message, action: 'rejected', ...(roleSlug ? { roleSlug } : {}) })
  }
  for (const k of ['permissionMode', 'folderConfigTrust', 'allowedDirectories', 'referenceDirectories', 'mcpServers', 'provider', 'maxBudgetUsd', 'isolateWriters', 'reviewMerges', 'kind', 'path'] as const) {
    if (!equal(before[k], after[k])) v('permission_widened', `${k} must not change in an evolution`)
  }
  const prev = new Map(before.roles.map((r) => [r.id, r]))
  if (after.roles.length !== before.roles.length) v('chart_broken', 'a role was added or removed')
  for (const r of after.roles) {
    const p = prev.get(r.id)
    if (!p) {
      v('chart_broken', `role ${r.slug} is not in the chart before`, r.slug)
      continue
    }
    if (!equal(p.requiredReports, r.requiredReports)) v('required_reports_dropped', `requiredReports of ${r.slug} changed`, r.slug)
    for (const k of ['spawnable', 'reportsTo', 'canSpawn', 'slug', 'name', 'position'] as const) if (!equal(p[k], r[k])) v('chart_broken', `${k} of ${r.slug} changed`, r.slug)
    if (!equal(p.connection, r.connection)) v('connection_changed', `connection of ${r.slug} changed`, r.slug)
    if (!equal(p.mcpServers, r.mcpServers)) v('mcp_widened', `MCP grants of ${r.slug} changed`, r.slug)
  }
  if (!after.roles.some((r) => r.reportsTo === null)) v('chart_broken', 'the chart has no root')
  const ids = new Map(after.roles.map((r) => [r.id, r]))
  for (const r of after.roles) {
    const seen = new Set<string>()
    let cur: Role | undefined = r
    while (cur && cur.reportsTo !== null) {
      if (seen.has(cur.id)) {
        v('chart_broken', `reportsTo cycle through ${r.slug}`, r.slug)
        break
      }
      seen.add(cur.id)
      cur = ids.get(cur.reportsTo)
    }
  }
  return out
}

/**
 * Validate a plan against the project it would change. Returns a NEW plan rebuilt from known fields only, with `gate`,
 * `promptChars`, `fingerprint` and `empty` filled. A violation is either 'trimmed' (the part is dropped, the rest kept) or
 * 'rejected' (`gate.ok` false: callers must not apply). Pure.
 */
export function validateEvolutionPlan(project: Project, plan: EvolutionPlan, opts: GateOptions = {}): EvolutionPlan {
  const violations: EvolutionGateViolation[] = []
  const trim = (rule: string, message: string, roleSlug?: string): void => {
    violations.push({ rule, message, action: 'trimmed', ...(roleSlug ? { roleSlug } : {}) })
  }
  const reject = (rule: string, message: string, roleSlug?: string): void => {
    violations.push({ rule, message, action: 'rejected', ...(roleSlug ? { roleSlug } : {}) })
  }
  const rejected = new Set((opts.rejected ?? []).map((r) => r.fingerprint))
  const underSlugs = new Set((opts.diagnosis?.findings ?? []).filter((f) => f.kind === 'tier_underprovisioned' && f.roleSlug).map((f) => f.roleSlug as string))
  const findings = opts.diagnosis?.findings ?? []
  const cooling = new Set(opts.cooldownSlugs ?? [])
  // An advisory finding (isAdvisoryFinding: unused_role, ceremonial_layer, spawner_step_work, skill_crystallization, an
  // exploration-only tier_overprovisioned) explains but never justifies a patch: it never lets tools go.
  const withFinding = new Set(findings.filter((f) => f.roleSlug && !isAdvisoryFinding(f)).map((f) => f.roleSlug as string))
  const listed = (kind: 'neverLoaded' | 'overlapping'): Set<string> => new Set(findings.flatMap((f) => (f.kind === 'prompt_deflation' && typeof f.data?.[kind] === 'string' ? String(f.data[kind]).split(',').filter(Boolean) : [])))
  const unusedSkills = new Set([...listed('neverLoaded'), ...listed('overlapping')])
  const throttle = findings.find((f) => f.kind === 'serial_bottleneck' && Number(f.data?.limitThrottled) === 1)
  const roles = new Map(project.roles.map((r) => [r.slug, r]))
  const raw = plan as unknown as Record<string, unknown>
  for (const k of FORBIDDEN_KEYS) if (k in raw) reject(k === 'permissionMode' || k === 'folderConfigTrust' ? 'permission_widened' : 'forbidden_field', `a plan may not carry ${k}`)

  // ---- role patches
  const patches: EvolutionRolePatch[] = []
  const seenSlugs = new Set<string>()
  for (const p0 of (Array.isArray(plan.rolePatches) ? plan.rolePatches : []).slice(0, 50)) {
    const rawPatch = (p0 ?? {}) as unknown as Record<string, unknown>
    const slug = typeof rawPatch.slug === 'string' ? rawPatch.slug : ''
    const role = roles.get(slug)
    if (!role) {
      trim('unknown_role', `no role "${cap(slug, 60)}"`)
      continue
    }
    if (seenSlugs.has(slug)) {
      trim('duplicate_patch', `a second patch for ${slug} was dropped`, slug)
      continue
    }
    seenSlugs.add(slug)
    if (cooling.has(slug)) {
      trim('role_cooldown', `${slug} was changed in a recent generation; it is left alone for now`, slug)
      continue
    }
    for (const k of FORBIDDEN_KEYS) if (k in rawPatch) reject(k === 'permissionMode' ? 'permission_widened' : k === 'connection' ? 'connection_changed' : k === 'mcpServers' ? 'mcp_widened' : k === 'requiredReports' ? 'required_reports_dropped' : 'forbidden_field', `a patch may not carry ${k}`, slug)
    const out: EvolutionRolePatch = { slug, reason: cap(rawPatch.reason, 240) }
    const under = underSlugs.has(slug)
    const cur = currentTier(role)
    const curEffort: Effort = role.effort ?? 'medium'
    // A role the user fixed runs as configured: its tier, effort and staffing bounds are never an evolution's to change.
    const fixed = isFixedRole(project, role)
    if (fixed && (rawPatch.tier !== undefined || rawPatch.effort !== undefined || rawPatch.staffing !== undefined)) trim('staffing_fixed', `${slug} has fixed staffing, so its tier, effort and staffing stay as configured`, slug)
    // A value only the user sets (tier top, effort xhigh / max, as the role's own or a staffing bound) is never moved by an
    // evolution: a rollback never restores it (restoreSnapshot), so such a cut could not be undone.
    const userOnly = cur === 'top' || role.tier === 'top' || settingTier(role.model ?? '') === 'top' || role.effort === 'xhigh' || role.effort === 'max' || role.staffing?.minTier === 'top' || role.staffing?.maxEffort === 'xhigh' || role.staffing?.maxEffort === 'max'

    const overFinding = findings.find((f) => f.kind === 'tier_overprovisioned' && f.roleSlug === slug)
    const roleRuns = overFinding?.data?.runs !== undefined ? Number(overFinding.data.runs) : opts.diagnosis?.metrics?.runs
    const thinWriter = isWriterRole(role) && (overFinding?.exploration !== undefined || (roleRuns !== undefined && roleRuns < MIN_RUNS_FOR_WRITER_FAST))

    if (!fixed && userOnly && (rawPatch.tier !== undefined || rawPatch.effort !== undefined || rawPatch.staffing !== undefined)) trim('user_only_value', `${slug} holds a value only you set (tier top, effort xhigh or max), so its tier, effort and staffing stay as they are`, slug)
    else if (!fixed && rawPatch.tier !== undefined) {
      const t = rawPatch.tier
      if (t === 'top') trim('tier_top', `tier "top" is never set by an evolution`, slug)
      else if (!isTier(t)) trim('tier_invalid', `unknown tier`, slug)
      else if (!cur) trim('tier_unknown_base', `${slug} has no known tier to change from`, slug)
      else if (t === cur) {
        // no-op
      } else if (!tierMoves(project, role)) trim('tier_no_effect', `${slug} runs on a concrete model, so a tier change would not change what it runs on`, slug)
      else if (compareTier(t, cur) > 0) {
        if (under && t === stepTier(cur, 1)) out.tier = t
        else trim('tier_raise', `${slug} may be raised only by one step and only when it is under-provisioned`, slug)
      } else if (t === 'fast' && thinWriter) {
        trim('tier_fast_thin_evidence', `${slug} edits files and needs at least ${MIN_RUNS_FOR_WRITER_FAST} measured runs before dropping to "fast"`, slug)
      } else out.tier = t
    }
    if (!fixed && !userOnly && rawPatch.effort !== undefined) {
      const e = rawPatch.effort
      if (e === 'xhigh' || e === 'max') trim('effort_xhigh', `effort "${e}" is never set by an evolution`, slug)
      else if (!isEff(e)) trim('effort_invalid', 'unknown effort', slug)
      else if (e === role.effort) {
        // no-op
      } else if (compareEffort(e, curEffort) > 0) {
        if (under && e === stepEffort(curEffort, 1)) out.effort = e
        else trim('effort_raise', `${slug} may raise effort only by one step and only when under-provisioned`, slug)
      } else if (e === 'low' && thinWriter) {
        trim('effort_low_thin_evidence', `${slug} edits files and needs at least ${MIN_RUNS_FOR_WRITER_FAST} measured runs before dropping effort to "low"`, slug)
      } else out.effort = e
    }
    // The effort ceiling automatic staffing uses for the role today (staffing.ts: staffing.maxEffort, else the role's
    // effort, else high).
    const curMax: Effort = role.staffing?.maxEffort ?? role.effort ?? 'high'
    const curFloor = role.staffing?.minTier
    // The floor staffing enforces today (effectiveRoleStaffing drops a floor above the role's tier): a raise is measured
    // against this, so a floor the runtime ignored is never switched on by a patch.
    const effFloor = enforcedStaffingFloor(role, project)
    /** A floor raise this patch proposed explicitly and the gate accepted (with an under-provisioned finding). */
    let floorRaised = false
    if (!fixed && !userOnly && rawPatch.staffing !== undefined) {
      const s = (rawPatch.staffing ?? {}) as Record<string, unknown>
      const curMode = role.staffing?.mode ?? 'auto'
      // Start from the role's own bounds: a field that is trimmed keeps its current value, never drops it.
      const next: RoleStaffing = { mode: curMode, ...(curFloor ? { minTier: curFloor } : {}), ...(role.staffing?.maxEffort ? { maxEffort: role.staffing.maxEffort } : {}) }
      if (s.mode !== undefined && s.mode !== curMode) trim('staffing_mode_changed', 'staffing mode is not changed by an evolution', slug)
      const ceiling = out.tier ?? cur
      if (s.minTier !== undefined) {
        if (s.minTier === 'top') trim('tier_top', 'staffing floor "top" is never set', slug)
        else if (!isTier(s.minTier)) trim('tier_invalid', 'unknown minTier', slug)
        else if (!ceiling) trim('tier_unknown_base', `${slug} has no known tier, so its staffing floor stays as it is`, slug)
        else if (compareTier(s.minTier, ceiling) > 0) trim('tier_raise', 'staffing floor above the role tier', slug)
        else if (compareTier(s.minTier, effFloor ?? 'fast') > 0 && !under) trim('tier_raise', 'staffing floor raised without an under-provisioned finding', slug)
        else {
          next.minTier = s.minTier
          if (compareTier(s.minTier, effFloor ?? 'fast') > 0) floorRaised = true
        }
      }
      if (s.maxEffort !== undefined) {
        if (s.maxEffort === 'xhigh' || s.maxEffort === 'max') trim('effort_xhigh', 'staffing maxEffort "xhigh"/"max" is never set', slug)
        else if (!isEff(s.maxEffort)) trim('effort_invalid', 'unknown maxEffort', slug)
        else if (compareEffort(s.maxEffort, curMax) > 0 && (!under || s.maxEffort !== stepEffort(curMax, 1))) trim('effort_raise', 'staffing maxEffort may rise only one step and only with an under-provisioned finding', slug)
        else if (s.maxEffort === 'low' && thinWriter) trim('effort_low_thin_evidence', `${slug} edits files and needs at least ${MIN_RUNS_FOR_WRITER_FAST} measured runs before capping effort at "low"`, slug)
        else next.maxEffort = s.maxEffort
      }
      if (next.minTier !== curFloor || next.maxEffort !== role.staffing?.maxEffort) out.staffing = next
    }
    // Spend rises by one step on one field per role: a second raise in the same patch is dropped (tier first, then
    // effort, then the staffing floor, then the effort ceiling).
    const raises: ('tier' | 'effort' | 'floor' | 'ceiling')[] = []
    if (out.tier !== undefined && cur && compareTier(out.tier, cur) > 0) raises.push('tier')
    if (out.effort !== undefined && compareEffort(out.effort, curEffort) > 0) raises.push('effort')
    // Only a floor this patch raised explicitly counts; a stored floor carried along is never a raise (nor an exemption).
    if (floorRaised && out.staffing?.minTier && compareTier(out.staffing.minTier, effFloor ?? 'fast') > 0) raises.push('floor')
    if (out.staffing?.maxEffort && compareEffort(out.staffing.maxEffort, curMax) > 0) raises.push('ceiling')
    for (const extra of raises.slice(1)) {
      trim('one_raise_per_role', `${slug} may rise on one of tier, effort or staffing per generation; the ${extra} raise was dropped`, slug)
      if (extra === 'effort') delete out.effort
      else if (out.staffing) {
        const st: RoleStaffing = { ...out.staffing }
        if (extra === 'floor') {
          if (curFloor) st.minTier = curFloor
          else delete st.minTier
        } else if (role.staffing?.maxEffort) st.maxEffort = role.staffing.maxEffort
        else delete st.maxEffort
        if (st.minTier === curFloor && st.maxEffort === role.staffing?.maxEffort) delete out.staffing
        else out.staffing = st
      }
    }
    // A lower tier never leaves the staffing floor above it (effectiveRoleStaffing would drop such a floor silently), and
    // the adjusted floor is never above the one staffing enforced before: the enforced floor, capped at the new tier, or
    // none when none was enforced.
    if (out.tier !== undefined) {
      const floor = (out.staffing ?? role.staffing)?.minTier
      if (floor && compareTier(floor, out.tier) > 0) {
        const st: RoleStaffing = { ...(out.staffing ?? role.staffing ?? { mode: 'auto' }) }
        if (!effFloor) delete st.minTier
        else st.minTier = compareTier(effFloor, out.tier) > 0 ? out.tier : effFloor
        out.staffing = st
      }
    }
    // Whatever the patch does to tier, model and staffing, the floor staffing enforces afterwards (effectiveRoleStaffing of
    // the patched role) may not exceed the one it enforced before, unless the floor raise is this role's one allowed raise.
    // A stored floor the runtime ignored (above the old tier) is otherwise switched on by any tier change that reaches it.
    if ((out.tier !== undefined || out.staffing) && raises[0] !== 'floor') {
      const floorAfter = (o: EvolutionRolePatch): ModelTier | undefined => enforcedStaffingFloor(applyPlan({ ...project, roles: [role] }, { rolePatches: [o] }).roles[0], project)
      const raised = (f: ModelTier | undefined): boolean => !!f && compareTier(f, effFloor ?? 'fast') > 0
      if (raised(floorAfter(out))) {
        const st: RoleStaffing = { ...(out.staffing ?? role.staffing ?? { mode: 'auto' }) }
        if (effFloor) st.minTier = effFloor
        else delete st.minTier
        if (equal(st, role.staffing)) delete out.staffing
        else out.staffing = st
        trim('floor_not_raised', `${slug}: the staffing floor stays at the one enforced before (${effFloor ?? 'none'})`, slug)
      }
    }
    const adds: ToolName[] = []
    for (const t of Array.isArray(rawPatch.addTools) ? rawPatch.addTools : []) {
      if (!isTool(t)) {
        trim('tool_unknown', `unknown tool`, slug)
      } else if (WRITE_EXEC_TOOLS.has(t)) {
        const hasWrite = role.tools.some((x) => WRITE_EXEC_TOOLS.has(x))
        reject(isReviewRole(role) ? 'write_tool_to_review' : hasWrite ? 'write_tool_added' : 'write_tool_to_readonly', `${t} is never added to ${slug}`, slug)
      } else if (!SAFE_ADD_TOOLS.has(t)) trim('tool_not_safe', `${t} is not a tool an evolution may add`, slug)
      else if (!role.tools.includes(t) && !adds.includes(t)) adds.push(t)
    }
    if (adds.length) out.addTools = adds
    const isRootRole = role.reportsTo === null
    const guard = isGuardRole(role, project.roles)
    const protectedRole = isRootRole || guard
    let drops = (Array.isArray(rawPatch.removeTools) ? rawPatch.removeTools : []).filter((t): t is ToolName => isTool(t) && role.tools.includes(t) && !adds.includes(t))
    if (drops.length && protectedRole) {
      trim('tool_removal_protected', `tools are never removed from ${slug} (root or checking role)`, slug)
      drops = []
    } else if (drops.length && !withFinding.has(slug)) {
      trim('tool_removal_unjustified', `no finding names ${slug}, so its tools stay`, slug)
      drops = []
    }
    const READ = ['Read', 'Glob', 'Grep'] as const
    if (drops.length) {
      const left = role.tools.filter((t) => !drops.includes(t))
      if (role.tools.some((t) => (READ as readonly string[]).includes(t)) && !left.some((t) => (READ as readonly string[]).includes(t)) && !adds.some((t) => (READ as readonly string[]).includes(t))) {
        trim('last_read_tool', `${slug} keeps at least one read tool`, slug)
        drops = []
      }
    }
    if (drops.length) out.removeTools = [...new Set(drops)]
    const rs = (Array.isArray(rawPatch.removeSkills) ? rawPatch.removeSkills : []).filter((id): id is string => typeof id === 'string' && !!role.skills?.includes(id))
    let rsOk = rs.filter((id) => unusedSkills.has(id))
    if (rsOk.length !== rs.length) trim('skill_removal_unjustified', 'a grant was removed without a never-loaded or overlap finding', slug)
    // Like tools: the root and a checking role keep their skill grants (an audit skill is often loaded rarely on purpose).
    if (rsOk.length && protectedRole) {
      trim('skill_removal_protected', `skill grants are never removed from ${slug} (root or checking role)`, slug)
      rsOk = []
    }
    if (rsOk.length) out.removeSkills = [...new Set(rsOk)]
    // A role with reports is never cut on a plan the service makes: the harm of a lead too weak for its reports shows up
    // as their retries, which no trial of a few runs can see (the bench: large-chart lead cuts promoted on windows with no
    // failed step). The whole sizing part goes (a raise riding with it is dropped too; it is held unattended anyway).
    if (opts.noCutsOnLeads && project.roles.some((r) => r.reportsTo === role.id)) {
      const lowers =
        (out.tier !== undefined && !!cur && compareTier(out.tier, cur) < 0) ||
        (out.effort !== undefined && compareEffort(out.effort, curEffort) < 0) ||
        (!!out.staffing?.maxEffort && compareEffort(out.staffing.maxEffort, curMax) < 0) ||
        (!!out.staffing && !!curFloor && (!out.staffing.minTier || compareTier(out.staffing.minTier, curFloor) < 0))
      if (lowers) {
        delete out.tier
        delete out.effort
        delete out.staffing
        trim('cut_on_lead', `${slug} has reports: a cut would act on them in ways a trial cannot measure, so its tier, effort and staffing stay; change them yourself if you agree`, slug)
      }
    }
    if (rawPatch.prompt !== undefined) {
      const pr = rawPatch.prompt
      if (typeof pr !== 'string' || !pr.trim()) trim('prompt_empty', 'an empty prompt is never set', slug)
      else if (pr.length > MAX_PATCH_PROMPT_CHARS || pr.includes('\0')) trim('prompt_invalid', 'prompt too long or invalid', slug)
      else if (introducesSecret(pr, role.prompt ?? '')) trim('prompt_secret', 'the prompt holds a secret-shaped token', slug)
      else if (pr === role.prompt) {
        // no-op
      } else if (guard) trim('prompt_protected', `the prompt of ${slug} (a root-excluded checking role) is never changed`, slug)
      else {
        // The gate recomputes the only prompts it accepts and ignores the supplied text beyond equality with them.
        const old = role.prompt ?? ''
        const deflate = findings.some((f) => f.kind === 'prompt_deflation' && f.roleSlug === slug)
        const conflict = findings.some((f) => f.kind === 'merge_conflict_hotspot' && f.roleSlug === slug)
        const accepted: string[] = []
        const compressed = compressPrompt(old).prompt
        if (deflate && !isRootRole) accepted.push(compressed)
        if (conflict) {
          if (managedBlockEdited(old)) trim('managed_block_edited', `${slug} has a hand-edited file-scope block, so its prompt is left alone`, slug)
          else {
            accepted.push(upsertScopeBlock(old))
            if (deflate && !isRootRole) accepted.push(upsertScopeBlock(compressed))
          }
        }
        if (accepted.includes(pr)) out.prompt = pr
        else if (!violations.some((v) => v.rule === 'managed_block_edited' && v.roleSlug === slug)) trim('prompt_not_subset', 'a prompt patch must equal the engine\'s own deduplication of the old prompt (plus the fixed file-scope block where a conflict finding applies)', slug)
      }
    }
    if (out.tier !== undefined || out.effort !== undefined || out.staffing || out.prompt !== undefined || out.addTools || out.removeTools || out.removeSkills) {
      if (rejected.has(patchFingerprint(out))) trim('rejected_hypothesis', `a change to ${slug} was rolled back before`, slug)
      else patches.push(out)
    }
  }

  // ---- anti-bloat: prompt characters of the whole chart
  const before = totalPromptChars(project.roles)
  const limit = Math.max(before, project.roles.length * PROMPT_BUDGET_PER_ROLE)
  const lenAfter = (): number => {
    const bySlug = new Map(patches.map((p) => [p.slug, p]))
    return project.roles.reduce((n, r) => n + (bySlug.get(r.slug)?.prompt?.length ?? r.prompt?.length ?? 0), 0)
  }
  while (lenAfter() > limit) {
    let worst = -1
    let growth = 0
    patches.forEach((p, i) => {
      if (p.prompt === undefined) return
      const g = p.prompt.length - (roles.get(p.slug)?.prompt?.length ?? 0)
      if (g > growth) {
        growth = g
        worst = i
      }
    })
    if (worst < 0) break
    trim('prompt_bloat', `${patches[worst].slug}'s prompt would take the chart above ${limit} characters`, patches[worst].slug)
    delete patches[worst].prompt
    if (patches[worst].tier === undefined && patches[worst].effort === undefined && !patches[worst].staffing && !patches[worst].addTools && !patches[worst].removeTools && !patches[worst].removeSkills) patches.splice(worst, 1)
  }

  // ---- one role patch per generation (the service always asks for it): a trial judges one role's change on that role's
  // own figures, so a harmful cut never rides with a good change (the bench, large:effort-high gen_2). The first patch
  // that survived every rule above is kept; the rest wait for later generations.
  if (opts.onePatchPerGeneration) {
    for (const extra of patches.slice(1)) trim('one_patch_per_generation', `${extra.slug} waits for a later generation: one role changes per generation, so each change is judged on its own`, extra.slug)
    patches.splice(1)
  }

  // ---- skills
  const existingNames = new Set((project.skills ?? []).map((s) => s.name))
  const skills: EvolutionSkillPatch[] = []
  for (const s of (Array.isArray(plan.newSkills) ? plan.newSkills : []).slice(0, MAX_PLAN_SKILLS + 5)) {
    const x = (s ?? {}) as Partial<EvolutionSkillPatch>
    const name = typeof x.name === 'string' ? x.name : ''
    const problem = draftProblem({ name, description: x.description, body: x.body }) ?? (existingNames.has(name) || skills.some((k) => k.name === name) ? 'name already used' : null)
    if (problem) trim('skill_invalid', `skill "${cap(name, 40)}": ${problem}`)
    else if ((x.body as string).length > MAX_EVOLVED_SKILL_BODY) trim('skill_invalid', `skill "${name}" is longer than ${MAX_EVOLVED_SKILL_BODY} characters`)
    else if (redactEvidence(x.body as string) !== x.body || redactEvidence(x.description as string) !== x.description) trim('skill_invalid', `skill "${name}" holds a secret-shaped token`)
    else if (skills.length >= MAX_PLAN_SKILLS || (project.skills?.length ?? 0) + skills.length >= SKILL_MAX_PER_PROJECT) trim('skill_invalid', 'too many new skills')
    else {
      const wanted = (Array.isArray(x.grantTo) ? x.grantTo : []).filter((g): g is string => typeof g === 'string' && roles.has(g))
      const grantTo = [...new Set(wanted.filter((g) => !(roles.get(g)!.reportsTo === null || isGuardRole(roles.get(g)!, project.roles))))]
      if (grantTo.length !== new Set(wanted).size) trim('skill_grant_protected', `a new skill is never granted to the root or a checking role`)
      skills.push({ name, description: x.description as string, body: x.body as string, grantTo, reason: cap(x.reason, 240) })
    }
  }
  const prune: string[] = []
  for (const id of Array.isArray(plan.pruneSkillIds) ? plan.pruneSkillIds : []) {
    const spec = (project.skills ?? []).find((k) => k.id === id)
    if (!spec) trim('skill_unknown', 'a skill to remove does not exist')
    else if (spec.libraryId) trim('skill_linked', `${spec.name} is linked from the library and is not removed by an evolution`)
    else if (!unusedSkills.has(id)) trim('skill_removal_unjustified', `${spec.name} has no never-loaded or overlap finding`)
    else if (prune.length >= MAX_PLAN_SKILLS) trim('skill_invalid', 'too many skills to remove')
    else if (!prune.includes(id)) prune.push(id)
  }

  // ---- concurrency
  let max: number | undefined
  if (plan.maxConcurrentSubagents !== undefined) {
    const n = plan.maxConcurrentSubagents
    const cur = effectiveConcurrency(project)
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENT_SUBAGENTS_LIMIT) trim('concurrency_cap', `concurrency must be an integer from 1 to ${MAX_CONCURRENT_SUBAGENTS_LIMIT}`)
    // A cut could not be rolled back (a rollback never raises the limit), so an evolution never lowers it.
    else if (n < cur) trim('concurrency_cut', 'an evolution does not lower the concurrency limit; only you can lower it')
    else if (n > cur && !throttle) trim('concurrency_cap', 'concurrency rises only with a throttled serial_bottleneck finding')
    else if (n > cur && n > Math.max(cur, Number(throttle?.data?.peakReady) || 0)) trim('concurrency_cap', 'concurrency stays within the widest ready set the finding saw')
    else if (n > cur + MAX_CONCURRENCY_RAISE) trim('concurrency_cap', `concurrency rises by at most ${MAX_CONCURRENCY_RAISE} per generation`)
    else if (n !== cur) max = n
  }

  const rebuilt: EvolutionPlan = {
    strategy: plan.strategy === 'hybrid' ? 'hybrid' : 'deterministic',
    fingerprint: '',
    rolePatches: patches,
    newSkills: skills,
    pruneSkillIds: prune,
    ...(max !== undefined ? { maxConcurrentSubagents: max } : {}),
    rationale: cap(plan.rationale, 1200),
    expectedImpact: {
      ...(finiteNonNeg(plan.expectedImpact?.costUsd) !== undefined ? { costUsd: finiteNonNeg(plan.expectedImpact?.costUsd) } : {}),
      ...(finiteNonNeg(plan.expectedImpact?.tokens) !== undefined ? { tokens: finiteNonNeg(plan.expectedImpact?.tokens) } : {}),
      ...(finiteNonNeg(plan.expectedImpact?.wallMs) !== undefined ? { wallMs: finiteNonNeg(plan.expectedImpact?.wallMs) } : {})
    },
    gate: { ok: true, violations },
    promptChars: { before, after: 0, limit },
    empty: false,
    ...(plan.usage ? { usage: { inputTokens: finiteNonNeg(plan.usage.inputTokens) ?? 0, outputTokens: finiteNonNeg(plan.usage.outputTokens) ?? 0, ...(finiteNonNeg(plan.usage.costUsd) !== undefined ? { costUsd: finiteNonNeg(plan.usage.costUsd) } : {}) } } : {})
  }
  rebuilt.fingerprint = planFingerprint(rebuilt)
  if (!isPlanEmpty(rebuilt) && rejected.has(rebuilt.fingerprint)) reject('rejected_hypothesis', 'this exact change was rolled back before')
  // The applied chart must leave everything else alone (defence in depth: applyPlan cannot touch these fields).
  for (const c of chartProblems(project, applyPlan(project, rebuilt))) violations.push(c)
  rebuilt.promptChars.after = totalPromptChars(applyPlan(project, rebuilt).roles)
  rebuilt.empty = isPlanEmpty(rebuilt)
  rebuilt.gate.ok = !violations.some((v) => v.action === 'rejected')
  return rebuilt
}

// ---------- ledger -----------------------------------------------------------------------------------------------------

export const MAX_GENERATIONS = 50
export const MAX_REJECTED = 200
/** A ledger file over this is treated as corrupt (set aside), and a write that would exceed it drops the oldest decided generations first. */
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_PATTERN.test(id)
}

/** What a generation changed on one role: the touched fields before and after (null = the field was absent). */
export interface RoleEdit {
  id: string
  slug: string
  pre: Partial<Record<PatchedField, unknown>>
  post: Partial<Record<PatchedField, unknown>>
}

export interface GenerationSnapshot {
  /** The whole chart before the change (display and audit; rollback uses `edits`). */
  roles: Role[]
  maxConcurrentSubagents: number | null
  postMaxConcurrentSubagents: number | null
  edits: RoleEdit[]
  addedSkillIds: string[]
  prunedSkills: { name: string; description: string; body: string; roleIds: string[] }[]
}

export interface StoredGeneration extends EvolutionGeneration {
  snapshot: GenerationSnapshot
  /** Measured work runs the store listed when the generation was decided (audit; the cooldown counts runs by time). */
  decidedAtRunCount?: number
  /**
   * What the trial judges, fixed when the generation was applied (trial rule 2, 2026-11-25). Absent on a generation
   * applied before that rule (or dropped by the shape check): the service derives it from the plan and the snapshot when
   * it settles the trial. Never crosses IPC (pub / toHistory strip it).
   */
  scope?: TrialScope
}

/** A role a trial judges, as the chart held it when the generation was applied. */
export interface TrialRole {
  id: string
  slug: string
  /** The chart's root: it runs in every run, and run digests keep no figures of their own for it. */
  root?: true
}

/** Summed figures of a set of roles over a set of runs (rates are taken when compared). */
export interface RoleFigures {
  /** Runs in which at least one of the roles ran. */
  runs: number
  agents: number
  /** Agents that passed first time (telemetry's first pass; none counted in a run that did not complete). */
  firstPass: number
  /** Agents that ended in error. */
  errors: number
  /** Failed delegation receipts naming one of the roles. */
  failedReceipts: number
  /** Staffing assignments of the roles, and how many of them were escalations. */
  assignments: number
  escalated: number
  costUsd: number
  turns: number
}

export interface TrialScope {
  rule: 2
  /** The roles the plan patched. Empty = no role patch (skills or the concurrency limit only). */
  roles: TrialRole[]
  /** Roles below a patched role in the chart (its reports, transitively), not themselves patched. */
  downstream: TrialRole[]
  /**
   * Roles above a patched role (its reportsTo chain up to the root), not themselves patched. Absent on a scope stored
   * before the review fixes: then no error run is ever treated as unrelated to the change (provablyUnrelated).
   */
  upstream?: TrialRole[]
  /** Roles with an open tier_underprovisioned finding when the generation was applied (an error the engine flagged). */
  flagged: TrialRole[]
  /** Effective concurrency limit before and after, when the plan changed it. */
  limit?: { before: number; after: number }
  /** The patched and downstream roles' figures over the clean baseline runs (see baselineRuns). */
  baseline: { patched: RoleFigures; downstream: RoleFigures }
}

/**
 * A rejected hypothesis as the ledger keeps it. The shared fields are what history shows; the rest (absent in a ledger
 * written before 2026-11-25) drive expiry and back-off: see liveRejections.
 */
export interface StoredRejection extends EvolutionRejectedHypothesis {
  /** Roles the rejected change patched; expiry counts runs in which one of them ran. Absent = every measured run counts. */
  roles?: TrialRole[]
  /** Consecutive rejections of this fingerprint (1 = first). Absent = 1. */
  strikes?: number
  /** Exercised runs counted since the rejection. Absent = 0. */
  seen?: number
  /** startedAt of the newest run counted (runs started after it are counted next). Absent = `at`. */
  countedUntil?: number
  /** A person rolled it back: it never expires. */
  permanent?: boolean
}

export interface Ledger {
  version: 1
  projectId: string
  generations: StoredGeneration[]
  rejectedHypotheses: StoredRejection[]
  /** The newest hybrid answer that gave nothing usable (only a hash of the digest text, never the text). Absent in older ledgers. */
  hybridMemo?: HybridMemo
}

export const HYBRID_MEMO_OUTCOMES = ['empty', 'refused', 'unusable', 'trimmed'] as const
/** A memo older than this is ignored (the model is asked again); it can only restore a call that existed before the memo. */
export const HYBRID_MEMO_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export interface HybridMemo {
  /** sha256 hex of the digest text the model was given. */
  digestHash: string
  outcome: (typeof HYBRID_MEMO_OUTCOMES)[number]
  at: number
}

/** Shape-check a stored memo; anything off is dropped (the next pass simply calls the model again). */
function sanitizeMemo(raw: unknown): HybridMemo | undefined {
  if (!isObj(raw) || typeof raw.digestHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.digestHash)) return undefined
  if (!(HYBRID_MEMO_OUTCOMES as readonly unknown[]).includes(raw.outcome) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  return { digestHash: raw.digestHash, outcome: raw.outcome as HybridMemo['outcome'], at: raw.at }
}

export const emptyLedger = (projectId: string): Ledger => ({ version: 1, projectId, generations: [], rejectedHypotheses: [] })

export function ledgerPath(dataDir: string, projectId: string): string {
  if (!isValidProjectId(projectId)) throw new Error('Invalid project id')
  return join(dataDir, 'evolution', `${projectId}.json`)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Most roles a trial scope or a rejection keeps (a chart this size is far past any real team). */
const MAX_SCOPE_ROLES = 100
const ROLE_KEY_MAX = 128

function sanitizeRoles(v: unknown): TrialRole[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_SCOPE_ROLES) return undefined
  const out: TrialRole[] = []
  for (const r of v) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.slug !== 'string' || !r.id || r.id.length > ROLE_KEY_MAX || r.slug.length > ROLE_KEY_MAX) return undefined
    if (r.root !== undefined && r.root !== true) return undefined
    out.push({ id: r.id, slug: r.slug, ...(r.root === true ? { root: true as const } : {}) })
  }
  return out
}

const FIGURE_KEYS = ['runs', 'agents', 'firstPass', 'errors', 'failedReceipts', 'assignments', 'escalated', 'costUsd', 'turns'] as const
function sanitizeFigures(v: unknown): RoleFigures | undefined {
  if (!isObj(v)) return undefined
  const out = {} as RoleFigures
  for (const k of FIGURE_KEYS) {
    const n = v[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e12) return undefined
    out[k] = n
  }
  return out
}

/** Shape-check a stored trial scope; anything off = undefined (the service then derives the scope from the plan). */
function sanitizeScope(v: unknown): TrialScope | undefined {
  if (!isObj(v) || v.rule !== 2 || !isObj(v.baseline)) return undefined
  const roles = sanitizeRoles(v.roles)
  const downstream = sanitizeRoles(v.downstream)
  const flagged = sanitizeRoles(v.flagged)
  const upstream = v.upstream === undefined ? undefined : sanitizeRoles(v.upstream)
  const patched = sanitizeFigures(v.baseline.patched)
  const down = sanitizeFigures(v.baseline.downstream)
  if (!roles || !downstream || !flagged || !patched || !down) return undefined
  if (v.upstream !== undefined && !upstream) return undefined
  let limit: TrialScope['limit']
  if (v.limit !== undefined) {
    const l = v.limit
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT_SUBAGENTS_LIMIT
    if (!isObj(l) || !ok(l.before) || !ok(l.after)) return undefined
    limit = { before: l.before, after: l.after }
  }
  return { rule: 2, roles, downstream, ...(upstream ? { upstream } : {}), flagged, ...(limit ? { limit } : {}), baseline: { patched, downstream: down } }
}

/**
 * The only reason a trial settlement wrote before the expiry fields existed (service.ts settleTrial, from the first
 * ledger on 2026-11-11 to trial rule 2 on 2026-11-25: `trial regressed: <reason>`). A person's rollback wrote their own
 * text or 'rolled back by the user'.
 */
export const OLD_TRIAL_REASON_PREFIX = 'trial regressed: '

/**
 * Whether an old-shaped rejection (no strikes, seen or countedUntil: written before 2026-11-25) provably came from a
 * trial settlement: its reason has the old trial prefix, it names a generation, and that generation is in the ledger,
 * rolled back, carries trial metrics (settleTrial set them before rolling back) and its outcome starts with the same
 * reason. Anything else (a person's rollback, a generation no longer in the ledger, a reason that does not match) is not
 * provable. The one case this cannot tell apart: a person who rolled back a PROMOTED generation and typed a reason that
 * starts with "trial regressed: " themselves.
 */
function provenOldTrialRejection(r: Record<string, unknown>, gens: readonly StoredGeneration[]): boolean {
  if (typeof r.reason !== 'string' || !r.reason.startsWith(OLD_TRIAL_REASON_PREFIX) || typeof r.generationId !== 'string') return false
  const g = gens.find((x) => x.id === r.generationId)
  if (!g || g.status !== 'rolled_back' || !isObj(g.trialMetrics) || typeof g.outcomeReason !== 'string') return false
  // addRejected capped the reason at 240 characters with an ellipsis; the outcome holds the full text.
  const stem = r.reason.endsWith('…') ? r.reason.slice(0, -1) : r.reason
  return stem.length > OLD_TRIAL_REASON_PREFIX.length && g.outcomeReason.startsWith(stem)
}

/**
 * A stored rejection with its expiry fields shape-checked. Fails closed: an expiry field that is present but malformed,
 * a `permanent` that is anything but absent or false, and an old-shaped entry (no strikes, seen or countedUntil) that is
 * not provably a trial's rollback (provenOldTrialRejection) all read as permanent, so a person's rollback in an old
 * ledger never expires. A malformed role list counts no run (it never expires either).
 */
function sanitizeRejection(r: EvolutionRejectedHypothesis & Record<string, unknown>, gens: readonly StoredGeneration[]): StoredRejection {
  const out: StoredRejection = { fingerprint: r.fingerprint, summary: r.summary, reason: r.reason, at: r.at, ...(typeof r.generationId === 'string' ? { generationId: r.generationId } : {}) }
  let malformed = false
  const roles = r.roles === undefined ? undefined : sanitizeRoles(r.roles)
  if (roles) out.roles = roles
  else if (r.roles !== undefined) out.roles = [] // a malformed role list counts no run, so the rejection never expires (fails closed)
  if (typeof r.strikes === 'number' && Number.isInteger(r.strikes) && r.strikes >= 1 && r.strikes <= REJECTION_MAX_STRIKES) out.strikes = r.strikes
  else if (r.strikes !== undefined) malformed = true
  if (typeof r.seen === 'number' && Number.isInteger(r.seen) && r.seen >= 0 && r.seen <= 1_000_000) out.seen = r.seen
  else if (r.seen !== undefined) malformed = true
  if (typeof r.countedUntil === 'number' && Number.isFinite(r.countedUntil)) out.countedUntil = r.countedUntil
  else if (r.countedUntil !== undefined) malformed = true
  if (!Number.isFinite(r.at)) malformed = true
  const oldShape = r.strikes === undefined && r.seen === undefined && r.countedUntil === undefined
  if ((r.permanent !== undefined && r.permanent !== false) || malformed || (oldShape && !provenOldTrialRejection(r, gens))) out.permanent = true
  return out
}

function sanitizeLedger(raw: unknown, projectId: string): Ledger | null {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.generations) || !Array.isArray(raw.rejectedHypotheses)) return null
  const gens = raw.generations.filter((g): g is StoredGeneration => isObj(g) && typeof g.id === 'string' && (g.status === 'trial' || g.status === 'promoted' || g.status === 'rolled_back') && isObj(g.snapshot) && isObj(g.baselineMetrics) && isObj(g.plan))
  for (const g of gens) {
    if (g.scope === undefined) continue
    const s = sanitizeScope(g.scope)
    if (s) g.scope = s
    else delete g.scope
  }
  const rej = raw.rejectedHypotheses
    .filter((r): r is EvolutionRejectedHypothesis & Record<string, unknown> => isObj(r) && typeof r.fingerprint === 'string' && typeof r.summary === 'string' && typeof r.reason === 'string' && typeof r.at === 'number')
    .map((r) => sanitizeRejection(r, gens))
  const keep = new Set(gens.slice(-MAX_GENERATIONS))
  const trial = gens.find((g) => g.status === 'trial')
  if (trial) keep.add(trial)
  const memo = sanitizeMemo(raw.hybridMemo)
  return { version: 1, projectId, generations: gens.filter((g) => keep.has(g)), rejectedHypotheses: boundRejections(rej), ...(memo ? { hybridMemo: memo } : {}) }
}

/**
 * Read the ledger. Missing = empty. Corrupt = empty, with the corrupt file moved aside (`.corrupt-<ms>`). Never throws.
 * With `readOnly` (read-scope paths) nothing is ever renamed or written: a corrupt file stays where it is and reads as empty.
 */
export function readLedger(dataDir: string, projectId: string, now: () => number = Date.now, log?: (level: 'info' | 'warn', m: string) => void, opts?: { readOnly?: boolean }): Ledger {
  let file: string
  try {
    file = ledgerPath(dataDir, projectId)
  } catch {
    return emptyLedger('invalid')
  }
  if (!existsSync(file)) return emptyLedger(projectId)
  try {
    if (statSync(file).size > MAX_LEDGER_BYTES) throw new Error('too large')
    const parsed = sanitizeLedger(JSON.parse(readFileSync(file, 'utf8')), projectId)
    if (parsed) return parsed
  } catch {
    // fall through to the corrupt handling
  }
  if (opts?.readOnly) {
    log?.('warn', `Evolution ledger for ${projectId} was unreadable; read as empty.`)
    return emptyLedger(projectId)
  }
  try {
    renameSync(file, `${file}.corrupt-${now()}`)
  } catch {
    // keep going with an empty ledger; the next write replaces the file
  }
  log?.('warn', `Evolution ledger for ${projectId} was unreadable; started empty (the old file was kept aside).`)
  return emptyLedger(projectId)
}

/** Write the ledger durably (bounded: the newest MAX_GENERATIONS generations, MAX_REJECTED rejections). Throws on failure. */
export function writeLedger(dataDir: string, ledger: Ledger): void {
  const keep = new Set(ledger.generations.slice(-MAX_GENERATIONS))
  const trial = ledger.generations.find((g) => g.status === 'trial')
  if (trial) keep.add(trial)
  const gens = ledger.generations.filter((g) => keep.has(g))
  const bounded: Ledger = { ...ledger, generations: gens, rejectedHypotheses: boundRejections(ledger.rejectedHypotheses) }
  let text = `${JSON.stringify(bounded)}\n`
  while (Buffer.byteLength(text) > MAX_LEDGER_BYTES) {
    const drop = bounded.generations.findIndex((g) => g.status !== 'trial')
    if (drop < 0) throw new Error('The evolution ledger is too large to write')
    bounded.generations = bounded.generations.filter((_, i) => i !== drop)
    text = `${JSON.stringify(bounded)}\n`
  }
  writeFileDurable(ledgerPath(dataDir, ledger.projectId), text)
}

export const trialOf = (l: Ledger): StoredGeneration | undefined => l.generations.find((g) => g.status === 'trial')

/** A generation as callers see it: no snapshot, no trial scope. */
export function publicGeneration(g: StoredGeneration): EvolutionGeneration {
  const { snapshot: _s, scope: _scope, ...rest } = g
  return rest
}

/** A rejection as callers see it (the shared fields only). */
const publicRejection = (r: StoredRejection): EvolutionRejectedHypothesis => ({ fingerprint: r.fingerprint, summary: r.summary, reason: r.reason, ...(r.generationId !== undefined ? { generationId: r.generationId } : {}), at: r.at })

/** The ledger as callers see it: no snapshots, and only the rejections that still block (liveRejections). */
export function toHistory(l: Ledger): EvolutionHistory {
  const generations: EvolutionGeneration[] = l.generations.slice(-MAX_GENERATIONS).map(publicGeneration)
  const champion = [...l.generations].reverse().find((g) => g.status === 'promoted')
  const trial = trialOf(l)
  return {
    projectId: l.projectId,
    generations,
    ...(champion ? { championId: champion.id } : {}),
    ...(trial ? { trialId: trial.id } : {}),
    rejectedHypotheses: liveRejections(l).slice(-MAX_REJECTED)
  }
}

export const nextGenerationId = (l: Ledger): string => {
  const max = l.generations.reduce((m, g) => Math.max(m, Number(/^gen_(\d+)$/.exec(g.id)?.[1] ?? 0)), 0)
  return `gen_${max + 1}`
}

// ---------- rejection expiry and back-off -------------------------------------------------------------------------------

/**
 * A rejection made by a trial expires once the roles it patched have run in this many measured runs since it (the first
 * rejection), so a correct change rolled back by noise can be tried again; the retry is an ordinary trial. Consecutive
 * rejections of the same fingerprint back off: the second waits REJECTION_EXPIRY_RUNS * 2 exercised runs, the third and
 * later never expire. A person's rollback never expires. A rejection in a ledger written before 2026-11-25 (no strikes,
 * seen or countedUntil) never expires unless it is provably a trial's rollback (sanitizeRejection); such a trial
 * rollback names no roles, so it counts every measured run.
 */
export const REJECTION_EXPIRY_RUNS = 20
export const REJECTION_MAX_STRIKES = 3

/** Exercised runs after which a rejection with this many strikes stops blocking (Infinity = never). */
export function rejectionExpiry(r: Pick<StoredRejection, 'strikes' | 'permanent'>): number {
  const s = r.strikes ?? 1
  if (r.permanent || s >= REJECTION_MAX_STRIKES) return Infinity
  return REJECTION_EXPIRY_RUNS * 2 ** (s - 1)
}

/** A rejection that never stops blocking (a person's rollback, a third strike, an old or malformed entry). Never evicted. */
export const isPinnedRejection = (r: StoredRejection): boolean => rejectionExpiry(r) === Infinity

/**
 * The rejections kept when there are more than MAX_REJECTED: expired entries go first (oldest first), then the oldest
 * that can still expire; a pinned entry (isPinnedRejection) is never evicted, so the list may stay above MAX_REJECTED
 * when that many are pinned (addRejected then refuses entries that could expire, and the service applies nothing new:
 * rejectionsFull).
 */
export function boundRejections(list: readonly StoredRejection[]): StoredRejection[] {
  const out = [...list]
  while (out.length > MAX_REJECTED) {
    let i = out.findIndex((r) => !isPinnedRejection(r) && !isLiveRejection(r))
    if (i < 0) i = out.findIndex((r) => !isPinnedRejection(r))
    if (i < 0) break
    out.splice(i, 1)
  }
  return out
}

/** True when MAX_REJECTED pinned rejections fill the ledger: no rejection that could expire can be stored, so nothing new is applied. */
export const rejectionsFull = (l: Pick<Ledger, 'rejectedHypotheses'>): boolean => l.rejectedHypotheses.filter(isPinnedRejection).length >= MAX_REJECTED

export const isLiveRejection = (r: StoredRejection): boolean => (r.seen ?? 0) < rejectionExpiry(r)

/** The rejections that still block a plan or patch (what the gate, the synthesizer and history read). */
export function liveRejections(l: Pick<Ledger, 'rejectedHypotheses'>): EvolutionRejectedHypothesis[] {
  return l.rejectedHypotheses.filter(isLiveRejection).map(publicRejection)
}

/**
 * Record a rejected hypothesis. One entry per fingerprint: a repeat replaces the old entry and adds a strike (capped at
 * REJECTION_MAX_STRIKES), and its run count starts again. False when it was not stored: MAX_REJECTED pinned rejections
 * already fill the ledger and this one could expire (rejectionsFull; the service then applies nothing new).
 */
export function addRejected(l: Ledger, r: Omit<EvolutionRejectedHypothesis, 'summary' | 'reason'> & { summary: string; reason: string; roles?: readonly TrialRole[]; permanent?: boolean }): boolean {
  const prev = l.rejectedHypotheses.find((x) => x.fingerprint === r.fingerprint)
  const strikes = Math.min(REJECTION_MAX_STRIKES, (prev ? (prev.strikes ?? 1) : 0) + 1)
  const entry: StoredRejection = {
    fingerprint: r.fingerprint,
    summary: cap(r.summary, 240),
    reason: cap(r.reason, 240),
    ...(r.generationId !== undefined ? { generationId: r.generationId } : {}),
    at: r.at,
    ...(r.roles ? { roles: r.roles.slice(0, MAX_SCOPE_ROLES).map((x) => ({ id: x.id, slug: x.slug, ...(x.root ? { root: true as const } : {}) })) } : {}),
    strikes,
    seen: 0,
    countedUntil: r.at,
    ...(r.permanent || prev?.permanent ? { permanent: true } : {})
  }
  const rest = l.rejectedHypotheses.filter((x) => x.fingerprint !== r.fingerprint)
  if (!isPinnedRejection(entry) && rest.filter(isPinnedRejection).length >= MAX_REJECTED) return false
  l.rejectedHypotheses = boundRejections([...rest, entry])
  return true
}

/** Drop the rejections of these fingerprints (a change that has now passed its trial starts from no strikes). */
export function clearRejected(l: Ledger, fingerprints: readonly string[]): boolean {
  const drop = new Set(fingerprints)
  const before = l.rejectedHypotheses.length
  l.rejectedHypotheses = l.rejectedHypotheses.filter((x) => !drop.has(x.fingerprint))
  return l.rejectedHypotheses.length !== before
}

/** The startedAt after which a rejection still has runs to count, or undefined when it no longer counts (expired or permanent). */
export function rejectionCountsFrom(r: StoredRejection): number | undefined {
  if (!isLiveRejection(r) || rejectionExpiry(r) === Infinity) return undefined
  return r.countedUntil ?? r.at
}

/**
 * Count, for every rejection that can still expire, the measured runs started after its `countedUntil` in which one of
 * its roles ran (any measured run when it names none), and move `countedUntil` to the newest run looked at. Mutates;
 * true when anything changed. Runs may be records or digests, in any order.
 */
export function ageRejections(l: Pick<Ledger, 'rejectedHypotheses'>, runs: readonly RunLike[]): boolean {
  const measured = runs.filter(isMeasuredRun).map(asDigest)
  let changed = false
  for (const r of l.rejectedHypotheses) {
    const from = rejectionCountsFrom(r)
    if (from === undefined) continue
    const fresh = measured.filter((d) => d.summary.startedAt > from)
    if (!fresh.length) continue
    const uses = r.roles === undefined ? () => true : roleMatcher(r.roles).ran
    r.seen = (r.seen ?? 0) + fresh.filter(uses).length
    r.countedUntil = Math.max(...fresh.map((d) => d.summary.startedAt))
    changed = true
  }
  return changed
}

// ---------- snapshots and restore ---------------------------------------------------------------------------------------

const fieldValue = (r: Role, f: PatchedField): unknown => {
  const v = (r as unknown as Record<string, unknown>)[f]
  return v === undefined ? null : structuredClone(v)
}

/** Capture the touched fields of every patched role before (`project`) and after (`applied`). */
export function captureEdits(project: Project, applied: Project, patches: readonly EvolutionRolePatch[]): RoleEdit[] {
  const after = new Map(applied.roles.map((r) => [r.id, r]))
  const edits: RoleEdit[] = []
  for (const p of patches) {
    const role = project.roles.find((r) => r.slug === p.slug)
    const next = role ? after.get(role.id) : undefined
    if (!role || !next) continue
    const pre: RoleEdit['pre'] = {}
    const post: RoleEdit['post'] = {}
    for (const f of touchedFields(p, role)) {
      pre[f] = fieldValue(role, f)
      post[f] = fieldValue(next, f)
    }
    edits.push({ id: role.id, slug: role.slug, pre, post })
  }
  return edits
}

export function snapshotOf(project: Project, applied: Project, plan: EvolutionPlan): GenerationSnapshot {
  return {
    roles: structuredClone(project.roles),
    maxConcurrentSubagents: project.maxConcurrentSubagents ?? null,
    postMaxConcurrentSubagents: applied.maxConcurrentSubagents ?? null,
    edits: captureEdits(project, applied, plan.rolePatches),
    addedSkillIds: [],
    prunedSkills: []
  }
}

export interface RestoreResult {
  /** False: the snapshot could not be applied safely; `project` is the unchanged input and `reason` says why. */
  ok: boolean
  project: Project
  notes: string[]
  restored: number
  reason?: string
}

/** The value (as text) a rollback must not restore for this field, or '' when it may. */
function neverRestored(f: PatchedField, pre: unknown): string {
  if (f === 'tier' && pre === 'top') return '"top"'
  if (f === 'model' && typeof pre === 'string' && settingTier(pre) === 'top') return '"top"'
  if (f === 'effort' && (pre === 'xhigh' || pre === 'max')) return `"${pre}"`
  if (f === 'staffing' && isObj(pre)) {
    if (pre.minTier === 'top') return '"top"'
    if (pre.maxEffort === 'xhigh' || pre.maxEffort === 'max') return `"${pre.maxEffort}"`
  }
  return ''
}

const ALLOWED_FIELDS: readonly PatchedField[] = ['tier', 'model', 'effort', 'staffing', 'prompt', 'tools', 'skills']
const MAX_RESTORED_PROMPT = 200_000

/**
 * Restore what a generation changed, field by field, where the user has not edited it since (a field whose current value
 * differs from the value the generation wrote is the user's and stays). Only the fields an evolution can change are ever
 * touched, only those the generation's own PLAN touched, each value is checked by type and enum, tools and skill grants are
 * rebuilt from the plan's add / remove lists (so a write or exec tool comes back only when this plan removed exactly that tool),
 * and the result must pass chartProblems against the current project. Never throws: any problem gives `ok: false` and the
 * project unchanged. Skills themselves live in the skills service and are the caller's. Pure.
 */
export function restoreSnapshot(project: Project, snap: GenerationSnapshot, plan: Pick<EvolutionPlan, 'rolePatches' | 'maxConcurrentSubagents'>): RestoreResult {
  const fail = (reason: string): RestoreResult => ({ ok: false, project, notes: [], restored: 0, reason })
  try {
    if (!snap || !Array.isArray(snap.edits) || !plan || !Array.isArray(plan.rolePatches)) return fail('the snapshot is malformed')
    // The edits must be exactly what this generation's own plan did to the chart the snapshot recorded: a value changed
    // in the ledger afterwards (a `pre` that the recorded chart does not hold) is refused, never restored.
    if (!Array.isArray(snap.roles)) return fail('the snapshot is malformed')
    const recorded = applyPlan({ ...project, roles: snap.roles }, plan)
    for (const e of snap.edits) {
      if (!isObj(e)) continue // a null entry restores nothing (skipped below too)
      if (!isObj(e.pre) || !isObj(e.post)) throw new Error('an edit entry is malformed')
      const was = snap.roles.find((r) => isObj(r) && r.id === e.id)
      const now = recorded.roles.find((r) => r.id === e.id)
      if (!was || !now || e.slug !== was.slug) throw new Error('an edit names a role the snapshot does not hold')
      for (const k of Object.keys(e.pre)) {
        if (!(ALLOWED_FIELDS as readonly string[]).includes(k)) throw new Error(`unknown field ${k.slice(0, 20)}`)
        const f = k as PatchedField
        if (!equal(e.pre[f], fieldValue(was, f)) || !equal(e.post[f], fieldValue(now, f))) throw new Error('an edit does not match the chart and plan it was recorded with')
      }
    }
    const notes: string[] = []
    let restored = 0
    const patches = new Map(plan.rolePatches.map((p) => [p.slug, p]))
    const skillIds = new Set((project.skills ?? []).map((k) => k.id))
    const roles = project.roles.map((r) => {
      const edit = snap.edits.find((e) => isObj(e) && e.id === r.id)
      if (!edit) return r
      if (!isObj(edit.pre) || !isObj(edit.post) || typeof edit.slug !== 'string') throw new Error('an edit entry is malformed')
      // Matched by the role's id: a role renamed since keeps its rollback (the plan names it by its slug then).
      const patch = patches.get(edit.slug)
      if (!patch) {
        notes.push(`${r.slug} is not part of the generation's plan`)
        return r
      }
      const next = { ...r } as unknown as Record<string, unknown>
      // A role fixed since (its staffing mode, the project's, or a concrete model) runs as the user set it: its sizing
      // fields stay, even where they still equal what the generation wrote.
      const fixedNow = isFixedRole(project, r)
      const SIZING: readonly string[] = ['tier', 'model', 'effort', 'staffing']
      const planTouches: Record<PatchedField, boolean> = {
        tier: patch.tier !== undefined,
        model: patch.tier !== undefined,
        effort: patch.effort !== undefined,
        staffing: patch.staffing !== undefined,
        prompt: patch.prompt !== undefined,
        tools: !!(patch.addTools?.length || patch.removeTools?.length),
        skills: !!patch.removeSkills?.length
      }
      for (const key of Object.keys(edit.pre)) {
        if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) throw new Error(`unknown field ${key.slice(0, 20)}`)
        const f = key as PatchedField
        if (!planTouches[f]) throw new Error(`field ${f} is not in the plan`)
        const cur = (r as unknown as Record<string, unknown>)[f]
        if (fixedNow && SIZING.includes(f)) {
          notes.push(`kept the fixed staffing of ${r.slug} (${f})`)
          continue
        }
        if (!equal(cur, edit.post[f])) {
          notes.push(`kept your later edit to ${r.slug}.${f}`)
          continue
        }
        const pre = edit.pre[f]
        // A rollback never sets what an evolution could never set (top, xhigh, max): the field keeps its current value.
        const never = neverRestored(f, pre)
        if (never) {
          notes.push(`kept ${r.slug}.${f}: restoring would set ${never}, which only you can set`)
          continue
        }
        if (f === 'tier') {
          if (pre === null) delete next.tier
          else if (isTier(pre)) next.tier = pre
          else throw new Error('tier is not a tier')
        } else if (f === 'model') {
          const ok = (v: unknown): boolean => typeof v === 'string' && settingTier(v) !== undefined
          if (ok(pre) && ok(edit.post.model)) next.model = pre
          else notes.push(`${r.slug}.model was left as it is`)
        } else if (f === 'effort') {
          if (pre === null) delete next.effort
          else if (isEff(pre)) next.effort = pre
          else throw new Error('effort is not an effort')
        } else if (f === 'staffing') {
          if (pre === null) delete next.staffing
          else {
            const clean = cleanRoleStaffing(pre)
            if (!clean || !equal(clean, pre)) throw new Error('staffing is malformed')
            next.staffing = clean
          }
        } else if (f === 'prompt') {
          if (typeof pre !== 'string' || !pre.trim() || pre.length > MAX_RESTORED_PROMPT || pre.includes('\0')) throw new Error('prompt is malformed')
          next.prompt = pre
        } else if (f === 'tools') {
          if (!Array.isArray(pre)) throw new Error('tools are malformed')
          const before = pre.filter(isTool)
          const added = new Set<string>(patch.addTools ?? [])
          const back = (patch.removeTools ?? []).filter((t) => before.includes(t))
          const tools = r.tools.filter((t) => !added.has(t))
          for (const t of back) {
            if (tools.includes(t)) continue
            // A write or exec tool comes back only where the project already trusts it with some role.
            if (WRITE_EXEC_TOOLS.has(t) && !project.roles.some((x) => x.tools.includes(t))) {
              notes.push(`${t} was not given back to ${r.slug}; add it yourself if you want it`)
              continue
            }
            tools.push(t)
          }
          next.tools = tools
        } else if (f === 'skills') {
          if (!Array.isArray(pre)) throw new Error('skills are malformed')
          const had = new Set(pre.filter((x): x is string => typeof x === 'string'))
          const grants = [...(r.skills ?? [])]
          for (const id of patch.removeSkills ?? []) if (had.has(id) && skillIds.has(id) && !grants.includes(id)) grants.push(id)
          next.skills = grants
        }
        restored++
      }
      return next as unknown as Role
    })
    for (const e of snap.edits) if (isObj(e) && !project.roles.some((r) => r.id === e.id)) notes.push(`role ${String(e.slug).slice(0, 40)} no longer exists`)
    let out: Project = { ...project, roles }
    if (plan.maxConcurrentSubagents !== undefined && snap.postMaxConcurrentSubagents !== snap.maxConcurrentSubagents) {
      const preMax = snap.maxConcurrentSubagents
      if (preMax !== null && !(Number.isInteger(preMax) && preMax >= 1 && preMax <= MAX_CONCURRENT_SUBAGENTS_LIMIT)) throw new Error('the concurrency limit is malformed')
      // The plan's own value must be what the generation wrote, and a rollback never raises the limit (an evolution only
      // raises it, so the value before is below the value after).
      if (snap.postMaxConcurrentSubagents !== plan.maxConcurrentSubagents) throw new Error('the concurrency limit does not match the plan')
      const limitOf = (v: number | null): number => effectiveConcurrency({ maxConcurrentSubagents: v ?? undefined })
      const raises = limitOf(preMax) > limitOf(snap.postMaxConcurrentSubagents)
      if (raises) notes.push('kept the concurrency limit (restoring it would raise it)')
      else if ((project.maxConcurrentSubagents ?? null) === snap.postMaxConcurrentSubagents) {
        const { maxConcurrentSubagents: _m, ...rest } = out
        out = preMax === null ? rest : { ...rest, maxConcurrentSubagents: preMax }
        restored++
      } else notes.push('kept your later edit to the concurrency limit')
    }
    const problems = chartProblems(project, out)
    if (problems.length) return fail(`the restored chart would break the safety rules (${problems.map((v) => v.rule).join(', ')})`)
    return { ok: true, project: out, notes, restored }
  } catch (e) {
    return fail(`the snapshot was unusable (${cap(e instanceof Error ? e.message : String(e), 80)})`)
  }
}

// ---------- trial evaluation --------------------------------------------------------------------------------------------

export const DEFAULT_EVAL_WINDOW = 3
export const MAX_FIRST_PASS_DROP = 0.15
export const MAX_ERROR_RATE_RISE = 0.2
export const MAX_COST_TIME_WORSENING = 0.25

export const clampWindow = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(10, Math.max(1, Math.floor(n))) : DEFAULT_EVAL_WINDOW)
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * Regression test of a trial against its baseline (all thresholds strict). Quality signals (first-pass drop, error-run rise)
 * need a baseline that measured at least one run; cost and time are compared as a product when both sides have both
 * figures, else each figure alone when both sides have it, else not at all (the reason says so). Pure.
 */
export function compareMetrics(baseline: EvolutionMetrics, trial: EvolutionMetrics): { regressed: boolean; reason: string } {
  const hasBaseline = baseline.runs >= 1
  if (hasBaseline) {
    const drop = r6(baseline.firstPassRate - trial.firstPassRate)
    if (drop > MAX_FIRST_PASS_DROP) return { regressed: true, reason: `first-pass rate fell ${Math.round(drop * 100)} points (${baseline.firstPassRate} to ${trial.firstPassRate})` }
  }
  const rise = r6(trial.errorRunRate - baseline.errorRunRate)
  if (rise > MAX_ERROR_RATE_RISE) return { regressed: true, reason: `error-run rate rose ${Math.round(rise * 100)} points (${baseline.errorRunRate} to ${trial.errorRunRate})` }
  let note = hasBaseline ? '' : 'no baseline run: decided on the error rate only'
  if (hasBaseline) {
    const notBetter = r6(trial.firstPassRate - baseline.firstPassRate) <= 0
    const usable = (b: number, t: number): boolean => b > 0 && t > 0
    const costOk = usable(baseline.medianCostUsd, trial.medianCostUsd)
    const wallOk = usable(baseline.medianWallMs, trial.medianWallMs)
    let worse: number | undefined
    let what = ''
    if (costOk && wallOk) {
      worse = (trial.medianCostUsd * trial.medianWallMs) / (baseline.medianCostUsd * baseline.medianWallMs) - 1
      what = 'cost x time'
    } else if (costOk) {
      worse = trial.medianCostUsd / baseline.medianCostUsd - 1
      what = 'cost'
    } else if (wallOk) {
      worse = trial.medianWallMs / baseline.medianWallMs - 1
      what = 'time'
    } else if (trial.medianCostUsd > 0 || trial.medianWallMs > 0 || baseline.medianCostUsd > 0 || baseline.medianWallMs > 0) note = 'cost and time not comparable (one side has no figures): decided on quality only'
    if (worse !== undefined && r6(worse) > MAX_COST_TIME_WORSENING && notBetter) return { regressed: true, reason: `${what} worsened ${Math.round(worse * 100)}% without a better first-pass rate` }
  }
  return { regressed: false, reason: `first-pass ${baseline.firstPassRate} to ${trial.firstPassRate}, errors ${baseline.errorRunRate} to ${trial.errorRunRate}${note ? `; ${note}` : ''}` }
}

export type TrialDecision =
  | { state: 'pending'; have: number; need: number; runs: number; cap: number }
  | { state: 'decided'; regressed: boolean; trialMetrics: EvolutionMetrics; reason: string; inconclusive?: boolean }

// ---------- trial rule 2: judge the change, not the week (2026-11-25) ---------------------------------------------------
//
// A trial counts only runs that EXERCISED the change (in the window, exercises with `attempts`): a run in which a
// patched role ran (a digest agent matched by role id, else slug), was assigned by staffing or failed a delegation
// receipt (a failed spawn of the patched role is evidence against the change, not a reason to skip the run); for a
// concurrency change, a run whose OBSERVED peak parallelism (Shape.maxParallel: how many of the root's reports actually
// overlapped) reached the lower of the old and new limit, never the plan's width (model-written text decides nothing);
// with neither a role patch nor a limit change (skills only), every run. An interrupted trial run always counts and
// fails the trial as before. The trial is decided on the first `evalWindowRuns` (default 3, 1..10) exercised runs that
// started at or after the apply; if trialRunCap (5 x that, at most 50) trial runs pass without them, it is rolled back as
// inconclusive, never promoted.
//
// The baseline is fixed at apply time: the newest BASELINE_RUNS measured runs among the newest 50 in which a patched role
// had an agent (or, for a limit, whose observed parallelism reached it), leaving out (a) every run that started inside
// the window of a rolled-back generation (apply to decision) and (b) every error run (status error, paused, failed or
// interrupted exec outcome) in which a role the engine had flagged as under-provisioned erred, failed a receipt or was
// escalated. A plan is not applied (a refusal, not a rejection: it is tried again on a later pass) unless the baseline
// holds at least max(MIN_BASELINE_RUNS, evalWindowRuns) runs, for every scope including skills-only and limit-only
// plans, and, when a non-root role is patched, at least max(MIN_BASELINE_ROLE_AGENTS, evalWindowRuns) agents of the
// patched roles (a root-only patch: that many agents of the roles below it). baselineShortfall.
//
// Regressed (rolled back) when any of these holds, every threshold strict (">"), rates rounded to 6 places:
//   1. the patched roles' own figures (all their agents in the window against the baseline): first pass fell more than
//      0.15; errors (max of error agents and failed receipts) per agent rose more than 0.15; escalations per assignment
//      rose more than 0.15; or, without a better first pass, cost per agent (turns per agent when cost is unknown on
//      either side) rose more than 25%;
//   2. downstream (roles below a patched role): first pass fell, or errors or escalations rose, more than 0.15;
//   3. the whole team (compareMetrics against the baseline runs' metrics: first pass fell more than 0.15, error-run rate
//      rose more than 0.2, cost x time worse than 25% without a better first pass) over the window runs PLUS every error
//      run that started between the apply and the last window run without exercising the change; from that set only a
//      run that is provably unrelated (provablyUnrelated) is left out: an error run with at least one erring agent or
//      failed receipt, every one of which belongs to a role the engine flagged as under-provisioned that is neither
//      patched, nor below, nor above a patched role. For a change with no role patch (limit, skills) nothing is left out;
//   4. a window run was interrupted (as before);
//   5. inconclusive: the patched roles have no baseline agent or no window agent, every run of 3 was left out, or the
//      cap was reached.
// Otherwise it is promoted.
//
// What is guaranteed (and what is not). Every threshold is the one the whole-team rule used before; rules 1 and 2 only
// add ways to roll back; a trial is never decided on a baseline thinner than the minimums above; an error run inside the
// trial's span always counts unless provably unrelated; a trial opened before rule 2 keeps the baseline it was opened
// with and must ALSO pass the old whole-team rule on the first evalWindowRuns runs after its apply (or, when its
// per-role baseline cannot be rebuilt to the minimums, is judged on the old rule alone). NOT guaranteed: that a new
// trial is never easier to promote than under the old rule, because the window (exercised runs only) and the baseline
// (the clean exercised runs, not the diagnosis window) both changed; a calm week that never used the change no longer
// promotes it, but a window of exercised runs can differ from the first runs after the apply in either direction.

/** A trial still short of its exercised runs is rolled back (inconclusive) once this many times `need` trial runs passed. */
export const TRIAL_RUN_CAP_FACTOR = 5
export const trialRunCap = (need: unknown): number => Math.min(50, TRIAL_RUN_CAP_FACTOR * clampWindow(need))
/** Most exercised runs a trial's baseline holds. */
export const BASELINE_RUNS = 10
/** Measured runs searched for the baseline (newest first). */
export const BASELINE_SEARCH_RUNS = 50
export const MAX_ROLE_FIRST_PASS_DROP = 0.15
export const MAX_ROLE_FAILURE_RISE = 0.15
export const MAX_ROLE_COST_WORSENING = 0.25
/** Fewest clean baseline runs a trial may be opened (or a pre-rule-2 trial judged per role) on; evalWindowRuns when higher. */
export const MIN_BASELINE_RUNS = 3
/** Fewest baseline agents of the patched (non-root) roles a trial may be opened on; evalWindowRuns when higher. */
export const MIN_BASELINE_ROLE_AGENTS = 3

export const emptyFigures = (): RoleFigures => ({ runs: 0, agents: 0, firstPass: 0, errors: 0, failedReceipts: 0, assignments: 0, escalated: 0, costUsd: 0, turns: 0 })

/** A trial with no role patch and no limit change: every run counts and only the whole-team rule applies. */
const EVERY_RUN_SCOPE: TrialScope = { rule: 2, roles: [], downstream: [], flagged: [], baseline: { patched: emptyFigures(), downstream: emptyFigures() } }

/**
 * Matches a digest's agents, assignments and receipts to roles (digestKey of the role id, or of the slug for agents).
 * `ran`: one of the roles had an agent in the run; always true when the set holds the root (the root runs in every run).
 * `attempted`: `ran`, or a staffing assignment or a failed delegation receipt names one of the roles (a spawn was tried).
 * Rejection expiry counts `ran` only, so a failed spawn never ages a rejection.
 */
export function roleMatcher(roles: readonly TrialRole[]): { agent: (a: DigestAgent) => boolean; id: (key: string) => boolean; ran: (r: RunLike) => boolean; attempted: (r: RunLike) => boolean } {
  const ids = new Set(roles.map((r) => digestKey(r.id)))
  const slugs = new Set(roles.map((r) => digestKey(r.slug)).filter(Boolean))
  const agent = (a: DigestAgent): boolean => (a.roleId !== undefined && ids.has(a.roleId)) || slugs.has(a.slug)
  const root = roles.some((r) => r.root)
  const ran = (r: RunLike): boolean => root || asDigest(r).agents.some(agent)
  return {
    agent,
    id: (k) => ids.has(k),
    ran,
    attempted: (r) => {
      if (ran(r)) return true
      const d = asDigest(r)
      return d.assignments.some((x) => ids.has(x.roleId)) || d.failedReceiptRoleIds.some((k) => ids.has(k))
    }
  }
}

const incompleteRun = (d: RunDigest): boolean => d.summary.status === 'paused' || isFailedExecOutcome(d.summary.execOutcome) || isInterruptedTrialRun(d)
const errorRun = (d: RunDigest): boolean => d.summary.status === 'error' || incompleteRun(d)

/** The roles' figures over these runs. */
export function figuresOf(runs: readonly RunLike[], roles: readonly TrialRole[]): RoleFigures {
  const m = roleMatcher(roles)
  const f = emptyFigures()
  for (const d of runs.map(asDigest)) {
    const incomplete = incompleteRun(d)
    let ran = false
    for (const a of d.agents) {
      if (!m.agent(a)) continue
      ran = true
      f.agents++
      if (!incomplete && a.firstPass) f.firstPass++
      if (a.error) f.errors++
      f.costUsd += a.costUsd
      f.turns += a.turns
    }
    for (const x of d.assignments) {
      if (!m.id(x.roleId)) continue
      f.assignments++
      if (x.escalated) f.escalated++
    }
    for (const id of d.failedReceiptRoleIds) if (m.id(id)) f.failedReceipts++
    if (ran) f.runs++
  }
  f.costUsd = r6(f.costUsd)
  return f
}

/** An error run in which one of these (flagged) roles erred, failed a receipt or was escalated. */
export function isFlaggedErrorRun(r: RunLike, flagged: readonly TrialRole[]): boolean {
  if (!flagged.length) return false
  const d = asDigest(r)
  if (!errorRun(d)) return false
  const m = roleMatcher(flagged)
  return d.agents.some((a) => m.agent(a) && a.error) || d.failedReceiptRoleIds.some(m.id) || d.assignments.some((x) => x.escalated && m.id(x.roleId))
}

/**
 * Whether a run exercised the change a scope describes (the rule above). `attempts` (the trial window): a staffing
 * assignment or a failed receipt of a patched role counts too. Without it (the baseline) only a patched role's agent
 * does, so a failed spawn before the change never makes the baseline look worse. A limit counts only on the observed
 * peak parallelism, never on the plan's width.
 */
export function exercises(r: RunLike, scope: Pick<TrialScope, 'roles' | 'limit'>, opts?: { attempts?: boolean }): boolean {
  const d = asDigest(r)
  if (isInterruptedTrialRun(d)) return true
  if (!scope.roles.length && !scope.limit) return true
  if (scope.roles.length) {
    const m = roleMatcher(scope.roles)
    if (opts?.attempts ? m.attempted(d) : m.ran(d)) return true
  }
  if (scope.limit && d.shape.maxParallel >= Math.min(scope.limit.before, scope.limit.after)) return true
  return false
}

/**
 * Whether an error run is provably unrelated to the change (rule 3): it is an error run, it has at least one erring agent
 * or failed receipt, and every erring agent and every failed receipt in it belongs to a role that the engine flagged as
 * under-provisioned and that is neither patched, nor below, nor above a patched role in the reportsTo chain. Never true
 * for a change with no role patch (a limit or skills change is project-level) or for a scope stored without `upstream`
 * (the chain above is unknown). An escalation is not an error and neither proves nor disproves anything here.
 */
export function provablyUnrelated(r: RunLike, scope: Pick<TrialScope, 'roles' | 'downstream' | 'upstream' | 'flagged'>): boolean {
  if (!scope.roles.length || !scope.upstream || !scope.flagged.length) return false
  const d = asDigest(r)
  if (!errorRun(d)) return false
  const near = new Set([...scope.roles, ...scope.downstream, ...scope.upstream].map((x) => x.id))
  const unrelated = scope.flagged.filter((x) => !near.has(x.id))
  if (!unrelated.length) return false
  const m = roleMatcher(unrelated)
  const erring = d.agents.filter((a) => a.error)
  if (!erring.length && !d.failedReceiptRoleIds.length) return false
  return erring.every(m.agent) && d.failedReceiptRoleIds.every(m.id)
}

/**
 * Why a baseline is too thin to open a trial on (or to judge a pre-rule-2 trial per role), else undefined: fewer than
 * max(MIN_BASELINE_RUNS, need) runs for any scope; with a patched non-root role, fewer than max(MIN_BASELINE_ROLE_AGENTS,
 * need) agents of the patched roles; with only the root patched, fewer than that many agents of the roles below it.
 */
export function baselineShortfall(scope: Pick<TrialScope, 'roles' | 'downstream'>, base: readonly RunLike[], need: unknown): string | undefined {
  const n = clampWindow(need)
  const runsNeeded = Math.max(MIN_BASELINE_RUNS, n)
  if (base.length < runsNeeded) return `${base.length} of the ${runsNeeded} clean runs before the change a trial compares with`
  const agentsNeeded = Math.max(MIN_BASELINE_ROLE_AGENTS, n)
  const measured = scope.roles.filter((r) => !r.root)
  if (measured.length) {
    const a = figuresOf(base, measured).agents
    if (a < agentsNeeded) return `${a} of the ${agentsNeeded} agents of ${measured.map((r) => r.slug).join(', ')} in clean runs before the change a trial compares with`
  } else if (scope.roles.length && scope.downstream.length) {
    const a = figuresOf(base, scope.downstream).agents
    if (a < agentsNeeded) return `${a} of the ${agentsNeeded} agents below ${scope.roles.map((r) => r.slug).join(', ')} in clean runs before the change a trial compares with`
  }
  return undefined
}

/** [appliedAt, decidedAt] of every rolled-back generation: runs started inside it never enter a baseline. */
export function rolledBackWindows(l: Pick<Ledger, 'generations'>): [number, number][] {
  return l.generations
    .filter((g) => g.status === 'rolled_back' && typeof g.appliedAt === 'number' && typeof g.decidedAt === 'number')
    .map((g) => [g.appliedAt, g.decidedAt as number])
}

/**
 * The clean baseline of a scope: the newest BASELINE_RUNS measured runs (started before `before`, when given) that
 * exercised it, outside every rolled-back window and without a flagged role's error run. Newest first.
 */
export function baselineRuns<T extends RunLike>(scope: Pick<TrialScope, 'roles' | 'limit' | 'flagged'>, runs: readonly T[], windows: readonly [number, number][], before?: number): T[] {
  return runs
    .filter(isMeasuredRun)
    .filter((r) => before === undefined || r.summary.startedAt < before)
    .filter((r) => !windows.some(([a, b]) => r.summary.startedAt >= a && r.summary.startedAt <= b))
    .filter((r) => !isFlaggedErrorRun(r, scope.flagged) && exercises(r, scope))
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
    .slice(0, BASELINE_RUNS)
}

/** Roles below any of these role ids (their reportsTo chain passes through one), not themselves in it. */
function downstreamOf(roles: readonly Pick<Role, 'id' | 'slug' | 'reportsTo'>[], ids: ReadonlySet<string>): TrialRole[] {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const out: TrialRole[] = []
  for (const r of roles) {
    if (ids.has(r.id)) continue
    const seen = new Set<string>()
    let cur = r.reportsTo
    while (cur !== null && cur !== undefined && !seen.has(cur)) {
      if (ids.has(cur)) {
        out.push({ id: r.id, slug: r.slug })
        break
      }
      seen.add(cur)
      cur = byId.get(cur)?.reportsTo ?? null
    }
  }
  return out
}

/** Roles above any of these role ids (on the reportsTo chain from one of them to the root), not themselves in it. */
function upstreamOf(roles: readonly Pick<Role, 'id' | 'slug' | 'reportsTo'>[], ids: ReadonlySet<string>): TrialRole[] {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const out = new Map<string, TrialRole>()
  for (const id of ids) {
    const seen = new Set<string>([id])
    let cur = byId.get(id)?.reportsTo ?? null
    while (cur !== null && cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      const r = byId.get(cur)
      if (!r) break
      if (!ids.has(r.id) && !out.has(r.id)) out.set(r.id, { id: r.id, slug: r.slug })
      cur = r.reportsTo ?? null
    }
  }
  return [...out.values()]
}

/**
 * The scope of a plan applied to `chart` (the roles as they were before the change; `project` gives the concurrency
 * limit): patched roles, downstream roles, flagged roles and the limit change. The baseline is left empty for the caller.
 * Undefined when the plan's role patches are unreadable.
 */
export function scopeOf(chart: readonly Pick<Role, 'id' | 'slug' | 'reportsTo'>[], project: Pick<Project, 'maxConcurrentSubagents'>, plan: Pick<EvolutionPlan, 'rolePatches' | 'maxConcurrentSubagents'>, diagnosis?: Pick<TeamEvolutionDiagnosis, 'findings'>): TrialScope | undefined {
  if (!Array.isArray(chart) || !plan || !Array.isArray(plan.rolePatches)) return undefined
  const bySlug = new Map(chart.filter((r) => isObj(r) && typeof r.id === 'string' && typeof r.slug === 'string').map((r) => [r.slug, r]))
  const roles: TrialRole[] = []
  for (const p of plan.rolePatches) {
    const r = isObj(p) && typeof p.slug === 'string' ? bySlug.get(p.slug) : undefined
    if (!r) return undefined
    if (!roles.some((x) => x.id === r.id)) roles.push({ id: r.id, slug: r.slug, ...(r.reportsTo === null ? { root: true as const } : {}) })
  }
  const ids = new Set(roles.map((r) => r.id))
  const flagged = [...new Set((diagnosis?.findings ?? []).filter((f) => f.kind === 'tier_underprovisioned' && f.roleSlug).map((f) => f.roleSlug as string))]
    .map((s) => bySlug.get(s))
    .filter((r): r is Pick<Role, 'id' | 'slug' | 'reportsTo'> => !!r && !ids.has(r.id))
    .map((r) => ({ id: r.id, slug: r.slug }))
  const limit =
    typeof plan.maxConcurrentSubagents === 'number' ? { before: effectiveConcurrency(project), after: effectiveConcurrency({ maxConcurrentSubagents: plan.maxConcurrentSubagents }) } : undefined
  return {
    rule: 2,
    roles: roles.slice(0, MAX_SCOPE_ROLES),
    downstream: downstreamOf([...bySlug.values()], ids).slice(0, MAX_SCOPE_ROLES),
    upstream: upstreamOf([...bySlug.values()], ids).slice(0, MAX_SCOPE_ROLES),
    flagged: flagged.slice(0, MAX_SCOPE_ROLES),
    ...(limit && limit.before !== limit.after ? { limit } : {}),
    baseline: { patched: emptyFigures(), downstream: emptyFigures() }
  }
}

const rate = (n: number, d: number): number => (d > 0 ? r6(n / d) : 0)
const pts = (x: number): number => Math.round(x * 100)

/** Rule 1 (`own`) or rule 2 of the decision above on two sets of figures; the reason when it regressed, else undefined. */
function figuresRegressed(what: string, b: RoleFigures, t: RoleFigures, own: boolean): string | undefined {
  if (!b.agents || !t.agents) return undefined
  const bfp = rate(b.firstPass, b.agents)
  const tfp = rate(t.firstPass, t.agents)
  if (r6(bfp - tfp) > MAX_ROLE_FIRST_PASS_DROP) return `${what}: first pass fell ${pts(bfp - tfp)} points (${bfp} to ${tfp})`
  const bErr = rate(Math.max(b.errors, b.failedReceipts), b.agents)
  const tErr = rate(Math.max(t.errors, t.failedReceipts), t.agents)
  if (r6(tErr - bErr) > MAX_ROLE_FAILURE_RISE) return `${what}: errors per agent rose ${pts(tErr - bErr)} points (${bErr} to ${tErr})`
  if (b.assignments > 0 && t.assignments > 0) {
    const bEsc = rate(b.escalated, b.assignments)
    const tEsc = rate(t.escalated, t.assignments)
    if (r6(tEsc - bEsc) > MAX_ROLE_FAILURE_RISE) return `${what}: escalations rose ${pts(tEsc - bEsc)} points (${bEsc} to ${tEsc})`
  }
  if (own && r6(tfp - bfp) <= 0) {
    const costOk = b.costUsd > 0 && t.costUsd > 0
    const bx = costOk ? b.costUsd / b.agents : b.turns / b.agents
    const tx = costOk ? t.costUsd / t.agents : t.turns / t.agents
    if (bx > 0 && tx > 0 && r6(tx / bx - 1) > MAX_ROLE_COST_WORSENING) return `${what}: ${costOk ? 'cost' : 'turns'} per agent rose ${pts(tx / bx - 1)}% without a better first pass`
  }
  return undefined
}

const figuresLine = (what: string, b: RoleFigures, t: RoleFigures): string =>
  `${what}: first pass ${rate(b.firstPass, b.agents)} to ${rate(t.firstPass, t.agents)}, errors ${rate(Math.max(b.errors, b.failedReceipts), b.agents)} to ${rate(Math.max(t.errors, t.failedReceipts), t.agents)}, cost per agent ${rate(b.costUsd, b.agents)} to ${rate(t.costUsd, t.agents)} (${b.agents} to ${t.agents} agents)`

/**
 * Rules 1 to 3 and the inconclusive cases of 5 on a full window (newest last or any order). `spanErrors`: the error runs
 * that started between the apply and the last window run without exercising the change; they join rule 3 unless
 * provably unrelated. Pure.
 */
export function judgeTrial(scope: TrialScope, baselineMetrics: EvolutionMetrics, windowRuns: readonly RunLike[], spanErrors: readonly RunLike[] = []): { regressed: boolean; reason: string; inconclusive?: boolean } {
  const parts: string[] = []
  if (!(baselineMetrics.runs >= MIN_BASELINE_RUNS)) return { regressed: true, inconclusive: true, reason: `inconclusive: the baseline holds ${Number(baselineMetrics.runs) || 0} runs (${MIN_BASELINE_RUNS} needed), too few to compare with` }
  // The root keeps no figures of its own in a run digest: a root patch is judged on its reports and the team (rules 2, 3).
  const measured = scope.roles.filter((r) => !r.root)
  if (measured.length < scope.roles.length) parts.push('the root\'s own figures are not measured')
  if (measured.length) {
    const b = scope.baseline.patched
    const t = figuresOf(windowRuns, measured)
    if (!b.agents) return { regressed: true, inconclusive: true, reason: 'inconclusive: no clean run before the change used the changed role, so there is nothing to compare with' }
    // A scope stored before the baseline minimums (apply now refuses thinner ones): never promoted on fewer agents.
    if (b.agents < MIN_BASELINE_ROLE_AGENTS) return { regressed: true, inconclusive: true, reason: `inconclusive: the changed role had only ${b.agents} agents in clean runs before the change (${MIN_BASELINE_ROLE_AGENTS} needed)` }
    if (!t.agents) return { regressed: true, inconclusive: true, reason: 'inconclusive: the changed role ran in none of the trial runs' }
    const r = figuresRegressed('the changed role', b, t, true)
    if (r) return { regressed: true, reason: r }
    parts.push(figuresLine('changed role', b, t))
  }
  if (scope.downstream.length) {
    const b = scope.baseline.downstream
    const t = figuresOf(windowRuns, scope.downstream)
    const r = figuresRegressed('its reports', b, t, false)
    if (r) return { regressed: true, reason: r }
    if (b.agents && t.agents) parts.push(figuresLine('reports', b, t))
  }
  const guard = windowRuns.filter((r) => !provablyUnrelated(r, scope))
  if (!guard.length) return { regressed: true, inconclusive: true, reason: 'inconclusive: every trial run carried the errors of an open, unrelated defect' }
  const counted = spanErrors.filter((r) => errorRun(asDigest(r)) && !provablyUnrelated(r, scope))
  const team = compareMetrics(baselineMetrics, measure([...guard, ...counted], 8, { includeInterrupted: true }))
  const extra = counted.length ? ` (with ${counted.length} error ${counted.length === 1 ? 'run' : 'runs'} in the trial that did not use the change)` : ''
  if (team.regressed) return { regressed: true, reason: `team${extra}: ${team.reason}` }
  parts.push(`team${extra}: ${team.reason}`)
  return { regressed: false, reason: parts.join('; ') }
}

/**
 * Decide an active trial (trial rule 2, above). Only runs that STARTED at or after the apply count (a run in flight at
 * apply time ran on the old chart). `gen.scope` absent = every run counts and only the whole-team rule applies (the
 * service always gives a scope; this keeps the function total). `opts.trialRuns`: how many trial runs the caller knows
 * started since the apply, when it handed over only a prefix of them. `opts.oldRuleToo` (a trial opened before rule 2,
 * judged on a rebuilt per-role scope): it must also pass the old whole-team rule, compareMetrics of its stored baseline
 * against the first `evalWindowRuns` trial runs after the apply, exercised or not. Pure. `runs` are run digests or records.
 */
export function evaluateActiveTrial(gen: Pick<StoredGeneration, 'appliedAt' | 'evalWindowRuns' | 'baselineMetrics' | 'scope'>, runs: readonly RunLike[], _limit = 8, opts?: { trialRuns?: number; oldRuleToo?: boolean }): TrialDecision {
  const need = clampWindow(gen.evalWindowRuns)
  const cap = trialRunCap(need)
  const scope = gen.scope ?? EVERY_RUN_SCOPE
  const since = runs
    .filter((r) => isTrialRun(r) && r.summary.startedAt >= gen.appliedAt)
    .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
    .slice(0, cap)
    .map(asDigest)
  const total = Math.min(cap, Math.max(opts?.trialRuns ?? 0, since.length))
  const windowRuns = since.filter((d) => exercises(d, scope, { attempts: true })).slice(0, need)
  if (windowRuns.length < need) {
    if (total < cap) return { state: 'pending', have: windowRuns.length, need, runs: total, cap }
    return {
      state: 'decided',
      regressed: true,
      inconclusive: true,
      trialMetrics: measure(windowRuns, 8, { includeInterrupted: true }),
      reason: `inconclusive: only ${windowRuns.length} of ${cap} runs since the change used the changed role${scope.limit && !scope.roles.length ? ' or limit' : ''} (${need} needed)`
    }
  }
  const trialMetrics = measure(windowRuns, 8, { includeInterrupted: true })
  const interrupted = windowRuns.filter(isInterruptedTrialRun).length
  if (interrupted > 0) {
    const c = compareMetrics(gen.baselineMetrics, trialMetrics)
    return {
      state: 'decided',
      regressed: true,
      trialMetrics,
      reason: c.regressed
        ? `trial run interrupted/timed out (${interrupted}/${windowRuns.length}): ${c.reason}`
        : `trial run interrupted/timed out (${interrupted}/${windowRuns.length})`
    }
  }
  // Error runs inside the trial's span (apply to the last window run) that did not exercise the change still count
  // against it in rule 3, unless provably unrelated.
  const last = windowRuns[windowRuns.length - 1].summary.startedAt
  const inWindow = new Set(windowRuns)
  const spanErrors = since.filter((d) => d.summary.startedAt <= last && !inWindow.has(d) && errorRun(d))
  const j = judgeTrial(scope, gen.baselineMetrics, windowRuns, spanErrors)
  if (!j.regressed && opts?.oldRuleToo) {
    const old = compareMetrics(gen.baselineMetrics, measure(since.slice(0, need), 8, { includeInterrupted: true }))
    if (old.regressed) return { state: 'decided', regressed: true, trialMetrics, reason: `the rule this trial was opened under: ${old.reason}` }
  }
  return { state: 'decided', regressed: j.regressed, trialMetrics, reason: j.reason, ...(j.inconclusive ? { inconclusive: true } : {}) }
}
