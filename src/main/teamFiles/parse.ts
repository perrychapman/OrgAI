import {
  SKILL_BODY_MAX_CHARS,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  SKILL_NAME_MAX,
  TEAM_FILES_AGENTS_DIR,
  TEAM_FILES_FORMAT,
  TEAM_FILES_JSON,
  TEAM_FILES_MAX_JSON_BYTES,
  TEAM_FILES_MAX_ROLES,
  TEAM_FILES_MAX_ROLE_BYTES,
  TEAM_FILES_MAX_SERVERS,
  TEAM_FILES_MAX_TOTAL_BYTES,
  TEAM_FILES_MCP_JSON,
  TEAM_FILES_SKILLS_DIR,
  isModelTier,
  isPermissionMode,
  type Effort,
  type McpRegistryRef,
  type McpServerSpec,
  type TeamFileProblem,
  type TeamFileWarning
} from '@shared/types'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT, ROLE_COLORS, isValidMcpServerName, skillDescriptionProblem, skillNameProblem, storedSkillEvaluation, teamReviewOf } from '@shared/defaults'
import { hiddenCharIn, hiddenCharProblem, isKeyLikeValue, reviewTarget } from '../capabilities/sanitize'
import { validModelId } from '../connections/codexAccount'
import { serverRiskRefusal, serverValueRefusal, slotRefusal, safeText } from '../kit/format'
import { pinErrors, validateSpec } from '../mcp/validate'
import { maskKeyLike } from '../runtime/codexAppServer'
import { parseFrontmatter, type FmValue } from '../setup/import/frontmatter'
import { inGitDir } from '../setup/import/scan'
import { digestFiles, looksLikeScript, safeKitRelPath, safeRelPath, SKILL_MAX_DEPTH, type FileData } from '../skills/files'
import { buildScannedSkill } from '../skills/scan'
import type { TeamDoc, TeamFile, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc, TeamSkillFileDoc } from './doc'
import { normalizeDoc, normalizeText, sha256Hex, teamDigest } from './digest'

/**
 * Team files to a TeamDoc. Pure: the caller reads the bytes. Every file is untrusted data: nothing is executed or
 * followed, every value is rebuilt field by field with a type and range check, and a file that is wrong in any way
 * becomes a problem that keeps the last approved content for that item (`base`) and is held, never overwritten.
 * Problem texts never quote file text. Never throws.
 */

export const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Role files carry long descriptions on one line. */
export const TEAM_ROLE_LINE_CHARS = 64 * 1024
export const TEAM_NAME_MAX = 120
export const TEAM_DESCRIPTION_MAX = 20_000
export const TEAM_PROMPT_MAX = 200_000
export const TEAM_RESPONSIBILITIES_MAX = 100
export const TEAM_RESPONSIBILITY_MAX = 4_000
export const TEAM_TOOLS_MAX = 100
export const TEAM_BRIEF_MAX = 20_000
export const EFFORT_VALUES: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const REFS_MAX = 200
export const TOOL_RE = /^[A-Za-z][\w-]{0,127}$/
export const COLOR_RE = /^#[0-9a-f]{6}$/i
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const CONFLICT = 'It has merge conflict markers.'
const MCP_STR_MAX = 8_000
const MCP_LIST_MAX = 200
const MCP_MAP_MAX = 100

export interface ParsedTeam {
  /** `.orgai/team.json` is among the files or named in readProblems. */
  present: boolean
  /** null when the team as a whole cannot be used. */
  doc: TeamDoc | null
  problems: TeamFileProblem[]
  notes: string[]
  warnings: TeamFileWarning[]
  /** Files, skill folders, mcp.json and team.json whose content was unusable: the writer must never overwrite them. */
  heldPaths: string[]
  /** teamDigest of the document plus the identity of the problem files; '' when doc is null. */
  digest: string
}

// ---------- small helpers ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sortedUnique = (list: readonly string[]): string[] => [...new Set(list)].sort(cmp)

class BadFile extends Error {}
const bad = (message: string): never => {
  throw new BadFile(message)
}

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

/** A role colour picked by the slug when a file names none, so every computer shows the same one. */
export function defaultRoleColor(slug: string): string {
  let h = 5381
  for (let i = 0; i < slug.length; i++) h = (Math.imul(h, 33) + slug.charCodeAt(i)) >>> 0
  return ROLE_COLORS[h % ROLE_COLORS.length]
}

interface MarkerCount {
  open: boolean
  mid: boolean
  close: boolean
}

function markers(text: string): MarkerCount {
  const m: MarkerCount = { open: false, mid: false, close: false }
  for (const line of text.split('\n')) {
    const l = line.replace(/\r$/, '')
    if (l.startsWith('<<<<<<< ')) m.open = true
    else if (l === '=======') m.mid = true
    else if (l.startsWith('>>>>>>> ')) m.close = true
  }
  return m
}

/** Conflict markers anywhere in a JSON file or in a role's frontmatter (any), or its body (both ends). */
export function hasConflictMarkers(text: string, kind: 'json' | 'role'): boolean {
  if (kind === 'json') {
    const m = markers(text)
    return m.open || m.mid || m.close
  }
  const lines = text.split('\n')
  let end = -1
  if (lines[0]?.trimEnd() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trimEnd()
      if (t === '---' || t === '...') {
        end = i
        break
      }
    }
  }
  const head = markers(lines.slice(0, end < 0 ? lines.length : end + 1).join('\n'))
  if (head.open || head.mid || head.close) return true
  const all = markers(text)
  return all.open && all.close
}

