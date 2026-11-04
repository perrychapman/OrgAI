import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ConnectorCategory,
  ConnectorDef,
  ConnectorVariant,
  McpLibraryEntry,
  UserConnectorAuth,
  UserConnectorDef,
  UserConnectorVariant
} from '@shared/types'
import { CONNECTOR_CATEGORIES, USER_CONNECTOR_PRESETS_MAX } from '@shared/types'
import { connectorById } from '@shared/connectors'
import { isValidMcpServerName } from '@shared/defaults'
import { hiddenCharIn } from '../capabilities/sanitize'
import { connectorEntryName } from './connectors'
import { validateLibraryEntry } from './validate'

/**
 * Custom connector presets (<data>/connector-presets.json): tiles the user defines for the Connectors gallery.
 * Everything here is untrusted input (the renderer, a file on disk, later a practice kit): validateUserPreset rebuilds
 * a preset field by field, caps every length, refuses hidden characters and never echoes a rejected value. Pure
 * except for ConnectorPresetStore. Secret values are never part of a preset (a token variant only names its slot).
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

const URL_MAX = 2000
const VALUE_MAX = 2000
const COMMAND_MAX = 500
const ARGS_MAX = 64
const MAP_MAX = 20

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** An own property of a plain object (never a prototype one). */
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)

function fail(message: string): never {
  throw new Error(message)
}

/** A required or optional string field: trimmed, length-capped, no hidden characters. The message never carries the value. */
function text(field: string, v: unknown, min: number, max: number, opts: { prose?: boolean; keepSpaces?: boolean } = {}): string {
  if (typeof v !== 'string') return fail(`${field} must be text.`)
  const s = opts.keepSpaces ? v : v.trim()
  if (s.length < min || s.length > max) return fail(min > 0 ? `${field} must be ${min === 1 ? 'at least 1' : min}-${max} characters.` : `${field} must be at most ${max} characters.`)
  if (hiddenCharIn(s, opts.prose ? { prose: true } : {})) return fail(`${field} contains a hidden character; remove it.`)
  return s
}

const absent = (v: unknown): boolean => v === undefined || v === null || v === ''

function httpsUrl(field: string, v: unknown): string {
  const s = text(field, v, 1, URL_MAX)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return fail(`${field} must be an https address.`)
  }
  if (u.protocol !== 'https:') return fail(`${field} must be an https address.`)
  if (u.username || u.password) return fail(`${field} must not contain a user name or password.`)
  return s
}

function textList(field: string, v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) return fail(`${field} must be a list.`)
  if (v.length > maxItems) return fail(`${field} can have at most ${maxItems} entries.`)
  const out = v.map((x, i) => text(`${field} ${i + 1}`, x, 1, maxLen, { prose: true }))
  return out.length ? out : undefined
}

function stringMap(field: string, v: unknown, nameRe: RegExp, kind: 'environment variable' | 'header'): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (!isPlain(v)) return fail(`${field} must be a list of names and values.`)
  const entries = Object.entries(v)
  if (entries.length > MAP_MAX) return fail(`${field} can have at most ${MAP_MAX} entries.`)
  const out: Record<string, string> = {}
  for (const [k, val] of entries) {
    if (k === '__proto__') return fail(`A ${kind} name is not valid.`)
    if (hiddenCharIn(k) || !nameRe.test(k) || k.length > 128) return fail(`A ${kind} name in ${field.toLowerCase()} is not valid.`)
    const s = text(`A ${kind} value in ${field.toLowerCase()}`, val, 0, VALUE_MAX, { keepSpaces: true })
    out[k] = s
  }
  return Object.keys(out).length ? out : undefined
}

