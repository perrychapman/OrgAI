import { AGENT_IMPORT_ELEVATED_TOOLS, TEAM_FILES_AGENTS_DIR, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON, TEAM_FILES_SKILLS_DIR, DEFAULT_MAX_AUTO_CONTINUES, type Effort, type ModelTier, type PermissionMode, type TeamFileChange, type TeamFileChangeKind } from '@shared/types'
import { compareEffort, compareTier, effectiveRoleStaffing, effectiveSubagentLimits, lowerEffort, settingTier, skillEvaluationOf, staffingModeOf, teamReviewOf } from '@shared/defaults'
import { fullTarget, safeText } from '../kit/format'
import type { TeamDoc, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc } from './doc'
import { canonicalJson, normalizeDoc } from './digest'
import { chartProblem, skillScripts } from './parse'

/**
 * The approval gate. `gateTeam(approved, disk)` splits the differences between the last approved team and what the
 * files say into changes that apply at once and changes that wait for the user, and returns the `effective` document
 * (what becomes the new approved team). Anything that raises power stays at its approved value and is listed pending;
 * prompts, descriptions, removals and lowered power apply. Idempotent: gating the effective document against the same
 * disk again applies nothing and lists the same pending changes with the same text (gateTeam settles to a fixpoint). Pure.
 */

export const FIRST_SEEN_REASON = "First time this repository's team is seen on this computer"
export const CHART_REASON = 'Part of a chart change that needs review'
const PROMPT_TEXT_MAX = 200_000

/**
 * The one place tools are classified (the Team files gate, the folder preview and the service all use it).
 * TRIVIAL_TOOLS is an ALLOWLIST: a new role applies at once only when every tool it holds is on it. PLAIN_SAFE_TOOLS adds
 * the web tools, which still wait for approval on a new role but are not listed as "elevated". Anything else, including
 * Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit and every tool this list has never heard of, is elevated.
 */
export const TRIVIAL_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'TodoWrite']
export const PLAIN_SAFE_TOOLS: readonly string[] = [...TRIVIAL_TOOLS, 'WebFetch', 'WebSearch']
export const ELEVATED_TOOLS: readonly string[] = [...AGENT_IMPORT_ELEVATED_TOOLS, 'PowerShell', 'MultiEdit']
export const isElevatedTool = (t: string): boolean => ELEVATED_TOOLS.includes(t) || !PLAIN_SAFE_TOOLS.includes(t)

/** Resolves what a connector or library server would link to on this computer (the service injects it; this file stays pure). */
export interface LinkInfo {
  /** The ENTRY's real target (the file's own address is never shown for a linked server). */
  target: string
  /** False: a catalog connector with no entry on this computer yet (approving adds it, and the user signs in). Unset = stored. */
  stored?: boolean
}
export type LinkResolver = (m: TeamMcpDoc) => LinkInfo | null

const TIER_RANK: Record<ModelTier, number> = { fast: 0, everyday: 1, deep: 2, top: 3 }
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