/** Text that looks like it holds a key. Does not say which text. */
function keyShaped(text: string): boolean {
  const t = text.length > 400_000 ? text.slice(0, 400_000) : text
  if (maskKeyLike(t) !== t) return true
  for (const tok of t.split(/[\s"',;:=()<>[\]{}`]+/)) {
    if (tok.length >= 8 && tok.length <= 400 && !/^[0-9a-f]{32,64}$/i.test(tok) && isKeyLikeValue(tok)) return true
  }
  return false
}

// ---------- chart validity ----------

/** Why the roles do not form a chart (exactly one root, every reportsTo a role, no cycles), or null. */
export function chartProblem(doc: Pick<TeamDoc, 'roles'>): string | null {
  const roles = doc.roles
  if (roles.length === 0) return 'The team has no roles.'
  const bySlug = new Map(roles.map((r) => [r.slug, r]))
  const roots = roles.filter((r) => r.reportsTo === null)
  if (roots.length === 0) return 'No role is the root: one role must report to nobody.'
  if (roots.length > 1) return 'More than one role reports to nobody; the team has exactly one root.'
  for (const r of roles) {
    if (r.reportsTo !== null && !bySlug.has(r.reportsTo)) return `${r.slug} reports to ${r.reportsTo}, which is not a role.`
  }
  for (const r of roles) {
    const seen = new Set<string>([r.slug])
    let cur = r
    while (cur.reportsTo !== null) {
      if (seen.has(cur.reportsTo)) return `The reporting lines of ${r.slug} loop back on themselves.`
      seen.add(cur.reportsTo)
      cur = bySlug.get(cur.reportsTo) as TeamRoleDoc
    }
  }
  return null
}

// ---------- roles ----------

function refProblem(field: string, list: readonly string[], ok: (s: string) => boolean): string | null {
  if (list.length > REFS_MAX) return `${field} has more than ${REFS_MAX} entries.`
  for (const s of list) if (typeof s !== 'string' || !ok(s)) return `${field} has an entry that is not a valid name.`
  return null
}

/** Everything the parser demands of a role, as a document check. Used on the write side too, so a file we write re-reads. */
export function roleDocProblem(r: TeamRoleDoc): string | null {
  if (typeof r.slug !== 'string' || !ROLE_SLUG_RE.test(r.slug)) return 'The role name cannot be used as a file name.'
  if (typeof r.name !== 'string' || r.name.trim() === '' || r.name.length > TEAM_NAME_MAX) return `The name needs 1 to ${TEAM_NAME_MAX} characters.`
  const name = hiddenCharProblem('The name', r.name)
  if (name) return name
  if (typeof r.description !== 'string' || r.description.length > TEAM_DESCRIPTION_MAX) return `The description has at most ${TEAM_DESCRIPTION_MAX.toLocaleString('en-US')} characters.`
  const desc = hiddenCharProblem('The description', r.description, { prose: true })
  if (desc) return desc
  if (typeof r.prompt !== 'string' || r.prompt.length > TEAM_PROMPT_MAX) return `The instructions have at most ${TEAM_PROMPT_MAX.toLocaleString('en-US')} characters.`
  const prompt = hiddenCharProblem('The instructions', r.prompt, { multiline: true })
  if (prompt) return prompt
  if (!Array.isArray(r.responsibilities) || r.responsibilities.length > TEAM_RESPONSIBILITIES_MAX) return `At most ${TEAM_RESPONSIBILITIES_MAX} responsibilities are allowed.`
  for (const x of r.responsibilities) {
    if (typeof x !== 'string' || x.length > TEAM_RESPONSIBILITY_MAX) return `A responsibility has at most ${TEAM_RESPONSIBILITY_MAX.toLocaleString('en-US')} characters.`
    const p = hiddenCharProblem('A responsibility', x, { prose: true })
    if (p) return p
  }
  if (!Array.isArray(r.tools) || r.tools.length > TEAM_TOOLS_MAX) return `At most ${TEAM_TOOLS_MAX} tools are allowed.`
  for (const t of r.tools) if (typeof t !== 'string' || !TOOL_RE.test(t)) return 'A tool name is not valid.'
  if ((r.tier === undefined) === (r.model === undefined)) return 'A role sets exactly one of tier and model.'
  if (r.tier !== undefined && !isModelTier(r.tier)) return 'The tier is not one of top, deep, everyday or fast.'
  if (r.model !== undefined && r.model !== 'inherit' && !validModelId(r.model)) return 'The model is not a valid model id.'
  if (r.effort !== undefined && !EFFORT_VALUES.includes(r.effort)) return 'The effort is not one of low, medium, high, xhigh or max.'
  if (typeof r.canSpawn !== 'boolean') return 'canSpawn must be true or false.'
  const refs =
    refProblem('spawnable', r.spawnable ?? [], (s) => ROLE_SLUG_RE.test(s)) ??
    refProblem('required_reports', r.requiredReports ?? [], (s) => ROLE_SLUG_RE.test(s)) ??
    refProblem('skills', r.skills ?? [], (s) => s.length <= SKILL_NAME_MAX && skillNameProblem(s) === null) ??
    refProblem('mcpServers', r.mcpServers ?? [], (s) => isValidMcpServerName(s))
  if (refs) return refs
  if (r.reportsTo !== null && (typeof r.reportsTo !== 'string' || !ROLE_SLUG_RE.test(r.reportsTo))) return 'reportsTo must name a role or be null.'
  if (typeof r.color !== 'string' || !COLOR_RE.test(r.color)) return 'The colour must look like #rrggbb.'
  return null
}

function fmList(data: Record<string, FmValue>, key: string, label: string): string[] | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const v = data[key]
  if (v === null) return []
  if (!Array.isArray(v)) return bad(`${label} must be a list.`)
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return bad(`${label} must be a list of text.`)
    out.push(x)
  }
  return out
}

interface RoleRead {
  role?: TeamRoleDoc
  problem?: string
  keyShaped?: boolean
}

