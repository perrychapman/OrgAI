/**
 * vault.json and secrets.json as files (docs/design/cli-standalone.md 5.2, 5.5 "Legacy file states"): the one load
 * validator (shared with readVaultMetadata, so doctor and the store never disagree about 'corrupt'), serialisation, and
 * the legacy file's three states. Pure apart from the reads; never decrypts. Every map is a null-prototype object, so a
 * key such as `__proto__` is an ordinary key. Electron-free; relative imports only.
 */
import { VAULT_CUSTODY_SCHEMES, type VaultCustodyScheme } from '../../shared/types'
import { nodeVaultFs, errorCode, type VaultFs } from './durableFs'
import {
  VAULT_FORMAT,
  VAULT_IV_BYTES,
  VAULT_TAG_BYTES,
  type VaultCipherText,
  type VaultCustody,
  type VaultEntry,
  type VaultFile,
  type VaultLegacyRetired,
  type VaultTombstone
} from './vaultTypes'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const VAULT_ID_RE = /^[0-9a-f]{32}$/
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** A null-prototype record. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** A secret key the vault can hold: non-empty, no NUL (the AAD separator). */
export function validSecretKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && !key.includes('\u0000')
}

function b64Bytes(v: unknown): number | undefined {
  if (typeof v !== 'string' || !B64.test(v)) return undefined
  return Buffer.from(v, 'base64').length
}

function cipherText(v: unknown): VaultCipherText | undefined {
  if (!isRecord(v)) return undefined
  if (b64Bytes(v.iv) !== VAULT_IV_BYTES || b64Bytes(v.tag) !== VAULT_TAG_BYTES) return undefined
  const ct = b64Bytes(v.ct)
  if (ct === undefined) return undefined
  return { iv: v.iv as string, ct: v.ct as string, tag: v.tag as string }
}

const epoch = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function custody(v: unknown): VaultCustody | undefined {
  if (!isRecord(v) || !VAULT_CUSTODY_SCHEMES.includes(v.scheme as VaultCustodyScheme)) return undefined
  const out: VaultCustody = { scheme: v.scheme as VaultCustodyScheme }
  if (v.wrapped !== undefined) {
    if (b64Bytes(v.wrapped) === undefined || v.wrapped === '') return undefined
    out.wrapped = v.wrapped as string
  }
  if (v.keyFile !== undefined) {
    if (typeof v.keyFile !== 'string' || v.keyFile === '' || v.keyFile.includes('\u0000')) return undefined
    out.keyFile = v.keyFile
  }
  if (out.scheme === 'dpapi-user' && out.wrapped === undefined) return undefined
  return out
}

function tombstone(v: unknown): VaultTombstone | undefined {
  if (!isRecord(v) || !epoch(v.at) || (v.by !== 'vault' && v.by !== 'legacy')) return undefined
  const out: VaultTombstone = { at: v.at, by: v.by }
  if (v.prev !== undefined) {
    const prev = cipherText(v.prev)
    if (!prev) return undefined
    out.prev = prev
  }
  if (v.prevLegacy !== undefined) {
    if (typeof v.prevLegacy !== 'string' || v.prevLegacy === '') return undefined
    out.prevLegacy = v.prevLegacy
  }
  if (v.legacyHash !== undefined) {
    if (typeof v.legacyHash !== 'string' || !HEX64.test(v.legacyHash)) return undefined
    out.legacyHash = v.legacyHash
  }
  return out
}

function hashMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined
  const out = dict<string>()
  for (const [k, h] of Object.entries(v)) {
    if (!validSecretKey(k) || typeof h !== 'string' || !HEX64.test(h)) return undefined
    out[k] = h
  }
  return out
}

function retired(v: unknown): VaultLegacyRetired | null | undefined {
  if (v === null) return null
  if (!isRecord(v) || !epoch(v.at) || typeof v.digest !== 'string' || !HEX64.test(v.digest)) return undefined
  const keys = hashMap(v.keys)
  if (!keys) return undefined
  return { at: v.at, digest: v.digest, keys }
}

/**
 * Validate a parsed vault.json (5.2 "Validation on load"): known format and scheme, a 32-hex vault id, exact iv and tag
 * lengths and base64 shape everywhere, `check` present, every map well formed. Anything else is undefined ('corrupt').
 * Unknown top-level fields are ignored.
 */
export function validateVaultFile(v: unknown): VaultFile | undefined {
  if (!isRecord(v) || v.format !== VAULT_FORMAT || typeof v.vaultId !== 'string' || !VAULT_ID_RE.test(v.vaultId)) return undefined
  const c = custody(v.custody)
  const check = cipherText(v.check)
  if (!c || !check || !isRecord(v.entries) || !isRecord(v.tombstones)) return undefined
  const entries = dict<VaultEntry>()
  for (const [k, e] of Object.entries(v.entries)) {
    const ct = cipherText(e)
    if (!validSecretKey(k) || !ct || !isRecord(e) || !epoch(e.at) || typeof e.lc !== 'boolean') return undefined
    entries[k] = { ...ct, at: e.at, lc: e.lc }
  }
  const tombstones = dict<VaultTombstone>()
  for (const [k, t] of Object.entries(v.tombstones)) {
    const tomb = tombstone(t)
    if (!validSecretKey(k) || !tomb) return undefined
    tombstones[k] = tomb
  }
  const legacy = hashMap(v.legacy)
  const legacyRetired = retired(v.legacyRetired)
  if (!legacy || legacyRetired === undefined) return undefined
  return { format: VAULT_FORMAT, vaultId: v.vaultId, custody: c, check, entries, tombstones, legacy, legacyRetired }
}

