// Run staffing resolver (docs/design/orchestration-efficiency.md 4.3, decisions D1, D2, D9): the one place that decides
// which tier, model and effort a spawned agent actually runs on. The orchestrator proposes (PlanStep.staff or values on
// the spawn call), this module clamps the proposal to what the org chart allows, never spends above the chart, and says
// why. Adapters (Claude spawn hook, Codex spawn_report, mock) call resolveStaffing at spawn time, apply the result only
// when `overrides` is true, and record it with recordStaffing.
//
// Pure: no I/O, no clock (staffingAssignment takes `now`), no imports from adapters. Types live in shared/types.ts
// ("Run staffing"); normalizers and effective values in shared/defaults.ts.

import {
  compareEffort,
  compareTier,
  effectiveRoleStaffing,
  nearestTiers,
  RUN_STAFFING_ASSIGNMENTS_MAX,
  settingTier,
  STAFFING_NOTE_MAX_CHARS,
  staffingGoalOf,
  staffingModeOf,
  tierForModel
} from '@shared/defaults'
import {
  EFFORTS,
  isEffort,
  isModelTier,
  MODEL_TIERS,
  type Effort,
  type ModelTier,
  type Project,
  type Role,
  type RunPlan,
  type RunStaffing,
  type StaffingAssignment,
  type StaffingGoal,
  type StaffingMode,
  type StaffingSource
} from '@shared/types'
import type { RuntimeContext } from './types'

/**
 * A tier and / or effort somebody asked for. Either field may be absent ("no preference"). Values that are not a known
 * ModelTier / Effort are ignored as if absent.
 */
export interface StaffingRequest {
  tier?: ModelTier
  effort?: Effort
}

export interface ResolveStaffingInput {
  /**
   * The role being spawned. Only model, tier, effort and staffing are read (a whole Role is fine). `model` is the
   * chart's value: 'inherit', a tier name, a legacy Claude alias (fable, opus, sonnet, haiku) or a concrete model id.
   */
  role: Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'>
  /** The project; only `staffing` is read (Project.staffing 'fixed' makes every role fixed). */
  project: Pick<Project, 'staffing'>
  /**
   * The resolved tier of the agent that spawns this one (its ResolvedStaffing.tier, or the root's chart tier). Used
   * only for a role whose model is 'inherit' and that has no tier of its own: it is that role's tier ceiling and its
   * chart tier. Without it such a role cannot be sized and runs as configured (fixed).
   */
  parentTier?: ModelTier
  /**
   * What the orchestrator asked for: the bound plan step's staff with values on the spawn call winning field by field
   * (staffRequestForSpawn builds it). Absent or empty = no request.
   */
  requested?: StaffingRequest
  /** The project profile's default, used field by field when nothing was requested (phase 4 supplies it; absent today). */
  profile?: StaffingRequest
  /** The connection's tier -> model id map (RunConnection.tierModels). Entries are trimmed; an empty one counts as absent. */
  tierModels: Partial<Record<ModelTier, string>>
  /** Efforts the adapter can send (defaults.ts effortOptionsFor(adapter)). Empty = the adapter never sends an effort. */
  adapterEfforts: readonly Effort[]
  /** The plan guard is engaged (usage near the weekly limit): deep and top assignments go to everyday. */
  planGuard?: boolean
  /**
   * The tier an 'inherit' role runs on when the spawn writes no model: the main thread's (the root's) live tier. Read
   * only by the plan guard of a fixed (or unsizable) 'inherit' role, so the guard is judged on the model 'inherit'
   * resolves to even when parentTier is unknown (a parent from before a resume) or names no deep tier.
   */
  inheritTier?: ModelTier
  /**
   * This spawn retries an attempt that failed verification or came back unresolved; the value is what that attempt ran
   * on (its ResolvedStaffing tier and effort; a missing field = what the role resolves to by default). The result goes
   * at most one step up, in tier or in effort, never past the ceilings and never into `top` (D9).
   */
  escalatedFrom?: StaffingRequest
  /**
   * The run's staffing goal. With 'cost', an auto role nobody asked anything of (no request, no profile value) starts one
   * tier below its ceiling (never below minTier) and, with no effort of its own, at 'medium' (never above the effort
   * ceiling), instead of the ceiling. Absent or other goals: unchanged.
   */
  goal?: StaffingGoal
}

/**
 * Why a 'clamped' (or fallback 'role') result moved away from what was asked. Read by staffingLabel.
 * - 'ceiling': above the role's tier or effort ceiling, brought down to it;
 * - 'floor': below the role's minTier, raised to it;
 * - 'connection': the connection has no model for the tier, so the nearest mapped tier inside the bounds was used;
 * - 'unmapped': no tier inside the bounds has a model, so the role's own model is used (source 'role').
 */
