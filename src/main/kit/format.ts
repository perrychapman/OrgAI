import { createHash } from 'node:crypto'
import {
  KIT_FORMAT,
  KIT_MAX_ITEMS,
  KIT_MAX_ITEMS_PER_KIND,
  MCP_PER_PROJECT_ENV_MAX,
  SKILL_BODY_MAX_CHARS,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  isProjectKind,
  type KitItemKind,
  type McpLibraryEntry,
  type ProjectKind,
  type UserConnectorDef
} from '@shared/types'
import { hiddenCharIn, hiddenCharProblem } from '../capabilities/sanitize'
import { credentialLikeName, riskyEnvName, validateLibraryEntry } from '../mcp/validate'
import { validateUserPreset } from '../mcp/presets'
import { digestFiles, safeRelPath, SKILL_MAX_DEPTH, type FileData } from '../skills/files'
import { buildScannedSkill } from '../skills/scan'
import { composeSkillMd, skillFromMd } from '../skills/skillMd'
import { parseOrgExport } from '../setup/import/parsers'
import { inGitDir } from '../setup/import/scan'
import { cleanTemplateDescription, cleanTemplateName } from '../setup/templates'

/**
 * The practice-kit file (`*.orgai-kit.json`, format 'orgai.kit/1'): building the document from stored data and reading
 * an untrusted one back. Pure (no fs, no secrets store). A kit never carries secret values, OAuth state or tokens,
 * connector or build fields, ids or folders; reading rebuilds every item field by field with caps, validates it with
 * the same rules as the stores (hidden characters, shell-injection skill bodies, pinned versions, preset rules) and
 * turns a bad item into a refused one instead of failing the file. Nothing in a kit is executed or followed.
 */

export const KIT_FILE_SUFFIX = '.orgai-kit.json'
/** Most text of one org.json inside a template. */
const TEMPLATE_ORG_MAX_CHARS = 1024 * 1024
const TEXT_MAX = 2000
const ARGS_MAX = 64
const MAP_MAX = 50
const NAMES_MAX = 50
const STRING_SCAN_MAX_NODES = 50_000
const STRING_SCAN_MAX_DEPTH = 10

// ---------- the document ----------

export interface KitSkillDoc {
  name: string
  description: string
  files: { path: string; text: string }[]
}

export type KitServerFields = Omit<McpLibraryEntry, 'id' | 'source' | 'addedAt'>

export interface KitTemplateDoc {
  name: string
  description: string
  kind: ProjectKind
  /** An 'orgai.org/1' document with no ids, positions, secrets or grants. */
  org: unknown
}

export interface KitDocument {
  format: typeof KIT_FORMAT
  exportedAt: string
  appVersion: string
  platform: string
  skills: KitSkillDoc[]
  mcpServers: KitServerFields[]
  connectorPresets: UserConnectorDef[]
  templates: KitTemplateDoc[]
}

// ---------- shared helpers ----------

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)

/** Text safe to show or quote: control, format and separator characters become "?", cut to `max`. */
export function safeText(v: unknown, max = 80): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The shell-ish line a server runs or connects to, in full: NAME=value command args, or url -H "Name: value". */
export function fullTarget(spec: Pick<McpLibraryEntry, 'transport' | 'command' | 'args' | 'url' | 'env' | 'headers'>): string {
  const quote = (a: string): string => (a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a)
  const sorted = (r: Record<string, string> | undefined): [string, string][] => Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (spec.transport === 'stdio') {
    return [...sorted(spec.env).map(([k, v]) => `${k}=${quote(v)}`), quote(spec.command ?? ''), ...(spec.args ?? []).map(quote)].join(' ')
  }
  return [spec.url ?? '', ...sorted(spec.headers).map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)].join(' ')
}

/** What a preset connects to, one line per variant. */
export function presetTarget(def: UserConnectorDef): string {
  return def.variants
    .map((v) => `${v.label}: ${fullTarget({ transport: v.transport, command: v.command, args: v.args, url: v.url, env: v.env, headers: v.headers })}`)
    .join('\n')
}

