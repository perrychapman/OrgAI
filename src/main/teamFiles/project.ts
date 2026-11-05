import {
  SKILL_BODY_MAX_CHARS,
  TEAM_FILES_MAX_ROLES,
  TEAM_FILES_MAX_SERVERS,
  type McpServerSpec,
  type ModelTier,
  type Project,
  type Role,
  type SkillSpec,
  type TeamFileWarning,
  type ToolName
} from '@shared/types'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT, newId, storedSkillEvaluation, teamReviewOf } from '@shared/defaults'
import { hiddenCharIn } from '../capabilities/sanitize'
import { skippedNote } from '../capabilities/localSkills'
import { safeKitRelPath } from '../skills/files'
import { validModelId } from '../connections/codexAccount'
import { mergeOrgChart } from '../setup/orgMerge'
import { normalizeDescription } from '../skills/skillMd'
import type { TeamDoc, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc, TeamSkillFileDoc } from './doc'
import { canonicalJson, normalizeDoc, normalizeText } from './digest'
import {
  COLOR_RE,
  EFFORT_VALUES,
  ROLE_SLUG_RE,
  TOOL_RE,
  TEAM_BRIEF_MAX,
  TEAM_DESCRIPTION_MAX,
  TEAM_NAME_MAX,
  TEAM_PROMPT_MAX,
  TEAM_RESPONSIBILITIES_MAX,
  TEAM_RESPONSIBILITY_MAX,
  TEAM_TOOLS_MAX,
  chartProblem,
  defaultRoleColor,
  roleDocProblem,
  serverFileRefusal,
  skillDocProblem
} from './parse'

/**
 * Project (the cache every reader uses) to TeamDoc and back. Pure: skill file content is passed in, nothing is read or
 * written here. Nothing per computer ever reaches the document: ids, positions, timestamps, secrets values, OAuth
 * state, overrides, plugins (absolute paths), connection and tier mapping. Values the file format cannot hold are
 * cleaned (hidden characters removed, over-long text cut) with a note, so a file we write always re-reads.
 */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

type Opts = { multiline?: boolean; prose?: boolean }

/** U+2028 and U+2029, built from code points so neither appears literally in this file. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'g')

function stripHidden(s: string, opts: Opts): string {
  if (!hiddenCharIn(s, opts)) return s
  let out = ''
  for (const ch of s) if (!hiddenCharIn(ch, opts)) out += ch
  return out
}

/** Hidden characters removed, line separators turned into line breaks (a quoted line must stay short), cut to `max`. */
function cleanText(s: unknown, max: number, opts: Opts, track: { stripped: boolean; cut: boolean }): string {
  let t = typeof s === 'string' ? normalizeText(s) : ''
  if (opts.prose) t = t.replace(LINE_SEPARATORS, String.fromCharCode(10))
  const stripped = stripHidden(t, opts)
  if (stripped !== t) track.stripped = true
  t = stripped
  if (t.length > max) {
    t = t.slice(0, max)
    // Do not leave half a surrogate pair.
    const last = t.charCodeAt(t.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1)
    track.cut = true
  }
  return t
}

const sortedUnique = (list: readonly string[]): string[] => [...new Set(list)].sort(cmp)

function okNum(v: unknown, min: number, max: number, int: boolean): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))
}

// ---------- servers ----------

/** A project server as a document entry. Only the fields its transport can hold; never secret values, OAuth or overrides. */
function mcpDocFromSpec(spec: McpServerSpec, roleSlugs: Set<string> | null): TeamMcpDoc {
  const doc: TeamMcpDoc = { name: spec.name, transport: spec.transport, enabled: spec.enabled !== false }
  if (spec.transport === 'stdio') {
    if (spec.command !== undefined) doc.command = spec.command
    if (spec.args?.length) doc.args = [...spec.args]
    if (spec.env && Object.keys(spec.env).length) doc.env = { ...spec.env }
    if (spec.secretEnv?.length) doc.secretEnv = sortedUnique(spec.secretEnv)
  } else {
    if (spec.url !== undefined) doc.url = spec.url
    if (spec.headers && Object.keys(spec.headers).length) doc.headers = { ...spec.headers }
    if (spec.secretHeaders?.length) doc.secretHeaders = sortedUnique(spec.secretHeaders)
  }
  if (spec.description) doc.description = spec.description
  if (spec.roles !== undefined) doc.roles = sortedUnique(roleSlugs ? spec.roles.filter((s) => roleSlugs.has(s)) : spec.roles)
  if (spec.connectorId) {
    doc.connectorId = spec.connectorId
    if (spec.connectorVariant) doc.connectorVariant = spec.connectorVariant
  } else if (spec.libraryId) doc.fromLibrary = true
  if (spec.registry) doc.registry = { name: spec.registry.name, version: spec.registry.version, registryType: spec.registry.registryType, identifier: spec.registry.identifier }
  return doc
}