function validateAuth(raw: unknown, transport: UserConnectorVariant['transport'], where: string): UserConnectorAuth {
  if (!isPlain(raw)) return fail(`${where} needs a sign-in setting.`)
  const kind = own(raw, 'kind')
  if (kind === 'none') return { kind: 'none' }
  if (kind === 'oauth') {
    if (transport === 'stdio') return fail(`${where}: OAuth sign-in needs an http or sse server, not a command.`)
    const scopesRaw = own(raw, 'scopes')
    if (scopesRaw === undefined || scopesRaw === null) return { kind: 'oauth' }
    if (!Array.isArray(scopesRaw)) return fail(`${where}: scopes must be a list.`)
    if (scopesRaw.length > 20) return fail(`${where}: at most 20 scopes are allowed.`)
    const scopes = scopesRaw.map((s) => {
      const t = text(`${where}: a scope`, s, 1, 200, { keepSpaces: true })
      if (/\s/.test(t)) return fail(`${where}: a scope must not contain spaces.`)
      return t
    })
    return scopes.length ? { kind: 'oauth', scopes } : { kind: 'oauth' }
  }
  if (kind === 'token') {
    const header = text(`${where}: the token ${transport === 'stdio' ? 'variable' : 'header'} name`, own(raw, 'header'), 1, 128)
    if (!(transport === 'stdio' ? ENV_NAME : HEADER_NAME).test(header)) {
      return fail(`${where}: the token ${transport === 'stdio' ? 'environment variable' : 'header'} name is not valid.`)
    }
    const label = text(`${where}: the token label`, own(raw, 'label'), 1, 64)
    const helpRaw = own(raw, 'help')
    const help = helpRaw === undefined || helpRaw === null ? '' : text(`${where}: the token help`, helpRaw, 0, 300, { prose: true })
    const prefixRaw = own(raw, 'prefix')
    let prefix: string | undefined
    if (!absent(prefixRaw)) {
      prefix = text(`${where}: the token prefix`, prefixRaw, 1, 32, { keepSpaces: true })
      if (!PRINTABLE_ASCII.test(prefix)) return fail(`${where}: the token prefix may contain only printable ASCII characters.`)
    }
    const linkRaw = own(raw, 'link')
    const link = absent(linkRaw) ? undefined : httpsUrl(`${where}: the token link`, linkRaw)
    return { kind: 'token', header, label, help, ...(prefix ? { prefix } : {}), ...(link ? { link } : {}) }
  }
  return fail(`${where}: the sign-in must be none, oauth or token.`)
}

function validateVariant(raw: unknown, index: number): UserConnectorVariant {
  const where = `Variant ${index + 1}`
  if (!isPlain(raw)) return fail(`${where} is not valid.`)
  const id = text(`${where} id`, own(raw, 'id'), 1, 32)
  if (!KEBAB.test(id)) return fail(`${where} id must be lowercase letters, digits and hyphens.`)
  const label = text(`${where} label`, own(raw, 'label'), 1, 64)
  const descRaw = own(raw, 'description')
  const description = absent(descRaw) ? undefined : text(`${where} description`, descRaw, 1, 300, { prose: true })
  const transportRaw = own(raw, 'transport')
  if (transportRaw !== 'http' && transportRaw !== 'sse' && transportRaw !== 'stdio') return fail(`${where} transport must be http, sse or stdio.`)
  const transport: UserConnectorVariant['transport'] = transportRaw
  const readOnlyRaw = own(raw, 'readOnly')
  if (readOnlyRaw !== undefined && typeof readOnlyRaw !== 'boolean') return fail(`${where}: read-only must be true or false.`)
  const base = { id, label, ...(description ? { description } : {}), transport, readOnly: readOnlyRaw === true }
  const hasKey = (k: string): boolean => !absent(own(raw, k)) && !(Array.isArray(own(raw, k)) && (own(raw, k) as unknown[]).length === 0) && !(isPlain(own(raw, k)) && Object.keys(own(raw, k) as object).length === 0)
  if (transport === 'stdio') {
    if (hasKey('url')) return fail(`${where}: a command server cannot have an address.`)
    if (hasKey('headers')) return fail(`${where}: a command server cannot have headers; use env.`)
    const command = text(`${where} command`, own(raw, 'command'), 1, COMMAND_MAX)
    const argsRaw = own(raw, 'args')
    let args: string[] | undefined
    if (argsRaw !== undefined && argsRaw !== null) {
      if (!Array.isArray(argsRaw)) return fail(`${where}: arguments must be a list.`)
      if (argsRaw.length > ARGS_MAX) return fail(`${where}: at most ${ARGS_MAX} arguments are allowed.`)
      args = argsRaw.map((a, i) => {
        const t = text(`${where} argument ${i + 1}`, a, 0, VALUE_MAX, { keepSpaces: true })
        if (t.includes('\0')) return fail(`${where} argument ${i + 1} is not valid.`)
        return t
      })
    }
    const env = stringMap(`${where} env`, own(raw, 'env'), ENV_NAME, 'environment variable')
    const auth = validateAuth(own(raw, 'auth'), 'stdio', where)
    return { ...base, command, ...(args?.length ? { args } : {}), ...(env ? { env } : {}), auth }
  }
  if (hasKey('command') || hasKey('args')) return fail(`${where}: an ${transport} server cannot have a command.`)
  if (hasKey('env')) return fail(`${where}: an ${transport} server cannot have env variables; use headers.`)
  const url = httpsUrl(`${where} address`, own(raw, 'url'))
  const headers = stringMap(`${where} headers`, own(raw, 'headers'), HEADER_NAME, 'header')
  if (headers) for (const v of Object.values(headers)) if (/[\r\n]/.test(v)) return fail(`${where}: a header value must be a single line.`)
  const auth = validateAuth(own(raw, 'auth'), transport, where)
  return { ...base, url, ...(headers ? { headers } : {}), auth }
}