/** The comparable shape of a server (the exported fields only), so a stored entry and a kit item compare. */
export function serverSignature(f: KitServerFields): string {
  const pairs = (r: Record<string, string> | undefined): [string, string][] => Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([
    f.name,
    f.transport,
    f.command ?? '',
    f.args ?? [],
    f.url ?? '',
    pairs(f.env),
    pairs(f.headers),
    [...(f.secretEnv ?? [])].sort(),
    [...(f.secretHeaders ?? [])].sort(),
    f.perProjectSecrets === true,
    [...(f.perProjectEnv ?? [])].sort(),
    f.description ?? ''
  ])
}

/** The exported fields of a stored preset, in a stable order, without origin. */
export function presetSignature(def: UserConnectorDef): string {
  const { origin: _o, ...rest } = def
  void _o
  return JSON.stringify(rest, (_k, v: unknown) => (isPlain(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))
}

/** A server's fields reduced to what a kit carries. */
export function serverFieldsOf(e: McpLibraryEntry): KitServerFields {
  const out: KitServerFields = { name: e.name, transport: e.transport }
  if (e.description) out.description = e.description
  if (e.transport === 'stdio') {
    if (e.command !== undefined) out.command = e.command
    if (e.args?.length) out.args = [...e.args]
    if (e.env && Object.keys(e.env).length) out.env = { ...e.env }
    if (e.secretEnv?.length) out.secretEnv = [...e.secretEnv]
  } else {
    if (e.url !== undefined) out.url = e.url
    if (e.headers && Object.keys(e.headers).length) out.headers = { ...e.headers }
    if (e.secretHeaders?.length) out.secretHeaders = [...e.secretHeaders]
  }
  if (e.perProjectSecrets === true) out.perProjectSecrets = true
  if (e.perProjectEnv?.length) out.perProjectEnv = [...e.perProjectEnv]
  return out
}

// ---------- building (export) ----------

const CREDENTIAL_ARG = /^-{0,2}[\w.-]*(?:token|secret|passw|api[-_]?key|credential|bearer)[\w.-]*=./i
const CREDENTIAL_QUERY = /(secret|token|passw|api[-_]?key|credential|auth|sig)/i

/**
 * A kit's plain env variables and headers follow the preset rules: none changes what runs (NODE_OPTIONS, PATH, *_PROXY
 * ...) and none looks like a credential (those belong in a secret slot). Names are already hidden-character checked.
 */
export function serverRiskRefusal(f: Pick<McpLibraryEntry, 'env' | 'headers'>): string | null {
  const name = (k: string): string => (/^[\w.-]{1,64}$/.test(k) ? ` (${k})` : '')
  for (const k of Object.keys(f.env ?? {})) {
    if (riskyEnvName(k)) return `An environment variable${name(k)} changes what runs and cannot be part of a kit.`
    if (credentialLikeName(k)) return `An environment variable${name(k)} looks like a credential; keep it as a secret variable instead.`
  }
  for (const k of Object.keys(f.headers ?? {})) {
    if (credentialLikeName(k, true)) return `A header${name(k)} looks like a credential; keep it as a secret header instead.`
  }
  return null
}

/** Why a stored server cannot go into a kit, or null. */
export function serverExportRefusal(e: McpLibraryEntry): string | null {
  if (e.connectorId) return 'It is a connector. Add the connector again from the gallery on the other computer.'
  if (e.buildDigest) return 'It is a server built by the assistant; its files stay on this computer.'
  const risk = serverRiskRefusal(e)
  if (risk) return risk
  if (e.transport === 'stdio') {
    if ((e.args ?? []).some((a) => CREDENTIAL_ARG.test(a))) return 'An argument looks like it carries a secret value; move it to a secret variable first.'
  } else if (e.url) {
    try {
      const u = new URL(e.url)
      if (u.username || u.password) return 'Its address carries a user name or password; move it to a secret header first.'
      for (const k of u.searchParams.keys()) if (CREDENTIAL_QUERY.test(k)) return 'Its address carries a key in the query; move it to a secret header first.'
    } catch {
      return 'Its address is not valid.'
    }
  }
  return null
}

/** A library skill as a kit item, or why it cannot be one (a binary file, an unreadable SKILL.md). */
export function skillToKit(name: string, description: string, files: FileData[]): { doc: KitSkillDoc } | { skip: string } {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const out: { path: string; text: string }[] = []
  for (const f of files) {
    let text: string
    try {
      if (f.data.includes(0)) throw new Error('binary')
      text = decoder.decode(f.data)
    } catch {
      return { skip: `${safeText(f.path, 60)} is not a text file; kits carry text files only.` }
    }
    if (f.path === 'SKILL.md') {
      const parsed = skillFromMd(text, name)
      if (!parsed.ok) return { skip: parsed.reason }
      text = composeSkillMd({ name: parsed.name, description: parsed.description, body: parsed.body })
    }
    out.push({ path: f.path, text })
  }
  if (!out.some((f) => f.path === 'SKILL.md')) return { skip: 'It has no SKILL.md.' }
  return { doc: { name, description, files: out } }
}

/** A saved template as a kit item. The source project's name is replaced by the template's own. */
export function templateToKit(info: { name: string; description: string; kind: ProjectKind }, orgText: string): { doc: KitTemplateDoc } | { skip: string } {
  let org: unknown
  try {
    org = JSON.parse(orgText)
  } catch {
    return { skip: 'Its chart file could not be read.' }
  }
  if (!isPlain(org) || !Array.isArray(org.roles)) return { skip: 'Its chart file could not be read.' }
  return {
    doc: {
      name: info.name,
      description: info.description,
      kind: info.kind,
      org: { format: 'orgai.org/1', exportedAt: new Date(0).toISOString(), project: { name: info.name }, roles: org.roles }
    }
  }
}

// ---------- reading (import) ----------

export interface ParsedSkill {
  name: string
  description: string
  body: string
  files: FileData[]
  digest: string
  scripts: string[]
}

export interface ParsedTemplate {
  name: string
  description: string
  kind: ProjectKind
  orgText: string
  rolesDigest: string
  roleNames: string[]
}

export interface ParsedItem {
  key: string
  kind: KitItemKind
  /** Display-safe. */
  name: string
  description?: string
  size: number
  notes: string[]
  refusal?: string
  skill?: ParsedSkill
  server?: KitServerFields
  preset?: UserConnectorDef
  template?: ParsedTemplate
}

export interface ParsedKit {
  exportedAt?: string
  appVersion?: string
  platform?: string
  items: ParsedItem[]
  notes: string[]
}

class KitFileError extends Error {}

function refuse(item: Pick<ParsedItem, 'key' | 'kind' | 'name' | 'size'>, reason: string): ParsedItem {
  return { ...item, notes: [], refusal: safeText(reason, 240) }
}

function metaText(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > 64 || hiddenCharIn(v)) return undefined
  return v
}

