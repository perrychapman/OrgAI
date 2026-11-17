import { compareTier, effectiveSubagentLimits } from '../../shared/defaults'
import { settleSpend, type SpendKey } from '../../shared/roleSpend'
import type { EvolutionGateViolation, EvolutionPlan, EvolutionRolePatch, EvolutionSpendRaise, Project } from '../../shared/types'
import { applyPlan, effectiveTier, isPlanEmpty } from './plan'
import { validateEvolutionPlan, type GateOptions } from './ratchet'

/**
 * Which parts of an evolution plan may make runs spend more, judged by the team files gate's own rule: a role's model,
 * effort and staffing through shared/roleSpend.ts settleSpend (the "May spend more" rows a person must approve when the
 * same change arrives through `.orgai/` files), and the project's concurrency limit the way teamFiles/gate.ts judges
 * `maxConcurrentSubagents` (a higher effective limit). Such a part is applied only when the person approved the reviewed
 * plan (EvolveApplyInput.allowSpendRaise); unattended passes hold it. Pure.
 */

const FIELD: Record<SpendKey, EvolutionSpendRaise['field']> = { tier: 'tier', model: 'tier', effort: 'effort', staffing: 'staffing' }
/** Never cut: a person decides on this text (role names are bounded by the project store). */
const clip = (s: string): string => s

const concurrencyOf = (p: Pick<Project, 'maxConcurrentSubagents'>): number => effectiveSubagentLimits({ maxConcurrentSubagents: p.maxConcurrentSubagents }).concurrency

/** Every part of `plan` that may make runs of `project` spend more, one entry per role field (and one for the limit). */
export function spendRaisesOf(project: Project, plan: Pick<EvolutionPlan, 'rolePatches' | 'maxConcurrentSubagents'>): EvolutionSpendRaise[] {
  const out: EvolutionSpendRaise[] = []
  for (const p of plan.rolePatches) {
    const role = project.roles.find((r) => r.slug === p.slug)
    if (!role) continue
    const after = applyPlan({ ...project, roles: [role] }, { rolePatches: [p] }).roles[0]
    const who = role.name || role.slug
    const settled = settleSpend(role, after, [project.staffing], who)
    const seen = new Set<EvolutionSpendRaise['field']>()
    // The model a role runs on is judged by the tier it really runs on (effectiveTier: a tier name or Claude alias in
    // `model` wins over `tier`), never by the `tier` fields alone: `{ model: 'everyday', tier: 'deep' }` patched to deep
    // moves from the everyday model to the deep one although both `tier` fields read deep (review fix-50 H-1).
    if (p.tier !== undefined && (role.model !== after.model || role.tier !== after.tier)) {
      const was = effectiveTier(role)
      const now = effectiveTier(after)
      if (!was || !now || compareTier(now, was) > 0) {
        seen.add('tier')
        out.push({ roleSlug: role.slug, field: 'tier', summary: was && now ? `${who} moves from the ${was} tier to the ${now} tier. This may spend more.` : `${who}'s model changes and may spend more.` })
      }
    }
    for (const h of settled.held) {
      // The model row is decided above (settleSpend compares only the `tier` fields), unless settleSpend attached other
      // rises of the whole change to it (a floor switched on, a role turning automatic): those are still a raise.
      if (h.id === 'model' || h.id === 'tier') {
        if (h.states.length && !seen.has('tier')) {
          seen.add('tier')
          out.push({ roleSlug: role.slug, field: 'tier', summary: clip(h.summary) })
        }
        continue
      }
      const field = FIELD[h.id]
      if (seen.has(field)) continue
      seen.add(field)
      out.push({ roleSlug: role.slug, field, summary: clip(h.summary) })
    }
  }
  if (plan.maxConcurrentSubagents !== undefined) {
    const before = concurrencyOf(project)
    const after = concurrencyOf({ maxConcurrentSubagents: plan.maxConcurrentSubagents })
    if (after > before) out.push({ field: 'concurrency', summary: `The subagent limit rises from ${before} to ${after}, so more reports may run at the same time. This may spend more.` })
  }
  return out
}

