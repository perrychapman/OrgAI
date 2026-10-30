import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillLibraryEntry } from '@shared/types'
import { isSafeId } from '@shared/defaults'

/**
 * The app-wide skill library index (<data>/skill-library.json): entries only. The files live under
 * <data>/skills/<entryId>/ and are managed by SkillService. Projects link entries by reference (SkillSpec.libraryId).
 */
export class SkillLibraryStore {
  private file: string
  private entries: SkillLibraryEntry[] = []

  constructor(dataDir: string) {
    this.file = join(dataDir, 'skill-library.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown }
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter((e): e is SkillLibraryEntry => !!e && typeof e === 'object' && isSafeId((e as SkillLibraryEntry).id) && typeof (e as SkillLibraryEntry).name === 'string')
        : []
    } catch (e) {
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
    return this.entries.map((e) => structuredClone(e))
  }

  get(id: string): SkillLibraryEntry | undefined {
    const e = this.entries.find((x) => x.id === id)
    return e ? structuredClone(e) : undefined
  }

  /** Add (new id) or replace the entry with that id. Returns the saved copy. */
  save(entry: SkillLibraryEntry): SkillLibraryEntry {
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