/**
 * A user preset rebuilt from untrusted input, or one readable Error. publisher is forced to 'user' and verified to
 * false; origin survives only as exactly 'kit'; unknown fields are dropped. Each variant is also built into its
 * library entry and run through validateLibraryEntry (pinned versions and the other server rules), reporting the first
 * problem per variant.
 */
export function validateUserPreset(input: unknown): UserConnectorDef {
  if (!isPlain(input)) return fail('A custom connector must be an object.')
  const id = text('The id', own(input, 'id'), 1, 48)
  if (!KEBAB.test(id) || !isValidMcpServerName(id)) return fail('The id must be lowercase letters, digits and single hyphens (at most 48 characters).')
  if (connectorById(id)) return fail('That id belongs to a built-in connector.')
  const name = text('The name', own(input, 'name'), 1, 64)
  const vendor = text('The vendor', own(input, 'vendor'), 1, 64)
  const description = text('The description', own(input, 'description'), 1, 300, { prose: true })
  const category = own(input, 'category')
  if (typeof category !== 'string' || !(CONNECTOR_CATEGORIES as readonly string[]).includes(category)) return fail('Pick a category from the list.')
  const statusRaw = own(input, 'status')
  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== 'preview' && statusRaw !== 'stable') return fail('The status must be preview or stable.')
  const docsRaw = own(input, 'docsUrl')
  const docsUrl = absent(docsRaw) ? undefined : httpsUrl('The documentation link', docsRaw)
  const variantsRaw = own(input, 'variants')
  if (!Array.isArray(variantsRaw) || variantsRaw.length < 1 || variantsRaw.length > 5) return fail('A connector needs 1-5 variants.')
  const variants = variantsRaw.map((v, i) => validateVariant(v, i))
  if (new Set(variants.map((v) => v.id)).size !== variants.length) return fail('Variant ids must be unique.')
  const defRaw = own(input, 'defaultVariant')
  let defaultVariant: string
  if (absent(defRaw)) defaultVariant = variants[0].id
  else if (typeof defRaw === 'string' && variants.some((v) => v.id === defRaw)) defaultVariant = defRaw
  else return fail('The default variant must be one of the variants.')
  const setup = textList('Setup step', own(input, 'setup'), 10, 300)
  const notes = textList('Note', own(input, 'notes'), 10, 300)
  const aliasesRaw = own(input, 'aliases')
  let aliases: string[] | undefined
  if (aliasesRaw !== undefined && aliasesRaw !== null) {
    if (!Array.isArray(aliasesRaw)) return fail('Aliases must be a list.')
    if (aliasesRaw.length > 20) return fail('At most 20 aliases are allowed.')
    const seen = new Set<string>()
    for (const a of aliasesRaw) seen.add(text('An alias', a, 1, 32).toLowerCase())
    aliases = [...seen]
  }
  const def: UserConnectorDef = {
    id,
    name,
    vendor,
    publisher: 'user',
    category: category as ConnectorCategory,
    description,
    ...(statusRaw === 'preview' || statusRaw === 'stable' ? { status: statusRaw } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    variants,
    defaultVariant,
    ...(setup ? { setup } : {}),
    ...(notes ? { notes } : {}),
    ...(aliases?.length ? { aliases } : {}),
    verified: false,
    ...(own(input, 'origin') === 'kit' ? { origin: 'kit' as const } : {})
  }
  for (const v of variants) {
    const problems = validateLibraryEntry(buildPresetEntry(def, v, 'preset-check', [], new Date(0)), [])
    if (problems.length) return fail(`Variant "${v.id}": ${problems[0]}`)
  }
  return def
}

