import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  KIT_FORMAT,
  KIT_MAX_BYTES,
  KIT_MAX_CHOICES,
  SKILL_NAME_MAX,
  type KitAction,
  type KitApplyInput,
  type KitApplyResult,
  type KitBundleApplyInput,
  type KitBundleExportInput,
  type KitBundleExportResult,
  type KitBundlePreviewInput,
  type KitCounts,
  type KitExportInput,
  type KitExportResult,
  type KitImportPreview,
  type KitItemKind,
  type KitNeedsSecrets,
  type KitPreviewInput,
  type KitPreviewItem,
  type KitSelection,
  type McpLibraryEntry,
  type McpLibraryInfo,
  type OrgTemplateInfo,
  type ProjectKind,
  type SkillLibraryInfo,
  type UserConnectorDef
} from '@shared/types'
import { isValidMcpServerName } from '@shared/defaults'
import { base64MaxChars, strictBase64, type FileData } from '../skills/files'
import { dropPrivateFiles, skippedNote } from '../capabilities/localSkills'
import {
  fullTarget,
  parseKit,
  presetSignature,
  presetVariantRefusal,
  presetTarget,
  renamedSkill,
  rolesDigestOf,
  safeText,
  serverExportRefusal,
  serverFieldsOf,
  serverSignature,
  sha256,
  skillToKit,
  templateToKit,
  type KitDocument,
  type KitServerFields,
  type ParsedItem
} from './format'

/** What the kit needs from the rest of the main process (index.ts wires the real services). */
export interface KitDeps {
  appVersion: string
  platform: string
  skills: {
    libraryList(): SkillLibraryInfo[]
    libraryFilesForKit(libraryId: string): { name: string; description: string; files: FileData[] }
    libraryImportForKit(input: { name: string; description: string; files: FileData[] }, replaceId?: string): unknown
  }
  mcp: {
    libraryEntries(): McpLibraryEntry[]
    /**
     * Library entries with their secret and sign-in state (McpService.libraryList): which secret slots hold a value and
     * the OAuth state. targetDigest covers it, so a value saved or a sign-in made after the preview makes a 'replace'
     * (which clears them) stale. Missing = only the entry's own connectedAt is covered.
     */
    libraryList?(): McpLibraryInfo[]
    kitImportEntry(fields: KitServerFields, replaceId?: string): McpLibraryEntry
    connectorPresetsList(): UserConnectorDef[]
    connectorPresetsKitSave(input: unknown): UserConnectorDef
  }
  templates: {
    list(): OrgTemplateInfo[]
    readForKit(templateId: string): { info: OrgTemplateInfo; orgText: string } | null
    saveFromKit(input: { name: string; description: string; kind: ProjectKind; orgText: string }, replaceId?: string): OrgTemplateInfo
  }
  now?: () => Date
}

const SELECTION_MAX_IDS = 500
const ID_MAX = 128
const KEY_RE = /^(?:skill|server|preset|template):\d{1,4}$/
const KIND_ORDER: KitItemKind[] = ['skill', 'preset', 'server', 'template']

