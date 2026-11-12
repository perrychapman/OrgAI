/**
 * Switching Codex's built-in multi-agent tools off at launch through a model catalog override.
 *
 * Why: Codex's model catalog (`codex debug models`) marks most models `multi_agent_version: "v2"`. For those models Codex
 * offers its own spawn_agent / send_message / followup_task / wait_agent / list_agents next to OrgAI's spawn_report and
 * adds a developer message `<multi_agent_mode>` ("Do not spawn sub-agents unless the user ... explicitly ask[s] ...").
 * Leads applied that rule to spawn_report and refused to delegate. `features.multi_agent(_v2)=false` does not remove them
 * for v2 models; `-c model_catalog_json="<file>"` with the installed catalog and the field set to "v1" does (checked at a
 * local stub with codex 0.166.0 app-server and 0.167.0 exec on 2026-11-10: no native tool, no `<multi_agent_role>` or
 * `<multi_agent_mode>` message, spawn_report / message_agent / list_team still offered, same reasoning effort). With
 * "v1", `features.multi_agent=false` (NATIVE_AGENT_CONFIG, always passed) keeps the v1 tools off, which also covers a
 * model id the catalog does not know (Codex falls back to v1 metadata).
 *
 * The override replaces the whole catalog, so the file is the catalog this Codex would use (same binary, same
 * CODEX_HOME, same provider lines) with that one field changed. Setting model_catalog_json at all changes one more
 * thing: for a model id the catalog does not know (a proxy's own ids), Codex's fallback base instructions gain a
 * "Planning" / `update_plan` section (about 3.8 KB; seen at the stub with the unmodified catalog as well). So the
 * override is applied only when every model id the run names is in the catalog ('skipped' otherwise); an unknown id
 * gets no native tools anyway with features.multi_agent=false. It is written into OrgAI's own CODEX_HOME, never the
 * user's ~/.codex, and cached by the binary's identity, the provider lines and Codex's own models_cache.json, so an
 * unchanged Codex reuses the file (one stat per launch). Everything here fails open: a missing command, a timeout, an
 * unparseable catalog or a failed write launch Codex exactly as before (the caller logs one warning) and OrgAI keeps
 * relying on its prompt notice and the native-item strikes in codex.ts.
 *
 * Electron-free; relative imports only.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { trackChildProcess } from '../host/shutdown'
import type { CodexBinary } from './codexBinary'

/** The value every multi-agent model is set to. "v1" is a value Codex's own catalog ships (gpt-5.6-luna, codex-auto-review). */
export const NATIVE_OFF_MULTI_AGENT_VERSION = 'v1'
/** The catalog field. If a Codex update renames it, the transform finds nothing to change and no override is written. */
export const MULTI_AGENT_FIELD = 'multi_agent_version'
/** `codex debug models` budget. It measured 40-120 ms (bundled catalog); a ChatGPT login may refresh over the network. */
export const CATALOG_DUMP_TIMEOUT_MS = 4_000
/** Largest catalog accepted (0.166.0's is about 0.75 MB). */
export const CATALOG_MAX_BYTES = 32 * 1024 * 1024
/** A written catalog older than this is regenerated, so a refreshed remote catalog (ChatGPT login) is picked up. */
export const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** Written catalogs of other keys older than this are deleted (a running app-server may still read a recent one). */
export const CATALOG_STALE_DELETE_MS = 24 * 60 * 60 * 1000
export const CATALOG_FILE_PREFIX = 'orgai-model-catalog-'
/** Codex's own cache of the refreshed remote catalog inside CODEX_HOME (0.166.0). Part of the cache key when present. */
export const CODEX_MODELS_CACHE_FILE = 'models_cache.json'

// ---------- the transformation (pure) ----------

export type CatalogTransform =
  /** The catalog with every multi-agent model set to v1; `changed` names the model slugs, `slugs` every model's. */
  | { kind: 'override'; json: string; changed: string[]; slugs: string[] }
  /** Nothing to change (no model offers native multi-agent tools): no override is needed. */
  | { kind: 'unchanged'; slugs: string[] }
  /** Not the shape this code knows: no override. */
  | { kind: 'unexpected'; reason: string }

