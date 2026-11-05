import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  FolderConfigAllowRule,
  FolderConfigCommand,
  FolderConfigEnv,
  FolderConfigFile,
  FolderConfigMcpServer,
  FolderConfigReview,
  FolderConfigState,
  FolderConfigTrust,
  FolderConfigTrustInput,
  Project,
  RepoConfigEffect
} from '@shared/types'
import { FOLDER_CONFIG_FILE_TEXT_MAX, FOLDER_CONFIG_LIST_MAX, FOLDER_CONFIG_TOTAL_TEXT_MAX, REPO_CONFIG_PATHS } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { hiddenCharIn, isCredentialArg, isKeyLikeArg, isKeyLikeValue, isSecretFlag } from '../capabilities/sanitize'
import { credentialLikeName } from '../mcp/validate'
import { isInsideEither, isNetworkPath } from '../quick/scratch'
import { parseToml } from '../setup/import/toml'
import { maskKeyLike } from './codexAppServer'
import { addRulesReport, allowRuleRefusal, readableRule, removeRule } from './permissionRules'

/**
 * Folder config trust (provider-neutral half). A project whose folder came with agent config of its own (a cloned
 * repository) starts 'untrusted': runs ignore that config until the user has read it and accepted it. Acceptance
 * binds a digest of everything in the folder that can run commands, start tools or grant permissions; any change
 * afterwards reads as 'changed' and the config stops loading again. Everything read here is untrusted data from
 * whoever wrote the folder: it is only parsed, masked and displayed, never executed.
 *
 * Projects stored before this feature have no folderConfigTrust field and stay 'none' (no gate, as before). That is
 * deliberate: a legacy project's folder was chosen by its owner before OrgAI cloned foreign repositories.
 */

const MAX_DEPTH = 12
const MAX_ENTRIES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const CHUNK = 64 * 1024
/** Largest settings / MCP / hooks file OrgAI parses for review; a bigger one is unreviewable. */
const STRUCTURED_MAX = 256 * 1024
/** Bytes kept in memory per file (the review shows at most this much) and for all files together. */
const RETAIN_PER_FILE = STRUCTURED_MAX
const RETAIN_TOTAL = 8 * 1024 * 1024
const FIELD_MAX = 4000
const MASK = '[masked]'
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex')
const DIGEST_RE = /^[0-9a-f]{64}$/

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const
const STRUCTURED = new Set<string>([...SETTINGS_FILES, '.codex/hooks.json', '.mcp.json', '.codex/config.toml'])
const LOCAL_RULES_FILE = '.claude/settings.local.json'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined
}

// ---------- Presence ----------

/**
 * The REPO_CONFIG_PATHS present in `root`, in table order. Only lstat; a link on the way counts as present and is
 * never followed. A segment that cannot be read for any reason but "not there" (ENOENT, ENOTDIR) counts as present
 * (fail closed).
 */
export function presentConfigPaths(root: string): string[] {
  const out: string[] = []
  if (typeof root !== 'string' || !root || isNetworkPath(root)) return out
  for (const { path } of REPO_CONFIG_PATHS) {
    const parts = path.split('/')
    let cur = root
    let found = true
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i])
      try {
        const st = lstatSync(cur)
        if (st.isSymbolicLink()) break
      } catch (e) {
        const c = codeOf(e)
        if (c === 'ENOENT' || c === 'ENOTDIR') found = false
        break
      }
    }
    if (found) out.push(path)
  }
  return out
}

/** The gate a new project starts with: a code project whose folder holds anything from REPO_CONFIG_PATHS is 'untrusted'. */
export function initialFolderConfigTrust(project: { path: string; kind?: unknown }): FolderConfigTrust | undefined {
  if (projectKindOf(project) === 'engagement') return undefined
  return presentConfigPaths(project.path).length > 0 ? { state: 'untrusted' } : undefined
}

// ---------- Scan ----------

interface Entry {
  rel: string
  kind: 'file' | 'link' | 'other' | 'dir'
  size: number
  hash: string
  effect: RepoConfigEffect
  digested: boolean
  linkTarget?: string
  buf?: Buffer
}

class Stop extends Error {}

interface Scan {
  root: string
  entries: Entry[]
  lines: string[]
  count: number
  bytes: number
  retained: number
  realSeen: Set<string>
  seenRel: Set<string>
  unreviewable?: string
}

