import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppSettings, Project, ProjectCreateInput, ProjectPathCheck } from '@shared/types'
import { newProject } from '@shared/defaults'
import { migrateProject } from '../connections/remap'

/** The file-system calls checkProjectPath makes; node:fs by default, a fake in tests. */
export interface PathFs {
  statSync(path: string): { isDirectory(): boolean }
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
}

const nodeFs: PathFs = { statSync, existsSync, readdirSync: (path) => readdirSync(path) }

/** Last path segment, either separator, '' for a drive or file-system root. */
export function suggestedProjectName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  if (!trimmed || /^[a-zA-Z]:$/.test(trimmed)) return ''
  return basename(trimmed.replace(/\\/g, '/'))
}

/** What is at `path` (projects:checkPath). Never throws: anything unreadable reports exists false. */
export function checkProjectPath(path: unknown, fs: PathFs = nodeFs): ProjectPathCheck {
  const raw = typeof path === 'string' ? path.trim() : ''
  const none: ProjectPathCheck = { exists: false, isDirectory: false, isGitRepo: false, suggestedName: suggestedProjectName(raw), empty: false }
  if (!raw) return none
  try {
    const isDirectory = fs.statSync(raw).isDirectory()
    if (!isDirectory) return { ...none, exists: true }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(raw)
    } catch {
      // Unlistable (permissions): it exists, but say nothing about its contents.
      return { ...none, exists: true, isDirectory: true }
    }
    const isGitRepo = entries.includes('.git') || fs.existsSync(join(raw, '.git'))
    return { ...none, exists: true, isDirectory: true, isGitRepo, empty: entries.length === 0 }
  } catch {
    return none
  }
}

/**
 * Why projects:create must refuse this input, or null. A path must be given and must not be a file; an
 * existing-repository project needs a folder that exists. A new idea may name a folder that does not exist yet.
 */
export function createPathError(input: Pick<ProjectCreateInput, 'path' | 'setupKind'>, check: ProjectPathCheck): string | null {
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (!path) return 'Choose a folder for the project.'
  if (check.exists && !check.isDirectory) return `${path} is a file, not a folder. Choose the project's folder.`
  if (input.setupKind === 'existing' && !check.exists) return `There is no folder at ${path}. Check the path, or choose "New idea" to start in a new folder.`
  return null
}

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

  /**
   * Validates the path (createPathError) and throws its message. `mock` needs `opts.mockAvailable` (the mock
   * adapter is registered); it sets provider.id 'mock' so every run of the project is token-free.
   */
  create(input: ProjectCreateInput, settings?: AppSettings, opts: { mockAvailable?: boolean; fs?: PathFs } = {}): Project {
    const error = createPathError(input, checkProjectPath(input.path, opts.fs))
    if (error) throw new Error(error)
    if (input.mock && !opts.mockAvailable) throw new Error('The mock adapter is not available. Start OrgAI with ORGAI_MOCK=1 to use it.')
    const project = newProject({ name: input.name, path: input.path.trim(), brief: input.brief, setupKind: input.setupKind }, settings)
    if (input.mock) project.provider = { ...project.provider, id: 'mock' }
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