function hasUnsafeInteger(v: unknown, depth = 0): boolean {
  if (depth > 64) return true
  if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v)
  if (Array.isArray(v)) return v.some((x) => hasUnsafeInteger(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).some((x) => hasUnsafeInteger(x, depth + 1))
  return false
}

/**
 * `codex debug models` output -> the same catalog with `multi_agent_version` set to "v1" on every model whose value is a
 * string other than "v1" (today "v2"). Entries without the field, with null or with "v1" are left alone (verified: they
 * offer no native tools with features.multi_agent=false). Every other field and the key order are kept: the text is
 * parsed and re-serialised, which keeps every value's meaning; an integer JavaScript cannot hold exactly makes the shape
 * unexpected rather than risk a changed number. Unexpected: not JSON, not an object with a `models` array, or a model
 * that is not an object.
 */
export function catalogWithoutNativeAgents(text: string): CatalogTransform {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unexpected', reason: 'the catalog is not JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unexpected', reason: 'the catalog is not a JSON object' }
  const models = (parsed as Record<string, unknown>).models
  if (!Array.isArray(models)) return { kind: 'unexpected', reason: 'the catalog has no models list' }
  if (models.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) return { kind: 'unexpected', reason: 'a catalog model is not an object' }
  if (hasUnsafeInteger(parsed)) return { kind: 'unexpected', reason: 'the catalog holds an integer too large to copy exactly' }
  const changed: string[] = []
  for (const m of models as Record<string, unknown>[]) {
    const v = m[MULTI_AGENT_FIELD]
    if (typeof v === 'string' && v !== NATIVE_OFF_MULTI_AGENT_VERSION) {
      m[MULTI_AGENT_FIELD] = NATIVE_OFF_MULTI_AGENT_VERSION
      changed.push(typeof m.slug === 'string' ? m.slug : '?')
    }
  }
  const slugs = slugsOf(models as Record<string, unknown>[])
  if (!changed.length) return { kind: 'unchanged', slugs }
  return { kind: 'override', json: JSON.stringify(parsed), changed, slugs }
}

function slugsOf(models: Record<string, unknown>[]): string[] {
  return models.flatMap((m) => (typeof m.slug === 'string' ? [m.slug] : []))
}

/** The `-c` entry that points Codex at a catalog file (a TOML basic string; JSON escaping is valid TOML here). */
export function modelCatalogEntry(path: string): string {
  return `model_catalog_json=${JSON.stringify(path)}`
}

/** The `-c` lines that choose the model provider; `debug models` gets the same ones so it sees the same catalog. */
export function providerConfigLines(config: readonly string[]): string[] {
  return config.filter((c) => /^model_provider(?:s\.|=)/.test(c))
}

// ---------- producing and caching the file ----------

/** Runs `<binary> debug models [-c ...]` and answers its stdout; rejects on a failed, oversized or timed-out run. */
export type CatalogDumpRunner = (binary: CodexBinary, args: string[], env: Record<string, string | undefined>, timeoutMs: number) => Promise<string>

export const defaultCatalogDumpRunner: CatalogDumpRunner = (binary, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    // Absolute path, no shell, a neutral cwd: nothing is read from a project folder.
    const child = execFile(binary.path, args, { timeout: timeoutMs, maxBuffer: CATALOG_MAX_BYTES, windowsHide: true, cwd: tmpdir(), env }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout ?? ''))
    )
    const untrack = trackChildProcess(child, 'codex debug models')
    child.once('error', untrack)
    child.once('close', untrack)
  })

/** The file system calls this module makes (tests inject failures). */
export interface CatalogFs {
  stat(path: string): { size: number; mtimeMs: number } | undefined
  realpath(path: string): string
  mkdir(path: string): void
  read(path: string): string
  write(path: string, text: string): void
  rename(from: string, to: string): void
  list(dir: string): string[]
  remove(path: string): void
}

