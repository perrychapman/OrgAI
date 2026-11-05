import { TEAM_FILES_AGENTS_DIR, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON, TEAM_FILES_SKILLS_DIR, type PermissionMode, type TeamFileChange, type TeamFileChangeKind } from '@shared/types'
import { skillEvaluationOf, teamReviewOf } from '@shared/defaults'
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
const ELEVATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit']
const PROMPT_TEXT_MAX = 200_000

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
  return [m.transport, m.command ?? null, m.args ?? [], m.env ?? {}, m.secretEnv ?? [], m.url ?? null, m.headers ?? {}, m.secretHeaders ?? [], m.connectorId ?? null, m.connectorVariant ?? null]
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
  teamReview: 'Team assistant review',
  skillEvaluation: 'Skill evaluation'
}
const SETTING_ORDER = Object.keys(SETTING_LABELS) as (keyof TeamSettingsDoc)[]

function showSetting(k: keyof TeamSettingsDoc, v: unknown): string {
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

function loosens(k: keyof TeamSettingsDoc, a: TeamDoc, d: TeamDoc): boolean {
  const av = a.settings[k]
  const dv = d.settings[k]
  switch (k) {
    case 'brief':
      return false
    case 'permissionMode':
      return permissionRank(dv as PermissionMode) > permissionRank(av as PermissionMode)
    case 'isolateWriters':
    case 'preferEverydayNearLimit':
      return av !== false && dv === false
    case 'reviewMerges':
      return av === true && dv !== true
    case 'autoContinue':
    case 'runMessaging':
      return av === false && dv !== false
    case 'maxBudgetUsd':
    case 'maxSubagentDepth':
    case 'maxConcurrentSubagents':
    case 'maxWindowShare':
    case 'maxAutoContinues':
      return typeof av === 'number' && (typeof dv !== 'number' || dv > av)
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

function engine(approvedIn: TeamDoc, diskIn: TeamDoc, force: string | null): Run {
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
    if (record(draft, needs, 'Loosens a limit or the permission mode')) {
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
    if (!am && dm) {
      record({ ...base, id: `mcp:${name}`, action: 'added', summary: `New service ${nm(name)} would run or connect to the address shown.`, target: serverTarget(dm), secretNames: secretNames(dm) }, true, 'New service')
    } else if (am && !dm) {
      if (record({ ...base, id: `mcp:${name}`, action: 'removed', summary: `Service ${nm(name)} is removed.` }, false, '')) effMcp.delete(name)
    } else if (am && dm) {
      const next: TeamMcpDoc = structuredClone(am)
      if (!same(launchOf(am), launchOf(dm))) {
        record({ ...base, id: `mcp:${name}:launch`, action: 'changed', summary: `Service ${nm(name)} would run or connect to something different.`, target: serverTarget(dm), secretNames: secretNames(dm) }, true, 'Changed what the service runs or connects to')
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
        if (dm.fromLibrary) next.fromLibrary = true
        else delete next.fromLibrary
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
    const detailKeys: (keyof TeamRoleDoc)[] = ['name', 'description', 'responsibilities', 'tier', 'model', 'effort', 'color', 'reportsTo']
    const changedDetails = detailKeys.filter((k) => !same(ar[k], dr[k]))
    if (changedDetails.length) {
      const labels = changedDetails.map((k) => (k === 'reportsTo' ? 'reporting line' : k === 'tier' || k === 'model' ? 'model' : k))
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
      const elevated = added.filter((t) => ELEVATED_TOOLS.includes(t))
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
      const plain = !r.tools.some((t) => ELEVATED_TOOLS.includes(t)) && !r.canSpawn && r.skills.length === 0 && r.mcpServers.length === 0 && !explicitServer
      if (plain) trivial.set(r.slug, r)
    }
    const accepted = new Set<string>()
    for (let changed = true; changed; ) {
      changed = false
      for (const [slug, r] of trivial) {
        if (accepted.has(slug)) continue
        if (r.reportsTo === null || effRoles.has(r.reportsTo) || accepted.has(r.reportsTo)) {
          accepted.add(slug)
          effRoles.set(slug, structuredClone(r))
          changed = true
        }
      }
    }
    for (const r of newRoles) {
      const draft: Draft = { id: `role:${r.slug}`, kind: 'role', name: nm(r.name), file: roleFile(r.slug), action: 'added', summary: `${nm(r.name)} joins the team.`, after: longText(r.prompt), toolsAfter: r.tools.map((t) => nm(t, 64)) }
      const elevated = [...r.tools.filter((t) => ELEVATED_TOOLS.includes(t)), ...(r.canSpawn ? ['canSpawn'] : [])]
      if (elevated.length) draft.elevatedAdded = elevated.map((t) => nm(t, 64))
      if (accepted.has(r.slug)) applied.push({ ...draft, needsApproval: false })
      else {
        const reason = trivial.has(r.slug) ? 'Reports to a role that needs review' : elevated.length ? 'New role with elevated tools' : r.skills.length || r.mcpServers.length || d.mcp.some((m) => m.roles?.includes(r.slug)) ? 'New role with skills or services' : 'New role'
        pending.push({ ...draft, needsApproval: true, reason })
      }
    }
  } else {
    for (const r of newRoles) {
      const elevated = [...r.tools.filter((t) => ELEVATED_TOOLS.includes(t)), ...(r.canSpawn ? ['canSpawn'] : [])]
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
    eff.roles = eff.roles.map((r) => ({ ...r, spawnable: r.spawnable.filter((s) => roleSet.has(s) && s !== r.slug), skills: r.skills.filter((s) => skillSet.has(s)), mcpServers: r.mcpServers.filter((s) => mcpSet.has(s)) }))
    eff.mcp = eff.mcp.map((m) => (m.roles ? { ...m, roles: m.roles.filter((s) => roleSet.has(s)) } : m))
  }
  return { effective: normalizeDoc(eff), pending, applied }
}

function byId(list: TeamFileChange[]): TeamFileChange[] {
  return list.sort((x, y) => cmp(x.id, y.id))
}

/**
 * Splits the differences between `approved` and `disk` into `applied` (already in `effective`) and `pending`.
 * `firstSeen`: no team of this folder was ever approved here, so everything waits and `effective` is `approved`.
 */
export function gateTeam(approved: TeamDoc, disk: TeamDoc, opts: { firstSeen?: boolean } = {}): { effective: TeamDoc; pending: TeamFileChange[]; applied: TeamFileChange[] } {
  if (opts.firstSeen) {
    const r = engine(approved, disk, FIRST_SEEN_REASON)
    return { effective: normalizeDoc(approved), pending: byId(r.pending), applied: [] }
  }
  const r = engine(approved, disk, null)
  if (chartProblem(r.effective) !== null) {
    const f = engine(approved, disk, CHART_REASON)
    return { effective: normalizeDoc(approved), pending: byId(f.pending), applied: [] }
  }
  return { effective: r.effective, pending: byId(r.pending), applied: byId(r.applied) }
}

const EMPTY: TeamDoc = { settings: { brief: '', permissionMode: 'default' }, roles: [], skills: [], mcp: [] }

/** Every difference between `before` (null: nothing) and `after`, all needing approval: the New project preview. */
export function describeChanges(before: TeamDoc | null, after: TeamDoc): TeamFileChange[] {
  return byId(engine(before ?? EMPTY, after, before ? 'Needs review' : FIRST_SEEN_REASON).pending)
}