export type StaffingAdjustment = 'ceiling' | 'floor' | 'connection' | 'unmapped'

export interface ResolvedStaffing {
  /**
   * 'fixed' when the role is fixed (effectiveRoleStaffing), or is auto but no tier ceiling is known for it (an
   * 'inherit' role without parentTier, a concrete model no tier name describes): it then runs exactly as configured.
   */
  mode: StaffingMode
  /**
   * Undefined only for a fixed result whose tier is unknown: a concrete model no tier describes, or an 'inherit' role
   * without parentTier.
   */
  tier?: ModelTier
  /**
   * The model id to run on: tierModels[tier] for an auto result, else the role's own model (for a fixed role this may
   * be 'inherit'). Never empty when tierModels has an entry or the role has a model. For the Claude spawn hook, write
   * CLAUDE_TIER_ALIAS[tier] instead: the SDK accepts only aliases there.
   */
  model: string
  /** Undefined = send no effort (the adapter's default applies). Always one of adapterEfforts for an auto result. */
  effort?: Effort
  source: StaffingSource
  /** One short human sentence when the result differs from what was asked or from the role's own setting. */
  note?: string
  /**
   * True when tier or effort differs from the role's chart values (so the adapter must override at spawn): tierChanged
   * or effortChanged. Tiers are compared, not model strings, when the role has a tier; an 'inherit' role's chart tier
   * is parentTier.
   */
  overrides: boolean
  /**
   * True when the tier differs from the tier the chart runs this role on (for an 'inherit' role: parentTier). An adapter
   * changes a spawn's model only then: an effort-only override must leave the model alone, since a tier's alias or
   * mapped id is not always the model the role would otherwise run on (an inherited or switched model).
   */
  tierChanged: boolean
  /** True when the effort differs from the role's own effort. An adapter changes a spawn's effort only then. */
  effortChanged: boolean
  /** The values a clamp moved away from (only the fields that moved). Present only with `adjustment`. */
  asked?: StaffingRequest
  /** Why the result was moved; present only when source is 'clamped', or 'role' after an 'unmapped' fallback. */
  adjustment?: StaffingAdjustment
}

/**
 * Tier -> the Claude alias the spawn hook writes as `model`. The Claude SDK accepts only these aliases as a per-spawn
 * model (`updatedInput.model` on an Agent call); a full model id fails the tool's schema validation
 * (docs/agent-notes/sdk-facts.md, "Verified against v0.3.318 by scripts/smoke-staffing.mjs"). On a proxy connection the
 * alias resolves to the connection's model for the tier through ANTHROPIC_DEFAULT_*_MODEL. It is the inverse of
 * defaults.ts CLAUDE_ALIAS_TIERS (not exported; settingTier(alias) reads it, and staffing.test.ts checks they agree).
 */
export const CLAUDE_TIER_ALIAS: Record<ModelTier, 'fable' | 'opus' | 'sonnet' | 'haiku'> = {
  top: 'fable',
  deep: 'opus',
  everyday: 'sonnet',
  fast: 'haiku'
}

/** The effort assumed for an attempt that sent none (the adapters' default level, sdk-facts.md: `medium`). */
const DEFAULT_EFFORT_BASELINE: Effort = 'medium'

/** The effort ceiling of an auto role that sets neither `effort` nor `staffing.maxEffort`. */
const UNSET_EFFORT_CEILING: Effort = 'high'

// ---------- Wording (the one table of user-facing text) ----------