function readRole(slug: string, bytes: Buffer): RoleRead {
  const text = decodeUtf8(bytes)
  if (text === null) return { problem: 'It is not valid UTF-8 text.' }
  const norm = normalizeText(text)
  if (hasConflictMarkers(norm, 'role')) return { problem: CONFLICT }
  const fm = parseFrontmatter(norm, { maxLineChars: TEAM_ROLE_LINE_CHARS })
  if (fm.error) return { problem: `Its header could not be read: ${safeText(fm.error, 120)}.` }
  const d = fm.data
  try {
    const str = (k: string, label: string): string => {
      const v = Object.hasOwn(d, k) ? d[k] : undefined
      if (typeof v !== 'string') return bad(`It needs ${label}.`)
      return v
    }
    const role: TeamRoleDoc = {
      slug,
      name: str('name', 'a name'),
      description: str('description', 'a description'),
      responsibilities: fmList(d, 'responsibilities', 'responsibilities') ?? [],
      prompt: fm.body,
      tools: sortedUnique(fmList(d, 'tools', 'tools') ?? []),
      canSpawn: false,
      spawnable: sortedUnique(fmList(d, 'spawnable', 'spawnable') ?? []),
      reportsTo: null,
      color: defaultRoleColor(slug),
      skills: sortedUnique(fmList(d, 'skills', 'skills') ?? []),
      mcpServers: sortedUnique(fmList(d, 'mcpServers', 'mcpServers') ?? [])
    }
    const required = sortedUnique(fmList(d, 'required_reports', 'required_reports') ?? [])
    if (required.length > 0) role.requiredReports = required
    const tier = Object.hasOwn(d, 'tier') ? d.tier : null
    const model = Object.hasOwn(d, 'model') ? d.model : null
    if (tier !== null && model !== null) return { problem: 'It sets both tier and model; use one.' }
    if (tier !== null) {
      if (typeof tier !== 'string' || !isModelTier(tier)) return { problem: 'The tier is not one of top, deep, everyday or fast.' }
      role.tier = tier
    } else if (model !== null) {
      if (typeof model !== 'string' || (model !== 'inherit' && !validModelId(model))) return { problem: 'The model is not a valid model id.' }
      role.model = model
    } else role.model = 'inherit'
    const effort = Object.hasOwn(d, 'effort') ? d.effort : null
    if (effort !== null) {
      if (typeof effort !== 'string' || !(EFFORT_VALUES as readonly string[]).includes(effort)) return { problem: 'The effort is not one of low, medium, high, xhigh or max.' }
      role.effort = effort as Effort
    }
    const canSpawn = Object.hasOwn(d, 'canSpawn') ? d.canSpawn : false
    if (canSpawn !== null && typeof canSpawn !== 'boolean') return { problem: 'canSpawn must be true or false.' }
    role.canSpawn = canSpawn === true
    const reportsTo = Object.hasOwn(d, 'reportsTo') ? d.reportsTo : null
    if (reportsTo !== null) {
      if (typeof reportsTo !== 'string' || !ROLE_SLUG_RE.test(reportsTo)) return { problem: 'reportsTo must name a role or be null.' }
      role.reportsTo = reportsTo
    }
    const color = Object.hasOwn(d, 'color') ? d.color : null
    if (typeof color === 'string' && COLOR_RE.test(color)) role.color = color.toLowerCase()
    const p = roleDocProblem(role)
    if (p) return { problem: p }
    return { role, keyShaped: keyShaped(norm) }
  } catch (e) {
    return { problem: e instanceof BadFile ? e.message : 'It could not be read.' }
  }
}

// ---------- team.json ----------

const SETTING_KEYS = [
  'brief',
  'permissionMode',
  'maxBudgetUsd',
  'maxSubagentDepth',
  'maxConcurrentSubagents',
  'maxWindowShare',
  'preferEverydayNearLimit',
  'isolateWriters',
  'reviewMerges',
  'autoContinue',
  'maxAutoContinues',
  'runMessaging',
  'teamReview',
  'skillEvaluation'
]
const KNOWN_TEAM_KEYS = new Set(['format', 'disabledSkills', ...SETTING_KEYS])

interface JsonRead<T> {
  value?: T
  problem?: string
}

function readJsonObject(bytes: Buffer): JsonRead<Record<string, unknown>> {
  if (bytes.length > TEAM_FILES_MAX_JSON_BYTES) return { problem: 'It is too large to read.' }
  const text = decodeUtf8(bytes)
  if (text === null) return { problem: 'It is not valid UTF-8 text.' }
  const norm = normalizeText(text)
  if (hasConflictMarkers(norm, 'json')) return { problem: CONFLICT }
  let value: unknown
  try {
    value = JSON.parse(norm)
  } catch {
    return { problem: 'It is not valid JSON.' }
  }
  if (!isObj(value)) return { problem: 'It is not a JSON object.' }
  const format = own(value, 'format')
  if (format !== TEAM_FILES_FORMAT) return { problem: 'It was made by a different OrgAI version (format).' }
  return { value }
}

function numField(o: Record<string, unknown>, k: string, min: number, max: number, int: boolean): number | undefined {
  const v = own(o, k)
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) return bad(`${k} is not a valid number.`)
  return v
}

function boolField(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = own(o, k)
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') return bad(`${k} must be true or false.`)
  return v
}

