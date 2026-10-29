import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, Project, SetupKind } from '@shared/types'
import { newProject } from '@shared/defaults'
import { migrateProject } from '../connections/remap'

/** Simple JSON-file store. Projects are small and few, so a database is overkill for now. */
export class ProjectStore {
  private file: string
  private projects: Project[] = []

  constructor(dataDir: string) {
    this.file = join(dataDir, 'projects.json')
    this.load()
    this.migrateAll()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { projects?: Project[] }
        this.projects = Array.isArray(parsed.projects) ? parsed.projects : []
      }
    } catch (e) {
      console.error('Failed to read projects.json, starting empty:', e)
      this.projects = []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, projects: this.projects }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * Boot migration, run by the constructor: projects saved before connections existed get provider.connection
   * and Role.tier (see migrateProject). Persists only when something changed. Returns how many projects changed.
   */
  migrateAll(): number {
    let changed = 0
    this.projects = this.projects.map((p) => {
      const m = migrateProject(p)
      if (m.changed) changed++
      return m.project
    })
    if (changed) this.persist()
    return changed
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): Project | null {
    return this.projects.find((p) => p.id === id) ?? null
  }

  create(input: { name: string; path: string; brief: string; setupKind?: SetupKind }, settings?: AppSettings): Project {
    const project = newProject(input, settings)
    this.projects.push(project)
    this.persist()
    return project
  }

  save(project: Project): Project {
    const updated = { ...project, updatedAt: new Date().toISOString() }
    const idx = this.projects.findIndex((p) => p.id === project.id)
    if (idx === -1) this.projects.push(updated)
    else this.projects[idx] = updated
    this.persist()
    return updated
  }

  /**
   * Save a project the renderer sent. mcpServers and plugins change only through mcp:* / plugins:*, so a stale
   * renderer copy must not wipe them: the stored values win. A project that is new to the store keeps what it sent.
   */
  saveFromRenderer(project: Project): Project {
    const stored = this.get(project.id)
    if (!stored) return this.save(project)
    const next: Project = { ...project }
    if (stored.mcpServers !== undefined) next.mcpServers = stored.mcpServers
    else delete next.mcpServers
    if (stored.plugins !== undefined) next.plugins = stored.plugins
    else delete next.plugins
    return this.save(next)
  }

  /** Read-modify-write one stored project. Throws when it does not exist. */
  update(id: string, fn: (p: Project) => Project): Project {
    const stored = this.get(id)
    if (!stored) throw new Error('Project not found')
    return this.save(fn(structuredClone(stored)))
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }
}