const WORDS = {
  label: {
    orchestrator: 'chosen by the orchestrator',
    profile: 'from the project profile',
    role: "the role's setting",
    fixed: 'fixed by the role',
    planGuard: 'usage guard',
    escalated: 'escalated after a failed attempt',
    ceiling: (asked: string) => `capped by the role: asked for ${asked}`,
    floor: (asked: string) => `raised to the role's minimum: asked for ${asked}`,
    connection: (asked: string) => `no ${asked} model on this connection`,
    unmapped: 'no model mapped within the role\'s limits'
  },
  note: {
    fixedIgnored: (asked: string) => `the role is fixed, so the request for ${asked} was ignored`,
    fixedNoEscalation: 'the role is fixed, so the retry was not escalated',
    projectFixedIgnored: (asked: string) => `the project's staffing is fixed, so the request for ${asked} was ignored`,
    projectFixedNoEscalation: "the project's staffing is fixed, so the retry was not escalated",
    noCeilingIgnored: (asked: string) =>
      `no tier ceiling is known for the role (it inherits and the parent's tier is unknown, or its model names no tier), so it runs as configured and the request for ${asked} was ignored`,
    noCeilingNoEscalation:
      "no tier ceiling is known for the role (it inherits and the parent's tier is unknown, or its model names no tier), so the retry was not escalated",
    tierCeiling: (who: string, asked: ModelTier, allowed: ModelTier) => `${who} ${asked}, the role allows up to ${allowed}`,
    tierFloor: (who: string, asked: ModelTier, floor: ModelTier) => `${who} ${asked}, the role needs at least ${floor}`,
    effortCeiling: (who: string, asked: Effort, allowed: Effort) => `${who} ${asked} effort, the role allows up to ${allowed}`,
    picked: (who: string, picked: string, chart: string) => `${who} picked ${picked}; the role is set to ${chart}`,
    escalationCut: (asked: string, ran: string) => `a retry goes at most one step up: asked for ${asked}, runs on ${ran}`,
    escalationNoTop: 'a retry never escalates into the top tier',
    escalatedEffort: (from: string, to: Effort) => `retry escalated effort from ${from} to ${to}`,
    escalatedTier: (from: ModelTier, to: ModelTier) => `retry escalated tier from ${from} to ${to}`,
    escalationNoRoom: "retry not escalated: already at the role's limits",
    planGuard: (to: string, from: string) =>
      `on the everyday tier (${to}) instead of ${from}: the weekly usage window is near its limit`,
    connectionLower: (tier: ModelTier, to: ModelTier) => `the connection has no model for ${tier}, so ${to} was used`,
    unmapped: (tier: ModelTier) => `the connection has no model for ${tier} or any tier within the role's limits, so the role's own model was used`,
    adapterEffort: (asked: Effort, to: Effort) => `the adapter does not support ${asked} effort, so ${to} was used`,
    adapterNoEffort: 'the adapter sends no effort, so its default applies'
  }
} as const

/** Who asked, for notes. */
const ASKER: Record<'orchestrator' | 'profile' | 'role' | 'escalation', string> = {
  orchestrator: 'the orchestrator asked for',
  profile: 'the project profile asked for',
  role: "the role's own setting is",
  escalation: 'the retry asked for'
}

// ---------- Small pure helpers ----------

/** "deep / high", "deep", "high" (an effort alone), or "" when empty. */
function fmt(req: StaffingRequest | undefined): string {
  return [req?.tier, req?.effort].filter(Boolean).join(' / ')
}

/** Keep only valid fields; undefined when nothing valid remains. */
function cleanRequest(req: StaffingRequest | undefined): StaffingRequest | undefined {
  if (!req || typeof req !== 'object') return undefined
  const out: StaffingRequest = {}
  if (isModelTier(req.tier)) out.tier = req.tier
  if (isEffort(req.effort)) out.effort = req.effort
  return out.tier || out.effort ? out : undefined
}

/** The next more capable tier, or undefined above top. */
function tierUp(t: ModelTier): ModelTier | undefined {
  const i = MODEL_TIERS.indexOf(t)
  return i > 0 ? MODEL_TIERS[i - 1] : undefined
}

/** The next less capable tier, or undefined below fast. */
function tierDown(t: ModelTier): ModelTier | undefined {
  const i = MODEL_TIERS.indexOf(t)
  return i >= 0 && i < MODEL_TIERS.length - 1 ? MODEL_TIERS[i + 1] : undefined
}

/** The next higher effort, or undefined above max. */
function effortUp(e: Effort): Effort | undefined {
  const i = EFFORTS.indexOf(e)
  return i >= 0 && i < EFFORTS.length - 1 ? EFFORTS[i + 1] : undefined
}

/** The trimmed model a connection maps for `tier`, or undefined. */
function mapped(tierModels: Partial<Record<ModelTier, string>> | undefined, tier: ModelTier): string | undefined {
  const m = tierModels?.[tier]
  return typeof m === 'string' && m.trim() ? m.trim() : undefined
}

/** `text` cut to STAFFING_NOTE_MAX_CHARS without splitting a surrogate pair. */
export function capNote(text: string): string {
  if (text.length <= STAFFING_NOTE_MAX_CHARS) return text
  let t = text.slice(0, STAFFING_NOTE_MAX_CHARS)
  const last = t.charCodeAt(t.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1)
  return t
}

function joinNotes(notes: string[]): string | undefined {
  if (!notes.length) return undefined
  const s = notes.join('; ')
  return capNote(s.charAt(0).toUpperCase() + s.slice(1) + '.')
}

/**
 * Whether a model setting runs on the deep or top tier: a tier name or legacy Claude alias naming deep / top, a full
 * Claude id of the opus or fable family, or the connection's own deep / top model id. The same predicate as the Claude
 * adapter's plan guard (claude.ts isDeepOrTopModel), replicated here so this module imports nothing from adapters.
 */