function readSettings(o: Record<string, unknown>, base: TeamSettingsDoc | null, notes: string[]): { settings: TeamSettingsDoc; disabled: string[] } {
  const brief = own(o, 'brief')
  if (brief !== undefined && (typeof brief !== 'string' || brief.length > TEAM_BRIEF_MAX)) bad(`brief must be text of at most ${TEAM_BRIEF_MAX.toLocaleString('en-US')} characters.`)
  const briefText = typeof brief === 'string' ? normalizeText(brief) : (base?.brief ?? '')
  const briefHidden = hiddenCharProblem('The brief', briefText, { prose: true })
  if (briefHidden) bad(briefHidden)
  const mode = own(o, 'permissionMode')
  if (mode !== undefined && !isPermissionMode(mode)) bad('permissionMode is not a known mode.')
  const settings: TeamSettingsDoc = { brief: briefText, permissionMode: isPermissionMode(mode) ? mode : (base?.permissionMode ?? 'default') }
  const set = <K extends keyof TeamSettingsDoc>(k: K, v: TeamSettingsDoc[K] | undefined): void => {
    if (v !== undefined) settings[k] = v as TeamSettingsDoc[K]
  }
  set('maxBudgetUsd', numField(o, 'maxBudgetUsd', 0, 1_000_000, false))
  // Above the effective caps is a problem, not a silent clamp: the file would say more than any run can do.
  set('maxSubagentDepth', numField(o, 'maxSubagentDepth', 0, MAX_SUBAGENT_DEPTH_LIMIT, true))
  set('maxConcurrentSubagents', numField(o, 'maxConcurrentSubagents', 0, MAX_CONCURRENT_SUBAGENTS_LIMIT, true))
  set('maxWindowShare', numField(o, 'maxWindowShare', 0, 100, false))
  set('preferEverydayNearLimit', boolField(o, 'preferEverydayNearLimit'))
  set('isolateWriters', boolField(o, 'isolateWriters'))
  set('reviewMerges', boolField(o, 'reviewMerges'))
  set('autoContinue', boolField(o, 'autoContinue'))
  set('maxAutoContinues', numField(o, 'maxAutoContinues', 0, 1000, true))
  set('runMessaging', boolField(o, 'runMessaging'))
  const tr = own(o, 'teamReview')
  if (tr !== undefined && tr !== null) {
    if (!isObj(tr)) bad('teamReview is not valid.')
    const t = tr as Record<string, unknown>
    const auto = own(t, 'auto')
    if (auto !== undefined && auto !== 'off' && auto !== 'free' && auto !== 'ai') bad('teamReview.auto is not valid.')
    const budget = numField(t, 'tokenBudget', 0, 1e9, false)
    const every = numField(t, 'everyRuns', 0, 1e6, false)
    settings.teamReview = teamReviewOf({ teamReview: { auto: (auto as 'off' | 'free' | 'ai' | undefined) ?? 'ai', tokenBudget: budget ?? Number.NaN, everyRuns: every ?? Number.NaN } })
  }
  const se = own(o, 'skillEvaluation')
  if (se !== undefined && se !== null) {
    if (!isObj(se)) bad('skillEvaluation is not valid.')
    const s = se as Record<string, unknown>
    const enabled = boolField(s, 'enabled')
    const budget = numField(s, 'tokenBudget', 0, 1e9, false)
    settings.skillEvaluation = storedSkillEvaluation({ ...(enabled !== undefined ? { enabled } : {}), tokenBudget: budget ?? Number.NaN })
  }
  const disabledRaw = own(o, 'disabledSkills')
  let disabled: string[] = []
  if (disabledRaw !== undefined && disabledRaw !== null) {
    if (!Array.isArray(disabledRaw) || disabledRaw.length > REFS_MAX || disabledRaw.some((x) => typeof x !== 'string' || skillNameProblem(x) !== null)) bad('disabledSkills must be a list of skill names.')
    disabled = sortedUnique(disabledRaw as string[])
  }
  const unknown = Object.keys(o).filter((k) => !KNOWN_TEAM_KEYS.has(k))
  if (unknown.length) notes.push(`team.json has ${unknown.length} setting${unknown.length === 1 ? '' : 's'} this version does not know; ${unknown.length === 1 ? 'it was' : 'they were'} ignored.`)
  return { settings, disabled }
}

// ---------- mcp.json ----------

function localAddressRefusal(url: string, transport: string): string | null {
  if (transport === 'stdio') return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'Its address is not valid.'
  }
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return null
  return 'Its address is not https (plain http is allowed only for this computer).'
}

/**
 * Why one server may not be in `.orgai/mcp.json`, or null: the same rules for reading and for writing, so a file we
 * write always reads back. Library rules (validateSpec, without the pinned-version rule: the user reviews the whole
 * command on approval), the kit's value and slot rules, the review text, and https unless the address is this computer.
 */
export function serverFileRefusal(m: TeamMcpDoc): string | null {
  const spec: McpServerSpec = {
    id: 'team-check',
    name: m.name,
    transport: m.transport,
    ...(m.command !== undefined ? { command: m.command } : {}),
    ...(m.args !== undefined ? { args: m.args } : {}),
    ...(m.env !== undefined ? { env: m.env } : {}),
    ...(m.secretEnv !== undefined ? { secretEnv: m.secretEnv } : {}),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.headers !== undefined ? { headers: m.headers } : {}),
    ...(m.secretHeaders !== undefined ? { secretHeaders: m.secretHeaders } : {}),
    ...(m.description !== undefined ? { description: m.description } : {}),
    enabled: m.enabled,
    ...(m.roles !== undefined ? { roles: m.roles } : {}),
    source: 'user',
    addedAt: '2000-01-01T00:00:00.000Z'
  }
  const errors = validateSpec(spec)
  const pins = new Set(spec.transport === 'stdio' && typeof spec.command === 'string' && spec.command.trim() && Array.isArray(spec.args ?? []) ? pinErrors(spec.command.trim(), spec.args ?? []) : [])
  const first = errors.find((e) => !pins.has(e))
  if (first) return first
  const fields = { transport: m.transport, args: m.args, url: m.url, env: m.env, headers: m.headers }
  // The command and the description are plain values too: a key pasted into either is committed like any argument.
  const textual = { transport: 'stdio' as const, args: [m.command, m.description].filter((v): v is string => typeof v === 'string' && v !== '') }
  const refusal = serverRiskRefusal(fields) ?? serverValueRefusal(fields) ?? serverValueRefusal(textual) ?? slotRefusal(m.transport, m.secretEnv, m.secretHeaders)
  if (refusal) return refusal
  const review = reviewTarget({ transport: m.transport, command: m.command, args: m.args, url: m.url, env: m.env, headers: m.headers })
  if (review.blockedReason) return review.blockedReason
  if (m.transport !== 'stdio') {
    const addr = localAddressRefusal(m.url ?? '', m.transport)
    if (addr) return addr
  }
  for (const [k, v] of [['connectorId', m.connectorId], ['connectorVariant', m.connectorVariant]] as const) {
    if (v !== undefined && !CONNECTOR_ID_RE.test(v)) return `${k} is not a valid id.`
  }
  if (m.registry) {
    for (const v of [m.registry.name, m.registry.version, m.registry.registryType, m.registry.identifier]) {
      if (typeof v !== 'string' || v.length > 400) return 'The registry reference is not valid.'
      const p = hiddenCharProblem('The registry reference', v)
      if (p) return p
    }
  }
  return null
}

function mcpStr(o: Record<string, unknown>, k: string, max = MCP_STR_MAX): string | undefined {
  const v = own(o, k)
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > max) return bad(`A server's ${k} is not valid.`)
  return v
}

function mcpList(o: Record<string, unknown>, k: string): string[] | undefined {
  const v = own(o, k)
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > MCP_LIST_MAX || v.some((x) => typeof x !== 'string' || x.length > MCP_STR_MAX)) return bad(`A server's ${k} is not valid.`)
  return v as string[]
}