/** Parses the bytes of a kit file. Throws a readable Error when the file as a whole is not a kit. */
export function parseKit(bytes: Buffer): ParsedKit {
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new KitFileError('This file is not an OrgAI kit.')
  }
  if (!isPlain(doc) || own(doc, 'format') !== KIT_FORMAT) throw new KitFileError('This file is not an OrgAI kit (or it is a newer version).')
  const groups = {
    skills: own(doc, 'skills'),
    mcpServers: own(doc, 'mcpServers'),
    connectorPresets: own(doc, 'connectorPresets'),
    templates: own(doc, 'templates')
  }
  let total = 0
  for (const [name, g] of Object.entries(groups)) {
    if (g === undefined || g === null) continue
    if (!Array.isArray(g)) throw new KitFileError('This file is not an OrgAI kit.')
    if (g.length > KIT_MAX_ITEMS_PER_KIND) throw new KitFileError(`The kit has more than ${KIT_MAX_ITEMS_PER_KIND} ${name === 'mcpServers' ? 'servers' : name === 'connectorPresets' ? 'presets' : name}.`)
    total += g.length
  }
  if (total > KIT_MAX_ITEMS) throw new KitFileError(`The kit has more than ${KIT_MAX_ITEMS} items.`)
  const items: ParsedItem[] = []
  const list = (g: unknown): unknown[] => (Array.isArray(g) ? g : [])
  list(groups.skills).forEach((raw, i) => items.push(parseSkill(raw, i)))
  list(groups.mcpServers).forEach((raw, i) => items.push(parseServer(raw, i)))
  list(groups.connectorPresets).forEach((raw, i) => items.push(parsePreset(raw, i)))
  list(groups.templates).forEach((raw, i) => items.push(parseTemplate(raw, i)))
  // Duplicates inside the file: the later one is refused (names are the match key).
  const seen = new Set<string>()
  for (const it of items) {
    const id = it.kind === 'preset' ? it.preset?.id : it.kind === 'skill' ? it.skill?.name : it.kind === 'server' ? it.server?.name : it.template?.name.toLowerCase()
    if (it.refusal || !id) continue
    const k = `${it.kind}:${id}`
    if (seen.has(k)) {
      it.refusal = 'The kit has another item with the same name.'
      delete it.skill
      delete it.server
      delete it.preset
      delete it.template
    } else seen.add(k)
  }
  return {
    exportedAt: metaText(own(doc, 'exportedAt')),
    appVersion: metaText(own(doc, 'appVersion')),
    platform: metaText(own(doc, 'platform')),
    items,
    notes: []
  }
}

