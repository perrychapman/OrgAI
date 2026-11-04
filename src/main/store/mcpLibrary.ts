import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpLibraryEntry } from '@shared/types'
import { MCP_PER_PROJECT_ENV_MAX } from '@shared/types'
import { perProjectEnvProblems } from '../mcp/validate'

/**
 * The app-wide MCP library (<data>/mcp-library.json): harness-level server definitions that projects link by
 * reference (McpServerSpec.libraryId). Free of secrets like projects.json: secret values and OAuth tokens live in
 * the SecretStore under mcplib:<entryId>:... keys. Validation (names, pinned versions) is McpService's job.
 */
/** Older records lack connectedAt; a malformed one (not a positive finite number, or on a non-connector) is dropped. */
function normalizeEntry(e: McpLibraryEntry): McpLibraryEntry {
  // buildDigest is main-written: a malformed value (not 64 hex chars) is dropped.
  if ('buildDigest' in e && !(typeof e.buildDigest === 'string' && /^[0-9a-f]{64}$/.test(e.buildDigest))) {
    const { buildDigest: _bd, ...r } = e
    e = r
  }
  // perProjectSecrets / perProjectEnv are user-set: junk is dropped (McpService validates the names themselves).
  if ('perProjectSecrets' in e && e.perProjectSecrets !== true) {
    const { perProjectSecrets: _p, ...r } = e
    e = r
  }
  if ('perProjectEnv' in e && !(Array.isArray(e.perProjectEnv) && e.perProjectEnv.length <= MCP_PER_PROJECT_ENV_MAX && e.perProjectEnv.every((n) => typeof n === 'string'))) {
    const { perProjectEnv: _p, ...r } = e
    e = r
  }
  // Names that would fail the per-project rules (secret slot, credential-like, run-changing, duplicate, connector) are dropped.
  if (e.connectorId) {
    const { perProjectEnv: _a, perProjectSecrets: _b, ...r } = e
    e = r
  } else if (Array.isArray(e.perProjectEnv)) {
    const kept: string[] = []
    for (const n of e.perProjectEnv) {
      if (perProjectEnvProblems({ ...e, perProjectEnv: [...kept, n] }).length === 0) kept.push(n)
    }
    if (kept.length !== e.perProjectEnv.length) {
      const { perProjectEnv: _p, ...r } = e
      e = kept.length ? { ...r, perProjectEnv: kept } : r
    }
  }
  // connectorCustom is main-written and only means something next to a connectorId.
  if ('connectorCustom' in e && !(e.connectorCustom === true && typeof e.connectorId === 'string')) {
    const { connectorCustom: _c, ...r } = e
    e = r
  }
  if (!('connectedAt' in e)) return e
  const ok = typeof e.connectedAt === 'number' && Number.isFinite(e.connectedAt) && e.connectedAt > 0 && typeof e.connectorId === 'string'
  if (ok) return e
  const { connectedAt: _drop, ...rest } = e
  return rest
}

export class McpLibraryStore {
  private file: string
  private entries: McpLibraryEntry[] = []

  constructor(dataDir: string) {
    this.file = join(dataDir, 'mcp-library.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown }
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries
            .filter((e): e is McpLibraryEntry => !!e && typeof e === 'object' && typeof (e as McpLibraryEntry).id === 'string' && typeof (e as McpLibraryEntry).name === 'string')
            .map(normalizeEntry)
        : []
    } catch (e) {
      console.error('Failed to read mcp-library.json, starting empty:', (e as Error).message)
      this.entries = []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /** Every entry, in insertion order (copies). */
  list(): McpLibraryEntry[] {
    return this.entries.map((e) => structuredClone(e))
  }

  get(id: string): McpLibraryEntry | undefined {
    const e = this.entries.find((x) => x.id === id)
    return e ? structuredClone(e) : undefined
  }

  /** Add (new id) or replace the entry with that id. Returns the saved copy. */
  save(entry: McpLibraryEntry): McpLibraryEntry {
    const copy = structuredClone(entry)
    const idx = this.entries.findIndex((e) => e.id === copy.id)
    if (idx === -1) this.entries.push(copy)
    else this.entries[idx] = copy
    this.persist()
    return structuredClone(copy)
  }

  /** Delete one entry; false when it did not exist. */
  remove(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    this.persist()
    return true
  }
}