function mcpMap(o: Record<string, unknown>, k: string): Record<string, string> | undefined {
  const v = own(o, k)
  if (v === undefined || v === null) return undefined
  if (!isObj(v)) return bad(`A server's ${k} is not valid.`)
  const keys = Object.keys(v)
  if (keys.length > MCP_MAP_MAX) return bad(`A server's ${k} is not valid.`)
  const out: Record<string, string> = {}
  for (const key of keys) {
    const val = v[key]
    if (typeof val !== 'string' || val.length > MCP_STR_MAX) return bad(`A server's ${k} is not valid.`)
    Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true })
  }
  return out
}

function readServer(raw: unknown): TeamMcpDoc {
  if (!isObj(raw)) return bad('A server entry is not an object.')
  const name = mcpStr(raw, 'name', 100)
  const transport = own(raw, 'transport')
  if (name === undefined || (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')) return bad('A server needs a name and a transport (stdio, http or sse).')
  const enabled = own(raw, 'enabled')
  if (enabled !== undefined && typeof enabled !== 'boolean') return bad("A server's enabled must be true or false.")
  const doc: TeamMcpDoc = { name, transport, enabled: enabled !== false }
  const command = mcpStr(raw, 'command')
  if (command !== undefined) doc.command = command
  const args = mcpList(raw, 'args')
  if (args?.length) doc.args = args
  const env = mcpMap(raw, 'env')
  if (env && Object.keys(env).length) doc.env = env
  const secretEnv = mcpList(raw, 'secretEnv')
  if (secretEnv?.length) doc.secretEnv = sortedUnique(secretEnv)
  const url = mcpStr(raw, 'url')
  if (url !== undefined) doc.url = url
  const headers = mcpMap(raw, 'headers')
  if (headers && Object.keys(headers).length) doc.headers = headers
  const secretHeaders = mcpList(raw, 'secretHeaders')
  if (secretHeaders?.length) doc.secretHeaders = sortedUnique(secretHeaders)
  const description = mcpStr(raw, 'description', 2_000)
  if (description) doc.description = description
  const roles = mcpList(raw, 'roles')
  if (roles !== undefined) {
    if (roles.some((r) => !ROLE_SLUG_RE.test(r))) return bad("A server's roles must be role names.")
    doc.roles = sortedUnique(roles)
  }
  const connectorId = mcpStr(raw, 'connectorId', 100)
  if (connectorId !== undefined) doc.connectorId = connectorId
  const connectorVariant = mcpStr(raw, 'connectorVariant', 100)
  if (connectorVariant !== undefined) doc.connectorVariant = connectorVariant
  if (own(raw, 'fromLibrary') === true) doc.fromLibrary = true
  const reg = own(raw, 'registry')
  if (reg !== undefined && reg !== null) {
    if (!isObj(reg)) return bad("A server's registry is not valid.")
    const r: McpRegistryRef = {
      name: mcpStr(reg, 'name', 400) ?? '',
      version: mcpStr(reg, 'version', 400) ?? '',
      registryType: mcpStr(reg, 'registryType', 400) ?? '',
      identifier: mcpStr(reg, 'identifier', 400) ?? ''
    }
    doc.registry = r
  }
  return doc
}

function readMcp(bytes: Buffer): JsonRead<TeamMcpDoc[]> {
  const j = readJsonObject(bytes)
  if (!j.value) return { problem: j.problem }
  const servers = own(j.value, 'servers')
  if (servers === undefined) return { value: [] }
  if (!Array.isArray(servers)) return { problem: 'servers is not a list.' }
  if (servers.length > TEAM_FILES_MAX_SERVERS) return { problem: `It lists more than ${TEAM_FILES_MAX_SERVERS} servers.` }
  const out: TeamMcpDoc[] = []
  const names = new Set<string>()
  for (let i = 0; i < servers.length; i++) {
    let doc: TeamMcpDoc
    try {
      doc = readServer(servers[i])
    } catch (e) {
      return { problem: `Server ${i + 1}: ${e instanceof BadFile ? e.message : 'it could not be read.'}` }
    }
    const label = /^[\w.-]{1,48}$/.test(doc.name) ? doc.name : `server ${i + 1}`
    const refusal = serverFileRefusal(doc)
    if (refusal) return { problem: `Server ${label} was refused: ${safeText(refusal, 300)}` }
    if (names.has(doc.name)) return { problem: `Two servers are named ${label}.` }
    names.add(doc.name)
    out.push(doc)
  }
  return { value: out }
}

// ---------- skills ----------

/** The checks on a skill as a document, for the write side: a skill we write must read back. */
export function skillDocProblem(s: TeamSkillDoc): string | null {
  const name = skillNameProblem(s.name)
  if (name) return name
  const desc = skillDescriptionProblem(s.description)
  if (desc) return desc
  const dh = hiddenCharProblem('The description', s.description, { prose: true })
  if (dh) return dh
  if (/[\r\n]/.test(s.description)) return 'The description has to be one line.'
  if (s.body.length > SKILL_BODY_MAX_CHARS) return `The instructions have more than ${SKILL_BODY_MAX_CHARS.toLocaleString('en-US')} characters.`
  if (s.body.includes('!`') || s.body.includes('```!') || s.body.includes('~~~!')) return 'Runs shell commands when loaded (!`...`), which OrgAI does not allow.'
  const bh = hiddenCharProblem('The instructions', s.body, { prose: true })
  if (bh) return bh
  if (s.files.length + 1 > SKILL_MAX_FILES) return `More than ${SKILL_MAX_FILES} files.`
  const seen = new Set<string>(['skill.md'])
  let total = Buffer.byteLength(s.body) + s.description.length
  for (const f of s.files) {
    if (typeof f.path !== 'string' || !safeKitRelPath(f.path) || f.path.length > 200 || hiddenCharIn(f.path)) return 'A file path is not allowed.'
    if (f.path === 'SKILL.md') return 'SKILL.md is written from the name, description and instructions.'
    if (inGitDir(f.path)) return 'It contains git internals.'
    if (f.path.split('/').length - 1 > SKILL_MAX_DEPTH) return `Folders nested deeper than ${SKILL_MAX_DEPTH} levels.`
    if (seen.has(f.path.toLowerCase())) return 'Two files have the same path.'
    seen.add(f.path.toLowerCase())
    const bytes = f.base64 !== undefined ? Buffer.from(f.base64, 'base64').length : Buffer.byteLength(f.text ?? '')
    if (bytes > SKILL_MAX_FILE_BYTES) return `A file is larger than ${SKILL_MAX_FILE_BYTES / 1024} KB.`
    total += bytes
    if (f.text !== undefined) {
      if (f.text.includes('\0')) return 'A text file has a NUL character.'
      const p = hiddenCharProblem('A file', f.text, { prose: true })
      if (p) return p
    }
  }
  if (total > SKILL_MAX_TOTAL_BYTES) return `The skill is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`
  return null
}

interface SkillRead {
  skill?: TeamSkillDoc
  problem?: string
  keyShaped?: boolean
  digest: string
}

function readSkill(name: string, files: TeamFile[], prefix: string): SkillRead {
  const data: FileData[] = files.map((f) => ({ path: f.path.slice(prefix.length), data: f.data }))
  const digest = digestFiles(data)
  const fail = (problem: string): SkillRead => ({ problem, digest })
  const nameProblem = skillNameProblem(name)
  if (nameProblem) return fail('The folder name is not a valid skill name.')
  if (data.length > SKILL_MAX_FILES) return fail(`More than ${SKILL_MAX_FILES} files.`)
  const lower = new Set<string>()
  let total = 0
  for (const f of data) {
    if (!safeKitRelPath(f.path) || f.path.length > 200 || hiddenCharIn(f.path)) return fail('A file path is not allowed.')
    if (inGitDir(f.path)) return fail('It contains git internals.')
    if (f.path.split('/').length - 1 > SKILL_MAX_DEPTH) return fail(`Folders nested deeper than ${SKILL_MAX_DEPTH} levels.`)
    if (lower.has(f.path.toLowerCase())) return fail('Two files have the same path.')
    lower.add(f.path.toLowerCase())
    if (f.data.length > SKILL_MAX_FILE_BYTES) return fail(`A file is larger than ${SKILL_MAX_FILE_BYTES / 1024} KB.`)
    total += f.data.length
    if (total > SKILL_MAX_TOTAL_BYTES) return fail(`The skill is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`)
  }
  const texts = new Map<string, string>()
  let shaped = false
  for (const f of data) {
    const t = f.data.includes(0) ? null : decodeUtf8(f.data)
    if (t === null) {
      if (f.path === 'SKILL.md') return fail('SKILL.md is not text.')
      continue
    }
    const n = normalizeText(t)
    const mk = markers(n)
    if (mk.open && mk.close) return fail(CONFLICT)
    const h = hiddenCharProblem('A file', n, { prose: true })
    if (h) return fail(h)
    if (!shaped && keyShaped(n)) shaped = true
    texts.set(f.path, n)
  }
  const built = buildScannedSkill(data, name, '', null)
  if (typeof built === 'string') return fail(built)
  if (built.name !== name) return fail('The folder name must match the name in SKILL.md.')
  const desc = skillDescriptionProblem(built.description) ?? hiddenCharProblem('The description', built.description, { prose: true })
  if (desc) return fail(desc)
  const others: TeamSkillFileDoc[] = []
  for (const f of data) {
    if (f.path === 'SKILL.md') continue
    const t = texts.get(f.path)
    others.push(t !== undefined ? { path: f.path, text: t } : { path: f.path, base64: f.data.toString('base64') })
  }
  others.sort((a, b) => cmp(a.path, b.path))
  const skill: TeamSkillDoc = { name, description: built.description, body: normalizeText(built.body).trim(), files: others, enabled: true }
  const p = skillDocProblem(skill)
  if (p) return fail(p)
  return { skill, keyShaped: shaped, digest }
}

/** Script-like files of a skill document, for the change list. */
export function skillScripts(s: TeamSkillDoc): string[] {
  return s.files.filter((f) => looksLikeScript(f.path, f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? '', 'utf8'))).map((f) => f.path)
}

// ---------- the whole team ----------

function emptyResult(present: boolean): ParsedTeam {
  return { present, doc: null, problems: [], notes: [], warnings: [], heldPaths: [], digest: '' }
}

export interface ParseOptions {
  base: TeamDoc | null
  agentsDirExists: boolean
  readProblems?: TeamFileProblem[]
  /**
   * Injected by the service (parse has no catalog or library): a message when a server that names a connector or a library
   * entry known on this computer carries a different address than that entry. The whole mcp.json is then a problem.
   */
  linkCheck?: (m: TeamMcpDoc) => string | null
}

export function parseTeamFiles(files: TeamFile[], opts: ParseOptions): ParsedTeam {
  try {
    return parseInner(files, opts)
  } catch {
    const r = emptyResult(false)
    r.problems.push({ file: TEAM_FILES_JSON, message: 'The team files could not be read. The last approved team stays.' })
    return r
  }
}

const ROLE_PATH = new RegExp(`^${TEAM_FILES_AGENTS_DIR.replace(/[.]/g, '\\.')}/([^/]+)$`)
const SKILL_PATH = new RegExp(`^${TEAM_FILES_SKILLS_DIR.replace(/[.]/g, '\\.')}/([^/]+)/(.+)$`)

function parseInner(allFiles: TeamFile[], opts: ParseOptions): ParsedTeam {
  const base = opts.base
  const readProblems = opts.readProblems ?? []
  const out = emptyResult(false)
  const held = new Set<string>()
  const problemIds: { file: string; contentDigest: string }[] = []
  const problem = (file: string, message: string, contentDigest?: string): void => {
    out.problems.push({ file, message })
    problemIds.push({ file, contentDigest: contentDigest ?? sha256Hex(`${file}\0${message}`) })
  }

  // Which items a reader problem holds.
  let settingsHeld = false
  let mcpHeld = false
  const rolesHeld = new Set<string>()
  const skillsHeld = new Set<string>()
  for (const rp of readProblems) {
    if (typeof rp?.file !== 'string' || typeof rp.message !== 'string') continue
    out.problems.push({ file: rp.file, message: rp.message })
    problemIds.push({ file: rp.file, contentDigest: sha256Hex(`${rp.file}\0${rp.message}`) })
    held.add(rp.file)
    if (rp.file === TEAM_FILES_JSON) settingsHeld = true
    else if (rp.file === TEAM_FILES_MCP_JSON) mcpHeld = true
    else {
      const rm = ROLE_PATH.exec(rp.file)
      const sm = SKILL_PATH.exec(rp.file)
      if (rm) rolesHeld.add(rm[1].replace(/\.md$/, ''))
      else if (sm) skillsHeld.add(sm[1])
      else if (rp.file.startsWith(`${TEAM_FILES_SKILLS_DIR}/`)) skillsHeld.add(rp.file.slice(TEAM_FILES_SKILLS_DIR.length + 1).split('/')[0])
    }
  }

  // Usable files: safe relative paths only, total size capped.
  const files: TeamFile[] = []
  let totalBytes = 0
  let ignoredPaths = 0
  for (const f of allFiles) {
    if (!f || typeof f.path !== 'string' || !Buffer.isBuffer(f.data)) continue
    if (!f.path.startsWith('.orgai/') || !safeRelPath(f.path)) {
      ignoredPaths++
      continue
    }
    totalBytes += f.data.length
    files.push(f)
  }
  if (ignoredPaths) out.notes.push(`${ignoredPaths} file${ignoredPaths === 1 ? '' : 's'} with an unusable path ${ignoredPaths === 1 ? 'was' : 'were'} ignored.`)
  const byPath = new Map(files.map((f) => [f.path, f]))
  const teamFile = byPath.get(TEAM_FILES_JSON)
  out.present = teamFile !== undefined || settingsHeld
  out.heldPaths = []

  const finish = (): ParsedTeam => {
    out.heldPaths = [...held].sort(cmp)
    return out
  }

  if (totalBytes > TEAM_FILES_MAX_TOTAL_BYTES) {
    problem(TEAM_FILES_JSON, `The team files together are larger than ${TEAM_FILES_MAX_TOTAL_BYTES / 1024 / 1024} MB, so nothing was read. The last approved team stays.`)
    return finish()
  }
  if (!teamFile && !settingsHeld) {
    problem(TEAM_FILES_JSON, 'The team file .orgai/team.json is missing, so the last approved team stays.')
    return finish()
  }

  // --- settings
  let settings: TeamSettingsDoc | null = null
  let disabled: string[] = []
  if (teamFile && !settingsHeld) {
    const j = readJsonObject(teamFile.data)
    if (!j.value) {
      problem(TEAM_FILES_JSON, j.problem ?? 'It could not be read.', sha256Hex(normalizeForId(teamFile.data)))
      held.add(TEAM_FILES_JSON)
    } else {
      try {
        const r = readSettings(j.value, base?.settings ?? null, out.notes)
        settings = r.settings
        disabled = r.disabled
        if (keyShaped(settings.brief)) out.warnings.push({ file: TEAM_FILES_JSON, message: 'It has text that looks like a key. Keys must not be committed.' })
      } catch (e) {
        problem(TEAM_FILES_JSON, e instanceof BadFile ? e.message : 'It could not be read.', sha256Hex(normalizeForId(teamFile.data)))
        held.add(TEAM_FILES_JSON)
      }
    }
  } else if (settingsHeld) held.add(TEAM_FILES_JSON)
  if (!settings && base) settings = base.settings
  if (!settings) return finish()
  // disabledSkills of a held team.json: keep the base's switches.
  if (held.has(TEAM_FILES_JSON) && base) disabled = base.skills.filter((s) => !s.enabled).map((s) => s.name)

  // --- roles
  const roleFiles: { slug: string; file: TeamFile }[] = []
  for (const f of files) {
    const m = ROLE_PATH.exec(f.path)
    if (!m) continue
    const fname = m[1]
    if (!fname.endsWith('.md')) {
      out.notes.push(`${safeText(f.path, 80)} is not a role file (.md) and was ignored.`)
      continue
    }
    const slug = fname.slice(0, -3)
    if (!ROLE_SLUG_RE.test(slug) || !safeKitRelPath(f.path)) {
      out.notes.push(`${safeText(f.path, 80)} has a file name that cannot be a role name (lowercase letters, digits and hyphens) and was ignored.`)
      continue
    }
    roleFiles.push({ slug, file: f })
  }
  for (const f of files) {
    if (f.path.startsWith(`${TEAM_FILES_AGENTS_DIR}/`) && f.path.slice(TEAM_FILES_AGENTS_DIR.length + 1).includes('/')) out.notes.push(`${safeText(f.path, 80)} is in a sub-folder of the agents folder and was ignored.`)
  }
  if (roleFiles.length > TEAM_FILES_MAX_ROLES) {
    problem(TEAM_FILES_AGENTS_DIR, `There are more than ${TEAM_FILES_MAX_ROLES} role files. The last approved team stays.`)
    return finish()
  }
  roleFiles.sort((a, b) => cmp(a.slug, b.slug))
  const roles = new Map<string, TeamRoleDoc>()
  for (const { slug, file } of roleFiles) {
    if (rolesHeld.has(slug)) continue
    if (file.data.length > TEAM_FILES_MAX_ROLE_BYTES) {
      problem(file.path, 'It is too large to read.', sha256Hex(file.data))
      held.add(file.path)
      rolesHeld.add(slug)
      continue
    }
    const r = readRole(slug, file.data)
    if (!r.role) {
      problem(file.path, r.problem ?? 'It could not be read.', sha256Hex(normalizeForId(file.data)))
      held.add(file.path)
      rolesHeld.add(slug)
      continue
    }
    if (r.keyShaped) out.warnings.push({ file: file.path, message: 'It has text that looks like a key. Keys must not be committed.' })
    roles.set(slug, r.role)
  }
  for (const slug of rolesHeld) {
    const keep = base?.roles.find((r) => r.slug === slug)
    held.add(`${TEAM_FILES_AGENTS_DIR}/${slug}.md`)
    if (keep) roles.set(slug, keep)
  }

  // --- skills
  const groups = new Map<string, TeamFile[]>()
  for (const f of files) {
    const m = SKILL_PATH.exec(f.path)
    if (!m) {
      if (f.path.startsWith(`${TEAM_FILES_SKILLS_DIR}/`) && !f.path.slice(TEAM_FILES_SKILLS_DIR.length + 1).includes('/')) out.notes.push(`${safeText(f.path, 80)} is not inside a skill folder and was ignored.`)
      continue
    }
    const list = groups.get(m[1]) ?? []
    list.push(f)
    groups.set(m[1], list)
  }
  const skills = new Map<string, TeamSkillDoc>()
  for (const dirName of [...groups.keys()].sort(cmp)) {
    const folder = `${TEAM_FILES_SKILLS_DIR}/${dirName}`
    if (skillsHeld.has(dirName)) continue
    const r = readSkill(dirName, groups.get(dirName) ?? [], `${folder}/`)
    if (!r.skill) {
      const shown = /^[a-z0-9-]{1,64}$/.test(dirName) ? folder : `${TEAM_FILES_SKILLS_DIR}/${safeText(dirName, 40)}`
      problem(shown, r.problem ?? 'It could not be read.', r.digest)
      if (shown === folder) {
        held.add(folder)
        skillsHeld.add(dirName)
      } else held.add(folder)
      continue
    }
    if (r.keyShaped) out.warnings.push({ file: folder, message: 'It has text that looks like a key. Keys must not be committed.' })
    skills.set(dirName, r.skill)
  }
  for (const name of skillsHeld) {
    held.add(`${TEAM_FILES_SKILLS_DIR}/${name}`)
    const keep = base?.skills.find((s) => s.name === name)
    if (keep) skills.set(name, keep)
  }
  const disabledSet = new Set(disabled)
  for (const s of skills.values()) if (!held.has(`${TEAM_FILES_SKILLS_DIR}/${s.name}`)) s.enabled = !disabledSet.has(s.name)

  // --- mcp
  let mcp: TeamMcpDoc[] = []
  const mcpFile = byPath.get(TEAM_FILES_MCP_JSON)
  if (mcpHeld) {
    mcp = base?.mcp ?? []
    held.add(TEAM_FILES_MCP_JSON)
  } else if (mcpFile) {
    const r = readMcp(mcpFile.data)
    // A connector or library link must carry the address of the entry it would link on this computer.
    let linkProblem: string | undefined
    if (r.value && opts.linkCheck) {
      for (const m of r.value) {
        let msg: string | null = null
        try {
          msg = opts.linkCheck(m)
        } catch {
          msg = null
        }
        if (msg) {
          const label = /^[\w.-]{1,48}$/.test(m.name) ? m.name : 'a server'
          linkProblem = `Server ${label} was refused: ${safeText(msg, 300)}`
          break
        }
      }
    }
    if (r.value && !linkProblem) {
      // Credential-shaped values are refused outright (serverFileRefusal), so there is nothing left to warn about.
      mcp = r.value
    } else if (r.value && linkProblem) {
      problem(TEAM_FILES_MCP_JSON, linkProblem, sha256Hex(normalizeForId(mcpFile.data)))
      held.add(TEAM_FILES_MCP_JSON)
      mcp = base?.mcp ?? []
    } else {
      problem(TEAM_FILES_MCP_JSON, r.problem ?? 'It could not be read.', sha256Hex(normalizeForId(mcpFile.data)))
      held.add(TEAM_FILES_MCP_JSON)
      mcp = base?.mcp ?? []
    }
  }

  // --- the whole team
  if (!opts.agentsDirExists && roleFiles.length === 0 && rolesHeld.size === 0) {
    problem(TEAM_FILES_AGENTS_DIR, 'The agents folder .orgai/agents is missing, so the last approved team stays.')
    return finish()
  }
  if (roles.size === 0) {
    problem(TEAM_FILES_AGENTS_DIR, 'The agents folder has no usable role file, so the last approved team stays.')
    return finish()
  }

  // Dangling references are dropped with a note.
  const skillNames = new Set(skills.keys())
  const serverNames = new Set(mcp.map((m) => m.name))
  const roleList = [...roles.values()].sort((a, b) => cmp(a.slug, b.slug)).map((r) => {
    const spawnable = r.spawnable.filter((s) => roles.has(s) && s !== r.slug)
    const sk = r.skills.filter((s) => skillNames.has(s))
    const srv = r.mcpServers.filter((s) => serverNames.has(s))
    const dropped = r.spawnable.length - spawnable.length + (r.skills.length - sk.length) + (r.mcpServers.length - srv.length)
    if (dropped) out.notes.push(`${r.slug} names ${dropped} role${dropped === 1 ? '' : 's'}, skill${dropped === 1 ? '' : 's'} or service${dropped === 1 ? '' : 's'} that ${dropped === 1 ? 'does' : 'do'} not exist; ${dropped === 1 ? 'it was' : 'they were'} left out.`)
    const out2: TeamRoleDoc = { ...r, spawnable, skills: sk, mcpServers: srv }
    // A required report must be a spawnable role of this one (cleanRequiredReports); anything else is left out quietly.
    const required = r.canSpawn ? (r.requiredReports ?? []).filter((s) => spawnable.includes(s)) : []
    if (required.length > 0) out2.requiredReports = required
    else delete out2.requiredReports
    return out2
  })
  const roleSlugs = new Set(roleList.map((r) => r.slug))
  const mcpList2 = mcp.map((m) => {
    if (!m.roles) return m
    const keep = m.roles.filter((s) => roleSlugs.has(s))
    if (keep.length !== m.roles.length) out.notes.push(`The service ${m.name} names roles that do not exist; they were left out.`)
    return { ...m, roles: keep }
  })

  const doc: TeamDoc = normalizeDoc({ settings, roles: roleList, skills: [...skills.values()], mcp: mcpList2 })
  const chart = chartProblem(doc)
  if (chart) {
    problem(TEAM_FILES_AGENTS_DIR, `${chart} The last approved team stays.`)
    return finish()
  }
  out.doc = doc
  out.digest = teamDigest(doc, problemIds)
  return finish()
}

function normalizeForId(data: Buffer): string {
  const t = decodeUtf8(data)
  return t === null ? data.toString('latin1') : normalizeText(t)
}