function parseSkill(raw: unknown, index: number): ParsedItem {
  const head = { key: `skill:${index}`, kind: 'skill' as const, name: '(unnamed skill)', size: 0 }
  if (!isPlain(raw)) return refuse(head, 'Not a skill.')
  head.name = safeText(own(raw, 'name')) || head.name
  const filesRaw = own(raw, 'files')
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) return refuse(head, 'The skill has no files.')
  if (filesRaw.length > SKILL_MAX_FILES) return refuse(head, `More than ${SKILL_MAX_FILES} files.`)
  const files: FileData[] = []
  const lower = new Set<string>()
  let total = 0
  for (const f of filesRaw) {
    if (!isPlain(f)) return refuse(head, 'A file entry is not valid.')
    const path = own(f, 'path')
    const t = own(f, 'text')
    if (typeof path !== 'string' || typeof t !== 'string') return refuse(head, 'A file entry is not valid.')
    if (!safeRelPath(path) || path.length > 200 || hiddenCharIn(path)) return refuse(head, `The file path "${safeText(path, 60)}" is not allowed.`)
    if (inGitDir(path)) return refuse(head, 'It contains git internals.')
    if (path.split('/').length - 1 > SKILL_MAX_DEPTH) return refuse(head, `Folders nested deeper than ${SKILL_MAX_DEPTH} levels.`)
    if (lower.has(path.toLowerCase())) return refuse(head, 'Two files have the same path.')
    lower.add(path.toLowerCase())
    if (t.includes('\0')) return refuse(head, `${safeText(path, 60)} is not a text file.`)
    const data = Buffer.from(t, 'utf8')
    if (data.length > SKILL_MAX_FILE_BYTES) return refuse(head, `${safeText(path, 60)} is larger than ${SKILL_MAX_FILE_BYTES / 1024} KB.`)
    total += data.length
    if (total > SKILL_MAX_TOTAL_BYTES) return refuse(head, `The skill is larger than ${SKILL_MAX_TOTAL_BYTES / 1024 / 1024} MB.`)
    const hidden = hiddenCharProblem(`The file ${safeText(path, 60)}`, t, { prose: true })
    if (hidden) return refuse(head, hidden)
    files.push({ path, data })
  }
  head.size = total
  const built = buildScannedSkill(files, typeof own(raw, 'name') === 'string' ? (own(raw, 'name') as string) : '', '', null)
  if (typeof built === 'string') return refuse(head, built)
  const nameHidden = hiddenCharProblem('The skill name', built.name) ?? hiddenCharProblem('The skill description', built.description)
  if (nameHidden) return refuse(head, nameHidden)
  if (built.body.length > SKILL_BODY_MAX_CHARS) return refuse(head, 'The instructions are too long.')
  const notes = [...built.notes.slice(0, 5)]
  if (built.scripts.length) notes.push(`Includes scripts the skill may ask agents to run: ${built.scripts.slice(0, 5).map((s) => safeText(s, 60)).join(', ')}.`)
  return {
    ...head,
    name: built.name,
    description: built.description,
    size: total,
    notes,
    skill: { name: built.name, description: built.description, body: built.body, files: built.data, digest: digestFiles(built.data), scripts: built.scripts }
  }
}