export interface FolderConfigScan {
  /** Lowercase sha256 hex of what the digest binds. */
  digest: string
  unreviewable?: string
  /** @internal */
  entries: Entry[]
}

function note(s: Scan, reason: string): void {
  if (!s.unreviewable) s.unreviewable = reason
}

function add(s: Scan, e: Entry, line?: string): void {
  if (++s.count > MAX_ENTRIES) {
    note(s, `This folder's config has more than ${MAX_ENTRIES.toLocaleString('en-US')} files.`)
    throw new Stop()
  }
  s.entries.push(e)
  if (e.digested) s.lines.push(line ?? `${e.rel}\0${e.kind}\0${e.hash}\n`)
}

function readChunked(s: Scan, abs: string, rel: string, keep: number): { hash: string; size: number; buf?: Buffer } {
  let fd: number | undefined
  try {
    fd = openSync(abs, 'r')
    const h = createHash('sha256')
    const chunk = Buffer.alloc(CHUNK)
    const kept: Buffer[] = []
    let keptLen = 0
    let size = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null)
      if (n <= 0) break
      size += n
      s.bytes += n
      if (s.bytes > MAX_BYTES) {
        note(s, `This folder's config is larger than ${MAX_BYTES / (1024 * 1024)} MB.`)
        throw new Stop()
      }
      h.update(chunk.subarray(0, n))
      if (keptLen < keep) {
        const take = Math.min(n, keep - keptLen)
        kept.push(Buffer.from(chunk.subarray(0, take)))
        keptLen += take
      }
    }
    return { hash: h.digest('hex'), size, ...(keptLen ? { buf: Buffer.concat(kept) } : {}) }
  } catch (e) {
    if (e instanceof Stop) throw e
    note(s, `Could not read ${rel}.`)
    throw new Stop()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** How many bytes of a file to keep: all structured files up to their cap, others while the shared budget lasts. */
function keepFor(s: Scan, rel: string, size: number): number {
  if (STRUCTURED.has(rel)) return Math.min(size, STRUCTURED_MAX)
  const room = Math.max(0, RETAIN_TOTAL - s.retained)
  return Math.min(size, RETAIN_PER_FILE, room)
}

function addFile(s: Scan, abs: string, rel: string, size: number, effect: RepoConfigEffect, digested: boolean): void {
  if (STRUCTURED.has(rel) && size > STRUCTURED_MAX) note(s, `${rel} is larger than ${STRUCTURED_MAX / 1024} KB, too large to review.`)
  if (digested) {
    const r = readChunked(s, abs, rel, keepFor(s, rel, size))
    if (r.buf) s.retained += r.buf.length
    add(s, { rel, kind: 'file', size: r.size, hash: r.hash, effect, digested, ...(r.buf ? { buf: r.buf } : {}) })
    return
  }
  // Listing only: read the head for display, never hashed.
  const keep = keepFor(s, rel, size)
  let buf: Buffer | undefined
  if (keep > 0) {
    let fd: number | undefined
    try {
      fd = openSync(abs, 'r')
      const b = Buffer.alloc(keep)
      const n = readSync(fd, b, 0, keep, 0)
      buf = b.subarray(0, n)
      s.retained += n
    } catch {
      buf = undefined
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* nothing to do */
        }
      }
    }
  }
  add(s, { rel, kind: 'file', size, hash: '', effect, digested: false, ...(buf ? { buf } : {}) })
}

function visit(s: Scan, abs: string, rel: string, depth: number, effect: RepoConfigEffect, digested: boolean): void {
  if (s.seenRel.has(rel)) return
  s.seenRel.add(rel)
  if (depth > MAX_DEPTH) {
    note(s, `${rel} is nested deeper than ${MAX_DEPTH} folders.`)
    throw new Stop()
  }
  let st
  try {
    st = lstatSync(abs)
  } catch (e) {
    const c = codeOf(e)
    if (c === 'ENOENT' || c === 'ENOTDIR') return
    note(s, `Could not read ${rel}.`)
    throw new Stop()
  }
  if (st.isSymbolicLink()) {
    visitLink(s, abs, rel, depth, effect, digested)
    return
  }
  if (st.isFile()) {
    addFile(s, abs, rel, st.size, effect, digested)
    return
  }
  if (st.isDirectory()) {
    add(s, { rel, kind: 'dir', size: 0, hash: EMPTY_DIGEST, effect, digested })
    let names: string[]
    try {
      names = readdirSync(abs).sort()
    } catch {
      note(s, `Could not read ${rel}.`)
      throw new Stop()
    }
    for (const name of names) visit(s, join(abs, name), `${rel}/${name}`, depth + 1, effect, digested)
    return
  }
  // FIFO, socket, device: never opened (a FIFO would block), hashed by kind only.
  add(s, { rel, kind: 'other', size: 0, hash: EMPTY_DIGEST, effect, digested })
}