export function isDeepOrTopModelRef(model: string | undefined, tierModels: Partial<Record<ModelTier, string>> | undefined): boolean {
  const m = model?.trim()
  if (!m) return false
  const tier = settingTier(m) ?? tierForModel(m)
  if (tier === 'deep' || tier === 'top') return true
  return m === tierModels?.deep?.trim() || m === tierModels?.top?.trim()
}

/**
 * The tier a role's own model setting runs on, the one reading the resolver and the Claude adapter (claude.ts
 * definitionTier) share. The agent definition sends `role.model` itself, so a tier name or Claude alias decides first
 * (a role with model `opus` and tier `everyday` runs on opus); a concrete id runs on the role's chart tier (`role.tier`),
 * else, with `byFamily`, the tier its family names (tierForModel; the resolver never derives a ceiling that way).
 * Undefined for 'inherit' or an empty model (the caller supplies the parent's or root's tier) and when nothing is known.
 * Pure.
 */
export function roleModelTier(role: Pick<Role, 'model' | 'tier'>, byFamily = false): ModelTier | undefined {
  const model = typeof role.model === 'string' ? role.model.trim() : ''
  if (!model || model === 'inherit') return undefined
  return settingTier(model) ?? (isModelTier(role.tier) ? role.tier : undefined) ?? (byFamily ? tierForModel(model) : undefined)
}

// ---------- resolveStaffing ----------

/**
 * Decide the tier, model and effort a spawned agent runs on, and why. Pure. Rules, in order:
 *
 * 1. effectiveRoleStaffing(role, project) decides the mode. 'fixed': the role's own model, tier and effort exactly as
 *    configured, source 'role', overrides false; a request (or escalation) is ignored with a note. Only the plan
 *    guard (6) still applies.
 * 2. Bounds (auto). Tier ceiling: for a role on its own model, roleModelTier (the tier a tier name or legacy alias in
 *    `model` names, else the role's tier), which is what its agent definition runs on; for an 'inherit' role, its tier,
 *    else parentTier. No ceiling known: treated as fixed (mode 'fixed'), never guessed upward. Floor:
 *    staffing.minTier when not above the ceiling. Effort ceiling: staffing.maxEffort ?? role.effort ?? 'high' (xhigh
 *    and max only when the chart allows them).
 * 3. Pick (auto). tier = requested ?? profile ?? ceiling; effort = requested ?? profile ?? role.effort (may stay
 *    undefined: no effort is sent and the adapter's default, DEFAULT_EFFORT_BASELINE, applies). Exception: when the
 *    effort is still undefined after rules 4 to 7 and the effort ceiling is below that default (a maxEffort of low on
 *    a role with no effort), the ceiling is sent, so the default never runs above the cap; this is skipped when the
 *    adapter sends no effort at all, and effortChanged is then true. Source 'orchestrator' when a requested field was
 *    used, else 'profile' when a profile field was used, else 'role'.
 * 4. Clamp into the bounds; any clamp gives source 'clamped' and a note naming what was asked and what was allowed.
 *    `top` results only when the ceiling is top (D9).
 * 5. Escalation (escalatedFrom set): with a request, missing request fields default to the previous attempt's values
 *    (not the profile); the result is at most one step above the previous attempt in tier OR in effort (tier kept
 *    when both were raised), never into `top` unless the previous attempt was already on top; source 'escalated'
 *    unless a clamp applied. Without a request: effort one step up when there is room (within the effort ceiling and
 *    the adapter's efforts), else tier one step up when there is room (within the ceiling, not top, mapped on the
 *    connection), else nothing changes and the note says so (source stays 'escalated').
 * 6. Plan guard: a deep or top result goes to everyday (source 'plan-guard') when the connection maps an everyday
 *    model different from the one it would have run on; otherwise nothing changes. It applies after the clamp and may
 *    go below minTier (the user's usage setting outranks the role's floor). A fixed result is steered when its chart
 *    tier or model is deep or top, or, for an 'inherit' role, when inheritTier is.
 * 7. Availability: an unmapped tier moves to the nearest lower mapped tier not below the floor, else the nearest higher
 *    one not above the ceiling (source 'clamped' unless the plan guard set it); else the role's own model and chart
 *    tier with the effort resolved so far, source 'role', adjustment 'unmapped'.
 * 8. Effort vs adapter: an effort the adapter cannot send becomes the nearest supported one at or below it, else the
 *    lowest supported; an empty adapterEfforts means no effort at all. This adds a note but does not change source.
 * 9. model = tierModels[tier]; overrides = tier or effort differs from the role's chart values.
 */
