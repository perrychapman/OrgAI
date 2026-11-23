import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SyncedFile, storeSyncFor, type StoreSync } from './shared/storeSync'
import type { SkillLibraryEntry } from '@shared/types'
import { isSafeId } from '@shared/defaults'

/**
 * The app-wide skill library index (<data>/skill-library.json): entries only. The files live under
 * <data>/skills/<entryId>/ and are managed by SkillService. Projects link entries by reference (SkillSpec.libraryId).
 */
export class SkillLibraryStore {
  private file: string
  private entries: SkillLibraryEntry[] = []
  /** Keeps the file correct when several orgai sessions share the data folder (store/shared/storeSync.ts). */
  private synced: SyncedFile

  constructor(dataDir: string, opts: { sync?: StoreSync } = {}) {
    this.file = join(dataDir, 'skill-library.json')
    this.synced = new SyncedFile(this.file, opts.sync ?? storeSyncFor(dataDir), (first) => this.load(first))
  }

  private load(first: boolean): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown }
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter((e): e is SkillLibraryEntry => !!e && typeof e === 'object' && isSafeId((e as SkillLibraryEntry).id) && typeof (e as SkillLibraryEntry).name === 'string')
        : []
    } catch (e) {
      if (!first) {
        console.error('Failed to read skill-library.json again, keeping the entries in memory:', (e as Error).message)
        return
      }
      console.error('Failed to read skill-library.json, starting empty:', (e as Error).message)
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
  list(): SkillLibraryEntry[] {
    this.synced.fresh()
    return this.entries.map((e) => structuredClone(e))
  }

  get(id: string): SkillLibraryEntry | undefined {
    this.synced.fresh()
    const e = this.entries.find((x) => x.id === id)
    return e ? structuredClone(e) : undefined
  }

  /** Add (new id) or replace the entry with that id. Returns the saved copy. */
  save(entry: SkillLibraryEntry): SkillLibraryEntry {
    const copy = structuredClone(entry)
    this.synced.change(() => {
      const idx = this.entries.findIndex((e) => e.id === copy.id)
      if (idx === -1) this.entries.push(copy)
      else this.entries[idx] = copy
      this.persist()
    })
    return structuredClone(copy)
  }

  /** Delete one entry; false when it did not exist. */
  remove(id: string): boolean {
    return this.synced.change(() => {
      const before = this.entries.length
      this.entries = this.entries.filter((e) => e.id !== id)
      if (this.entries.length === before) return false
      this.persist()
      return true
    })
  }
}