function visitLink(s: Scan, abs: string, rel: string, depth: number, effect: RepoConfigEffect, digested: boolean): void {
  let target: string
  try {
    target = readlinkSync(abs)
  } catch {
    note(s, `Could not read ${rel}.`)
    throw new Stop()
  }
  add(s, { rel, kind: 'link', size: 0, hash: sha256(target), effect, digested, linkTarget: target.slice(0, 1000) })
  if (!digested) return
  // Resolving a network path would open a connection: decide on the spelling alone.
  if (isNetworkPath(target) || isNetworkPath(resolve(dirname(abs), target))) {
    note(s, `${rel} links outside the project folder.`)
    return
  }
  let real: string
  try {
    real = realpathSync.native(abs)
  } catch {
    note(s, `${rel} is a broken link.`)
    return
  }
  if (isNetworkPath(real) || !isInsideEither(s.root, real)) {
    note(s, `${rel} links outside the project folder.`)
    return
  }
  let st
  try {
    st = lstatSync(real)
  } catch {
    note(s, `${rel} is a broken link.`)
    return
  }
  if (st.isDirectory()) {
    if (s.realSeen.has(real)) return
    s.realSeen.add(real)
    if (depth + 1 > MAX_DEPTH) {
      note(s, `${rel} is nested deeper than ${MAX_DEPTH} folders.`)
      throw new Stop()
    }
    let names: string[]
    try {
      names = readdirSync(real).sort()
    } catch {
      note(s, `Could not read ${rel}.`)
      throw new Stop()
    }
    for (const name of names) visit(s, join(real, name), `${rel}/${name}`, depth + 1, effect, digested)
  } else if (st.isFile()) {
    const r = readChunked(s, real, rel, 0)
    s.lines.push(`${rel}\0target-file\0${r.hash}\n`)
  } else {
    s.lines.push(`${rel}\0target-other\0${EMPTY_DIGEST}\n`)
  }
}

function inDigestScope(path: string, effect: RepoConfigEffect): boolean {
  return effect !== 'instructions' && path !== '.orgai/org.json'
}

/**
 * Read the folder's agent config once: the digest and everything the review shows. Never throws. See the header of
 * this file for the scope; instruction files and .orgai/org.json are listed but not digested.
 */
export function scanFolderConfig(root: string): FolderConfigScan {
  const s: Scan = { root, entries: [], lines: [], count: 0, bytes: 0, retained: 0, realSeen: new Set(), seenRel: new Set() }
  if (typeof root !== 'string' || !root || isNetworkPath(root)) {
    return { digest: EMPTY_DIGEST, unreviewable: 'The project folder is on the network, so its config cannot be reviewed.', entries: [] }
  }
  try {
    for (const { path, effect } of REPO_CONFIG_PATHS) {
      const digested = inDigestScope(path, effect)
      const parts = path.split('/')
      let cur = root
      let rel = ''
      for (let i = 0; i < parts.length; i++) {
        cur = join(cur, parts[i])
        rel = rel ? `${rel}/${parts[i]}` : parts[i]
        let st
        try {
          st = lstatSync(cur)
        } catch (e) {
          const c = codeOf(e)
          if (c === 'ENOENT' || c === 'ENOTDIR') break
          note(s, `Could not read ${rel}.`)
          throw new Stop()
        }
        if (st.isSymbolicLink() || i === parts.length - 1) {
          visit(s, cur, rel, i, effect, digested)
          break
        }
      }
    }
    // A structured file that is not a plain file cannot be read for review.
    for (const e of s.entries) {
      if (STRUCTURED.has(e.rel) && e.kind !== 'file') note(s, `${e.rel} is not a plain file, so its content cannot be reviewed.`)
    }
  } catch (e) {
    if (!(e instanceof Stop)) note(s, 'The folder\'s config could not be read.')
  }
  const lines = [...s.lines].sort()
  const digest = lines.length ? sha256(lines.join('')) : EMPTY_DIGEST
  return { digest, ...(s.unreviewable ? { unreviewable: s.unreviewable } : {}), entries: s.entries }
}