export function resolveStaffing(input: ResolveStaffingInput): ResolvedStaffing {
  const { role, project, parentTier, tierModels, adapterEfforts, planGuard, escalatedFrom } = input
  const requested = cleanRequest(input.requested)
  const profile = cleanRequest(input.profile)
  const eff = effectiveRoleStaffing(role, project)
  const roleModel = typeof role.model === 'string' ? role.model.trim() : ''
  const inherit = roleModel === 'inherit'
  const roleTier = isModelTier(role.tier) ? role.tier : undefined
  const roleEffort = isEffort(role.effort) ? role.effort : undefined
  const parent = isModelTier(parentTier) ? parentTier : undefined
  // A role on its own model: the tier that model runs on (roleModelTier, the reading the Claude adapter shares), so the
  // ceiling is never below what the definition actually runs. An 'inherit' role: its chart tier, else the parent's.
  const ceiling: ModelTier | undefined = inherit ? (eff.maxTier ?? parent) : roleModelTier(role)
  /** The tier the chart runs this role on today (for overrides and for the fixed result). */
  const chartTier: ModelTier | undefined = inherit ? (roleTier ?? parent) : roleModelTier(role, true)

  // ---- 1. fixed (or no ceiling known: treated as fixed) ----
  if (eff.mode === 'fixed' || !ceiling) {
    const notes: string[] = []
    const fixedRole = eff.mode === 'fixed'
    const fixedProject = staffingModeOf(project) === 'fixed'
    if (requested) {
      notes.push(
        fixedProject
          ? WORDS.note.projectFixedIgnored(fmt(requested))
          : fixedRole
            ? WORDS.note.fixedIgnored(fmt(requested))
            : WORDS.note.noCeilingIgnored(fmt(requested))
      )
    } else if (escalatedFrom) {
      notes.push(fixedProject ? WORDS.note.projectFixedNoEscalation : fixedRole ? WORDS.note.fixedNoEscalation : WORDS.note.noCeilingNoEscalation)
    }
    const model = roleModel || fallbackModel(tierModels, chartTier ?? 'everyday')?.model || ''
    const base: ResolvedStaffing = { mode: 'fixed', model, source: 'role', overrides: false, tierChanged: false, effortChanged: false }
    if (chartTier) base.tier = chartTier
    if (roleEffort) base.effort = roleEffort
    // 6. The plan guard, as the Claude adapter's old steerToEveryday: by the role's tier, by its model, or for an
    // 'inherit' role by the model 'inherit' resolves to (the root's, inheritTier).
    if (planGuard) {
      const inheritDeep = inherit && (input.inheritTier === 'deep' || input.inheritTier === 'top')
      const deep = chartTier === 'deep' || chartTier === 'top' || inheritDeep || isDeepOrTopModelRef(roleModel, tierModels)
      const to = mapped(tierModels, 'everyday')
      if (deep && to && to !== model) {
        notes.push(WORDS.note.planGuard(to, roleModel || 'its configured model'))
        base.tier = 'everyday'
        base.model = to
        base.source = 'plan-guard'
        base.overrides = true
        base.tierChanged = true
      }
    }
    const note = joinNotes(notes)
    if (note) base.note = note
    return base
  }

  // ---- 2. bounds ----
  const floor = eff.minTier && compareTier(eff.minTier, ceiling) <= 0 ? eff.minTier : undefined
  const effortCeiling: Effort = eff.maxEffort ?? UNSET_EFFORT_CEILING
  const notes: string[] = []
  let adjustment: StaffingAdjustment | undefined
  const asked: StaffingRequest = {}
  let clamped = false

  /** Rule 4 on one candidate: clamp into [floor, ceiling] and under the effort ceiling, with notes. */
  const clamp = (tier: ModelTier, effort: Effort | undefined, who: string): { tier: ModelTier; effort: Effort | undefined } => {
    let t = tier
    let e = effort
    if (compareTier(t, ceiling) > 0) {
      notes.push(WORDS.note.tierCeiling(who, t, ceiling))
      asked.tier = t
      adjustment ??= 'ceiling'
      t = ceiling
      clamped = true
    } else if (floor && compareTier(t, floor) < 0) {
      notes.push(WORDS.note.tierFloor(who, t, floor))
      asked.tier = t
      adjustment ??= 'floor'
      t = floor
      clamped = true
    }
    if (e && compareEffort(e, effortCeiling) > 0) {
      notes.push(WORDS.note.effortCeiling(who, e, effortCeiling))
      asked.effort = e
      adjustment ??= 'ceiling'
      e = effortCeiling
      clamped = true
    }
    return { tier: t, effort: e }
  }

  let tier: ModelTier
  let effort: Effort | undefined
  let source: StaffingSource

  if (!escalatedFrom) {
    // ---- 3. pick ----
    source = requested ? 'orchestrator' : profile ? 'profile' : 'role'
    const cost = input.goal === 'cost'
    const downTier = cost && !requested?.tier && !profile?.tier ? tierDown(ceiling) : undefined
    const costTier = downTier && (!floor || compareTier(downTier, floor) >= 0) ? downTier : ceiling
    const costEffort: Effort | undefined =
      cost && !requested?.effort && !profile?.effort && !roleEffort && input.adapterEfforts.includes('medium')
        ? compareEffort('medium', effortCeiling) <= 0
          ? 'medium'
          : effortCeiling
        : undefined
    const pick = {
      tier: requested?.tier ?? profile?.tier ?? costTier,
      effort: requested?.effort ?? profile?.effort ?? roleEffort ?? costEffort
    }
    // ---- 4. clamp ----
    const who = ASKER[source === 'orchestrator' ? 'orchestrator' : source === 'profile' ? 'profile' : 'role']
    ;({ tier, effort } = clamp(pick.tier, pick.effort, who))
    if (clamped) source = 'clamped'
    else if (source !== 'role' && (tier !== chartTier || effort !== roleEffort)) {
      notes.push(WORDS.note.picked(source === 'orchestrator' ? 'the orchestrator' : 'the project profile', fmt({ tier, effort }), fmt({ tier: chartTier, effort: roleEffort }) || 'its defaults'))
    }
  } else {
    // ---- 5. escalation ----
    source = 'escalated'
    const prevTierRaw = isModelTier(escalatedFrom.tier) ? escalatedFrom.tier : ceiling
    const prevEffortRaw = isEffort(escalatedFrom.effort) ? escalatedFrom.effort : roleEffort
    if (requested) {
      const cand = clamp(requested.tier ?? prevTierRaw, requested.effort ?? prevEffortRaw, ASKER.orchestrator)
      tier = cand.tier
      effort = cand.effort
      const prevEffortCmp = prevEffortRaw ?? DEFAULT_EFFORT_BASELINE
      let cut = false
      if (compareTier(tier, prevTierRaw) > 0) {
        const one = tierUp(prevTierRaw) as ModelTier
        if (one === 'top' && prevTierRaw !== 'top') {
          notes.push(WORDS.note.escalationNoTop)
          tier = prevTierRaw
        } else if (tier !== one) {
          tier = one
          cut = true
        }
      }
      if (effort && compareEffort(effort, prevEffortCmp) > 0) {
        if (compareTier(tier, prevTierRaw) > 0) {
          // Tier first: the tier step is the one step; the effort stays where it was.
          effort = prevEffortRaw
          cut = true
        } else {
          const one = effortUp(prevEffortCmp) as Effort
          if (effort !== one) {
            effort = one
            cut = true
          }
        }
      }
      if (cut) notes.push(WORDS.note.escalationCut(fmt(requested), fmt({ tier, effort }) || 'its defaults'))
    } else {
      // Start from the previous attempt, clamped into today's bounds, then take one step.
      const base = clamp(prevTierRaw, prevEffortRaw, ASKER.escalation)
      tier = base.tier
      effort = base.effort
      const baseEffort = effort ?? DEFAULT_EFFORT_BASELINE
      const nextEffort = EFFORTS.find(
        (e) => compareEffort(e, baseEffort) > 0 && compareEffort(e, effortCeiling) <= 0 && adapterEfforts.includes(e)
      )
      const nextTier = tierUp(tier)
      if (nextEffort) {
        notes.push(WORDS.note.escalatedEffort(effort ?? 'the default', nextEffort))
        effort = nextEffort
      } else if (nextTier && nextTier !== 'top' && compareTier(nextTier, ceiling) <= 0 && mapped(tierModels, nextTier)) {
        notes.push(WORDS.note.escalatedTier(tier, nextTier))
        tier = nextTier
      } else {
        notes.push(WORDS.note.escalationNoRoom)
      }
    }
    if (clamped) source = 'clamped'
  }

  // ---- 6. plan guard ----
  if (planGuard && (tier === 'deep' || tier === 'top')) {
    const to = mapped(tierModels, 'everyday')
    if (to && to !== mapped(tierModels, tier)) {
      notes.push(WORDS.note.planGuard(to, tier))
      tier = 'everyday'
      source = 'plan-guard'
    }
  }

  // ---- 7. availability ----
  let model = mapped(tierModels, tier)
  if (!model) {
    const wanted = tier
    let found: ModelTier | undefined
    for (let t = tierDown(wanted); t && (!floor || compareTier(t, floor) >= 0); t = tierDown(t)) {
      if (mapped(tierModels, t)) {
        found = t
        break
      }
    }
    if (!found) {
      for (let t = tierUp(wanted); t && compareTier(t, ceiling) <= 0; t = tierUp(t)) {
        if (mapped(tierModels, t)) {
          found = t
          break
        }
      }
    }
    if (found) {
      notes.push(WORDS.note.connectionLower(wanted, found))
      tier = found
      model = mapped(tierModels, found) as string
      if (source !== 'plan-guard') {
        source = 'clamped'
        if (!adjustment) {
          adjustment = 'connection'
          asked.tier = wanted
        }
      }
    } else {
      notes.push(WORDS.note.unmapped(wanted))
      const fb = roleModel ? undefined : fallbackModel(tierModels, chartTier ?? ceiling)
      model = roleModel || fb?.model || ''
      tier = fb?.tier ?? chartTier ?? ceiling
      source = 'role'
      adjustment = 'unmapped'
      if (!asked.tier) asked.tier = wanted
    }
  }

  // ---- 3 (end). no effort under a cap below the adapter default: send the cap, else the default would exceed it ----
  if (!effort && adapterEfforts.length && compareEffort(effortCeiling, DEFAULT_EFFORT_BASELINE) < 0) effort = effortCeiling

  // ---- 8. effort vs adapter ----
  if (effort) {
    if (!adapterEfforts.length) {
      notes.push(WORDS.note.adapterNoEffort)
      effort = undefined
    } else if (!adapterEfforts.includes(effort)) {
      const want = effort
      const below = [...EFFORTS].reverse().find((e) => compareEffort(e, want) <= 0 && adapterEfforts.includes(e))
      const lowest = EFFORTS.find((e) => adapterEfforts.includes(e))
      effort = below ?? lowest
      if (effort) notes.push(WORDS.note.adapterEffort(want, effort))
    }
  }

  // ---- 9. result ----
  const tierChanged = tier !== chartTier
  const effortChanged = effort !== roleEffort
  const out: ResolvedStaffing = { mode: 'auto', tier, model, source, overrides: tierChanged || effortChanged, tierChanged, effortChanged }
  if (effort) out.effort = effort
  const note = joinNotes(notes)
  if (note) out.note = note
  if (adjustment) {
    out.adjustment = adjustment
    out.asked = asked
  }
  return out
}