/** Parse and validate vault.json text; undefined = 'corrupt'. */
export function parseVaultFile(text: string): VaultFile | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  return validateVaultFile(v)
}

/** A deep copy with null-prototype maps (plans mutate copies, never the live vault). */
export function cloneVault(v: VaultFile): VaultFile {
  const entries = dict<VaultEntry>()
  for (const [k, e] of Object.entries(v.entries)) entries[k] = { ...e }
  const tombstones = dict<VaultTombstone>()
  for (const [k, t] of Object.entries(v.tombstones)) tombstones[k] = { ...t, ...(t.prev ? { prev: { ...t.prev } } : {}) }
  const legacy = dict<string>()
  for (const [k, h] of Object.entries(v.legacy)) legacy[k] = h
  let legacyRetired: VaultLegacyRetired | null = null
  if (v.legacyRetired) {
    const keys = dict<string>()
    for (const [k, h] of Object.entries(v.legacyRetired.keys)) keys[k] = h
    legacyRetired = { at: v.legacyRetired.at, digest: v.legacyRetired.digest, keys }
  }
  return { format: v.format, vaultId: v.vaultId, custody: { ...v.custody }, check: { ...v.check }, entries, tombstones, legacy, legacyRetired }
}

/** vault.json bytes (stable key order of the format; values are ciphertext and hashes only). */
export function serializeVaultFile(v: VaultFile): string {
  const out = {
    format: v.format,
    vaultId: v.vaultId,
    custody: v.custody,
    check: v.check,
    entries: v.entries,
    tombstones: v.tombstones,
    legacy: v.legacy,
    legacyRetired: v.legacyRetired
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * How a read error of vault.json or secrets.json counts: ENOENT is no file; EISDIR (a directory in its place) is damage;
 * anything else (EIO, EACCES, EBUSY, EPERM: a network home, an antivirus lock) is an I/O failure that may pass, never
 * damage (review round 2): the store reports it with its code and reads again, and reset refuses rather than moving a
 * healthy file aside.
 */
function readErrorKind(e: unknown): 'missing' | 'damaged' | 'io' {
  const code = errorCode(e)
  if (code === 'ENOENT') return 'missing'
  if (code === 'EISDIR') return 'damaged'
  return 'io'
}

/** The errno code of an I/O read failure, for the store's sentence ('EIO' when the error carries none). */
function ioCode(e: unknown): string {
  return errorCode(e) ?? 'EIO'
}

/**
 * A vault.json read: absent (no file), corrupt (does not parse or validate, or a directory in its place), unreadable (an
 * I/O error: not known to be damaged), or the vault.
 */
export type VaultRead = { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'unreadable'; code: string } | { kind: 'vault'; vault: VaultFile }

/**
 * Read `<dataDir>/vault.json`. An I/O error is 'unreadable' with its code, or rethrown with `strictIo` (the store's
 * in-process recovery and secrets:reset, where a transient I/O error must not pass for a damaged or missing file).
 */
export function readVaultFile(path: string, f: VaultFs = nodeVaultFs, strictIo = false): VaultRead {
  let text: string
  try {
    text = f.readFileSync(path).toString('utf8')
  } catch (e) {
    const kind = readErrorKind(e)
    if (kind === 'missing') return { kind: 'absent' }
    if (kind === 'damaged') return { kind: 'corrupt' }
    if (strictIo) throw e
    return { kind: 'unreadable', code: ioCode(e) }
  }
  const vault = parseVaultFile(text)
  return vault ? { kind: 'vault', vault } : { kind: 'corrupt' }
}

/**
 * secrets.json as read (5.5 Legacy file states). `bytes` is the exact file content, for the retirement digest.
 * 'unreadable' is an I/O error (not one of the three file states): the store handles it like 'corrupt' (never written,
 * no reconcile rows) but reads it again, and reset refuses instead of moving it aside (review round 2).
 */
export type LegacyRead =
  | { state: 'ok'; values: Record<string, string>; bytes: Buffer }
  | { state: 'missing' }
  | { state: 'corrupt' }
  | { state: 'unreadable'; code: string }

/**
 * Read secrets.json: 'ok' when it parses and `secrets` is an object (non-string values are ignored, as the older app
 * does), 'missing' when there is no file, 'corrupt' when it does not parse (never rewritten by a host of this wave),
 * 'unreadable' on an I/O error. `strictIo` rethrows an I/O error instead.
 */
export function readLegacyFile(path: string, f: VaultFs = nodeVaultFs, strictIo = false): LegacyRead {
  let bytes: Buffer
  try {
    bytes = f.readFileSync(path)
  } catch (e) {
    const kind = readErrorKind(e)
    if (kind === 'missing') return { state: 'missing' }
    if (kind === 'damaged') return { state: 'corrupt' }
    if (strictIo) throw e
    return { state: 'unreadable', code: ioCode(e) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { state: 'corrupt' }
  }
  if (!isRecord(parsed) || !isRecord(parsed.secrets)) return { state: 'corrupt' }
  const values = dict<string>()
  for (const [k, v] of Object.entries(parsed.secrets)) if (typeof v === 'string' && validSecretKey(k)) values[k] = v
  return { state: 'ok', values, bytes }
}

/** secrets.json bytes in the older app's shape (`{ version: 1, secrets }`). */
export function serializeLegacyFile(values: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, secrets: values }, null, 2), 'utf8')
}