// ---------- State ----------

type GateProject = Pick<Project, 'path' | 'kind' | 'folderConfigTrust'>

export function folderConfigStateOf(project: GateProject, scan?: FolderConfigScan): FolderConfigState {
  const t = project.folderConfigTrust as unknown
  if (t === undefined) return 'none'
  if (!t || typeof t !== 'object') return 'untrusted'
  const rec = t as { state?: unknown; digest?: unknown }
  if (rec.state !== 'trusted') return 'untrusted'
  if (typeof rec.digest !== 'string' || !DIGEST_RE.test(rec.digest)) return 'changed'
  try {
    const s = scan ?? scanFolderConfig(project.path)
    return !s.unreviewable && s.digest === rec.digest ? 'trusted' : 'changed'
  } catch {
    return 'changed'
  }
}

/** True when the folder's own config may load right now: no gate, or accepted and unchanged. A broken scan is false. */
export function folderConfigLoadsNow(project: GateProject): boolean {
  try {
    const state = folderConfigStateOf(project)
    return state === 'none' || state === 'trusted'
  } catch {
    return false
  }
}

/** The rebuilt record, undefined stays undefined; anything else present that is not a valid record becomes untrusted. */
export function cleanFolderConfigTrust(v: unknown): FolderConfigTrust | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { state: 'untrusted' }
  const r = v as Record<string, unknown>
  if (r.state !== 'trusted' && r.state !== 'untrusted') return { state: 'untrusted' }
  const importedRules = Array.isArray(r.importedRules)
    ? [...new Set(r.importedRules.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1000))].slice(0, 1000)
    : undefined
  const decidedAt = typeof r.decidedAt === 'string' && r.decidedAt.length <= 40 && !Number.isNaN(Date.parse(r.decidedAt)) ? r.decidedAt : undefined
  const digest = typeof r.digest === 'string' && DIGEST_RE.test(r.digest) ? r.digest : undefined
  const out: FolderConfigTrust = { state: r.state === 'trusted' && digest ? 'trusted' : 'untrusted' }
  if (out.state === 'trusted') out.digest = digest
  if (decidedAt) out.decidedAt = decidedAt
  if (importedRules && importedRules.length) out.importedRules = importedRules
  return out
}

/** The one-sentence run warning for a gated folder, or '' for states that load. */
export function folderConfigWarning(state: FolderConfigState, paths: readonly string[]): string {
  if (state !== 'untrusted' && state !== 'changed') return ''
  const known = new Set(REPO_CONFIG_PATHS.map((p) => p.path))
  const list = paths.filter((p) => known.has(p))
  const shown = list.slice(0, 6).join(', ')
  const more = list.length > 6 ? `, and ${list.length - 6} more` : ''
  const files = list.length ? `: ${shown}${more}` : ''
  return state === 'changed'
    ? `This folder's agent config changed since you accepted it, so it was not loaded${files}. Review it again in Project settings to use it.`
    : `This folder's own agent config was not loaded${files}. Review it in Project settings to use it.`
}