/** The model of the nearest mapped tier to `tier` (defaults.ts nearestTiers order), or undefined when nothing is mapped. */
function fallbackModel(tierModels: Partial<Record<ModelTier, string>>, tier: ModelTier): { model: string; tier: ModelTier } | undefined {
  for (const t of nearestTiers(tier)) {
    const m = mapped(tierModels, t)
    if (m) return { model: m, tier: t }
  }
  return undefined
}

// ---------- Plan step binding ----------

/**
 * The plan step a spawn of `roleSlug` belongs to, and what it asks for. The step is the first, in plan order, that is
 * 'pending' or 'in_progress', whose `staff.role` equals `roleSlug` (both trimmed, case-sensitive), whose id is not in
 * `bound`, and whose `after` steps are all 'done' or 'skipped' (an `after` id that names no step counts as satisfied);
 * when no such ready step exists, the first unbound pending or in-progress step naming the role regardless of `after`.
 * `requested` merges the step's staff tier / effort with `onCall` (values on the spawn call win field by field); it is
 * undefined when neither gives a valid value. No step: `stepId` undefined and `requested` = the call's values, or
 * undefined. Pure: the caller adds the returned stepId to its bound set once the spawn is accepted.
 */
export function staffRequestForSpawn(
  plan: RunPlan | undefined,
  roleSlug: string,
  bound: ReadonlySet<string>,
  onCall?: StaffingRequest
): { stepId?: string; requested?: StaffingRequest } {
  const slug = typeof roleSlug === 'string' ? roleSlug.trim() : ''
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : []
  const call = cleanRequest(onCall)
  const candidates = slug
    ? steps.filter(
        (s) =>
          (s.status === 'pending' || s.status === 'in_progress') &&
          typeof s.staff?.role === 'string' &&
          s.staff.role.trim() === slug &&
          !bound.has(s.id)
      )
    : []
  const status = new Map(steps.map((s) => [s.id, s.status]))
  const ready = (s: (typeof steps)[number]): boolean =>
    (s.after ?? []).every((id) => {
      const st = status.get(id)
      return st === undefined || st === 'done' || st === 'skipped'
    })
  const step = candidates.find(ready) ?? candidates[0]
  if (!step) return call ? { requested: call } : {}
  const requested = cleanRequest({ tier: call?.tier ?? step.staff?.tier, effort: call?.effort ?? step.staff?.effort })
  return requested ? { stepId: step.id, requested } : { stepId: step.id }
}