/** Bytes of a regular, non-linked file of at most KIT_MAX_BYTES. Throws a readable Error. */
export function readKitFile(path: unknown): Buffer {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('Choose a kit file.')
  let st
  try {
    st = lstatSync(path)
  } catch {
    throw new Error('The kit file could not be found.')
  }
  if (st.isSymbolicLink()) throw new Error('Choose the kit file itself, not a link to it.')
  if (!st.isFile()) throw new Error('That is not a file.')
  if (st.size > KIT_MAX_BYTES) throw new Error(`The kit file is larger than ${KIT_MAX_BYTES / 1024 / 1024} MB.`)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.size > KIT_MAX_BYTES) throw new Error('The kit file could not be read.')
    const buf = Buffer.alloc(fst.size)
    let len = 0
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, len)
      if (n <= 0) break
      len += n
    }
    return buf.subarray(0, len)
  } catch (e) {
    throw e instanceof Error && /larger|kit file/.test(e.message) ? e : new Error('The kit file could not be read.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * A bundle's kit bytes from base64: the string length is bounded first (so more than KIT_MAX_BYTES is never decoded),
 * then decoded strictly (alphabet, padding, length % 4, canonical tail). Throws a readable Error.
 */
export function decodeKitBytes(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new Error('The kit file is not valid base64.')
  if (raw.length > base64MaxChars(KIT_MAX_BYTES)) throw new Error(`The kit file is larger than ${KIT_MAX_BYTES / 1024 / 1024} MB.`)
  const bytes = strictBase64(raw, KIT_MAX_BYTES)
  if (!bytes) throw new Error('The kit file is not valid base64.')
  return bytes
}

function writeAtomic(path: string, data: Buffer): void {
  let existing
  try {
    existing = lstatSync(path)
  } catch {
    existing = undefined
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('Choose a file name, not a folder or a link.')
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { flag: 'wx' })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

function selection(name: string, v: unknown): KitSelection | undefined {
  if (v === undefined || v === null) return undefined
  if (v === 'all') return 'all'
  if (!Array.isArray(v) || v.length > SELECTION_MAX_IDS || v.some((x) => typeof x !== 'string' || !x || x.length > ID_MAX)) throw new Error(`The ${name} choice is not valid.`)
  return [...new Set(v as string[])]
}

/** Rebuilds kit:export's include field by field. */
export function exportArgs(input: unknown): KitExportInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose what to export.')
  const i = input as Record<string, unknown>
  if (typeof i.path !== 'string' || !i.path || i.path.length > 4096) throw new Error('Choose where to save the kit.')
  return { path: i.path, include: includeArgs(i.include) }
}

function includeArgs(inc: unknown): KitExportInput['include'] {
  if (!inc || typeof inc !== 'object' || Array.isArray(inc)) throw new Error('Choose what to export.')
  const r = inc as Record<string, unknown>
  const include: KitExportInput['include'] = {}
  const skills = selection('skills', r.skills)
  if (skills) include.skills = skills
  const servers = selection('servers', r.mcpServers)
  if (servers) include.mcpServers = servers
  const presets = selection('presets', r.connectorPresets)
  if (presets) include.connectorPresets = presets
  const templates = selection('templates', r.templates)
  if (templates) include.templates = templates
  return include
}

const DIGEST_RE = /^[0-9a-f]{64}$/

/** kit:applyImport's input; `targetDigest` (cli-spec 3.6) is optional on the file path and checked when present. */
export type KitFileApplyInput = KitApplyInput & { targetDigest?: string }

/** Rebuilds kit:applyImport's input. */
export function applyArgs(input: unknown): KitFileApplyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose what to import.')
  const i = input as Record<string, unknown>
  if (typeof i.path !== 'string' || !i.path || i.path.length > 4096) throw new Error('Choose a kit file.')
  const digest = digestArg(i.digest)
  const choices = choicesArg(i.choices)
  if (i.targetDigest === undefined || i.targetDigest === null) return { path: i.path, digest, choices }
  return { path: i.path, digest, choices, targetDigest: targetDigestArg(i.targetDigest) }
}

function digestArg(v: unknown): string {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) throw new Error(KIT_CHANGED)
  return v
}

function targetDigestArg(v: unknown): string {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) throw staleTargetError()
  return v
}

/** The longest kit file name a bundle carries (the preview's fileName is cut to this too). */
const KIT_FILE_NAME_MAX = 120
const KIT_SUFFIX = '.orgai-kit.json'

/** Rebuilds kit:exportBundle's input (Wave 1 socket channel). No path: the bytes come back to the caller. */
export function exportBundleArgs(input: unknown): KitBundleExportInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose what to export.')
  const i = input as Record<string, unknown>
  const include = includeArgs(i.include)
  if (i.fileName === undefined || i.fileName === null) return { include }
  if (typeof i.fileName !== 'string' || i.fileName.length > 4096) throw new Error('The kit file name is not valid.')
  return { include, fileName: i.fileName }
}

function rawBytesArg(v: unknown): string {
  if (typeof v !== 'string') throw new Error('The kit file is not valid base64.')
  if (v.length > base64MaxChars(KIT_MAX_BYTES)) throw new Error(KIT_TOO_LARGE)
  return v
}