/**
 * Why a server stays on this computer and out of the files, or null: a built server (its files stay here), or anything
 * `serverFileRefusal` refuses (credentials in plain values or the address, unreviewable commands, hidden characters).
 */
export function localOnlyServerReason(spec: McpServerSpec & { buildDigest?: string }): string | null {
  if (spec.buildDigest) return 'It is a server built by the assistant; its files stay on this computer.'
  if (typeof spec.name !== 'string') return 'It has no name.'
  return serverFileRefusal(mcpDocFromSpec(spec, null))
}

// ---------- project to document ----------

export interface DocFromProject {
  doc: TeamDoc
  notes: string[]
  warnings: TeamFileWarning[]
  /** Plain sentence: the team cannot be written as files until the user fixes this. */
  blocked?: string
}

/** Skill file content as the project holds it. `skipped`: private-looking files (.env*, .pem, .key, dot-files) left out. */
export interface SkillContent {
  body: string
  files: TeamSkillFileDoc[]
  skipped?: string[]
}

/** A role file name the folder reader would refuse (Windows device names, trailing dots...), so the role would vanish on the next read. */
export const roleFileUnsafe = (slug: string): boolean => !safeKitRelPath(`.orgai/agents/${slug}.md`)

export function docFromProject(project: Project, skillContent: (spec: SkillSpec) => SkillContent | null): DocFromProject {
  const notes: string[] = []
  const warnings: TeamFileWarning[] = []
  const track = { stripped: false, cut: false }
  let blocked: string | undefined
  const block = (m: string): void => {
    blocked ??= m
  }

  // --- settings
  const settings: TeamSettingsDoc = { brief: cleanText(project.brief, TEAM_BRIEF_MAX, { prose: true }, track), permissionMode: project.permissionMode }
  const put = <K extends keyof TeamSettingsDoc>(k: K, v: TeamSettingsDoc[K] | undefined, ok: boolean): void => {
    if (v === undefined) return
    if (ok) settings[k] = v
    else notes.push(`A project setting (${k}) has a value the team files cannot hold and was left out.`)
  }
  put('maxBudgetUsd', project.maxBudgetUsd, okNum(project.maxBudgetUsd, 0, 1_000_000, false))
  put('maxSubagentDepth', project.maxSubagentDepth, okNum(project.maxSubagentDepth, 0, MAX_SUBAGENT_DEPTH_LIMIT, true))
  put('maxConcurrentSubagents', project.maxConcurrentSubagents, okNum(project.maxConcurrentSubagents, 0, MAX_CONCURRENT_SUBAGENTS_LIMIT, true))
  put('maxWindowShare', project.maxWindowShare, okNum(project.maxWindowShare, 0, 100, false))
  const plan = project.preferEverydayNearLimit ?? project.preferSonnetNearLimit
  put('preferEverydayNearLimit', plan, typeof plan === 'boolean')
  put('isolateWriters', project.isolateWriters, typeof project.isolateWriters === 'boolean')
  put('reviewMerges', project.reviewMerges, typeof project.reviewMerges === 'boolean')
  put('autoContinue', project.autoContinue, typeof project.autoContinue === 'boolean')
  put('maxAutoContinues', project.maxAutoContinues, okNum(project.maxAutoContinues, 0, 1000, true))
  put('runMessaging', project.runMessaging, typeof project.runMessaging === 'boolean')
  if (project.teamReview) settings.teamReview = teamReviewOf(project)
  if (project.skillEvaluation) settings.skillEvaluation = storedSkillEvaluation(project.skillEvaluation)

  // --- skills
  const skills: TeamSkillDoc[] = []
  const skillNameById = new Map<string, string>()
  const seenSkill = new Set<string>()
  for (const spec of project.skills ?? []) {
    const label = typeof spec.name === 'string' ? spec.name.slice(0, 64) : 'a skill'
    if (seenSkill.has(spec.name)) {
      notes.push(`Skill ${label} is left out: another skill has the same name.`)
      continue
    }
    const content = skillContent(spec)
    if (!content) {
      notes.push(`Skill ${label} is left out: its files could not be read.`)
      continue
    }
    const t = { stripped: false, cut: false }
    const doc: TeamSkillDoc = {
      name: spec.name,
      description: cleanText(normalizeDescription(String(spec.description ?? '')), 1024, { prose: true }, t),
      body: cleanText(content.body, SKILL_BODY_MAX_CHARS, { prose: true }, t).trim(),
      files: content.files
        .filter((f) => f.path !== 'SKILL.md')
        .map((f) => (f.base64 !== undefined ? { path: f.path, base64: f.base64 } : { path: f.path, text: normalizeText(f.text ?? '') })),
      enabled: spec.enabled !== false
    }
    const problem = skillDocProblem(doc)
    if (problem) {
      notes.push(`Skill ${label} is left out: ${problem}`)
      continue
    }
    if (content.skipped?.length) notes.push(`Skill ${label}: ${skippedNote(content.skipped)}. They stay on this computer and are not written to the team files.`)
    if (t.stripped) notes.push(`Hidden characters were removed from the text of skill ${label}.`)
    if (t.cut) notes.push(`The text of skill ${label} was shortened.`)
    seenSkill.add(spec.name)
    skills.push(doc)
    skillNameById.set(spec.id, spec.name)
  }

  // --- roles
  const roleList = project.roles ?? []
  if (roleList.length > TEAM_FILES_MAX_ROLES) block(`The team has more than ${TEAM_FILES_MAX_ROLES} roles; team files hold at most that many.`)
  const slugById = new Map(roleList.map((r) => [r.id, r.slug]))
  const roleSlugs = new Set(roleList.map((r) => r.slug))

  // --- servers
  const mcp: TeamMcpDoc[] = []
  const serverNameById = new Map<string, string>()
  const seenServer = new Set<string>()
  for (const spec of (project.mcpServers ?? []) as (McpServerSpec & { buildDigest?: string })[]) {
    const label = typeof spec.name === 'string' && /^[\w.-]{1,48}$/.test(spec.name) ? spec.name : 'a service'
    const reason = localOnlyServerReason(spec)
    if (reason) {
      notes.push(`Service ${label} stays on this computer: ${reason.replace(/\.$/, '')}.`)
      continue
    }
    if (seenServer.has(spec.name)) {
      notes.push(`Service ${label} is left out: another service has the same name.`)
      continue
    }
    if (mcp.length >= TEAM_FILES_MAX_SERVERS) {
      notes.push(`Service ${label} is left out: team files hold at most ${TEAM_FILES_MAX_SERVERS} services.`)
      continue
    }
    seenServer.add(spec.name)
    mcp.push(mcpDocFromSpec(spec, roleSlugs))
    serverNameById.set(spec.id, spec.name)
  }

  const roles: TeamRoleDoc[] = []
  const seenSlug = new Set<string>()
  // File-name problems first: they are the ones the user can fix, and later problems can follow from them.
  for (const r of roleList) {
    if (typeof r.slug !== 'string' || !ROLE_SLUG_RE.test(r.slug)) {
      block(`The role "${typeof r.name === 'string' ? stripHidden(r.name, {}).slice(0, 60) : 'a role'}" has a name that cannot be a file name. Rename it so it uses lowercase letters, digits and hyphens.`)
      break
    }
  }
  for (const r of roleList) {
    const t = { stripped: false, cut: false }
    const shown = typeof r.name === 'string' ? stripHidden(r.name, {}).slice(0, 60) : 'a role'
    if (typeof r.slug !== 'string' || !ROLE_SLUG_RE.test(r.slug)) {
      block(`The role "${shown}" has a name that cannot be a file name. Rename it so it uses lowercase letters, digits and hyphens.`)
      continue
    }
    if (roleFileUnsafe(r.slug)) {
      block(`The role "${shown}" has a name that is reserved on Windows (${r.slug}), so its file would not be read back. Rename it.`)
      continue
    }
    if (seenSlug.has(r.slug)) {
      block(`Two roles share the file name ${r.slug}. Rename one of them.`)
      continue
    }
    seenSlug.add(r.slug)
    let reportsTo: string | null = null
    if (r.reportsTo !== null) {
      const parent = slugById.get(r.reportsTo)
      if (parent === undefined) block(`The role "${shown}" reports to a role that no longer exists. Open the Team tab and fix the chart.`)
      else reportsTo = parent
    }
    const model = typeof r.model === 'string' && r.model.trim() !== '' ? r.model.trim() : 'inherit'
    const doc: TeamRoleDoc = {
      slug: r.slug,
      name: cleanText(r.name, TEAM_NAME_MAX, {}, track).trim() || r.slug,
      description: cleanText(r.description, TEAM_DESCRIPTION_MAX, { prose: true }, t),
      responsibilities: (r.responsibilities ?? []).slice(0, TEAM_RESPONSIBILITIES_MAX).map((x) => cleanText(x, TEAM_RESPONSIBILITY_MAX, { prose: true }, t)),
      prompt: cleanText(r.prompt, TEAM_PROMPT_MAX, { multiline: true }, t).trim(),
      tools: sortedUnique((r.tools ?? []).filter((x): x is ToolName => typeof x === 'string' && TOOL_RE.test(x))).slice(0, TEAM_TOOLS_MAX),
      canSpawn: r.canSpawn === true,
      spawnable: sortedUnique((r.spawnable ?? []).map((id) => slugById.get(id)).filter((s): s is string => typeof s === 'string' && s !== r.slug)),
      reportsTo,
      color: typeof r.color === 'string' && COLOR_RE.test(r.color) ? r.color.toLowerCase() : defaultRoleColor(r.slug),
      skills: sortedUnique((r.skills ?? []).map((id) => skillNameById.get(id)).filter((s): s is string => s !== undefined)),
      mcpServers: sortedUnique((r.mcpServers ?? []).map((id) => serverNameById.get(id)).filter((s): s is string => s !== undefined))
    }
    if (r.tier) doc.tier = r.tier
    else if (model === 'inherit' || validModelId(model)) doc.model = model
    else {
      doc.model = 'inherit'
      notes.push(`${r.slug}: its model is not a valid model id and is written as "inherit".`)
    }
    if (r.effort && EFFORT_VALUES.includes(r.effort)) doc.effort = r.effort
    if ((r.responsibilities ?? []).length > TEAM_RESPONSIBILITIES_MAX) t.cut = true
    if (t.stripped) track.stripped = true
    if (t.cut) notes.push(`The text of ${r.slug} was shortened to fit the team files.`)
    const problem = roleDocProblem(doc)
    if (problem) block(`The role "${shown}" cannot be written as a file: ${problem}`)
    roles.push(doc)
  }
  if (track.stripped) notes.push('Hidden characters were removed from some text before it was written to the files.')
  if (track.cut) notes.push('Some text was shortened to fit the team files.')
  const plugins = project.plugins?.length ?? 0
  if (plugins) notes.push(plugins === 1 ? '1 plugin stays on this computer.' : `${plugins} plugins stay on this computer.`)

  const doc = normalizeDoc({ settings, roles, skills, mcp })
  // A prompt with both conflict-marker lines would read back as a conflict.
  for (const r of doc.roles) {
    if (/^<<<<<<< /m.test(r.prompt) && /^>>>>>>> /m.test(r.prompt)) block(`The instructions of ${r.slug} contain lines that look like merge conflict markers; reword them.`)
  }
  const chart = doc.roles.length ? chartProblem(doc) : 'The team has no roles.'
  if (chart && !blocked) block(`The team cannot be written as files: ${chart}`)
  return { doc, notes, warnings, ...(blocked ? { blocked } : {}) }
}