/** The patch without the fields the raises name. */
function stripPatch(p: EvolutionRolePatch, raises: readonly EvolutionSpendRaise[]): EvolutionRolePatch {
  const out: EvolutionRolePatch = { ...p }
  for (const r of raises) {
    if (r.roleSlug !== p.slug) continue
    if (r.field === 'tier') delete out.tier
    else if (r.field === 'effort') delete out.effort
    else if (r.field === 'staffing') delete out.staffing
  }
  return out
}

const hasChange = (p: EvolutionRolePatch): boolean =>
  p.tier !== undefined || p.effort !== undefined || p.staffing !== undefined || p.prompt !== undefined || !!p.addTools?.length || !!p.removeTools?.length || !!p.removeSkills?.length

/**
 * `plan` with every part that may spend more taken out, re-checked by the safety gate (`gate`, the same options the
 * plan was made with), and the held parts both returned and recorded as 'spend_held' violations (action 'trimmed').
 * Repeats until nothing left raises spend; when that cannot be reached in a few rounds, every sizing field (tier, effort,
 * staffing) and the limit are dropped. The returned plan never raises spend (`spendRaisesOf` is empty). Pure.
 */
export function holdSpendRaises(project: Project, plan: EvolutionPlan, gate: GateOptions): { plan: EvolutionPlan; held: EvolutionSpendRaise[] } {
  const held: EvolutionSpendRaise[] = []
  const known = (r: EvolutionSpendRaise): boolean => held.some((h) => h.roleSlug === r.roleSlug && h.field === r.field)
  let cur = plan
  for (let round = 0; round < 4; round++) {
    const raises = spendRaisesOf(project, cur)
    if (!raises.length) break
    for (const r of raises) if (!known(r)) held.push(r)
    cur = regate(project, cur, { ...cur, rolePatches: cur.rolePatches.map((p) => stripPatch(p, raises)).filter(hasChange), ...(raises.some((r) => r.field === 'concurrency') ? { maxConcurrentSubagents: undefined } : {}) }, gate)
  }
  if (spendRaisesOf(project, cur).length) {
    // Fail closed: nothing that sizes a run is applied.
    const sizing = cur.rolePatches.map((p) => {
      const { tier: _t, effort: _e, staffing: _s, ...rest } = p
      return rest
    })
    cur = regate(project, cur, { ...cur, rolePatches: sizing.filter(hasChange), maxConcurrentSubagents: undefined }, gate)
  }
  const violations: EvolutionGateViolation[] = held.map((h) => ({ rule: 'spend_held', message: `Held (may spend more; needs your approval): ${h.summary}`, action: 'trimmed', ...(h.roleSlug ? { roleSlug: h.roleSlug } : {}) }))
  cur.gate.violations.push(...violations)
  cur.spendRaises = []
  return { plan: cur, held }
}

/** Re-run the gate on a reduced plan and keep the earlier verdict's notes (a reduced plan only loses parts). */
function regate(project: Project, before: EvolutionPlan, reduced: EvolutionPlan, gate: GateOptions): EvolutionPlan {
  const { maxConcurrentSubagents, ...rest } = reduced
  const next = validateEvolutionPlan(project, maxConcurrentSubagents === undefined ? rest : reduced, gate)
  const key = (v: EvolutionGateViolation): string => `${v.rule}\u0000${v.roleSlug ?? ''}\u0000${v.message}`
  const seen = new Set(next.gate.violations.map(key))
  next.gate.violations = [...before.gate.violations.filter((v) => !seen.has(key(v))), ...next.gate.violations]
  next.gate.ok = !next.gate.violations.some((v) => v.action === 'rejected')
  next.empty = isPlanEmpty(next)
  return next
}
