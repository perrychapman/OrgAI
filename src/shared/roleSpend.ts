/**
 * The spend rule of the team files gate (src/main/teamFiles/gate.ts), moved here so the CLI's role editing (`orgai team
 * role add|set|move`) judges a role change by the same rule and prints the same "May spend more" sentences. Pure: no
 * main-process code. A role here is only what decides spend: model, tier, effort, staffing and whether it is the root
 * (TeamRoleDoc and Role both fit).
 */
import type { Effort, ModelTier, RoleStaffing, StaffingMode } from './types'
import { compareEffort, compareTier, effectiveRoleStaffing, lowerEffort, settingTier } from './defaults'

/** What decides a role's spend. `model`: a pinned id, 'inherit' or a tier name; `reportsTo` null = the root. */
export interface SpendRole {
  model?: string
  tier?: ModelTier
  effort?: Effort
  staffing?: RoleStaffing
  reportsTo: string | null
}

/** Project.staffing as a team document holds it (undefined = automatic). */
export type ProjectStaffing = StaffingMode | undefined

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** JSON with sorted keys (teamFiles/digest canonicalJson): equal values give equal text. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort(cmp)) out[k] = walk((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

const TIER_RANK: Record<ModelTier, number> = { fast: 0, everyday: 1, deep: 2, top: 3 }
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

/** Whether a role's model setting moves to something that may spend more: only a strictly lower tier is safe. */
export function modelMayCostMore(a: SpendRole, d: SpendRole): boolean {
  if (a.tier !== undefined && d.tier !== undefined) return TIER_RANK[d.tier] > TIER_RANK[a.tier]
  return true
}
export const effortRaised = (a: SpendRole, d: SpendRole): boolean => (d.effort === undefined ? false : (EFFORT_RANK[d.effort] ?? 99) > (a.effort === undefined ? -1 : (EFFORT_RANK[a.effort] ?? 99)))

/** The effort ceiling the staffing resolver enforces on an automatic role when none is set (runtime/staffing.ts rule 2). */
const UNSET_EFFORT_CEILING: Effort = 'high'
/**
 * What a run gets when no effort is sent: the adapter's default (claude.ts CLAUDE_SDK_DEFAULT_EFFORT, staffing.ts
 * DEFAULT_EFFORT_BASELINE). A fixed role with no effort runs at it.
 */
const DEFAULT_SENT_EFFORT: Effort = 'medium'

/**
 * Under what a role's spend is judged: the project's staffing mode, and whether the role's parent tier is known at spawn
 * (only matters for an 'inherit' role with no tier: without it the resolver cannot size the role and runs it as fixed).
 */
export interface SpendContext {
  project: ProjectStaffing
  parentKnown: boolean
}
/** Every reading a change is judged under: each project mode, with the parent tier known and unknown. */
export const contextsOf = (projects: readonly ProjectStaffing[]): SpendContext[] => projects.flatMap((project) => [true, false].map((parentKnown) => ({ project, parentKnown })))

/**
 * What a role lets a run spend, as the run time does it (runtime/staffing.ts resolveStaffing, and the adapters for the
 * root):
 * - fixed: the root (it never goes through the resolver; its effort is passed straight through), a role the resolver
 *   cannot size (no tier and a model that names none: a concrete model, or 'inherit' when the parent tier is unknown),
 *   and a role effectiveRoleStaffing makes fixed;
 * - most: the highest effort a run may send. Fixed: its effort, else the adapter default. Automatic: up to
 *   `staffing.maxEffort ?? effort ?? high`;
 * - nopick: the effort it runs at when nobody picks one. Fixed: as `most`. Automatic: its effort, else the default, never
 *   above the cap (the resolver sends a cap below the default);
 * - floor: the effective tier floor of an automatic role (effectiveRoleStaffing: a floor above the role's tier is left
 *   out). A fixed role has none: its floor starts to count when it becomes automatic, and that switch is judged on it.
 */
export interface Spend {
  fixed: boolean
  most: Effort
  nopick: Effort
  floor?: ModelTier
}
export function spendOf(r: SpendRole, ctx: SpendContext): Spend {
  const e = effectiveRoleStaffing({ model: r.model ?? '', tier: r.tier, effort: r.effort, staffing: r.staffing }, { staffing: ctx.project })
  const model = (r.model ?? '').trim()
  const sized = r.tier !== undefined || (model === 'inherit' ? ctx.parentKnown : settingTier(model) !== undefined)
  if (r.reportsTo === null || !sized || e.mode === 'fixed') {
    const at = r.effort ?? DEFAULT_SENT_EFFORT
    return { fixed: true, most: at, nopick: at }
  }
  const most = e.maxEffort ?? UNSET_EFFORT_CEILING
  const out: Spend = { fixed: false, most, nopick: lowerEffort(r.effort ?? DEFAULT_SENT_EFFORT, most) }
  if (e.minTier) out.floor = e.minTier
  return out
}

/**
 * How moving from spend `x` to spend `y` can make a run spend more: 'fixed' automatic becomes fixed (a fixed role always
 * runs at its configured model and effort); 'auto' fixed becomes automatic and the most it may send rises; 'most' the
 * most it may send rises in the same mode; 'nopick' what it runs at when nobody picks rises (automatic only: for a fixed
 * role it is `most`); 'floor' the effective tier floor is added or raised. Empty: it spends no more.
 */
export type SpendRise = 'fixed' | 'auto' | 'most' | 'nopick' | 'floor'
export interface Clause {
  kind: SpendRise
  x: Spend
  y: Spend
}
export function spendRises(x: Spend, y: Spend): Clause[] {
  const out: SpendRise[] = []
  if (!x.fixed && y.fixed) out.push('fixed')
  else {
    if (compareEffort(y.most, x.most) > 0) out.push(x.fixed ? 'auto' : 'most')
    if (!y.fixed && compareEffort(y.nopick, x.nopick) > 0) out.push('nopick')
  }
  if (y.floor !== undefined && (x.floor === undefined || compareTier(y.floor, x.floor) > 0)) out.push('floor')
  return out.map((kind) => ({ kind, x, y }))
}

/** Every rise moving a role from `a` to `d` brings under any of `contexts`, one per kind (the first reading that has it). */
export function risesUnder(a: SpendRole, d: SpendRole, contexts: readonly SpendContext[]): Clause[] {
  const out = new Map<SpendRise, Clause>()
  for (const ctx of contexts) for (const c of spendRises(spendOf(a, ctx), spendOf(d, ctx))) if (!out.has(c.kind)) out.set(c.kind, c)
  return [...out.values()]
}

/** One rise in plain words. `cap`: the staffing cap itself was raised ('raised') or removed ('removed'), for 'most'. */
function clauseText(who: string, c: Clause, cap?: 'raised' | 'removed'): string {
  const { x, y } = c
  switch (c.kind) {
    case 'fixed':
      return `${who} becomes fixed: it always runs at its configured model and effort`
    case 'auto':
      return `${who} becomes automatic and may be picked up to ${y.most} effort (it ran at ${x.most})`
    case 'most':
      return cap === 'removed'
        ? `${who}'s effort ceiling is removed, so it may be picked up to ${y.most} effort (up to ${x.most} before)`
        : cap === 'raised'
          ? `${who}'s effort ceiling is raised from ${x.most} to ${y.most}`
          : `${who} may be picked up to ${y.most} effort (up to ${x.most} before)`
    case 'nopick':
      return `${who} runs at ${y.nopick} effort when nothing is picked (${x.nopick} before)`
    case 'floor':
      return x.floor === undefined ? `${who} gets a lowest tier of ${y.floor}` : `${who}'s lowest tier is raised from ${x.floor} to ${y.floor}`
  }
}
/** The new value a clause states. */
const clauseValue = (c: Clause): string | undefined => (c.kind === 'fixed' ? 'fixed' : c.kind === 'nopick' ? c.y.nopick : c.kind === 'floor' ? c.y.floor : c.y.most)
/** Whether held rows already state clause `c` (same kind, same new value). */
const states = (held: readonly { states: Clause[] }[], c: Clause): boolean => held.some((h) => h.states.some((s) => s.kind === c.kind && clauseValue(s) === clauseValue(c)))

export type SpendKey = 'tier' | 'model' | 'effort' | 'staffing'
const SPEND_KEYS: readonly SpendKey[] = ['tier', 'model', 'effort', 'staffing']
export interface HeldSpend {
  id: SpendKey
  summary: string
  /** The rises this row's text states. */
  states: Clause[]
}

/**
 * How a role's model, effort and staffing settle when the files move it from `ar` to `dr` under the project staffing
 * modes `projects` (the settled one, plus the one on disk while a change to it waits: a step applies only when it spends
 * no more under every one of them, so approving the waiting project change later never lets an already applied role
 * change spend more), each read with the parent tier known and unknown (contextsOf): the role as it will stand
 * (`role`), the keys that apply and the held rows ('model', 'effort', 'staffing' with their summaries). In order, each
 * step judged on the state the steps before it settled:
 * 1. model: only a strictly lower tier applies;
 * 2. a raised effort (or one set over none) is held;
 * 3. staffing, on its own (the approved effort): held when, against the approved role, it raises any part of the spend
 *    (spendRises);
 * 4. any other effort change (lowered or removed), on the staffing as step 3 settled it: held when it raises the spend
 *    (a removed effort lets a fixed role run at the default and an automatic one run at the default when nothing is
 *    picked and be picked up to its cap or high).
 * Each step spends no more than the one before it, so the settled role spends no more than the approved one. When any
 * row is held, approving takes the whole role on disk: the rises from `ar` to `dr` that no held row states are added to
 * the first held row (staffing, else effort, else model). Pure.
 */
export function settleSpend<R extends SpendRole>(ar: R, dr: R, projects: readonly ProjectStaffing[], who: string): { role: R; apply: SpendKey[]; held: HeldSpend[] } {
  const contexts = contextsOf(projects)
  const role: R = { ...ar }
  const apply = new Set<SpendKey>()
  const held: HeldSpend[] = []
  const put = (into: R, k: SpendKey): void => {
    const r = into as unknown as Record<string, unknown>
    if (dr[k] === undefined) delete r[k]
    else r[k] = structuredClone(dr[k])
  }
  if (!same([ar.tier, ar.model], [dr.tier, dr.model])) {
    if (modelMayCostMore(ar, dr)) held.push({ id: 'model', summary: `${who}'s model changes and may spend more.`, states: [] })
    else {
      put(role, 'tier')
      put(role, 'model')
      apply.add('tier').add('model')
    }
  }
  const effortChanged = !same(ar.effort, dr.effort)
  const raised = effortChanged && effortRaised(ar, dr)
  if (raised) {
    const next: R = { ...role }
    put(next, 'effort')
    held.push({ id: 'effort', summary: `${who}'s reasoning effort is raised and may spend more.`, states: risesUnder(role, next, contexts) })
  }
  if (!same(ar.staffing, dr.staffing)) {
    const next: R = { ...role }
    put(next, 'staffing')
    const rises = risesUnder(ar, next, contexts)
    if (rises.length) {
      const cap = ar.staffing?.maxEffort !== undefined && next.staffing?.maxEffort === undefined ? 'removed' : 'raised'
      held.push({ id: 'staffing', summary: `${rises.map((c) => clauseText(who, c, cap)).join('; ')}. This may spend more.`, states: rises })
    } else {
      put(role, 'staffing')
      apply.add('staffing')
    }
  }
  if (effortChanged && !raised) {
    const next: R = { ...role }
    put(next, 'effort')
    const rises = risesUnder(role, next, contexts)
    if (rises.length) {
      const how = rises.map((c) =>
        c.y.fixed
          ? `it runs at the default effort (${c.y.most}) instead of ${c.x.most}`
          : c.kind === 'nopick'
            ? `it runs at ${c.y.nopick} effort when nothing is picked (${c.x.nopick} before)`
            : `it may be picked up to ${c.y.most} effort instead of ${c.x.most}`
      )
      held.push({ id: 'effort', summary: `${who}'s reasoning effort is removed, so ${[...new Set(how)].join(' and ')}. This may spend more.`, states: rises })
    } else {
      put(role, 'effort')
      apply.add('effort')
    }
  }
  // Approving takes the whole role on disk: say what of that no held row says yet.
  if (held.length) {
    const missing = risesUnder(ar, dr, contexts).filter((c) => !states(held, c))
    if (missing.length) {
      const first = held.find((h) => h.id === 'staffing') ?? held.find((h) => h.id === 'effort') ?? held[0]
      first.summary += ` With the rest of this change, ${missing.map((c) => clauseText(who, c)).join('; ')}.`
      first.states.push(...missing)
    }
  }
  return { role, apply: SPEND_KEYS.filter((k) => apply.has(k)), held }
}