// ---------- quick key ----------

/**
 * A string that changes whenever something the team files hold changes (roles by slug without positions, settings,
 * servers, skills with their digests), so the service can skip reading skill files when nothing relevant changed.
 */
export function teamKey(project: Project): string {
  const slugById = new Map((project.roles ?? []).map((r) => [r.id, r.slug]))
  const skillById = new Map((project.skills ?? []).map((s) => [s.id, s.name]))
  const serverById = new Map((project.mcpServers ?? []).map((s) => [s.id, s.name]))
  const names = (ids: string[] | undefined, by: Map<string, string>): string[] => sortedUnique((ids ?? []).map((id) => by.get(id) ?? `?${id}`))
  const roles = [...(project.roles ?? [])]
    .sort((a, b) => cmp(a.slug, b.slug))
    .map((r: Role) => [
      r.slug,
      r.name,
      r.description,
      r.responsibilities,
      r.prompt,
      sortedUnique(r.tools),
      r.tier ?? null,
      r.model,
      r.effort ?? null,
      r.canSpawn,
      names(r.spawnable, slugById),
      r.reportsTo === null ? null : (slugById.get(r.reportsTo) ?? '?'),
      r.color,
      names(r.skills, skillById),
      names(r.mcpServers, serverById)
    ])
  const skills = [...(project.skills ?? [])].sort((a, b) => cmp(a.name, b.name)).map((s) => [s.name, s.description, s.enabled, s.digest, s.libraryId ?? null])
  const servers = [...(project.mcpServers ?? [])]
    .sort((a, b) => cmp(a.name, b.name))
    .map((s) => [s.name, s.transport, s.command ?? null, s.args ?? [], s.env ?? {}, s.secretEnv ?? [], s.url ?? null, s.headers ?? {}, s.secretHeaders ?? [], s.description ?? null, s.enabled, s.roles ?? null, s.connectorId ?? null, s.connectorVariant ?? null, s.libraryId ?? null, s.registry ?? null, (s as { buildDigest?: string }).buildDigest ?? null])
  const settings = [
    project.brief,
    project.permissionMode,
    project.maxBudgetUsd,
    project.maxSubagentDepth,
    project.maxConcurrentSubagents,
    project.maxWindowShare,
    project.preferEverydayNearLimit,
    project.preferSonnetNearLimit,
    project.isolateWriters,
    project.reviewMerges,
    project.autoContinue,
    project.maxAutoContinues,
    project.runMessaging,
    project.teamReview ?? null,
    project.skillEvaluation ?? null,
    project.plugins?.length ?? 0
  ].map((v) => (v === undefined ? null : v))
  return canonicalJson({ settings, roles, skills, servers })
}

