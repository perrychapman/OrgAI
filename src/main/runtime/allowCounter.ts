import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { PermissionSuggestion } from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { atomicWrite, ensurePlainDir, projectDataDir, readPlain } from '../store/projectData'
import { allowRuleStrings, deriveSuggestions } from './permissionRules'

/**
 * UI overhaul "You have allowed this N times" (PermissionRequest.priorAllows): a per-project count of the "Allow once"
 * answers the user gave on the desktop, per rule-matching key. The key is the one the card's own "always allow" offer is
 * made of: the allow rules a call is matched by (permissionRules.ts: `Bash(npm test:*)`, `Edit(//dir/**)`, `Read`, an
 * MCP tool), taken from the request's own suggestions (chooseSuggestions, which the adapter built with the right
 * free-folder options) and, when it has none, derived with deriveSuggestions. A call no rule can cover has no key and is
 * never counted (its count is unknown, not 0).
 *
 * The file lives in OrgAI's own per-project data folder (<data>/projects/<projectId>/allow-counts.json, next to
 * permission-rules.json of engagements and removed with the project), never in the project's folder: a code project's
 * saved rules sit in its repository, and a counter has no business there. Bounded (ALLOW_COUNT_KEYS_MAX keys, least
 * recently allowed dropped; counts capped at ALLOW_COUNT_MAX), written atomically, and rebuilt field by field on every
 * read (a damaged or hand-edited file reads as what is valid in it). Structured-clone safe: plain numbers and strings.
 * The file stores the SHA-256 of each key, never the key (commands and paths can be private); only equality is needed.
 */

/** Most keys kept per project; past it the least recently allowed key is dropped. */
export const ALLOW_COUNT_KEYS_MAX = 500
/** A count never goes above this. */
export const ALLOW_COUNT_MAX = 9999
/** A key longer than this is never counted (and one this long in the file is dropped on read). */
export const ALLOW_COUNT_KEY_MAX_CHARS = 400
/** The largest counter file read; a bigger one is treated as damaged (an empty counter). */
const FILE_MAX_BYTES = 512 * 1024

/** `<data>/projects/<projectId>/allow-counts.json`. Throws on an unsafe project id. */
export function allowCountFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'allow-counts.json')
}

/**
 * The key a call is counted under, or null when no rule covers it (so nothing is counted and nothing is claimed). Never
 * the raw command: only the rule the card would offer, so `npm test` and `npm test -- --watch` share `Bash(npm test:*)`.
 */
export function allowCountKey(toolName: string, input: unknown, suggestions?: readonly PermissionSuggestion[]): string | null {
  if (typeof toolName !== 'string' || !toolName) return null
  let rules = suggestions?.length ? allowRuleStrings([...suggestions]) : []
  if (!rules.length) {
    try {
      rules = allowRuleStrings(deriveSuggestions(toolName, input))
    } catch {
      return null
    }
  }
  if (!rules.length) return null
  const key = [...rules].sort().join(' | ')
  return key.length <= ALLOW_COUNT_KEY_MAX_CHARS ? key : null
}

/**
 * What the file stores for a key: its SHA-256 (lower-case hex). A key is a rule built from a command or a path
 * (`Bash(npm run deploy --token ...:*)`, `Edit(//home/me/secret-project/**)`), and the file only ever needs to say "this
 * same key again", so the plain text is not kept on disk (security review L1).
 */
export function allowCountHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

const HASH_RE = /^[0-9a-f]{64}$/

/** One stored entry from an untrusted file (`v` 2: key is a hash; version 1: the plain key, hashed here), or null. */
function cleanEntry(v: unknown, plain: boolean): [string, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const [key, count] = v as [unknown, unknown]
  if (typeof key !== 'string' || !key) return null
  if (plain ? key.length > ALLOW_COUNT_KEY_MAX_CHARS : !HASH_RE.test(key)) return null
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return null
  return [plain ? allowCountHash(key) : key, Math.min(ALLOW_COUNT_MAX, Math.floor(count))]
}

function writeCounts(dataDir: string, projectId: string, counts: Map<string, number>): void {
  const dir = projectDataDir(dataDir, projectId)
  ensurePlainDir(dataDir, projectId, dir)
  atomicWrite(allowCountFile(dataDir, projectId), JSON.stringify({ v: 2, entries: [...counts] }) + '\n')
}

/**
 * The project's counts keyed by allowCountHash(key), least recently allowed first (a Map keeps that order). A missing,
 * oversized, linked or damaged file, an unsafe project id and every invalid entry read as nothing. Duplicate keys keep the
 * later entry; past ALLOW_COUNT_KEYS_MAX the oldest are dropped. A version 1 file (plain keys, written before L1) is read
 * by hashing its keys and rewritten as version 2 at once, so the plain text leaves the disk (a failed rewrite keeps the
 * counts in memory and leaves the old file for the next try). Never throws.
 */
export function readAllowCounts(dataDir: string, projectId: string): Map<string, number> {
  const out = new Map<string, number>()
  try {
    if (!dataDir || !isSafeId(projectId)) return out
    const file = readPlain(allowCountFile(dataDir, projectId), FILE_MAX_BYTES)
    if (!file) return out
    const parsed = JSON.parse(file.text) as unknown
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { entries?: unknown; v?: unknown }) : undefined
    const entries = obj?.entries
    if (!obj || !Array.isArray(entries)) return out
    const plain = obj.v !== 2
    for (const raw of entries) {
      const e = cleanEntry(raw, plain)
      if (!e) continue
      out.delete(e[0])
      out.set(e[0], e[1])
    }
    while (out.size > ALLOW_COUNT_KEYS_MAX) out.delete(out.keys().next().value as string)
    if (plain) {
      try {
        writeCounts(dataDir, projectId, out)
      } catch {
        /* the next bump rewrites it */
      }
    }
  } catch {
    return new Map()
  }
  return out
}

/** How many times the project's user allowed `key` once; undefined when it has no record (unknown, never 0 by guess). */
export function allowCountOf(dataDir: string, projectId: string, key: string): number | undefined {
  return readAllowCounts(dataDir, projectId).get(allowCountHash(key))
}

/**
 * Count one more allow of `key` (it becomes the most recently allowed) and save the file atomically. Returns the new
 * count, or undefined when nothing was saved (unsafe id, a key that cannot be counted, an unwritable folder): a counter
 * never gets in the way of a decision.
 */
export function bumpAllowCount(dataDir: string, projectId: string, key: string): number | undefined {
  try {
    if (!dataDir || !isSafeId(projectId) || !key || key.length > ALLOW_COUNT_KEY_MAX_CHARS) return undefined
    const counts = readAllowCounts(dataDir, projectId)
    const hash = allowCountHash(key)
    const next = Math.min(ALLOW_COUNT_MAX, (counts.get(hash) ?? 0) + 1)
    counts.delete(hash)
    counts.set(hash, next)
    while (counts.size > ALLOW_COUNT_KEYS_MAX) counts.delete(counts.keys().next().value as string)
    writeCounts(dataDir, projectId, counts)
    return next
  } catch {
    return undefined
  }
}