// ---------- Recording ----------

/** The StaffingAssignment row for a resolved spawn. `now` is epoch ms; the note is already capped by resolveStaffing. */
export function staffingAssignment(
  resolved: ResolvedStaffing,
  ids: { roleId: string; agentId?: string; stepId?: string },
  now: number
): StaffingAssignment {
  const row: StaffingAssignment = { roleId: ids.roleId, model: resolved.model, source: resolved.source, at: now }
  if (ids.agentId) row.agentId = ids.agentId
  if (ids.stepId) row.stepId = ids.stepId
  if (resolved.tier) row.tier = resolved.tier
  if (resolved.effort) row.effort = resolved.effort
  if (resolved.note) row.note = capNote(resolved.note)
  return row
}

/**
 * The run's staffing record with `row` appended: keeps `current.goal` when there is a current record (else `goal`),
 * and only the newest RUN_STAFFING_ASSIGNMENTS_MAX rows. Pure: `current` is not modified.
 */
export function appendStaffing(current: RunStaffing | undefined, goal: StaffingGoal, row: StaffingAssignment): RunStaffing {
  const assignments = [...(current?.assignments ?? []), row]
  return {
    goal: current ? current.goal : goal,
    assignments: assignments.length > RUN_STAFFING_ASSIGNMENTS_MAX ? assignments.slice(-RUN_STAFFING_ASSIGNMENTS_MAX) : assignments
  }
}