export const nodeCatalogFs: CatalogFs = {
  stat: (p) => {
    try {
      const s = statSync(p)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  },
  mkdir: (p) => void mkdirSync(p, { recursive: true, mode: 0o700 }),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, t) => writeFileSync(p, t, { mode: 0o600 }),
  rename: (a, b) => renameSync(a, b),
  list: (d) => readdirSync(d),
  remove: (p) => unlinkSync(p)
}

export interface NativeCatalogInput {
  binary: CodexBinary
  /** The app-server's environment (scrubbed, PATH set): the dump runs with exactly this. */
  env: Record<string, string | undefined>
  /** The app-server's `-c` lines; only the provider lines are passed to the dump. */
  config: readonly string[]
  /**
   * The model ids this run names (roles, tier mapping, a completion's model). Any id the catalog does not know skips the
   * override (see the header). Empty: Codex's default model, which comes from the catalog.
   */
  models?: readonly string[]
  /**
   * The Codex home OrgAI assigns for its connections (codexHomeDir(dataDir)). The file is written only when
   * env.CODEX_HOME resolves to this path: an inherited CODEX_HOME (the user's own ~/.codex) never gets one. Missing:
   * no override.
   */
  expectedHome?: string
  run?: CatalogDumpRunner
  fs?: CatalogFs
  now?: () => number
  timeoutMs?: number
}

export type NativeCatalogResult =
  /** `config` holds the model_catalog_json entry; `cached` when an earlier file was reused. */
  | { status: 'written' | 'cached'; config: string[]; path: string; ms: number }
  /** No model offers native tools: nothing to override. */
  | { status: 'unchanged'; config: []; ms: number }
  /** The run names a model id the catalog does not know: no override (it would change that model's base instructions). */
  | { status: 'skipped'; config: []; reason: string; ms: number }
  /** Failed open: launch as before. `reason` is secret-free. */
  | { status: 'failed'; config: []; reason: string; ms: number }

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Generations in flight in this process, by pre-dump key (concurrent launches share one dump). */
const inflight = new Map<string, Promise<NativeCatalogResult>>()
/** Model slugs of each written catalog file, so a cached launch can check the run's models without parsing the file again. */
const slugsByFile = new Map<string, Set<string>>()
const SLUGS_BY_FILE_MAX = 16
/** Keys whose catalog had nothing to change (no file is written for them): not dumped again in this process. */
const unchangedKeys = new Set<string>()
/** Catalog files Codex refused (rejectNativeCatalog): never offered again in this process. */
const rejectedFiles = new Set<string>()

/** Forget the in-process memory (tests: a new process validates files again and has rejected none). */
export function clearNativeCatalogMemory(): void {
  slugsByFile.clear()
  unchangedKeys.clear()
  rejectedFiles.clear()
}

/**
 * Codex refused this catalog (a start with model_catalog_json failed with a configuration or catalog error and the
 * same start without it succeeded, see catalogStartFailure): never offered again in this process. The file is NOT
 * deleted: another app-server of this process may have been launched with it and reads it again on thread/start
 * ("failed to load configuration: No such file or directory" otherwise). A later process validates it again
 * (validCatalogSlugs) and the sweep removes it once it is stale.
 */
export function rejectNativeCatalog(path: string): void {
  rejectedFiles.add(path)
}

/** Whether rejectNativeCatalog rejected this file in this process. */
export function isNativeCatalogRejected(path: string): boolean {
  return rejectedFiles.has(path)
}

/**
 * Why an app-server start with the catalog override in effect failed, judged from its error text (message plus the
 * stderr tail). Conservative: unknown text is 'other' (not the catalog's, not known to be transient).
 * - 'transient': Codex's own state raced another app-server starting in the same CODEX_HOME. "failed to initialize
 *   sqlite state runtime" was seen at the lab stub (codex 0.166.0 and 0.167.0, exit 1 during initialize, 2026-11-10);
 *   "database is locked" / SQLITE_BUSY are SQLite's own busy texts (not seen from Codex: unverified).
 * - 'catalog': the text names the catalog option ("failed to parse model_catalog_json ... missing field", the real
 *   0.166.0 app-server with a broken catalog at the stub) or a configuration load or parse failure ("failed to load
 *   configuration: No such file or directory", 0.166.0/0.167.0 at the stub once the file was gone).
 * A transient match wins over a catalog match.
 */
