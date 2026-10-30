import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpLibraryEntry } from '@shared/types'

/**
 * The app-wide MCP library (<data>/mcp-library.json): harness-level server definitions that projects link by
 * reference (McpServerSpec.libraryId). Free of secrets like projects.json: secret values and OAuth tokens live in
 * the SecretStore under mcplib:<entryId>:... keys. Validation (names, pinned versions) is McpService's job.
 */
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
        ? parsed.entries.filter((e): e is McpLibraryEntry => !!e && typeof e === 'object' && typeof (e as McpLibraryEntry).id === 'string' && typeof (e as McpLibraryEntry).name === 'string')
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