/** The ConnectorDef the gallery and dialogs read for a custom preset (publisher 'user', status 'stable', no docs link as ''). */
export function presetConnectorDef(def: UserConnectorDef): ConnectorDef {
  const variants: ConnectorVariant[] = def.variants.map((v) => ({
    id: v.id,
    label: v.label,
    ...(v.description ? { description: v.description } : {}),
    transport: v.transport,
    url: v.transport === 'stdio' ? '' : (v.url ?? ''),
    ...(v.transport !== 'stdio' && v.headers && Object.keys(v.headers).length ? { headers: { ...v.headers } } : {}),
    readOnly: v.readOnly,
    auth: structuredClone(v.auth)
  }))
  return {
    id: def.id,
    name: def.name,
    vendor: def.vendor,
    publisher: 'user',
    category: def.category,
    description: def.description,
    status: def.status ?? 'stable',
    docsUrl: def.docsUrl ?? '',
    variants,
    defaultVariant: def.defaultVariant,
    setup: [...(def.setup ?? [])],
    ...(def.notes?.length ? { notes: [...def.notes] } : {}),
    ...(def.aliases?.length ? { aliases: [...def.aliases] } : {}),
    verified: false
  }
}

/**
 * The library entry for a preset variant (like buildConnectorEntry): stdio -> command / args / env and, for a token,
 * the secret env slot; http / sse -> url / headers and the secret header slot. Marked connectorCustom so the id is
 * looked up in the user's presets, never the curated catalog.
 */
export function buildPresetEntry(def: UserConnectorDef, variant: UserConnectorVariant, id: string, taken: readonly string[], now: Date): McpLibraryEntry {
  const stdio = variant.transport === 'stdio'
  const token = variant.auth.kind === 'token' ? variant.auth.header : undefined
  return {
    id,
    name: connectorEntryName(def, taken),
    transport: variant.transport,
    ...(stdio
      ? {
          command: variant.command,
          ...(variant.args?.length ? { args: [...variant.args] } : {}),
          ...(variant.env && Object.keys(variant.env).length ? { env: { ...variant.env } } : {}),
          ...(token ? { secretEnv: [token] } : {})
        }
      : {
          url: variant.url ?? '',
          ...(variant.headers && Object.keys(variant.headers).length ? { headers: { ...variant.headers } } : {}),
          ...(token ? { secretHeaders: [token] } : {})
        }),
    source: 'user',
    description: `${def.name} (${variant.label}): ${def.description}`.slice(0, 200),
    addedAt: now.toISOString(),
    connectorId: def.id,
    connectorVariant: variant.id,
    connectorCustom: true
  }
}

/** <data>/connector-presets.json as { version: 1, presets: [...] }, written atomically. */
export class ConnectorPresetStore {
  private file: string
  private presets: UserConnectorDef[] = []

  constructor(dataDir: string) {
    this.file = join(dataDir, 'connector-presets.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { presets?: unknown }
      if (!Array.isArray(parsed.presets)) return
      const seen = new Set<string>()
      for (const raw of parsed.presets) {
        try {
          const def = validateUserPreset(raw)
          if (seen.has(def.id)) throw new Error('duplicate')
          seen.add(def.id)
          this.presets.push(def)
        } catch {
          console.warn('Dropped an invalid custom connector from connector-presets.json.')
        }
        if (this.presets.length >= USER_CONNECTOR_PRESETS_MAX) break
      }
    } catch (e) {
      console.error('Failed to read connector-presets.json, starting empty:', (e as Error).message)
      this.presets = []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, presets: this.presets }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /** Every preset in store order (copies). */
  list(): UserConnectorDef[] {
    return this.presets.map((p) => structuredClone(p))
  }

  get(id: string): UserConnectorDef | undefined {
    const p = this.presets.find((x) => x.id === id)
    return p ? structuredClone(p) : undefined
  }

  /** Add or replace (by id) a validated preset; returns the saved copy. */
  save(def: UserConnectorDef): UserConnectorDef {
    const clean = validateUserPreset(def)
    const idx = this.presets.findIndex((p) => p.id === clean.id)
    if (idx === -1) this.presets.push(clean)
    else this.presets[idx] = clean
    this.persist()
    return structuredClone(clean)
  }

  /** Delete one preset; false when it did not exist. */
  remove(id: string): boolean {
    const before = this.presets.length
    this.presets = this.presets.filter((p) => p.id !== id)
    if (this.presets.length === before) return false
    this.persist()
    return true
  }
}