/**
 * Append `row` to the run's staffing record through the context. Reads (getStaffing) and writes (updateStaffing) with
 * no await in between, so two spawns recorded in the same tick both land: RunManager stores the record synchronously
 * inside updateStaffing before anything awaits. The goal for a first record is ctx.staffingGoal, else 'balanced'.
 *
 * A row bound to a plan step also marks that step in_progress when it is still pending (markStepRunning), so a step with
 * a report working on it is never shown or nudged as ready. The row is stored first and the plan write is independent:
 * a failure of either rejects only after both were tried.
 */
export function recordStaffing(
  ctx: Pick<RuntimeContext, 'getStaffing' | 'updateStaffing' | 'staffingGoal'> & Partial<Pick<RuntimeContext, 'getPlan' | 'updatePlan'>>,
  row: StaffingAssignment
): Promise<void> {
  const next = appendStaffing(ctx.getStaffing(), staffingGoalOf(undefined, ctx.staffingGoal), row)
  const staffed = ctx.updateStaffing(next)
  // Fresh read and write in the same tick as the row, so two reports starting together both get marked.
  let marked: Promise<void> | undefined
  try {
    marked = markStepRunning(ctx, row.stepId)
  } catch (e) {
    marked = Promise.reject(e)
  }
  if (!marked) return staffed
  return Promise.allSettled([staffed, marked]).then(([a, b]) => {
    if (a.status === 'rejected') throw a.reason
    if (b.status === 'rejected') throw b.reason
  })
}

/** Write the plan back with `stepId` in_progress when it exists and is pending; undefined when there is nothing to write. */
function markStepRunning(ctx: Partial<Pick<RuntimeContext, 'getPlan' | 'updatePlan'>>, stepId: string | undefined): Promise<void> | undefined {
  if (!stepId || !ctx.getPlan || !ctx.updatePlan) return undefined
  const plan = ctx.getPlan()
  if (!plan?.steps.some((s) => s.id === stepId && s.status === 'pending')) return undefined
  const steps = plan.steps.map((s) => (s.id === stepId && s.status === 'pending' ? { ...s, status: 'in_progress' as const } : s))
  return ctx.updatePlan({ ...plan, steps, updatedAt: Date.now() })
}

// ---------- Label ----------

/**
 * The short text adapters put in a spawn's result and logs, e.g. "everyday / medium (chosen by the orchestrator)",
 * "everyday (capped by the role: asked for deep)", "everyday (usage guard)", "sonnet-4-6 / high (fixed by the role)".
 * The head is the tier (the model for a fixed role on its own model, or an unmapped fallback), then the effort when one
 * is sent. All wording lives in this module's WORDS table.
 */
export function staffingLabel(resolved: ResolvedStaffing): string {
  const L = WORDS.label
  const ownModel = (resolved.mode === 'fixed' && resolved.source === 'role') || resolved.adjustment === 'unmapped'
  const head = [ownModel || !resolved.tier ? resolved.model : resolved.tier, resolved.effort].filter(Boolean).join(' / ')
  const asked = fmt(resolved.asked)
  let why: string
  switch (resolved.source) {
    case 'orchestrator':
      why = L.orchestrator
      break
    case 'profile':
      why = L.profile
      break
    case 'plan-guard':
      why = L.planGuard
      break
    case 'escalated':
      why = L.escalated
      break
    case 'clamped':
      why =
        resolved.adjustment === 'floor'
          ? L.floor(asked)
          : resolved.adjustment === 'connection'
            ? L.connection(asked)
            : L.ceiling(asked)
      break
    default:
      why = resolved.adjustment === 'unmapped' ? L.unmapped : resolved.mode === 'fixed' ? L.fixed : L.role
  }
  return `${head} (${why})`
}