// ---------- document to project ----------

/** Canvas positions by depth in the chart, the way the drafter lays a new chart out. */
function layoutByDepth(roles: Role[]): Map<string, { x: number; y: number }> {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const depth = (r: Role): number => {
    let d = 0
    let cur: Role | undefined = r
    const seen = new Set<string>()
    while (cur?.reportsTo && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.reportsTo)
      d++
    }
    return d
  }
  const levels = new Map<number, Role[]>()
  for (const r of roles) {
    const d = depth(r)
    levels.set(d, [...(levels.get(d) ?? []), r])
  }
  const out = new Map<string, { x: number; y: number }>()
  for (const [d, group] of levels) {
    const width = (group.length - 1) * 300
    group.forEach((r, i) => out.set(r.id, { x: i * 300 - width / 2, y: d * 210 }))
  }
  return out
}

export interface RolesFromDocContext {
  /** The project's model for a tier on its connection. */
  tierModel: (tier: ModelTier) => string | undefined
  /** Id of the project's server with this name. */
  serverId: (name: string) => string | undefined
  /** Id of the project's skill with this name. */
  skillId: (name: string) => string | undefined
  /** Ids of local-only servers: a role that holds one keeps holding it. */
  keepServerIds: string[]
}

/**
 * The project's roles for a document. Ids survive per slug (mergeOrgChart: slug, then same name), so grants and positions
 * stay; slug, colour, effort and tier / model then come from the document. Grants map to ids through `ctx` (names that
 * map to nothing are dropped) plus the local-only servers the existing role already held. New roles are laid out by depth.
 */