/** Whether a role's model setting moves to something that may spend more: only a strictly lower tier is safe. */
function modelMayCostMore(a: TeamRoleDoc, d: TeamRoleDoc): boolean {
  if (a.tier !== undefined && d.tier !== undefined) return TIER_RANK[d.tier] > TIER_RANK[a.tier]
  return true
}
const effortRaised = (a: TeamRoleDoc, d: TeamRoleDoc): boolean => (d.effort === undefined ? false : (EFFORT_RANK[d.effort] ?? 99) > (a.effort === undefined ? -1 : (EFFORT_RANK[a.effort] ?? 99)))

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
interface SpendContext {
  project: TeamSettingsDoc['staffing']
  parentKnown: boolean
}
/** Every reading a change is judged under: each project mode, with the parent tier known and unknown. */
const contextsOf = (projects: readonly TeamSettingsDoc['staffing'][]): SpendContext[] => projects.flatMap((project) => [true, false].map((parentKnown) => ({ project, parentKnown })))

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
interface Spend {
  fixed: boolean
  most: Effort
  nopick: Effort
  floor?: ModelTier
}
function spendOf(r: TeamRoleDoc, ctx: SpendContext): Spend {
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
type SpendRise = 'fixed' | 'auto' | 'most' | 'nopick' | 'floor'
interface Clause {
  kind: SpendRise
  x: Spend
  y: Spend
}
function spendRises(x: Spend, y: Spend): Clause[] {
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
function risesUnder(a: TeamRoleDoc, d: TeamRoleDoc, contexts: readonly SpendContext[]): Clause[] {
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

type SpendKey = 'tier' | 'model' | 'effort' | 'staffing'
const SPEND_KEYS: readonly SpendKey[] = ['tier', 'model', 'effort', 'staffing']
interface HeldSpend {
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
function settleSpend(ar: TeamRoleDoc, dr: TeamRoleDoc, projects: readonly TeamSettingsDoc['staffing'][], who: string): { role: TeamRoleDoc; apply: SpendKey[]; held: HeldSpend[] } {
  const contexts = contextsOf(projects)
  const role: TeamRoleDoc = { ...ar }
  const apply = new Set<SpendKey>()
  const held: HeldSpend[] = []
  const put = (into: TeamRoleDoc, k: SpendKey): void => {
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
    const next: TeamRoleDoc = { ...role }
    put(next, 'effort')
    held.push({ id: 'effort', summary: `${who}'s reasoning effort is raised and may spend more.`, states: risesUnder(role, next, contexts) })
  }
  if (!same(ar.staffing, dr.staffing)) {
    const next: TeamRoleDoc = { ...role }
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
    const next: TeamRoleDoc = { ...role }
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

/**
 * The project's staffing mode moving from `a` to `d`, judged against every role on both sides (whether or not its own
 * staffing changed): each role as approved under the approved mode against the same role as it would settle under the
 * new mode (settleSpend), with the parent tier known and unknown. Returns the names of the roles that would spend more.
 * A role only spends more here by its effective mode flipping: in an unchanged mode settleSpend already keeps it at or
 * below the approved role.
 */
function projectStaffingRises(a: TeamDoc, d: TeamDoc): string[] {
  const dRoles = new Map(d.roles.map((r) => [r.slug, r]))
  const out: string[] = []
  for (const ar of a.roles) {
    const dr = dRoles.get(ar.slug)
    if (!dr) continue
    const settled = settleSpend(ar, dr, [d.settings.staffing], '').role
    const rises = [true, false].some((parentKnown) => spendRises(spendOf(ar, { project: a.settings.staffing, parentKnown }), spendOf(settled, { project: d.settings.staffing, parentKnown })).length > 0)
    if (rises) out.push(dr.name)
  }
  return out
}

/** The sentence a held project staffing change adds: who would spend more, and how. */
function projectStaffingSentence(names: string[], toFixed: boolean): string {
  const one = names.length === 1
  return toFixed
    ? ` ${joinAnd(names)} would then always run at ${one ? 'its' : 'their'} configured model and effort, which may spend more.`
    : ` ${joinAnd(names)} may then run at a higher effort or tier than ${one ? 'it does' : 'they do'} now.`
}

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, dontAsk: 1, default: 2, acceptEdits: 3, auto: 4, bypassPermissions: 5 }
/** plan < dontAsk < default < acceptEdits < auto < bypassPermissions. Unknown values rank highest. */
export function permissionRank(mode: PermissionMode): number {
  return MODE_RANK[mode] ?? 99
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const nm = (s: unknown, max = 80): string => safeText(s, max)
const HIDDEN_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Prompt-sized text with hidden characters replaced (line breaks and tabs kept). */
function longText(s: string): string {
  const t = s.replace(HIDDEN_ALL, (m) => (m === '\n' || m === '\t' ? m : '?'))
  return t.length > PROMPT_TEXT_MAX ? `${t.slice(0, PROMPT_TEXT_MAX - 1)}…` : t
}

function joinAnd(items: readonly string[]): string {
  const shown = items.slice(0, 5).map((x) => nm(x, 60))
  if (items.length > 5) shown.push(`${items.length - 5} more`)
  if (shown.length <= 1) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

const diff = (a: readonly string[], b: readonly string[]): string[] => {
  const s = new Set(b)
  return a.filter((x) => !s.has(x))
}
const inter = (a: readonly string[], b: readonly string[]): string[] => {
  const s = new Set(b)
  return a.filter((x) => s.has(x))
}

type Draft = Omit<TeamFileChange, 'needsApproval' | 'reason'>

interface Run {
  effective: TeamDoc
  pending: TeamFileChange[]
  applied: TeamFileChange[]
}

const roleFile = (slug: string): string => `${TEAM_FILES_AGENTS_DIR}/${slug}.md`
const skillFile = (name: string): string => `${TEAM_FILES_SKILLS_DIR}/${name}`

function serverTarget(m: TeamMcpDoc): string {
  return fullTarget({ transport: m.transport, command: m.command, args: m.args, url: m.url, env: m.env, headers: m.headers }).replace(HIDDEN_ALL, '?')
}

function launchOf(m: TeamMcpDoc): unknown {
  return [m.transport, m.command ?? null, m.args ?? [], m.env ?? {}, m.secretEnv ?? [], m.url ?? null, m.headers ?? {}, m.secretHeaders ?? [], m.connectorId ?? null, m.connectorVariant ?? null, m.fromLibrary === true]
}

/** Text for who could use a linked server once approved. */
function reach(m: TeamMcpDoc): string {
  return m.roles ? `Available to ${joinAnd(m.roles)}.` : 'Available to every role.'
}

const SETTING_LABELS: Record<keyof TeamSettingsDoc, string> = {
  brief: 'Project brief',
  permissionMode: 'Permission mode',
  maxBudgetUsd: 'Budget limit per run',
  maxSubagentDepth: 'Subagent depth limit',
  maxConcurrentSubagents: 'Concurrent agents limit',
  maxWindowShare: 'Plan window share limit',
  preferEverydayNearLimit: 'Plan guard',
  isolateWriters: 'Separate worktrees for writers',
  reviewMerges: 'Review merges',
  autoContinue: 'Auto-continue',
  maxAutoContinues: 'Auto-continue limit',
  runMessaging: 'Runs messaging each other',
  staffing: 'Automatic staffing',
  staffingGoal: 'Staffing goal',
  reviewPolicy: 'Review policy',
  teamReview: 'Team assistant review',
  skillEvaluation: 'Skill evaluation'
}
const SETTING_ORDER = Object.keys(SETTING_LABELS) as (keyof TeamSettingsDoc)[]

function showSetting(k: keyof TeamSettingsDoc, v: unknown): string {
  if (v === undefined && k === 'staffing') return 'automatic'
  if (v === undefined && k === 'staffingGoal') return 'balanced'
  if (v === undefined && k === 'reviewPolicy') return 'by risk'
  if (k === 'staffing' && v === 'fixed') return 'off (every role runs as configured)'
  if (v === undefined) return 'not set'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return k === 'brief' ? 'text' : nm(v, 40)
  if (k === 'teamReview') {
    const t = v as { auto: string; tokenBudget: number; everyRuns: number }
    return `${nm(t.auto, 10)}, up to ${t.tokenBudget} tokens every ${t.everyRuns} runs`
  }
  const s = v as { enabled?: boolean; tokenBudget: number }
  return `${s.enabled === undefined ? 'follows the team assistant' : s.enabled ? 'on' : 'off'}, up to ${s.tokenBudget} tokens`
}

/** A document's chart in the shape effectiveSubagentLimits reads (slug as id). */
const limitRoles = (doc: TeamDoc): { id: string; reportsTo: string | null }[] => doc.roles.map((r) => ({ id: r.slug, reportsTo: r.reportsTo }))

/** The settings (brief left out) as label and value, in plain words: the folder preview shows them beside the changes. */
export function describeSettings(s: TeamSettingsDoc): { label: string; value: string }[] {
  return SETTING_ORDER.filter((k) => k !== 'brief').map((k) => ({ label: SETTING_LABELS[k], value: showSetting(k, s[k]) }))
}

function loosens(k: keyof TeamSettingsDoc, a: TeamDoc, d: TeamDoc): boolean {
  const av = a.settings[k]
  const dv = d.settings[k]
  switch (k) {
    case 'brief':
      return false
    case 'permissionMode':
      return permissionRank(dv as PermissionMode) > permissionRank(av as PermissionMode)
    case 'isolateWriters':
      return av !== false && dv === false
    case 'preferEverydayNearLimit': {
      // true (always on) > unset (automatic) > false (off): any step down loosens.
      const rank = (v: unknown): number => (v === true ? 2 : v === false ? 0 : 1)
      return rank(dv) < rank(av)
    }
    case 'reviewMerges':
      return av === true && dv !== true
    case 'autoContinue':
    case 'runMessaging':
      return av === false && dv !== false
    // Effective values are compared, never the stored ones: 0 or unset budget = no cap; unset limits are automatic.
    case 'maxBudgetUsd':
    case 'maxWindowShare': {
      const eff = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : Infinity)
      return eff(dv) > eff(av)
    }
    case 'maxSubagentDepth': {
      const depth = (doc: TeamDoc): number => effectiveSubagentLimits({ maxSubagentDepth: doc.settings.maxSubagentDepth, roles: limitRoles(doc) }).depth
      return depth(d) > depth(a)
    }
    case 'maxConcurrentSubagents': {
      const conc = (doc: TeamDoc): number => effectiveSubagentLimits({ maxConcurrentSubagents: doc.settings.maxConcurrentSubagents, roles: limitRoles(doc) }).concurrency
      return conc(d) > conc(a)
    }
    case 'maxAutoContinues': {
      const eff = (v: unknown): number => (typeof v === 'number' ? v : DEFAULT_MAX_AUTO_CONTINUES)
      return eff(dv) > eff(av)
    }
    // Judged against every role: held when any role becomes fixed or may be picked up above what it ran at when fixed.
    case 'staffing':
      return projectStaffingRises(a, d).length > 0
    // The goal and the review policy move spend only inside ceilings the user already approved.
    case 'staffingGoal':
    case 'reviewPolicy':
      return false
    case 'teamReview': {
      const x = teamReviewOf({ teamReview: av as TeamSettingsDoc['teamReview'] })
      const y = teamReviewOf({ teamReview: dv as TeamSettingsDoc['teamReview'] })
      const rank = { off: 0, free: 1, ai: 2 } as const
      return rank[y.auto] > rank[x.auto] || y.tokenBudget > x.tokenBudget || y.everyRuns < x.everyRuns
    }
    case 'skillEvaluation': {
      const x = skillEvaluationOf({ skillEvaluation: av as TeamSettingsDoc['skillEvaluation'], teamReview: a.settings.teamReview })
      const y = skillEvaluationOf({ skillEvaluation: dv as TeamSettingsDoc['skillEvaluation'], teamReview: d.settings.teamReview })
      return (!x.enabled && y.enabled) || y.tokenBudget > x.tokenBudget
    }
  }
}

function engine(approvedIn: TeamDoc, diskIn: TeamDoc, force: string | null, link?: LinkResolver): Run {
  const a = normalizeDoc(approvedIn)
  const d = normalizeDoc(diskIn)
  const eff: TeamDoc = structuredClone(a)
  const pending: TeamFileChange[] = []
  const applied: TeamFileChange[] = []

  /** Records a change. `needs`: it raises power, so it waits; with `force` everything waits. Returns whether it applies. */
  const record = (c: Draft, needs: boolean, reason: string): boolean => {
    if (force !== null || needs) {
      pending.push({ ...c, needsApproval: true, reason: force ?? reason })
      return false
    }
    applied.push({ ...c, needsApproval: false })
    return true
  }

  // ---------- settings ----------
  for (const k of SETTING_ORDER) {
    const av = a.settings[k]
    const dv = d.settings[k]
    if (same(av, dv)) continue
    const label = SETTING_LABELS[k]
    const needs = loosens(k, a, d)
    let summary = k === 'brief' ? 'The project brief changed.' : `${label} changes from ${showSetting(k, av)} to ${showSetting(k, dv)}.`
    if (k === 'staffing' && needs) summary += projectStaffingSentence(projectStaffingRises(a, d), staffingModeOf({ staffing: dv as TeamSettingsDoc['staffing'] }) === 'fixed')
    const draft: Draft = { id: `settings:${k}`, kind: 'settings', name: label, file: TEAM_FILES_JSON, action: 'changed', summary }
    if (k === 'brief') {
      draft.before = longText(String(av ?? ''))
      draft.after = longText(String(dv ?? ''))
    }
    const takes = record(draft, needs, k === 'staffing' ? 'May spend more' : 'Loosens a limit or the permission mode')
    // Remember which settings really loosen (also in the all-pending previews), for the power-first order.
    if (needs) LOOSENING.add((takes ? applied : pending)[(takes ? applied : pending).length - 1])
    if (takes) {
      const s = eff.settings as unknown as Record<string, unknown>
      if (dv === undefined) delete s[k]
      else s[k] = structuredClone(dv)
    }
  }

  // ---------- skills ----------
  const aSkills = new Map(a.skills.map((s) => [s.name, s]))
  const dSkills = new Map(d.skills.map((s) => [s.name, s]))
  const skillNames = [...new Set([...aSkills.keys(), ...dSkills.keys()])].sort(cmp)
  const effSkills = new Map(aSkills)
  for (const name of skillNames) {
    const as = aSkills.get(name)
    const ds = dSkills.get(name)
    const base = { kind: 'skill' as TeamFileChangeKind, name: nm(name), file: skillFile(name) }
    if (!as && ds) {
      const scripts = skillScripts(ds)
      record({ ...base, id: `skill:${name}`, action: 'added', summary: `New skill ${nm(name)}${scripts.length ? ` with ${scripts.length} script${scripts.length === 1 ? '' : 's'}` : ''}.`, after: longText(ds.body), scripts: scripts.map((s) => nm(s, 120)) }, true, 'New skill')
    } else if (as && !ds) {
      if (record({ ...base, id: `skill:${name}`, action: 'removed', summary: `Skill ${nm(name)} is removed.` }, false, '')) effSkills.delete(name)
    } else if (as && ds) {
      const content = (s: TeamSkillDoc): unknown => [s.description, s.body, s.files]
      const next = { ...as, enabled: as.enabled && ds.enabled }
      if (!same(content(as), content(ds))) {
        const scripts = skillScripts(ds)
        record({ ...base, id: `skill:${name}`, action: 'changed', summary: `Skill ${nm(name)} changed.`, before: longText(as.body), after: longText(ds.body), scripts: scripts.map((s) => nm(s, 120)) }, true, 'Changed skill')
      }
      if (as.enabled !== ds.enabled) {
        if (ds.enabled) record({ ...base, id: `skill:${name}:enabled`, action: 'changed', summary: `Skill ${nm(name)} is turned on.` }, true, 'Skill turned on')
        else record({ ...base, id: `skill:${name}:enabled`, action: 'changed', summary: `Skill ${nm(name)} is turned off.` }, false, '')
      }
      effSkills.set(name, next)
    }
  }
  eff.skills = [...effSkills.values()]

  // ---------- servers ----------
  const aMcp = new Map(a.mcp.map((m) => [m.name, m]))
  const dMcp = new Map(d.mcp.map((m) => [m.name, m]))
  const serverNames = [...new Set([...aMcp.keys(), ...dMcp.keys()])].sort(cmp)
  const effMcp = new Map(aMcp)
  for (const name of serverNames) {
    const am = aMcp.get(name)
    const dm = dMcp.get(name)
    const base = { kind: 'mcp' as TeamFileChangeKind, name: nm(name), file: TEAM_FILES_MCP_JSON }
    const secretNames = (m: TeamMcpDoc): string[] => [...(m.secretEnv ?? []), ...(m.secretHeaders ?? [])].map((s) => nm(s, 64))
    /** What approving shows: a linked server shows the ENTRY's target and says it uses the stored sign-in and who can reach it. */
    const shown = (m: TeamMcpDoc, plain: string): Pick<TeamFileChange, 'summary' | 'target' | 'secretNames' | 'usesStoredSignIn' | 'reachesRoles'> => {
      const linked = m.connectorId !== undefined || m.fromLibrary === true ? (link?.(m) ?? null) : null
      if (!linked) return { summary: plain, target: serverTarget(m), secretNames: secretNames(m) }
      const stored = linked.stored !== false
      return {
        summary: `${plain.replace(/ would run or connect to the address shown\.$/, ' would connect to the address shown')}, ${stored ? 'using the sign-in stored on this computer' : 'and you will need to sign in'}. ${reach(m)}`,
        target: linked.target.replace(HIDDEN_ALL, '?'),
        secretNames: secretNames(m),
        ...(stored ? { usesStoredSignIn: true as const } : {}),
        ...(m.roles ? { reachesRoles: [...m.roles] } : {})
      }
    }
    if (!am && dm) {
      record({ ...base, id: `mcp:${name}`, action: 'added', ...shown(dm, `New service ${nm(name)} would run or connect to the address shown.`) }, true, 'New service')
    } else if (am && !dm) {
      if (record({ ...base, id: `mcp:${name}`, action: 'removed', summary: `Service ${nm(name)} is removed.` }, false, '')) effMcp.delete(name)
    } else if (am && dm) {
      const next: TeamMcpDoc = structuredClone(am)
      if (!same(launchOf(am), launchOf(dm))) {
        record({ ...base, id: `mcp:${name}:launch`, action: 'changed', ...shown(dm, `Service ${nm(name)} would run or connect to something different.`) }, true, 'Changed what the service runs or connects to')
      }
      if (am.enabled !== dm.enabled) {
        if (dm.enabled) record({ ...base, id: `mcp:${name}:enabled`, action: 'changed', summary: `Service ${nm(name)} is turned on.` }, true, 'Service turned on')
        else if (record({ ...base, id: `mcp:${name}:enabled`, action: 'changed', summary: `Service ${nm(name)} is turned off.` }, false, '')) next.enabled = false
      }
      // Descriptive fields apply.
      if (!force) {
        if (dm.description === undefined) delete next.description
        else next.description = dm.description
        if (dm.registry === undefined) delete next.registry
        else next.registry = structuredClone(dm.registry)
        // fromLibrary is part of the launch (it relinks to this computer's stored sign-in): it waits with the rest of it.
      }
      // Which roles may use it.
      const ar = am.roles
      const dr = dm.roles
      if (!same(ar, dr)) {
        if (ar === undefined) {
          // From every role to a list: narrowing.
          if (record({ ...base, id: `mcp:${name}:roles-narrowed`, action: 'changed', summary: `Service ${nm(name)} is limited to ${joinAnd(dr ?? [])}.` }, false, '')) next.roles = [...(dr ?? [])]
        } else if (dr === undefined) {
          record({ ...base, id: `mcp:${name}:roles`, action: 'changed', summary: `Service ${nm(name)} becomes available to every role.` }, true, 'More roles may use a service')
        } else {
          const added = diff(dr, ar)
          const removed = diff(ar, dr)
          if (added.length) record({ ...base, id: `mcp:${name}:roles`, action: 'changed', summary: `Service ${nm(name)} becomes available to ${joinAnd(added)}.` }, true, 'More roles may use a service')
          if (removed.length) {
            if (record({ ...base, id: `mcp:${name}:roles-narrowed`, action: 'changed', summary: `Service ${nm(name)} is no longer available to ${joinAnd(removed)}.` }, false, '')) next.roles = inter(ar, dr)
          } else if (!added.length) next.roles = [...dr]
        }
      }
      effMcp.set(name, next)
    }
  }
  eff.mcp = [...effMcp.values()]

  // ---------- roles ----------
  const aRoles = new Map(a.roles.map((r) => [r.slug, r]))
  const dRoles = new Map(d.roles.map((r) => [r.slug, r]))
  const slugs = [...new Set([...aRoles.keys(), ...dRoles.keys()])].sort(cmp)
  const effRoles = new Map(aRoles)
  const newRoles: TeamRoleDoc[] = []
  for (const slug of slugs) {
    const ar = aRoles.get(slug)
    const dr = dRoles.get(slug)
    if (ar && !dr) {
      if (record({ id: `role:${slug}`, kind: 'role', name: nm(ar.name), file: roleFile(slug), action: 'removed', summary: `${nm(ar.name)} is removed from the team.`, before: longText(ar.prompt) }, false, '')) effRoles.delete(slug)
      continue
    }
    if (!ar && dr) {
      newRoles.push(dr)
      continue
    }
    if (!ar || !dr) continue
    const who = nm(dr.name)
    const base = { kind: 'role' as TeamFileChangeKind, name: who, file: roleFile(slug) }
    const next: TeamRoleDoc = structuredClone(ar)
    // Prompt.
    if (ar.prompt !== dr.prompt) {
      if (record({ ...base, id: `role:${slug}:prompt`, action: 'changed', summary: `${who}'s instructions changed.`, before: longText(ar.prompt), after: longText(dr.prompt) }, false, '')) next.prompt = dr.prompt
    }
    // Everything else that is not power.
    const detailKeys: (keyof TeamRoleDoc)[] = ['name', 'description', 'responsibilities', 'color']
    // Becoming or ceasing to be the top of the chart always waits (a root swap is how a pulled file takes over the team);
    // moving under a different parent applies.
    if ((ar.reportsTo === null) !== (dr.reportsTo === null)) {
      record({ ...base, id: `role:${slug}:root`, action: 'changed', summary: dr.reportsTo === null ? `${who} would become the top of the chart.` : `${who} would stop being the top of the chart.` }, true, 'Changes who is at the top of the chart')
    } else detailKeys.push('reportsTo')
    // Model, effort and staffing (settleSpend): anything that may make a run spend more waits, judged under the project's
    // staffing mode as settled above (an applied project switch was already judged against this role) and, while a
    // project switch waits, under the mode on disk too.
    const modes = staffingModeOf(eff.settings) === staffingModeOf(d.settings) ? [eff.settings.staffing] : [eff.settings.staffing, d.settings.staffing]
    const spend = settleSpend(ar, dr, modes, who)
    for (const h of spend.held) record({ ...base, id: `role:${slug}:${h.id}`, action: 'changed', summary: h.summary }, true, 'May spend more')
    detailKeys.push(...spend.apply)
    const changedDetails = detailKeys.filter((k) => !same(ar[k], dr[k]))
    if (changedDetails.length) {
      const labels = changedDetails.map((k) => (k === 'reportsTo' ? 'reporting line' : k === 'staffing' ? 'staffing limits' : k === 'tier' || k === 'model' ? 'model' : k))
      if (record({ ...base, id: `role:${slug}:details`, action: 'changed', summary: `${who}'s ${joinAnd([...new Set(labels)])} changed.` }, false, '')) {
        for (const k of changedDetails) {
          const nr = next as unknown as Record<string, unknown>
          if (dr[k] === undefined) delete nr[k]
          else nr[k] = structuredClone(dr[k])
        }
      }
    }
    // Tools: removals apply, additions wait.
    const added = diff(dr.tools, ar.tools)
    const removed = diff(ar.tools, dr.tools)
    const kept = inter(ar.tools, dr.tools)
    if (removed.length) {
      if (record({ ...base, id: `role:${slug}:tools-removed`, action: 'changed', summary: `${who} loses ${joinAnd(removed)}.`, toolsBefore: ar.tools.map((t) => nm(t, 64)), toolsAfter: kept.map((t) => nm(t, 64)) }, false, '')) next.tools = kept
    }
    if (added.length) {
      const elevated = added.filter(isElevatedTool)
      record({ ...base, id: `role:${slug}:tools`, action: 'changed', summary: `${who} gains ${joinAnd(added)}.`, toolsBefore: kept.map((t) => nm(t, 64)), toolsAfter: dr.tools.map((t) => nm(t, 64)), toolsAdded: added.map((t) => nm(t, 64)), ...(elevated.length ? { elevatedAdded: elevated.map((t) => nm(t, 64)) } : {}) }, true, elevated.length ? 'New tools, including elevated ones' : 'New tools')
    }
    // Spawning.
    const spawnAdded = diff(dr.spawnable, ar.spawnable)
    const spawnRemoved = diff(ar.spawnable, dr.spawnable)
    const spawnOn = !ar.canSpawn && dr.canSpawn
    const spawnOff = ar.canSpawn && !dr.canSpawn
    if (spawnOn || spawnAdded.length) {
      const bits = [...(spawnOn ? ['can start other agents'] : []), ...(spawnAdded.length ? [`can start ${joinAnd(spawnAdded)}`] : [])]
      record({ ...base, id: `role:${slug}:spawn`, action: 'changed', summary: `${who} ${bits.join(' and ')}.`, ...(spawnOn ? { elevatedAdded: ['canSpawn'] } : {}) }, true, 'May start other agents')
    }
    if (spawnOff || spawnRemoved.length) {
      if (record({ ...base, id: `role:${slug}:spawn-removed`, action: 'changed', summary: `${who} can start fewer agents.` }, false, '')) {
        if (spawnOff) next.canSpawn = false
        next.spawnable = inter(ar.spawnable, dr.spawnable)
      }
    }
    // Required reports (Role.requiredReports): any change goes the spawnable way, through approval (an added one adds an
    // obligation, a removed one loosens enforcement). The final filter below keeps them within the effective spawnable.
    const reqAdded = diff(dr.requiredReports ?? [], ar.requiredReports ?? [])
    const reqRemoved = diff(ar.requiredReports ?? [], dr.requiredReports ?? [])
    if (reqAdded.length || reqRemoved.length) {
      const bits = [...(reqAdded.length ? [`must report through ${joinAnd(reqAdded)}`] : []), ...(reqRemoved.length ? [`no longer must report through ${joinAnd(reqRemoved)}`] : [])]
      record({ ...base, id: `role:${slug}:required-reports`, action: 'changed', summary: `${who} ${bits.join(' and ')}.` }, true, 'Changes which agents it must delegate to')
    }
    // Skill and service grants.
    for (const [field, label, reason] of [
      ['skills', 'skill', 'New skill access'],
      ['mcpServers', 'service', 'New service access']
    ] as const) {
      const gAdded = diff(dr[field], ar[field])
      const gRemoved = diff(ar[field], dr[field])
      if (gAdded.length) record({ ...base, id: `role:${slug}:${field}`, action: 'changed', summary: `${who} gains access to ${label} ${joinAnd(gAdded)}.` }, true, reason)
      if (gRemoved.length) {
        if (record({ ...base, id: `role:${slug}:${field}-removed`, action: 'changed', summary: `${who} loses access to ${label} ${joinAnd(gRemoved)}.` }, false, '')) next[field] = inter(ar[field], dr[field])
      }
    }
    effRoles.set(slug, next)
  }

  // New roles: a role with no elevated tool, no spawning, no skills and no services applies at once; the rest wait.
  if (force === null) {
    const trivial = new Map<string, TeamRoleDoc>()
    for (const r of newRoles) {
      const explicitServer = d.mcp.some((m) => m.roles?.includes(r.slug))
      // Only the allowlist is trivial; a new top of the chart always waits.
      const plain = r.reportsTo !== null && r.tools.every((t) => TRIVIAL_TOOLS.includes(t)) && !r.canSpawn && r.skills.length === 0 && r.mcpServers.length === 0 && !explicitServer
      if (plain) trivial.set(r.slug, r)
    }
    const accepted = new Set<string>()
    for (let changed = true; changed; ) {
      changed = false
      for (const [slug, r] of trivial) {
        if (accepted.has(slug)) continue
        if (r.reportsTo !== null && (effRoles.has(r.reportsTo) || accepted.has(r.reportsTo))) {
          accepted.add(slug)
          effRoles.set(slug, structuredClone(r))
          changed = true
        }
      }
    }
    for (const r of newRoles) {
      const draft: Draft = { id: `role:${r.slug}`, kind: 'role', name: nm(r.name), file: roleFile(r.slug), action: 'added', summary: `${nm(r.name)} joins the team.`, after: longText(r.prompt), toolsAfter: r.tools.map((t) => nm(t, 64)) }
      const elevated = [...r.tools.filter(isElevatedTool), ...(r.canSpawn ? ['canSpawn'] : [])]
      if (elevated.length) draft.elevatedAdded = elevated.map((t) => nm(t, 64))
      if (accepted.has(r.slug)) applied.push({ ...draft, needsApproval: false })
      else {
        const reason = r.reportsTo === null ? 'New top of the chart' : trivial.has(r.slug) ? 'Reports to a role that needs review' : elevated.length ? 'New role with elevated tools' : r.skills.length || r.mcpServers.length || d.mcp.some((m) => m.roles?.includes(r.slug)) ? 'New role with skills or services' : 'New role'
        pending.push({ ...draft, needsApproval: true, reason })
      }
    }
  } else {
    for (const r of newRoles) {
      const elevated = [...r.tools.filter(isElevatedTool), ...(r.canSpawn ? ['canSpawn'] : [])]
      pending.push({
        id: `role:${r.slug}`,
        kind: 'role',
        name: nm(r.name),
        file: roleFile(r.slug),
        action: 'added',
        summary: `${nm(r.name)} joins the team.`,
        needsApproval: true,
        reason: force,
        after: longText(r.prompt),
        toolsAfter: r.tools.map((t) => nm(t, 64)),
        ...(elevated.length ? { elevatedAdded: elevated.map((t) => nm(t, 64)) } : {})
      })
    }
  }

  // Nothing in the effective team may point at something it does not have.
  if (force === null) {
    eff.roles = [...effRoles.values()]
    const roleSet = new Set(eff.roles.map((r) => r.slug))
    const skillSet = new Set(eff.skills.map((s) => s.name))
    const mcpSet = new Set(eff.mcp.map((m) => m.name))
    eff.roles = eff.roles.map((r) => {
      const spawnable = r.spawnable.filter((s) => roleSet.has(s) && s !== r.slug)
      const out: TeamRoleDoc = { ...r, spawnable, skills: r.skills.filter((s) => skillSet.has(s)), mcpServers: r.mcpServers.filter((s) => mcpSet.has(s)) }
      const required = r.canSpawn ? (r.requiredReports ?? []).filter((s) => spawnable.includes(s)) : []
      if (required.length > 0) out.requiredReports = required
      else delete out.requiredReports
      return out
    })
    eff.mcp = eff.mcp.map((m) => (m.roles ? { ...m, roles: m.roles.filter((s) => roleSet.has(s)) } : m))
  }
  return { effective: normalizeDoc(eff), pending, applied }
}

/** The settings changes that really loosen something (identity of the change objects built in this module). */
const LOOSENING = new WeakSet<TeamFileChange>()

/** Most powerful first: settings that loosen, roles with elevated tools, services, skills, then the rest. */
function powerGroup(c: TeamFileChange): number {
  if (c.kind === 'settings' && LOOSENING.has(c)) return 0
  if (c.kind === 'role' && c.elevatedAdded?.length) return 1
  if (c.kind === 'mcp') return 2
  if (c.kind === 'skill') return 3
  return 4
}

/** Sorted by power group, then by id (stable, so a listing and its digest agree). */
function byId(list: TeamFileChange[]): TeamFileChange[] {
  return list.sort((x, y) => powerGroup(x) - powerGroup(y) || cmp(x.id, y.id))
}

/** At most this many passes settle one gate (gateTeam); two or three are typical. */
const GATE_MAX_PASSES = 8

export interface GateOptions {
  firstSeen?: boolean
  /** What a connector or library server would link to on this computer; absent: the file's own target is shown. */
  link?: LinkResolver
}

/**
 * Splits the differences between `approved` and `disk` into `applied` (already in `effective`) and `pending`.
 * `firstSeen`: no team of this folder was ever approved here, so everything waits and `effective` is `approved`.
 */
export function gateTeam(approved: TeamDoc, disk: TeamDoc, opts: GateOptions = {}): { effective: TeamDoc; pending: TeamFileChange[]; applied: TeamFileChange[] } {
  if (opts.firstSeen) {
    const r = engine(approved, disk, FIRST_SEEN_REASON, opts.link)
    return { effective: normalizeDoc(approved), pending: byId(r.pending), applied: [] }
  }
  // Settle to a fixpoint: a change held against the approved team may spend no more against the team the changes that
  // applied leave (an effort lowered beside a cap), so pass again over the result until nothing more applies. Every pass
  // only applies changes that spend no more and moves the team toward the disk, so it converges; the cap is a guard.
  // The pending rows and their summaries are those of the last pass (the settled team against the disk), so gating the
  // result again applies nothing and lists the same rows with the same text.
  let r = engine(approved, disk, null, opts.link)
  const applied = new Map(r.applied.map((c) => [c.id, c]))
  for (let pass = 1; ; pass++) {
    if (chartProblem(r.effective) !== null) {
      const f = engine(approved, disk, CHART_REASON, opts.link)
      return { effective: normalizeDoc(approved), pending: byId(f.pending), applied: [] }
    }
    if (!r.applied.length || pass >= GATE_MAX_PASSES) break
    r = engine(r.effective, disk, null, opts.link)
    for (const c of r.applied) if (!applied.has(c.id)) applied.set(c.id, c)
  }
  return { effective: r.effective, pending: byId(r.pending), applied: byId([...applied.values()]) }
}

const EMPTY: TeamDoc = { settings: { brief: '', permissionMode: 'default' }, roles: [], skills: [], mcp: [] }

/** Every difference between `before` (null: nothing) and `after`, all needing approval: the New project preview. */
export function describeChanges(before: TeamDoc | null, after: TeamDoc, link?: LinkResolver): TeamFileChange[] {
  return byId(engine(before ?? EMPTY, after, before ? 'Needs review' : FIRST_SEEN_REASON, link).pending)
}
