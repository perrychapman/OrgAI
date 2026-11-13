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
  RunRecord,
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
import { measuredRuns, measure } from './telemetry'

/**
 * The safety gate and the ledger of the Pareto-Ratchet. The gate is a spend and security boundary: it fails closed, it
 * rebuilds the plan field by field (nothing it does not know survives) and every rule has a test with a violating plan.
 */

// ---------- safety gate -------------------------------------------------------------------------------------------------

export interface GateOptions {
  /** Rejected hypotheses: a plan or a patch with one of these fingerprints is refused / trimmed. */
  rejected?: readonly Pick<EvolutionRejectedHypothesis, 'fingerprint'>[]
  /** The diagnosis behind the plan: only roles with a tier_underprovisioned finding may be raised. Absent = no raises. */
  diagnosis?: Pick<TeamEvolutionDiagnosis, 'findings'>
  /** Roles patched in either of the last two decided generations: no new patch for them (anti-oscillation). */
  cooldownSlugs?: readonly string[]
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
  const withFinding = new Set(findings.filter((f) => f.roleSlug).map((f) => f.roleSlug as string))
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
    const userOnly = cur === 'top' || role.effort === 'xhigh' || role.effort === 'max' || role.staffing?.minTier === 'top' || role.staffing?.maxEffort === 'xhigh' || role.staffing?.maxEffort === 'max'

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
}

export interface Ledger {
  version: 1
  projectId: string
  generations: StoredGeneration[]
  rejectedHypotheses: EvolutionRejectedHypothesis[]
}

export const emptyLedger = (projectId: string): Ledger => ({ version: 1, projectId, generations: [], rejectedHypotheses: [] })

export function ledgerPath(dataDir: string, projectId: string): string {
  if (!isValidProjectId(projectId)) throw new Error('Invalid project id')
  return join(dataDir, 'evolution', `${projectId}.json`)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function sanitizeLedger(raw: unknown, projectId: string): Ledger | null {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.generations) || !Array.isArray(raw.rejectedHypotheses)) return null
  const gens = raw.generations.filter((g): g is StoredGeneration => isObj(g) && typeof g.id === 'string' && (g.status === 'trial' || g.status === 'promoted' || g.status === 'rolled_back') && isObj(g.snapshot) && isObj(g.baselineMetrics) && isObj(g.plan))
  const rej = raw.rejectedHypotheses.filter((r): r is EvolutionRejectedHypothesis => isObj(r) && typeof r.fingerprint === 'string' && typeof r.summary === 'string' && typeof r.reason === 'string' && typeof r.at === 'number')
  const keep = new Set(gens.slice(-MAX_GENERATIONS))
  const trial = gens.find((g) => g.status === 'trial')
  if (trial) keep.add(trial)
  return { version: 1, projectId, generations: gens.filter((g) => keep.has(g)), rejectedHypotheses: rej.slice(-MAX_REJECTED) }
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
  const bounded: Ledger = { ...ledger, generations: gens, rejectedHypotheses: ledger.rejectedHypotheses.slice(-MAX_REJECTED) }
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

/** The ledger as callers see it: no snapshots. */
export function toHistory(l: Ledger): EvolutionHistory {
  const generations: EvolutionGeneration[] = l.generations.slice(-MAX_GENERATIONS).map(({ snapshot: _s, ...g }) => g)
  const champion = [...l.generations].reverse().find((g) => g.status === 'promoted')
  const trial = trialOf(l)
  return {
    projectId: l.projectId,
    generations,
    ...(champion ? { championId: champion.id } : {}),
    ...(trial ? { trialId: trial.id } : {}),
    rejectedHypotheses: l.rejectedHypotheses.slice(-MAX_REJECTED)
  }
}

export const nextGenerationId = (l: Ledger): string => {
  const max = l.generations.reduce((m, g) => Math.max(m, Number(/^gen_(\d+)$/.exec(g.id)?.[1] ?? 0)), 0)
  return `gen_${max + 1}`
}

export function addRejected(l: Ledger, r: Omit<EvolutionRejectedHypothesis, 'summary' | 'reason'> & { summary: string; reason: string }): void {
  l.rejectedHypotheses = [...l.rejectedHypotheses.filter((x) => !(x.fingerprint === r.fingerprint && x.reason === r.reason)), { ...r, summary: cap(r.summary, 240), reason: cap(r.reason, 240) }].slice(-MAX_REJECTED)
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

export type TrialDecision = { state: 'pending'; have: number; need: number } | { state: 'decided'; regressed: boolean; trialMetrics: EvolutionMetrics; reason: string }

/**
 * Decide an active trial. The window is the first `evalWindowRuns` finished work runs that STARTED at or after the
 * generation was applied (a run in flight at apply time ran on the old chart, so it never counts; this is equivalent to
 * counting runs since `appliedAtRunCount` and does not depend on how many records the store lists). Pure.
 */
export function evaluateActiveTrial(gen: Pick<EvolutionGeneration, 'appliedAt' | 'evalWindowRuns' | 'baselineMetrics'>, runs: RunRecord[], limit = 8): TrialDecision {
  const need = clampWindow(gen.evalWindowRuns)
  const since = measuredRuns(runs, 50)
    .filter((r) => r.summary.startedAt >= gen.appliedAt)
    .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
  if (since.length < need) return { state: 'pending', have: since.length, need }
  const trialMetrics = measure(since.slice(0, need), limit)
  const c = compareMetrics(gen.baselineMetrics, trialMetrics)
  return { state: 'decided', regressed: c.regressed, trialMetrics, reason: c.reason }
}