export function rolesFromDoc(project: Project, doc: TeamDoc, ctx: RolesFromDocContext): Role[] {
  const proposedId = new Map(doc.roles.map((r) => [r.slug, newId('role')]))
  const grants = (r: TeamRoleDoc): { mcp: string[]; skills: string[] } => ({
    mcp: r.mcpServers.map((n) => ctx.serverId(n)).filter((x): x is string => x !== undefined),
    skills: r.skills.map((n) => ctx.skillId(n)).filter((x): x is string => x !== undefined)
  })
  const proposed: Role[] = doc.roles.map((r) => {
    const g = grants(r)
    return {
      id: proposedId.get(r.slug) as string,
      slug: r.slug,
      name: r.name,
      description: r.description,
      responsibilities: [...r.responsibilities],
      prompt: r.prompt,
      tools: [...r.tools] as ToolName[],
      model: r.tier ? (ctx.tierModel(r.tier) ?? 'inherit') : (r.model ?? 'inherit'),
      ...(r.tier ? { tier: r.tier } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      canSpawn: r.canSpawn,
      spawnable: r.spawnable.map((s) => proposedId.get(s)).filter((x): x is string => x !== undefined),
      reportsTo: r.reportsTo === null ? null : (proposedId.get(r.reportsTo) ?? null),
      position: { x: 0, y: 0 },
      color: r.color,
      mcpServers: g.mcp,
      skills: g.skills
    }
  })
  const merged = mergeOrgChart({ roles: project.roles ?? [], mcpServers: project.mcpServers, skills: project.skills }, proposed).roles
  const existingById = new Map((project.roles ?? []).map((r) => [r.id, r]))
  const keep = new Set(ctx.keepServerIds)
  const result = merged.map((role, i) => {
    const d = doc.roles[i]
    const prior = existingById.get(role.id)
    const out: Role = { ...role, slug: d.slug, color: d.color }
    if (d.effort) out.effort = d.effort
    else delete out.effort
    if (d.tier) {
      out.tier = d.tier
      out.model = ctx.tierModel(d.tier) ?? 'inherit'
    } else {
      delete out.tier
      out.model = d.model ?? 'inherit'
    }
    const g = grants(d)
    out.skills = g.skills
    out.mcpServers = sortedUnique([...g.mcp, ...(prior?.mcpServers ?? []).filter((id) => keep.has(id))])
    if (prior) out.position = { ...prior.position }
    return out
  })
  const layout = layoutByDepth(result)
  for (const r of result) if (!existingById.has(r.id)) r.position = layout.get(r.id) ?? { x: 0, y: 0 }
  return result
}

/** The project with every settings key set from the document (or deleted when the document has none). */
export function settingsFromDoc(project: Project, doc: TeamDoc): Project {
  const p: Project = { ...project }
  const s = doc.settings
  p.brief = s.brief
  p.permissionMode = s.permissionMode
  const rec = p as unknown as Record<string, unknown>
  const assign = (k: keyof TeamSettingsDoc): void => {
    const v = s[k]
    if (v === undefined) delete rec[k]
    else rec[k] = structuredClone(v)
  }
  assign('maxBudgetUsd')
  assign('maxSubagentDepth')
  assign('maxConcurrentSubagents')
  assign('maxWindowShare')
  assign('isolateWriters')
  assign('reviewMerges')
  assign('autoContinue')
  assign('maxAutoContinues')
  assign('runMessaging')
  assign('teamReview')
  assign('skillEvaluation')
  if (s.preferEverydayNearLimit === undefined) {
    delete p.preferEverydayNearLimit
    delete p.preferSonnetNearLimit
  } else {
    p.preferEverydayNearLimit = s.preferEverydayNearLimit
    p.preferSonnetNearLimit = s.preferEverydayNearLimit
  }
  return p
}

const launchKey = (m: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'env' | 'secretEnv' | 'url' | 'headers' | 'secretHeaders'>): string =>
  canonicalJson([m.transport, m.command ?? null, m.args ?? [], m.env ?? {}, sortedUnique(m.secretEnv ?? []), m.url ?? null, m.headers ?? {}, sortedUnique(m.secretHeaders ?? [])])

/**
 * A project-only server for a document entry. A new one has source 'user'; with the same launch as `existing` it keeps
 * that server's id, addedAt, source and OAuth state. Never a library link.
 */
export function mcpSpecFromDoc(doc: TeamMcpDoc, existing: McpServerSpec | undefined, id: string, addedAt: string): McpServerSpec {
  const spec: McpServerSpec = { id, name: doc.name, transport: doc.transport, enabled: doc.enabled, source: 'user', addedAt }
  if (doc.command !== undefined) spec.command = doc.command
  if (doc.args?.length) spec.args = [...doc.args]
  if (doc.env && Object.keys(doc.env).length) spec.env = { ...doc.env }
  if (doc.secretEnv?.length) spec.secretEnv = [...doc.secretEnv]
  if (doc.url !== undefined) spec.url = doc.url
  if (doc.headers && Object.keys(doc.headers).length) spec.headers = { ...doc.headers }
  if (doc.secretHeaders?.length) spec.secretHeaders = [...doc.secretHeaders]
  if (doc.description) spec.description = doc.description
  if (doc.roles !== undefined) spec.roles = [...doc.roles]
  if (doc.registry) spec.registry = { ...doc.registry }
  if (doc.connectorId) {
    spec.connectorId = doc.connectorId
    if (doc.connectorVariant) spec.connectorVariant = doc.connectorVariant
  }
  if (existing && launchKey(existing) === launchKey(spec)) {
    spec.id = existing.id
    spec.addedAt = existing.addedAt
    spec.source = existing.source
    if (existing.oauth) spec.oauth = structuredClone(existing.oauth)
  }
  return spec
}