function textField(v: unknown, max: number, opts: { prose?: boolean } = {}): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > max) throw new KitFileError('A field is not valid or too long.')
  if (hiddenCharIn(v, opts.prose ? { prose: true } : {})) throw new KitFileError('A field contains a hidden character; remove it.')
  return v
}

function nameList(v: unknown, max: number): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > max) throw new KitFileError('A list is not valid or too long.')
  return v.map((x) => {
    if (typeof x !== 'string' || !x || x.length > 128) throw new KitFileError('A name in a list is not valid.')
    return x
  })
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (!isPlain(v)) throw new KitFileError('A list of names and values is not valid.')
  const entries = Object.entries(v)
  if (entries.length > MAP_MAX) throw new KitFileError('A list of names and values is too long.')
  const out: Record<string, string> = {}
  for (const [k, val] of entries) {
    if (k === '__proto__' || typeof val !== 'string' || val.length > TEXT_MAX) throw new KitFileError('A list of names and values is not valid.')
    out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

function parseServer(raw: unknown, index: number): ParsedItem {
  const head = { key: `server:${index}`, kind: 'server' as const, name: '(unnamed server)', size: 0 }
  if (!isPlain(raw)) return refuse(head, 'Not a server.')
  head.name = safeText(own(raw, 'name')) || head.name
  head.size = Buffer.byteLength(JSON.stringify(raw))
  let fields: KitServerFields
  try {
    const name = textField(own(raw, 'name'), 128)
    const transport = own(raw, 'transport')
    if (!name || (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')) throw new KitFileError('The server needs a name and a transport (stdio, http or sse).')
    fields = { name, transport }
    const command = textField(own(raw, 'command'), TEXT_MAX)
    if (command !== undefined) fields.command = command
    const url = textField(own(raw, 'url'), TEXT_MAX)
    if (url !== undefined) fields.url = url
    const description = textField(own(raw, 'description'), 500, { prose: true })
    if (description) fields.description = description
    const argsRaw = own(raw, 'args')
    if (argsRaw !== undefined && argsRaw !== null) {
      if (!Array.isArray(argsRaw) || argsRaw.length > ARGS_MAX || argsRaw.some((a) => typeof a !== 'string' || a.length > TEXT_MAX)) throw new KitFileError('The arguments are not valid.')
      if (argsRaw.length) fields.args = argsRaw as string[]
    }
    const env = stringMap(own(raw, 'env'))
    if (env) fields.env = env
    const headers = stringMap(own(raw, 'headers'))
    if (headers) fields.headers = headers
    const secretEnv = nameList(own(raw, 'secretEnv'), NAMES_MAX)
    if (secretEnv?.length) fields.secretEnv = secretEnv
    const secretHeaders = nameList(own(raw, 'secretHeaders'), NAMES_MAX)
    if (secretHeaders?.length) fields.secretHeaders = secretHeaders
    if (own(raw, 'perProjectSecrets') === true) fields.perProjectSecrets = true
    const perProjectEnv = nameList(own(raw, 'perProjectEnv'), MCP_PER_PROJECT_ENV_MAX)
    if (perProjectEnv?.length) fields.perProjectEnv = perProjectEnv
  } catch (e) {
    return refuse(head, e instanceof Error ? e.message : 'The server is not valid.')
  }
  const problems = validateLibraryEntry({ ...fields, id: 'kit-check', source: 'user', addedAt: '2000-01-01T00:00:00.000Z' }, [])
  if (problems.length) return refuse(head, problems[0])
  const risk = serverRiskRefusal(fields)
  if (risk) return refuse(head, risk)
  const notes: string[] = []
  const slots = [...(fields.secretEnv ?? []), ...(fields.secretHeaders ?? [])]
  if (slots.length) notes.push(fields.perProjectSecrets ? 'Each project that uses it enters its own secret values.' : 'Needs secret values after import.')
  return { ...head, name: fields.name, ...(fields.description ? { description: fields.description } : {}), notes, server: fields }
}

function parsePreset(raw: unknown, index: number): ParsedItem {
  const head = { key: `preset:${index}`, kind: 'preset' as const, name: '(unnamed preset)', size: 0 }
  if (!isPlain(raw)) return refuse(head, 'Not a preset.')
  head.name = safeText(own(raw, 'name')) || head.name
  head.size = Buffer.byteLength(JSON.stringify(raw))
  try {
    const def = validateUserPreset(raw)
    return { ...head, name: def.name, description: def.description, notes: [], preset: def }
  } catch (e) {
    return refuse(head, e instanceof Error ? e.message : 'The preset is not valid.')
  }
}

/** Every string inside a value passes the hidden-character gate (prose rules); bounded in depth and node count. */
function scanStrings(value: unknown): string | null {
  let nodes = 0
  const walk = (v: unknown, depth: number): string | null => {
    if (++nodes > STRING_SCAN_MAX_NODES || depth > STRING_SCAN_MAX_DEPTH) return 'The chart is too large or nested too deeply.'
    if (typeof v === 'string') return hiddenCharProblem('The chart', v, { prose: true })
    if (Array.isArray(v)) {
      for (const x of v) {
        const p = walk(x, depth + 1)
        if (p) return p
      }
    } else if (isPlain(v)) {
      for (const [k, x] of Object.entries(v)) {
        const pk = hiddenCharProblem('The chart', k)
        if (pk) return pk
        const p = walk(x, depth + 1)
        if (p) return p
      }
    }
    return null
  }
  return walk(value, 0)
}

function parseTemplate(raw: unknown, index: number): ParsedItem {
  const head = { key: `template:${index}`, kind: 'template' as const, name: '(unnamed template)', size: 0 }
  if (!isPlain(raw)) return refuse(head, 'Not a template.')
  head.name = safeText(own(raw, 'name')) || head.name
  try {
    const name = cleanTemplateName(own(raw, 'name'))
    const description = cleanTemplateDescription(own(raw, 'description'))
    const kind = own(raw, 'kind')
    if (!isProjectKind(kind)) throw new KitFileError('The template has an unknown kind.')
    const org = own(raw, 'org')
    if (!isPlain(org) || own(org, 'format') !== 'orgai.org/1' || !Array.isArray(own(org, 'roles'))) throw new KitFileError('The template has no org chart.')
    const hidden = scanStrings(org)
    if (hidden) throw new KitFileError(hidden)
    const roles = own(org, 'roles') as unknown[]
    const orgText = JSON.stringify({ format: 'orgai.org/1', exportedAt: new Date(0).toISOString(), project: { name }, roles }, null, 2)
    if (orgText.length > TEMPLATE_ORG_MAX_CHARS) throw new KitFileError('The org chart is too large.')
    const parsed = parseOrgExport(orgText, 'org.json')
    if (!parsed.agents.length) throw new KitFileError(parsed.warnings[0] ?? 'The template has no roles.')
    const roleNames = parsed.agents.map((a) => safeText(a.name, 80)).filter(Boolean).slice(0, 40)
    return {
      ...head,
      name,
      description,
      size: Buffer.byteLength(orgText),
      notes: [],
      template: { name, description, kind: kind as ProjectKind, orgText, rolesDigest: rolesDigestOf(orgText), roleNames }
    }
  } catch (e) {
    return refuse(head, e instanceof Error ? e.message : 'The template is not valid.')
  }
}

/** sha256 of an org.json text's roles array, so a stored template and a kit one compare. */
export function rolesDigestOf(orgText: string): string {
  try {
    const org = JSON.parse(orgText) as { roles?: unknown }
    return sha256(JSON.stringify(org.roles ?? null))
  } catch {
    return ''
  }
}

/** The skill with another name (SKILL.md rewritten), for "add as a copy". */
export function renamedSkill(skill: ParsedSkill, name: string): ParsedSkill {
  const files = skill.files.map((f) => (f.path === 'SKILL.md' ? { path: f.path, data: Buffer.from(composeSkillMd({ name, description: skill.description, body: skill.body }), 'utf8') } : f))
  return { ...skill, name, files, digest: digestFiles(files) }
}