export function catalogStartFailure(text: string): 'transient' | 'catalog' | 'other' {
  if (/failed to initialize sqlite state|database is locked|SQLITE_BUSY/i.test(text)) return 'transient'
  if (/model_catalog_json|failed to (?:load|parse) (?:the )?config(?:uration)?\b/i.test(text)) return 'catalog'
  return 'other'
}

/**
 * The model slugs of a catalog file when it has the shape catalogWithoutNativeAgents writes (an object with a `models`
 * array of objects, no multi_agent_version string other than "v1"); undefined for anything else.
 */
export function validCatalogSlugs(text: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const models = (parsed as Record<string, unknown>).models
  if (!Array.isArray(models) || !models.length) return undefined
  if (models.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) return undefined
  const list = models as Record<string, unknown>[]
  if (list.some((m) => typeof m[MULTI_AGENT_FIELD] === 'string' && m[MULTI_AGENT_FIELD] !== NATIVE_OFF_MULTI_AGENT_VERSION)) return undefined
  return slugsOf(list)
}

/** Same folder by resolved path (realpath when it exists; case-insensitive on Windows). */
function samePath(a: string, b: string, fs: CatalogFs): boolean {
  const norm = (p: string): string => {
    const r = resolve(fs.realpath(resolve(p)))
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function rememberSlugs(file: string, slugs: readonly string[]): Set<string> {
  if (slugsByFile.size >= SLUGS_BY_FILE_MAX) slugsByFile.clear()
  const set = new Set(slugs)
  slugsByFile.set(file, set)
  return set
}

/** The applied result for a run, or 'skipped' when it names a model the catalog does not know. */
function gate(r: NativeCatalogResult, models: readonly string[], slugs: () => Set<string> | undefined, t0: number): NativeCatalogResult {
  if (r.status !== 'written' && r.status !== 'cached') return r
  const wanted = [...new Set(models.filter((m) => typeof m === 'string' && m.length > 0))]
  if (!wanted.length) return r
  const known = slugs()
  if (!known) return { status: 'failed', config: [], reason: 'the written catalog could not be read back', ms: Date.now() - t0 }
  const unknown = wanted.filter((m) => !known.has(m))
  if (!unknown.length) return r
  return { status: 'skipped', config: [], reason: `Codex's catalog does not know ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ' and more' : ''}`, ms: Date.now() - t0 }
}

/**
 * The `-c` entries that switch Codex's built-in multi-agent tools off for this binary and CODEX_HOME, generating the
 * catalog file once per key. Never throws.
 */
export async function nativeAgentsCatalogConfig(input: NativeCatalogInput): Promise<NativeCatalogResult> {
  const t0 = Date.now()
  const fs = input.fs ?? nodeCatalogFs
  const now = input.now ?? Date.now
  const fail = (reason: string): NativeCatalogResult => ({ status: 'failed', config: [], reason, ms: Date.now() - t0 })
  try {
    const home = input.env.CODEX_HOME?.trim()
    // Never write into the user's own ~/.codex: only OrgAI's own Codex home gets a catalog file.
    if (!home) return fail('no OrgAI Codex home (CODEX_HOME) is set')
    if (!input.expectedHome?.trim()) return fail("OrgAI's Codex home is not known to the adapter")
    if (!samePath(home, input.expectedHome, fs)) return fail("CODEX_HOME is not OrgAI's own Codex home")
    const real = fs.realpath(input.binary.path)
    const st = fs.stat(real)
    if (!st) return fail(`${input.binary.path} was not found`)
    const providers = providerConfigLines(input.config)
    const keyOf = (): string => {
      const cache = fs.stat(join(home, CODEX_MODELS_CACHE_FILE))
      return sha([real, st.size, st.mtimeMs, providers.join('\n'), cache ? `${cache.size}:${cache.mtimeMs}` : 'none'].join('\0'))
    }
    const fileOf = (key: string): string => join(home, `${CATALOG_FILE_PREFIX}${key}.json`)
    const cachedFor = (key: string): string | undefined => {
      const f = fileOf(key)
      const s = fs.stat(f)
      return s && s.size > 0 && now() - s.mtimeMs < CATALOG_MAX_AGE_MS ? f : undefined
    }
    const models = input.models ?? []
    /** The slugs of a file this process wrote or validated; a file not seen yet is parsed and checked once. */
    const validated = (file: string): Set<string> | undefined => {
      const known = slugsByFile.get(file)
      if (known) return known
      try {
        const slugs = validCatalogSlugs(fs.read(file))
        return slugs ? rememberSlugs(file, slugs) : undefined
      } catch {
        return undefined
      }
    }
    const finish = (r: NativeCatalogResult): NativeCatalogResult => {
      if ((r.status === 'written' || r.status === 'cached') && rejectedFiles.has(r.path)) return fail('Codex did not start with this catalog earlier in this process')
      return gate({ ...r, ms: Date.now() - t0 } as NativeCatalogResult, models, r.status === 'written' || r.status === 'cached' ? () => validated(r.path) : () => undefined, t0)
    }
    const before = keyOf()
    const hit = cachedFor(before)
    if (rejectedFiles.has(fileOf(before))) return fail('Codex did not start with this catalog earlier in this process')
    // A file on disk is reused only once it parses to the shape this module writes (a truncated or edited one is regenerated).
    if (hit && validated(hit)) return finish({ status: 'cached', config: [modelCatalogEntry(hit)], path: hit, ms: 0 })
    if (unchangedKeys.has(before)) return { status: 'unchanged', config: [], ms: Date.now() - t0 }
    const running = inflight.get(before)
    if (running) return finish(await running)
    const job = (async (): Promise<NativeCatalogResult> => {
      let out: string
      try {
        out = await (input.run ?? defaultCatalogDumpRunner)(input.binary, ['debug', 'models', ...providers.flatMap((c) => ['-c', c])], input.env, input.timeoutMs ?? CATALOG_DUMP_TIMEOUT_MS)
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { killed?: boolean }
        // The code only (ENOENT, an exit code): the message would carry the command line and stderr.
        return fail(err?.killed ? 'codex debug models timed out' : `codex debug models failed (${String(err?.code ?? 'no exit code').slice(0, 40)})`)
      }
      const t = catalogWithoutNativeAgents(out)
      if (t.kind === 'unexpected') return fail(`codex debug models printed an unexpected catalog: ${t.reason}`)
      if (t.kind === 'unchanged') {
        if (unchangedKeys.size >= SLUGS_BY_FILE_MAX) unchangedKeys.clear()
        unchangedKeys.add(before)
        return { status: 'unchanged', config: [], ms: Date.now() - t0 }
      }
      // The dump may have refreshed Codex's own models cache: name the file after the state it reflects now.
      const key = keyOf()
      const file = fileOf(key)
      try {
        fs.mkdir(home)
        const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
        fs.write(tmp, t.json)
        fs.rename(tmp, file)
      } catch (e) {
        return fail(`the catalog could not be written (${String((e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? e).slice(0, 80)})`)
      }
      rememberSlugs(file, t.slugs)
      sweep(fs, home, file, now())
      return { status: 'written', config: [modelCatalogEntry(file)], path: file, ms: Date.now() - t0 }
    })()
    inflight.set(before, job)
    try {
      return finish(await job)
    } finally {
      inflight.delete(before)
    }
  } catch (e) {
    return fail(`unexpected error (${String((e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? 'unknown').slice(0, 40)})`)
  }
}

/** Delete written catalogs (and leftover temp files) of other keys that are old enough not to be in use. Best effort. */
function sweep(fs: CatalogFs, home: string, keep: string, now: number): void {
  try {
    for (const name of fs.list(home)) {
      if (!name.startsWith(CATALOG_FILE_PREFIX)) continue
      const p = join(home, name)
      if (p === keep) continue
      const s = fs.stat(p)
      if (s && now - s.mtimeMs > CATALOG_STALE_DELETE_MS) fs.remove(p)
    }
  } catch {
    // best effort
  }
}