/** Rebuilds kit:previewBundle's input. The base64 is only length-checked here; previewBundle decodes it strictly. */
export function previewBundleArgs(input: unknown): KitBundlePreviewInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose a kit file.')
  const i = input as Record<string, unknown>
  if (typeof i.fileName !== 'string' || i.fileName.length > 4096) throw new Error('The kit file name is not valid.')
  return { fileName: i.fileName, rawBytesBase64: rawBytesArg(i.rawBytesBase64) }
}

/** Rebuilds kit:applyBundle's input (applyArgs' choice and digest rules, plus a required targetDigest). */
export function applyBundleArgs(input: unknown): KitBundleApplyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose what to import.')
  const i = input as Record<string, unknown>
  const rawBytesBase64 = rawBytesArg(i.rawBytesBase64)
  const digest = digestArg(i.digest)
  const targetDigest = targetDigestArg(i.targetDigest)
  return { rawBytesBase64, digest, targetDigest, choices: choicesArg(i.choices) }
}

function choicesArg(raw: unknown): KitApplyInput['choices'] {
  if (!Array.isArray(raw) || raw.length > KIT_MAX_CHOICES) throw new Error('Choose what to import.')
  const seen = new Set<string>()
  const choices: KitApplyInput['choices'] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') throw new Error('A choice is not valid.')
    const key = (c as Record<string, unknown>).key
    const action = (c as Record<string, unknown>).action
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('A choice is not valid.')
    if (action !== 'add' && action !== 'replace' && action !== 'copy' && action !== 'skip') throw new Error('A choice is not valid.')
    if (seen.has(key)) continue
    seen.add(key)
    choices.push({ key, action })
  }
  return choices
}

const KIT_CHANGED = 'The kit file changed since the preview. Preview it again.'
const KIT_TOO_LARGE = `The kit file is larger than ${KIT_MAX_BYTES / 1024 / 1024} MB.`
/** The refusal when the destination library moved since the preview (code 'stale_target_digest'). */
export const STALE_TARGET_MESSAGE = 'Something in your library changed since the preview. Preview the kit again.'

function staleTargetError(): Error {
  return Object.assign(new Error(STALE_TARGET_MESSAGE), { code: 'stale_target_digest' })
}

/** A bundle's file name: the caller's, cleaned (or the dated default), at most 120 chars, ending in .orgai-kit.json. */
export function kitBundleFileName(raw: string | undefined, now: Date): string {
  const fallback = `orgai-kit-${now.toISOString().slice(0, 10)}`
  let stem = typeof raw === 'string' ? raw : ''
  stem = stem.split(/[\\/]/).pop() ?? ''
  stem = stem.replace(/\.orgai-kit\.json$/i, '').replace(/\.json$/i, '')
  stem = stem.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '')
  if (!stem) stem = fallback
  return `${stem.slice(0, KIT_FILE_NAME_MAX - KIT_SUFFIX.length)}${KIT_SUFFIX}`
}

/** JSON with object keys sorted at every level (arrays keep their order), for digests. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** A library server's secret and sign-in state, by presence only (never a value or token): what a replace clears. */
interface ServerSecretState {
  envSet: string[]
  headersSet: string[]
  /** A token is stored ('authorized' or 'expired'); a transient 'error' or the expiry clock never count. */
  signedIn: boolean
  account: string | null
  connectedAt: number | null
}

interface Existing {
  skills: Map<string, { id: string; digest: string }>
  servers: Map<string, McpLibraryEntry>
  /** By entry id. */
  serverSecrets: Map<string, ServerSecretState>
  presets: Map<string, UserConnectorDef>
  templates: Map<string, { id: string; rolesDigest: string; updatedAt: number }>
}

interface Classified {
  status: 'new' | 'same' | 'different' | 'refused'
  canReplace: boolean
  conflict?: string
  replaceId?: string
}

