import { AGENT_IMPORT_ELEVATED_TOOLS, TEAM_FILES_AGENTS_DIR, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON, TEAM_FILES_SKILLS_DIR, DEFAULT_MAX_AUTO_CONTINUES, type ModelTier, type PermissionMode, type TeamFileChange, type TeamFileChangeKind } from '@shared/types'
import { cleanRoleStaffing, compareEffort, compareTier, effectiveRoleStaffing, effectiveSubagentLimits, skillEvaluationOf, staffingModeOf, teamReviewOf } from '@shared/defaults'
import { fullTarget, safeText } from '../kit/format'
import type { TeamDoc, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc } from './doc'
import { canonicalJson, normalizeDoc } from './digest'
import { chartProblem, skillScripts } from './parse'

/**
 * The approval gate. `gateTeam(approved, disk)` splits the differences between the last approved team and what the
 * files say into changes that apply at once and changes that wait for the user, and returns the `effective` document
 * (what becomes the new approved team). Anything that raises power stays at its approved value and is listed pending;
 * prompts, descriptions, removals and lowered power apply. Idempotent: gating the effective document against the same
 * disk again applies nothing and lists the same pending changes. Pure.
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

/** The effort ceiling the staffing resolver enforces when none is set (runtime/staffing.ts rule 2). */
const UNSET_EFFORT_CEILING = 'high' as const

/** What a role's staffing lets a run spend: its effective mode, effort ceiling (high when none) and the raw tier floor. */
function staffingSpend(r: TeamRoleDoc, projectStaffing: TeamSettingsDoc['staffing']): { fixed: boolean; ceiling: NonNullable<TeamRoleDoc['effort']>; floor: ModelTier | undefined } {
  const e = effectiveRoleStaffing({ model: r.model ?? '', tier: r.tier, effort: r.effort, staffing: r.staffing }, { staffing: projectStaffing })
  return { fixed: e.mode === 'fixed', ceiling: e.maxEffort ?? UNSET_EFFORT_CEILING, floor: cleanRoleStaffing(r.staffing)?.minTier }
}

/**
 * Whether moving a role from `a` to `d` (its tier, model and effort already as the gate settled them) can make a run
 * spend more: a raised effort ceiling (a removed one counts when it raises the effective one), a raised or added tier
 * floor, or automatic becoming fixed. `pa` and `pd` are the project staffing before and after the gate settled it.
 */
function staffingMayCostMore(a: TeamRoleDoc, d: TeamRoleDoc, pa: TeamSettingsDoc['staffing'], pd: TeamSettingsDoc['staffing']): boolean {
  const x = staffingSpend(a, pa)
  const y = staffingSpend(d, pd)
  if (!x.fixed && y.fixed) return true
  if (compareEffort(y.ceiling, x.ceiling) > 0) return true
  return y.floor !== undefined && (x.floor === undefined || compareTier(y.floor, x.floor) > 0)
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
    // Fixed means every role always runs at its ceiling; unset and 'auto' are the same.
    case 'staffing':
      return staffingModeOf({ staffing: av as TeamSettingsDoc['staffing'] }) === 'auto' && staffingModeOf({ staffing: dv as TeamSettingsDoc['staffing'] }) === 'fixed'
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
    const summary = k === 'brief' ? 'The project brief changed.' : `${label} changes from ${showSetting(k, av)} to ${showSetting(k, dv)}.`
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
    // A model that may spend more waits: a higher tier, any pinned model, or leaving a tier for anything but a lower one.
    let modelOk = true
    let effortOk = true
    if (!same([ar.tier, ar.model], [dr.tier, dr.model])) {
      if (modelMayCostMore(ar, dr)) modelOk = false
      if (modelMayCostMore(ar, dr)) record({ ...base, id: `role:${slug}:model`, action: 'changed', summary: `${who}'s model changes and may spend more.` }, true, 'May spend more')
      else detailKeys.push('tier', 'model')
    }
    if (!same(ar.effort, dr.effort)) {
      if (effortRaised(ar, dr)) effortOk = false
      if (effortRaised(ar, dr)) record({ ...base, id: `role:${slug}:effort`, action: 'changed', summary: `${who}'s reasoning effort is raised and may spend more.` }, true, 'May spend more')
      else detailKeys.push('effort')
    }
    // Staffing: held when it can make a run spend more. Judged on the role as it will stand after the rows above (a held
    // model or effort stays at the approved value) and on the project's staffing as settled above.
    const settled: TeamRoleDoc = { ...dr, tier: modelOk ? dr.tier : ar.tier, model: modelOk ? dr.model : ar.model, effort: effortOk ? dr.effort : ar.effort }
    let staffingOk = true
    if (!same(ar.staffing, dr.staffing)) {
      if (staffingMayCostMore(ar, settled, a.settings.staffing, eff.settings.staffing)) {
        staffingOk = false
        record({ ...base, id: `role:${slug}:staffing`, action: 'changed', summary: `${who}'s staffing limits are raised and may spend more.` }, true, 'May spend more')
      } else detailKeys.push('staffing')
    }
    // Removing the effort (which the rule above lets through) lifts the effective ceiling to high when no maxEffort holds it.
    if (effortOk && !same(ar.effort, dr.effort) && staffingMayCostMore(ar, { ...settled, staffing: staffingOk ? dr.staffing : ar.staffing }, a.settings.staffing, eff.settings.staffing)) {
      detailKeys.splice(detailKeys.indexOf('effort'), 1)
      record({ ...base, id: `role:${slug}:effort`, action: 'changed', summary: `${who}'s reasoning effort is removed, which raises its effort ceiling and may spend more.` }, true, 'May spend more')
    }
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
  const r = engine(approved, disk, null, opts.link)
  if (chartProblem(r.effective) !== null) {
    const f = engine(approved, disk, CHART_REASON, opts.link)
    return { effective: normalizeDoc(approved), pending: byId(f.pending), applied: [] }
  }
  return { effective: r.effective, pending: byId(r.pending), applied: byId(r.applied) }
}

const EMPTY: TeamDoc = { settings: { brief: '', permissionMode: 'default' }, roles: [], skills: [], mcp: [] }

/** Every difference between `before` (null: nothing) and `after`, all needing approval: the New project preview. */
export function describeChanges(before: TeamDoc | null, after: TeamDoc, link?: LinkResolver): TeamFileChange[] {
  return byId(engine(before ?? EMPTY, after, before ? 'Needs review' : FIRST_SEEN_REASON, link).pending)
}