// ---------- Masking ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clip(s: string): string {
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}…` : s
}

function secretLooking(name: string, value: string): boolean {
  return credentialLikeName(name, true) || isKeyLikeValue(value) || maskKeyLike(value) !== value
}

const VALUE_PARENTS = new Set(['env', 'headers', 'http_headers', 'environment', 'env_http_headers'])

/** A display string: URL userinfo and key-like fragments masked. */
function maskString(v: string): string {
  return maskKeyLike(v.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s?#]*@/gi, `$1${MASK}@`))
}

function maskJson(v: unknown, key: string | undefined, parent: string | undefined, depth: number): unknown {
  if (typeof v === 'string') {
    if (parent && VALUE_PARENTS.has(parent.toLowerCase()) && key !== undefined && credentialLikeName(key, true)) return MASK
    if (isKeyLikeValue(v)) return MASK
    return maskString(v)
  }
  if (depth > 50) return '[too deep]'
  // An args list: a value after a secret flag, or a credential-looking argument, is masked like an MCP target's.
  if (Array.isArray(v) && key === 'args' && v.every((x) => typeof x === 'string')) return maskedArgs(v as string[])
  if (Array.isArray(v)) return v.map((x) => maskJson(x, undefined, key, depth + 1))
  if (isObj(v)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [k, x] of Object.entries(v)) out[k] = maskJson(x, k, key, depth + 1)
    return out
  }
  return v
}

function maskLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let out = line
      const m = /^(\s*[\w."'-]{1,80}\s*[=:]\s*)(.+)$/.exec(line)
      if (m && credentialLikeName(m[1].replace(/[\s=:"']/g, ''), true) && /\S/.test(m[2])) return m[1] + MASK
      if (/^\s*args\s*=\s*\[/.test(out)) {
        // A TOML args array: mask the way an MCP target does (the value after a secret flag, credential-looking items).
        let maskNext = false
        out = out.replace(/"((?:[^"\\\n]|\\.)*)"/g, (all, inner: string) => {
          if (maskNext) {
            maskNext = false
            return `"${MASK}"`
          }
          if (isSecretFlag(inner)) {
            maskNext = true
            return all
          }
          return isKeyLikeArg(inner) || isCredentialArg(inner) ? `"${MASK}"` : all
        })
      }
      out = out.replace(/"([^"\n]{8,})"|'([^'\n]{8,})'/g, (all, a?: string, b?: string) => (isKeyLikeValue(a ?? b ?? '') ? `"${MASK}"` : all))
      return maskString(out)
    })
    .join('\n')
}

function decode(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined
  return buf.toString('utf8').replace(/^﻿/, '')
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------- Review extraction ----------

interface Collected {
  commands: FolderConfigCommand[]
  env: FolderConfigEnv[]
  allowRules: FolderConfigAllowRule[]
  mcpServers: FolderConfigMcpServer[]
}

const HELPER_KEYS = ['apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'gcpAuthRefresh', 'otelHeadersHelper'] as const

function handlerText(h: unknown): string {
  if (isObj(h) && typeof h.command === 'string') return h.command
  try {
    return JSON.stringify(h) ?? ''
  } catch {
    return ''
  }
}

function pushCommand(out: Collected, source: string, kind: 'hook' | 'helper', label: string, command: string): void {
  const hidden = hiddenCharIn(`${label}\n${command}`, { multiline: true })
  out.commands.push({ source, kind, label: clip(label), command: clip(maskString(command)), ...(hidden ? { hiddenChar: hidden } : {}) })
}

function collectHooks(out: Collected, source: string, hooks: unknown): void {
  if (!isObj(hooks)) return
  for (const [event, groups] of Object.entries(hooks)) {
    const list = Array.isArray(groups) ? groups : [groups]
    for (const g of list) {
      const matcher = isObj(g) && typeof g.matcher === 'string' && g.matcher ? ` ${g.matcher}` : ''
      const label = `${event.slice(0, 100)}${matcher.slice(0, 101)}`
      if (isObj(g) && Array.isArray(g.hooks)) for (const h of g.hooks) pushCommand(out, source, 'hook', label, handlerText(h))
      else pushCommand(out, source, 'hook', label, handlerText(g))
    }
  }
}

function collectEnv(out: Collected, source: string, env: unknown): void {
  if (!isObj(env)) return
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? ''
    const masked = secretLooking(name, value)
    const hidden = hiddenCharIn(name) ?? hiddenCharIn(value)
    out.env.push({ source, name: clip(name), value: masked ? MASK : clip(value), masked, ...(hidden ? { hiddenChar: hidden } : {}) })
  }
}

function collectSettings(out: Collected, source: string, v: unknown): void {
  if (!isObj(v)) return
  collectHooks(out, source, v.hooks)
  for (const k of HELPER_KEYS) if (v[k] !== undefined) pushCommand(out, source, 'helper', k, handlerText(typeof v[k] === 'string' ? { command: v[k] } : v[k]))
  for (const k of ['statusLine', 'fileSuggestion'] as const) if (v[k] !== undefined) pushCommand(out, source, 'helper', k, handlerText(v[k]))
  collectEnv(out, source, v.env)
  const allow = isObj(v.permissions) ? v.permissions.allow : undefined
  if (Array.isArray(allow)) {
    for (const r of allow) {
      if (typeof r !== 'string') continue
      const hidden = hiddenCharIn(r)
      const refused = allowRuleRefusal(r.trim()) ?? (hidden ? `The rule contains a hidden character (${hidden}).` : null)
      out.allowRules.push({ source, rule: clip(r), ...(refused ? { refused } : {}), ...(hidden ? { hiddenChar: hidden } : {}) })
    }
  }
}

function quoteArg(a: string): string {
  return a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a
}

function maskUrl(url: string): string {
  let u = url.replace(/(:\/\/)[^/@\s?#]*@/, `$1${MASK}@`)
  u = u.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (all, sep: string, k: string, val: string) => (secretLooking(k, val) ? `${sep}${k}=${MASK}` : all))
  return maskKeyLike(u)
}

function maskedArgs(args: string[]): string[] {
  const out: string[] = []
  let maskNext = false
  for (const a of args) {
    if (maskNext) {
      out.push(MASK)
      maskNext = false
      continue
    }
    if (isSecretFlag(a)) {
      out.push(a)
      maskNext = true
      continue
    }
    if (isKeyLikeArg(a) || isCredentialArg(a)) {
      const eq = /^(-{1,2}[\w.-]{1,60})=/.exec(a)
      out.push(eq ? `${eq[1]}=${MASK}` : MASK)
      continue
    }
    out.push(maskString(a))
  }
  return out
}

function pairsOf(v: unknown): Array<[string, string]> {
  if (!isObj(v)) return []
  return Object.entries(v)
    .map(([k, x]): [string, string] => [k, typeof x === 'string' ? x : JSON.stringify(x) ?? ''])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function mcpTarget(spec: Record<string, unknown>): string {
  const url = typeof spec.url === 'string' ? spec.url : undefined
  if (url !== undefined) {
    const headers = pairsOf(spec.headers ?? spec.http_headers)
    return [maskUrl(url), ...headers.map(([k, v]) => `-H ${JSON.stringify(`${k}: ${secretLooking(k, v) ? MASK : v}`)}`)].join(' ')
  }
  const env = pairsOf(spec.env)
  const args = Array.isArray(spec.args) ? spec.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? '')) : []
  const command = typeof spec.command === 'string' ? spec.command : ''
  return [...env.map(([k, v]) => `${k}=${secretLooking(k, v) ? MASK : quoteArg(v)}`), quoteArg(maskKeyLike(command)), ...maskedArgs(args).map(quoteArg)].join(' ')
}

function collectMcp(out: Collected, source: string, servers: unknown): void {
  if (!isObj(servers)) return
  for (const [name, raw] of Object.entries(servers)) {
    const spec = isObj(raw) ? raw : {}
    const target = isObj(raw) ? mcpTarget(spec) : JSON.stringify(raw) ?? ''
    // Hidden characters are judged on the raw values, not the masked display.
    const parts = [name, typeof spec.command === 'string' ? spec.command : '', typeof spec.url === 'string' ? spec.url : '', ...(Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : [])]
    const hidden = parts.map((p) => hiddenCharIn(p)).find(Boolean) ?? null
    out.mcpServers.push({ source, name: clip(name), target: clip(target), ...(hidden ? { hiddenChar: hidden } : {}) })
  }
}

function emptyCollected(): Collected {
  return { commands: [], env: [], allowRules: [], mcpServers: [] }
}

function collectFrom(out: Collected, rel: string, text: string): void {
  if (rel === '.codex/config.toml') {
    const t = parseToml(text)
    if (!t.error) collectMcp(out, rel, t.data.mcp_servers)
    return
  }
  const v = parseJsonObject(text)
  if (v === undefined) return
  if (rel === '.mcp.json') collectMcp(out, rel, isObj(v) ? v.mcpServers : undefined)
  else if (rel === '.codex/hooks.json') collectHooks(out, rel, isObj(v) && isObj(v.hooks) ? v.hooks : v)
  else collectSettings(out, rel, v)
}

function cap<T>(list: T[], flag: { truncated: boolean }): T[] {
  if (list.length <= FOLDER_CONFIG_LIST_MAX) return list
  flag.truncated = true
  return list.slice(0, FOLDER_CONFIG_LIST_MAX)
}

/** What accepting would approve, read from disk now. A 'none' project still lists its content. */
export function folderConfigReview(project: Pick<Project, 'id' | 'path' | 'kind' | 'folderConfigTrust'>): FolderConfigReview {
  const scan = scanFolderConfig(project.path)
  const state = folderConfigStateOf(project, scan)
  const flag = { truncated: false }
  const out = emptyCollected()
  const files: FolderConfigFile[] = []
  let total = 0
  for (const e of scan.entries) {
    if (e.kind === 'dir') continue
    const f: FolderConfigFile = { path: e.rel, effect: e.effect, kind: e.kind, sizeBytes: e.size, digested: e.digested }
    if (e.kind === 'link') f.linkTarget = e.linkTarget
    if (e.kind === 'file' && e.buf) {
      const raw = decode(e.buf)
      if (raw !== undefined) {
        const hidden = hiddenCharIn(raw, { multiline: true })
        if (hidden) f.hiddenChar = hidden
        if (STRUCTURED.has(e.rel) && e.size <= STRUCTURED_MAX) collectFrom(out, e.rel, raw)
        const json = e.rel.endsWith('.json') ? parseJsonObject(raw) : undefined
        let shown = json !== undefined ? JSON.stringify(maskJson(json, undefined, undefined, 0), null, 2) : maskLines(raw.slice(0, FOLDER_CONFIG_FILE_TEXT_MAX + 1))
        if (e.size > e.buf.length) f.truncated = true
        if (shown.length > FOLDER_CONFIG_FILE_TEXT_MAX) {
          shown = shown.slice(0, FOLDER_CONFIG_FILE_TEXT_MAX)
          f.truncated = true
        }
        if (total + shown.length > FOLDER_CONFIG_TOTAL_TEXT_MAX) {
          f.truncated = true
          flag.truncated = true
        } else {
          total += shown.length
          f.text = shown
        }
      }
    } else if (e.kind === 'file' && e.size > 0) {
      f.truncated = true
    }
    files.push(f)
  }
  return {
    projectId: project.id,
    state,
    digest: scan.digest,
    files: cap(files, flag),
    commands: cap(out.commands, flag),
    env: cap(out.env, flag),
    allowRules: cap(out.allowRules, flag),
    mcpServers: cap(out.mcpServers, flag),
    truncated: flag.truncated,
    ...(scan.unreviewable ? { unreviewable: scan.unreviewable } : {})
  }
}

// ---------- Apply ----------

function localRulesOf(scan: FolderConfigScan): string[] {
  const e = scan.entries.find((x) => x.rel === LOCAL_RULES_FILE && x.kind === 'file' && x.buf)
  const text = e?.buf ? decode(e.buf) : undefined
  if (text === undefined) return []
  const v = parseJsonObject(text)
  const allow = isObj(v) && isObj(v.permissions) ? v.permissions.allow : undefined
  if (!Array.isArray(allow)) return []
  return [...new Set(allow.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean))].filter(readableRule)
}

/**
 * The project after the user's decision (the caller saves it). Refuses with a readable sentence: no gate ('none'), a
 * missing or malformed digest, a digest that no longer matches the folder, or trust on an unreviewable config.
 * Accepting copies the readable rules of the folder's settings.local.json into `deps.rulesFile` (never ones already
 * imported: a rule the user removed later stays removed); revoking removes the rules it imported.
 */
export function applyFolderConfigTrust(
  project: Project,
  input: Pick<FolderConfigTrustInput, 'trust' | 'digest'>,
  deps: { rulesFile: string; now?: () => string }
): Project {
  const stored = project.folderConfigTrust
  if (stored === undefined) throw new Error('This project has no folder config to review.')
  const decidedAt = (deps.now ?? (() => new Date().toISOString()))()
  const previous = cleanFolderConfigTrust(stored)?.importedRules ?? []
  if (input.trust !== true) {
    // Revoking never needs a digest: it only removes trust.
    for (const rule of previous) {
      try {
        removeRule({ file: deps.rulesFile }, rule)
      } catch {
        /* an unreadable rules file: the trust still ends */
      }
    }
    return { ...project, folderConfigTrust: { state: 'untrusted', decidedAt, importedRules: [] } }
  }
  if (typeof input.digest !== 'string' || !DIGEST_RE.test(input.digest)) throw new Error("Review this folder's config first.")
  const scan = scanFolderConfig(project.path)
  if (scan.unreviewable) throw new Error(scan.unreviewable)
  if (scan.digest !== input.digest) throw new Error("This folder's config changed since you reviewed it. Review it again.")
  const fresh = localRulesOf(scan).filter((r) => !previous.includes(r))
  const { added } = fresh.length ? addRulesReport({ file: deps.rulesFile }, fresh) : { added: [] as string[] }
  const importedRules = [...new Set([...previous, ...added])].slice(0, 1000)
  return { ...project, folderConfigTrust: { state: 'trusted', digest: scan.digest, decidedAt, importedRules } }
}