/** A name that is not in `taken`: base, then base-2, base-3 ... cut to fit `max`. */
function uniqueName(base: string, taken: ReadonlySet<string>, max: number, sep: string, ok: (s: string) => boolean = () => true): string {
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : `${sep}${n}`
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`
    if (!taken.has(candidate) && ok(candidate)) return candidate
  }
  throw new Error('Could not find a free name for the copy.')
}

const emptyCounts = (): KitCounts => ({ skills: 0, mcpServers: 0, connectorPresets: 0, templates: 0 })
const countKey = (k: KitItemKind): keyof KitCounts => (k === 'skill' ? 'skills' : k === 'server' ? 'mcpServers' : k === 'preset' ? 'connectorPresets' : 'templates')

/**
 * The practice kit (docs/design/engagement-2.md): export library skills, library MCP servers, custom connector
 * presets and team templates to one `*.orgai-kit.json` file, and preview and apply one. Secret values, OAuth state,
 * tokens, connector and build fields, ids and folders never go into a kit. An imported file is untrusted: every item is
 * rebuilt and validated (format.ts) and a bad item is refused alone. Apply is bound to the previewed file by its sha256
 * and applies only the chosen items; items are independent (a failure leaves the others applied) and there is no undo.
 */
export class KitService {
  /**
   * The library mutation mutex of kit:applyBundle (cli-spec 3.6 item 2): a promise chain, so one bundle apply runs
   * from its digest and targetDigest checks through its last write before the next one starts.
   */
  private applyChain: Promise<unknown> = Promise.resolve()

  constructor(private deps: KitDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.applyChain.then(fn, fn)
    this.applyChain = run.catch(() => undefined)
    return run
  }

  // ---------- export ----------

  /** kit:export. `input.path` has been authorized by the caller (the save dialog). */
  export(input: KitExportInput): KitExportResult {
    const built = this.buildExport(input.include)
    writeAtomic(input.path, built.data)
    return { path: input.path, counts: built.counts, bytes: built.data.length, notes: built.notes }
  }

  /**
   * kit:exportBundle (Wave 1 socket channel): the same content and notes as export(), returned as base64 with no file
   * written. The file name is the caller's, cleaned (kitBundleFileName), or `orgai-kit-<yyyy-mm-dd>.orgai-kit.json`.
   */
  exportBundle(input: KitBundleExportInput): KitBundleExportResult {
    const built = this.buildExport(input.include)
    return {
      fileName: kitBundleFileName(input.fileName, this.now()),
      rawBytesBase64: built.data.toString('base64'),
      counts: built.counts,
      bytes: built.data.length,
      notes: built.notes
    }
  }

  /** The kit file's bytes, counts and notes for `include`. Throws when nothing can be exported or it is too large. */
  private buildExport(include: KitExportInput['include']): { data: Buffer; counts: KitCounts; notes: string[] } {
    const notes: string[] = []
    const doc: KitDocument = {
      format: KIT_FORMAT,
      exportedAt: this.now().toISOString(),
      appVersion: this.deps.appVersion,
      platform: this.deps.platform,
      skills: [],
      mcpServers: [],
      connectorPresets: [],
      templates: []
    }
    const pick = <T extends { id: string }>(sel: KitSelection | undefined, all: T[], label: string): T[] => {
      if (!sel) return []
      if (sel === 'all') return all
      const byId = new Map(all.map((x) => [x.id, x]))
      const out: T[] = []
      for (const id of sel) {
        const hit = byId.get(id)
        if (hit) out.push(hit)
        else notes.push(`A ${label} you chose is no longer there.`)
      }
      return out
    }

    for (const info of pick(include.skills, this.deps.skills.libraryList().map((i) => ({ id: i.entry.id, name: i.entry.name })), 'skill')) {
      try {
        const s = this.deps.skills.libraryFilesForKit(info.id)
        // Dotfiles, .env*, *.pem and *.key never leave (the capabilities apply path's list).
        const { kept, skipped } = dropPrivateFiles(s.files)
        if (skipped.length) notes.push(`The skill ${safeText(info.name)}: ${skippedNote(skipped)}.`)
        const r = skillToKit(s.name, s.description, kept)
        if ('skip' in r) notes.push(`Left out the skill ${safeText(info.name)}: ${r.skip}`)
        else doc.skills.push(r.doc)
      } catch (e) {
        notes.push(`Left out the skill ${safeText(info.name)}: ${safeText(e instanceof Error ? e.message : 'its files could not be read', 160)}`)
      }
    }

    let signIns = 0
    for (const e of pick(include.mcpServers, this.deps.mcp.libraryEntries(), 'server')) {
      const refusal = serverExportRefusal(e)
      if (refusal) {
        notes.push(`Left out the server ${safeText(e.name)}: ${refusal}`)
        continue
      }
      if (e.oauth) signIns++
      doc.mcpServers.push(serverFieldsOf(e))
    }
    if (signIns) notes.push(`${signIns} server${signIns === 1 ? '' : 's'} used a sign-in. Sign-ins are not included; sign in again after importing.`)

    for (const p of pick(include.connectorPresets, this.deps.mcp.connectorPresetsList(), 'preset')) {
      const { origin: _origin, ...rest } = p
      void _origin
      const bad = p.variants.map((v) => presetVariantRefusal(v)).find((r) => r !== null)
      if (bad) {
        notes.push(`Left out the connector preset ${safeText(p.name)}: ${bad}`)
        continue
      }
      doc.connectorPresets.push(rest as UserConnectorDef)
    }

    for (const t of pick(include.templates, this.deps.templates.list(), 'template')) {
      const stored = this.deps.templates.readForKit(t.id)
      if (!stored) {
        notes.push(`Left out the template ${safeText(t.name)}: its chart file could not be read.`)
        continue
      }
      const r = templateToKit(stored.info, stored.orgText)
      if ('skip' in r) notes.push(`Left out the template ${safeText(t.name)}: ${r.skip}`)
      else doc.templates.push(r.doc)
    }

    const counts: KitCounts = { skills: doc.skills.length, mcpServers: doc.mcpServers.length, connectorPresets: doc.connectorPresets.length, templates: doc.templates.length }
    if (counts.skills + counts.mcpServers + counts.connectorPresets + counts.templates === 0) {
      throw new Error(notes.length ? `Nothing could be exported. ${notes[0]}` : 'Choose at least one item.')
    }
    const data = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    if (data.length > KIT_MAX_BYTES) throw new Error(`The kit would be larger than ${KIT_MAX_BYTES / 1024 / 1024} MB. Choose fewer items.`)
    if (counts.mcpServers) notes.push('Secret values are not included. People enter their own after importing.')
    return { data, counts, notes }
  }

  // ---------- import ----------

  private existing(): Existing {
    const entries = this.deps.mcp.libraryEntries()
    const infos = new Map((this.deps.mcp.libraryList?.() ?? []).map((i) => [i.entry.id, i]))
    const serverSecrets = new Map<string, ServerSecretState>()
    for (const e of entries) {
      const info = infos.get(e.id)
      serverSecrets.set(e.id, {
        envSet: [...(info?.envSet ?? [])].sort(),
        headersSet: [...(info?.headersSet ?? [])].sort(),
        signedIn: info?.auth.state === 'authorized' || info?.auth.state === 'expired',
        account: info?.auth.account ?? null,
        connectedAt: typeof e.connectedAt === 'number' ? e.connectedAt : null
      })
    }
    return {
      skills: new Map(this.deps.skills.libraryList().map((i) => [i.entry.name, { id: i.entry.id, digest: i.entry.digest }])),
      servers: new Map(entries.map((e) => [e.name, e])),
      serverSecrets,
      presets: new Map(this.deps.mcp.connectorPresetsList().map((p) => [p.id, p])),
      templates: new Map(
        this.deps.templates.list().flatMap((t) => {
          const stored = this.deps.templates.readForKit(t.id)
          return stored ? [[t.name.toLowerCase(), { id: t.id, rolesDigest: rolesDigestOf(stored.orgText), updatedAt: t.updatedAt }] as const] : []
        })
      )
    }
  }

  /**
   * sha256 over a canonical JSON of the destination state the kit's items would touch (cli-spec 3.6 item 2): per
   * non-refused item, the entry it would meet (skill by name: id + digest; server by name: id + serverSignature +
   * connector / build markers + which secret slots hold a value, the OAuth state and account and connectedAt (review
   * Low: a replace clears them, so a value saved or a sign-in made after the preview makes the apply stale instead of
   * wiping it); preset by id: its JSON; template by name: id + updatedAt + roles digest), or `null` when there is none,
   * so a same-name entry added after the preview also makes the digest stale. Secret values never enter it.
   */
  private targetDigestOf(items: ParsedItem[], ex: Existing): string {
    const state = items
      .filter((it) => !it.refusal)
      .map((it) => {
        if (it.skill) {
          const hit = ex.skills.get(it.skill.name)
          return { kind: 'skill', name: it.skill.name, hit: hit ? { id: hit.id, digest: hit.digest } : null }
        }
        if (it.server) {
          const hit = ex.servers.get(it.server.name)
          return {
            kind: 'server',
            name: it.server.name,
            hit: hit
              ? {
                  id: hit.id,
                  signature: serverSignature(serverFieldsOf(hit)),
                  connectorId: hit.connectorId ?? null,
                  built: !!hit.buildDigest,
                  secrets: ex.serverSecrets.get(hit.id) ?? null
                }
              : null
          }
        }
        if (it.preset) {
          const hit = ex.presets.get(it.preset.id)
          return { kind: 'preset', id: it.preset.id, hit: hit ? JSON.parse(JSON.stringify(hit)) : null }
        }
        if (it.template) {
          const hit = ex.templates.get(it.template.name.toLowerCase())
          return { kind: 'template', name: it.template.name.toLowerCase(), hit: hit ? { id: hit.id, updatedAt: hit.updatedAt, rolesDigest: hit.rolesDigest } : null }
        }
        return { kind: it.kind, key: it.key, hit: null }
      })
    return sha256(canonicalJson(state))
  }

  private classify(item: ParsedItem, ex: Existing): Classified {
    if (item.refusal) return { status: 'refused', canReplace: false }
    if (item.skill) {
      const hit = ex.skills.get(item.skill.name)
      if (!hit) return { status: 'new', canReplace: true }
      if (hit.digest === item.skill.digest) return { status: 'same', canReplace: true, replaceId: hit.id }
      return { status: 'different', canReplace: true, replaceId: hit.id, conflict: 'A skill with this name is in your library with other content.' }
    }
    if (item.server) {
      const hit = ex.servers.get(item.server.name)
      if (!hit) return { status: 'new', canReplace: true }
      if (!hit.connectorId && !hit.buildDigest && serverSignature(serverFieldsOf(hit)) === serverSignature(item.server)) return { status: 'same', canReplace: true, replaceId: hit.id }
      if (hit.connectorId || hit.buildDigest) {
        return { status: 'different', canReplace: false, conflict: 'Your server with this name is a connector or a built server, which a kit cannot replace. Add it as a copy or skip it.' }
      }
      return { status: 'different', canReplace: true, replaceId: hit.id, conflict: 'A server with this name is in your library with another definition. Replacing it clears its secret values and sign-in.' }
    }
    if (item.preset) {
      const hit = ex.presets.get(item.preset.id)
      if (!hit) return { status: 'new', canReplace: true }
      if (presetSignature(hit) === presetSignature(item.preset)) return { status: 'same', canReplace: true, replaceId: hit.id }
      return { status: 'different', canReplace: true, replaceId: hit.id, conflict: 'A preset with this id is in your presets with another definition.' }
    }
    if (item.template) {
      const hit = ex.templates.get(item.template.name.toLowerCase())
      if (!hit) return { status: 'new', canReplace: true }
      if (hit.rolesDigest === item.template.rolesDigest) return { status: 'same', canReplace: true, replaceId: hit.id }
      return { status: 'different', canReplace: true, replaceId: hit.id, conflict: 'A template with this name is saved with another org chart.' }
    }
    return { status: 'refused', canReplace: false }
  }

  /** kit:previewImport. `input.path` has been authorized by the caller (the open dialog). */
  previewImport(input: KitPreviewInput): KitImportPreview {
    return this.previewBytes(readKitFile(input.path), basename(input.path), input.path)
  }

  /**
   * kit:previewBundle (Wave 1 socket channel): the bytes come as base64. The length is bounded so the decoded size is
   * at most KIT_MAX_BYTES before anything is decoded, then decoded strictly and previewed by the same parser and
   * validators as a picked file. `path` is ''.
   */
  previewBundle(input: KitBundlePreviewInput): KitImportPreview {
    return this.previewBytes(decodeKitBytes(input?.rawBytesBase64), typeof input?.fileName === 'string' ? input.fileName : '', '')
  }

  /** The preview core over a kit file's bytes (file or bundle), with the targetDigest of the destination state. */
  previewBytes(bytes: Buffer, fileName: string, path: string): KitImportPreview {
    if (bytes.length > KIT_MAX_BYTES) throw new Error(KIT_TOO_LARGE)
    const digest = sha256(bytes)
    const parsed = parseKit(bytes)
    const ex = this.existing()
    const items: KitPreviewItem[] = parsed.items.map((it) => {
      const c = this.classify(it, ex)
      const out: KitPreviewItem = {
        key: it.key,
        kind: it.kind,
        name: it.name,
        status: c.status,
        action: c.status === 'new' ? 'add' : 'skip',
        canReplace: c.canReplace,
        size: it.size,
        notes: [...it.notes]
      }
      if (it.description) out.description = it.description
      if (c.conflict) out.conflict = c.conflict
      if (it.refusal) out.refusal = it.refusal
      if (it.server) {
        out.command = fullTarget(it.server)
        const slots = [...(it.server.secretEnv ?? []), ...(it.server.secretHeaders ?? [])]
        if (slots.length) out.secretSlots = slots
        if (it.server.perProjectSecrets) out.perProjectSecrets = true
      }
      if (it.preset) out.command = presetTarget(it.preset)
      if (it.skill) {
        out.files = it.skill.files.filter((f) => f.path !== 'SKILL.md').map((f) => f.path)
        if (it.skill.scripts.length) out.scripts = it.skill.scripts
      }
      if (it.template) {
        out.roleNames = it.template.roleNames
        out.roles = it.template.roles.map((r) => ({ ...r, elevatedTools: [...r.elevatedTools] }))
      }
      return out
    })
    const notes: string[] = []
    const refused = items.filter((i) => i.status === 'refused').length
    if (refused) notes.push(`${refused} item${refused === 1 ? ' was' : 's were'} refused and cannot be imported.`)
    return {
      path,
      fileName: safeText(basename(fileName.replace(/\\/g, '/')), KIT_FILE_NAME_MAX),
      digest,
      bytes: bytes.length,
      ...(parsed.exportedAt ? { exportedAt: parsed.exportedAt } : {}),
      ...(parsed.appVersion ? { appVersion: parsed.appVersion } : {}),
      ...(parsed.platform ? { platform: parsed.platform } : {}),
      items,
      notes,
      targetDigest: this.targetDigestOf(parsed.items, ex)
    }
  }

  /**
   * kit:applyImport. Refuses a stale digest, and a stale `targetDigest` when one is given (absent = not checked, the
   * Desktop's old contract). `input` has been through applyArgs; the path is authorized by the caller. Synchronous, so
   * it never interleaves with an applyBundle in this process.
   */
  applyImport(input: KitFileApplyInput): KitApplyResult {
    return this.applyBytes(readKitFile(input.path), input)
  }

  /**
   * kit:applyBundle (Wave 1 socket channel), under the KitService mutex from verification through the last write:
   * 1. the decoded bytes must match `digest` (else "The kit file changed since the preview. Preview it again."),
   * 2. the destination state must still match `targetDigest` (else code 'stale_target_digest', before any write),
   * 3. the chosen items are applied exactly like a picked file.
   */
  applyBundle(input: KitBundleApplyInput): Promise<KitApplyResult> {
    return this.exclusive(() => this.applyBytes(decodeKitBytes(input?.rawBytesBase64), input))
  }

  /** The apply core over a kit file's bytes. `targetDigest` undefined = not checked (the file path's old contract). */
  applyBytes(bytes: Buffer, input: { digest: string; choices: KitApplyInput['choices']; targetDigest?: string }): KitApplyResult {
    if (bytes.length > KIT_MAX_BYTES) throw new Error(KIT_TOO_LARGE)
    if (sha256(bytes) !== input.digest) throw new Error(KIT_CHANGED)
    const parsed = parseKit(bytes)
    const ex = this.existing()
    if (input.targetDigest !== undefined && this.targetDigestOf(parsed.items, ex) !== input.targetDigest) throw staleTargetError()
    const choice = new Map(input.choices.map((c) => [c.key, c.action]))
    const result: KitApplyResult = { added: 0, replaced: 0, copied: 0, skipped: 0, counts: emptyCounts(), failed: [], needsSecrets: [], notes: [] }
    const takenSkills = new Set(ex.skills.keys())
    const takenServers = new Set(ex.servers.keys())
    const takenPresetIds = new Set(ex.presets.keys())
    const takenPresetNames = new Set(this.deps.mcp.connectorPresetsList().map((p) => p.name))
    const takenTemplates = new Set(ex.templates.keys())

    const ordered = [...parsed.items].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    for (const item of ordered) {
      const action: KitAction = choice.get(item.key) ?? 'skip'
      if (action === 'skip') {
        result.skipped++
        continue
      }
      const fail = (reason: string): void => {
        result.failed.push({ key: item.key, name: item.name, reason: safeText(reason, 240) })
      }
      const c = this.classify(item, ex)
      if (c.status === 'refused') {
        fail(item.refusal ?? 'Refused.')
        continue
      }
      if (c.status === 'same') {
        result.skipped++
        continue
      }
      const allowed = c.status === 'new' ? action === 'add' : (action === 'replace' && c.canReplace) || action === 'copy'
      if (!allowed) {
        fail(action === 'replace' && !c.canReplace ? 'Yours cannot be replaced from a kit.' : 'That choice is not available for this item.')
        continue
      }
      try {
        const mode = c.status === 'new' ? 'added' : action === 'replace' ? 'replaced' : 'copied'
        const replaceId = action === 'replace' ? c.replaceId : undefined
        if (item.skill) {
          let skill = item.skill
          if (action === 'copy') {
            skill = renamedSkill(skill, uniqueName(`${skill.name}-copy`, takenSkills, SKILL_NAME_MAX, '-'))
          }
          this.deps.skills.libraryImportForKit({ name: skill.name, description: skill.description, files: skill.files }, replaceId)
          takenSkills.add(skill.name)
        } else if (item.server) {
          let fields = item.server
          if (action === 'copy') fields = { ...fields, name: uniqueName(`${fields.name}-copy`, takenServers, 48, '-', isValidMcpServerName) }
          this.deps.mcp.kitImportEntry(fields, replaceId)
          takenServers.add(fields.name)
          const env = fields.secretEnv ?? []
          const headers = fields.secretHeaders ?? []
          if (env.length || headers.length) {
            const need: KitNeedsSecrets = { name: fields.name, env: [...env], headers: [...headers], perProject: fields.perProjectSecrets === true }
            result.needsSecrets.push(need)
          }
          if (mode === 'replaced') result.notes.push(`Replaced the server ${fields.name}; its stored secret values and sign-in were cleared.`)
        } else if (item.preset) {
          let def = item.preset
          if (action === 'copy') {
            const id = uniqueName(`${def.id}-copy`, takenPresetIds, 48, '-')
            const name = uniqueName(`${def.name} (copy)`, takenPresetNames, 64, ' ')
            def = { ...def, id, name }
          }
          this.deps.mcp.connectorPresetsKitSave(def)
          takenPresetIds.add(def.id)
          takenPresetNames.add(def.name)
        } else if (item.template) {
          let t = item.template
          if (action === 'copy') {
            const name = uniqueName(`${t.name} (copy)`, new Set<string>(), 80, ' ', (s) => !takenTemplates.has(s.toLowerCase()))
            t = { ...t, name }
          }
          this.deps.templates.saveFromKit({ name: t.name, description: t.description, kind: t.kind, orgText: t.orgText }, replaceId)
          takenTemplates.add(t.name.toLowerCase())
        }
        result[mode === 'added' ? 'added' : mode === 'replaced' ? 'replaced' : 'copied']++
        result.counts[countKey(item.kind)]++
      } catch (e) {
        fail(e instanceof Error ? e.message : 'It could not be imported.')
      }
    }
    if (result.needsSecrets.length) result.notes.push('Imported servers need their secret values before agents can use them. Set them in Settings > Connectors.')
    result.notes.push('Importing cannot be undone. Remove an item from its own list to take it back.')
    return result
  }
}
