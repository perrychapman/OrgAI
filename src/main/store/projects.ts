import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, win32, type PlatformPath } from 'node:path'
import type { AppSettings, ConnectionId, Project, ProjectCreateInput, ProjectPathCheck, Role } from '@shared/types'
import { HARNESS_PROJECT_ID, PROJECT_ALLOWED_DIRECTORIES_MAX, PROJECT_ALLOWED_DIRECTORY_MAX_CHARS, isModelTier, isVirtualProjectId } from '@shared/types'
import { isSafeId, modelForTier, newProject, preferEverydayNearLimit, projectConnection, skillEvaluationOf, teamReviewOf, type TierContext } from '@shared/defaults'
import { migrateProject } from '../connections/remap'
import { validModelId } from '../connections/codexAccount'
import { isInsideEither, pathKey, samePath } from '../quick/scratch'
import { allowedDirectoryRisk } from '../runtime/allowedDirectories'
import { homedir } from 'node:os'

/** The tier mapping of a connection, for the invalid-model fallback. Default: the connection's builtin catalog only. */
export type TierContextFor = (connection: ConnectionId) => TierContext | undefined

/** Invalid model values already logged (at most INVALID_MODEL_LOG_MAX), so a value is logged once per process. */
const loggedInvalidModels = new Set<string>()
const INVALID_MODEL_LOG_MAX = 200

/** Whether a stored Role.model is acceptable: missing or empty, 'inherit', a tier name, or a valid model id. */
export function acceptableRoleModel(model: unknown): boolean {
  if (model === undefined || model === null || model === '') return true
  if (typeof model !== 'string') return false
  return model === 'inherit' || isModelTier(model) || validModelId(model)
}

/**
 * Replace every Role.model that fails acceptableRoleModel (a hand-edited projects.json or a compromised renderer could
 * store '--some-cli-flag', which would become the CLI's --model argument): the role's tier through the project's
 * connection (modelForTier), else 'inherit'. Logs once per invalid value, never echoing it. Pure apart from the log.
 */
export function sanitizeRoleModels(
  project: Project,
  tierContext?: TierContextFor,
  log: (message: string) => void = (m) => console.warn(m)
): { project: Project; changed: boolean } {
  if (!project || !Array.isArray(project.roles)) return { project, changed: false }
  let changed = false
  const roles = project.roles.map((role): Role => {
    if (!role || typeof role !== 'object' || acceptableRoleModel(role.model)) return role
    changed = true
    let connection: ConnectionId = 'anthropic'
    try {
      connection = projectConnection(project)
    } catch {
      // A malformed provider: keep the anthropic default.
    }
    const ctx = tierContext?.(connection) ?? { connection, tierModels: {} }
    const hit = isModelTier(role.tier) ? modelForTier(role.tier, ctx) : undefined
    const next: Role = { ...role }
    if (hit && validModelId(hit.model)) {
      next.model = hit.model
      next.tier = hit.tier
    } else {
      next.model = 'inherit'
      delete next.tier
    }
    const key = typeof role.model === 'string' ? role.model.slice(0, 256) : `<${typeof role.model}>`
    if (!loggedInvalidModels.has(key)) {
      if (loggedInvalidModels.size < INVALID_MODEL_LOG_MAX) loggedInvalidModels.add(key)
      const name = typeof role.name === 'string' ? role.name.replace(/[^ -~]/g, '?').slice(0, 80) : '(unnamed)'
      log(`Role "${name}" had an invalid model (not a model id); it now uses ${next.model === 'inherit' ? 'inherit' : `the ${next.tier} tier (${next.model})`}.`)
    }
    return next
  })
  return changed ? { project: { ...project, roles }, changed } : { project, changed }
}

/**
 * Keep Project.preferEverydayNearLimit and its deprecated mirror preferSonnetNearLimit in step on a renderer save: an
 * older renderer that changes only the legacy field wins; otherwise the new field (or, when neither is set, the legacy
 * one) decides. Both fields come back set to the effective value, or both unset when neither was set. Pure.
 */
export function reconcileNearLimitProject(stored: Project, incoming: Project): Project {
  const legacy = incoming.preferSonnetNearLimit
  const legacyChanged = typeof legacy === 'boolean' && legacy !== stored.preferSonnetNearLimit
  const freshChanged = incoming.preferEverydayNearLimit !== stored.preferEverydayNearLimit
  const value = legacyChanged && !freshChanged ? legacy : incoming.preferEverydayNearLimit === undefined && legacy === undefined ? undefined : preferEverydayNearLimit(incoming)
  const next = { ...incoming }
  if (value === undefined) {
    delete next.preferEverydayNearLimit
    delete next.preferSonnetNearLimit
  } else {
    next.preferEverydayNearLimit = value
    next.preferSonnetNearLimit = value
  }
  return next
}

/** The file-system calls checkProjectPath makes; node:fs by default, a fake in tests. */
export interface PathFs {
  statSync(path: string): { isDirectory(): boolean }
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
}

const nodeFs: PathFs = { statSync, existsSync, readdirSync: (path) => readdirSync(path) }

/** Trim and drop one pair of surrounding quotes (a path pasted from Explorer's "Copy as path"). */
export function cleanProjectPath(path: unknown): string {
  const t = typeof path === 'string' ? path.trim() : ''
  const m = /^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t)
  return (m ? m[1] : t).trim()
}

/** Last path segment, either separator, '' for a drive or file-system root. */
export function suggestedProjectName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  if (!trimmed || /^[a-zA-Z]:$/.test(trimmed)) return ''
  return basename(trimmed.replace(/\\/g, '/'))
}

/** What is at `path` (projects:checkPath). Never throws: anything unreadable reports exists false. */
export function checkProjectPath(path: unknown, fs: PathFs = nodeFs): ProjectPathCheck {
  const raw = cleanProjectPath(path)
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
  const path = cleanProjectPath(input.path)
  if (!path) return 'Choose a folder for the project.'
  if (!isAbsolute(path) && !/^[a-zA-Z]:[\\/]/.test(path)) return `Use a full path, for example ${process.platform === 'win32' ? 'C:\\Projects\\shop' : '/Users/you/projects/shop'}.`
  if (check.exists && !check.isDirectory) return `${path} is a file, not a folder. Choose the project's folder.`
  if (input.setupKind === 'existing' && !check.exists) return `There is no folder at ${path}. Check the path, or choose "New idea" to start in a new folder.`
  return null
}

/** Raw entries looked at by cleanAllowedDirectories before it stops (a hostile list cannot cost unbounded fs work). */
const ALLOWED_DIRECTORIES_SCAN_MAX = 200

export interface AllowedDirectoryOpts {
  /** Path flavour for the syntax checks (tests pass `path.win32` / `path.posix`). Default: the native one. */
  path?: PlatformPath
  /** True when `dir` is the data dir, inside it or contains it. Default: isInsideEither both ways (fails closed). */
  touchesData?: (dir: string) => boolean
  /** True when two accepted folders name the same place. Default: scratch.ts pathKey / samePath. */
  same?: (a: string, b: string) => boolean
  /** The project's folder: it, anything inside it and any folder containing it are dropped (allowedDirectoryRisk). */
  projectPath?: string
  /**
   * The user's home folder: home, its ancestors and the config folders under it are dropped (allowedDirectoryRisk).
   * Omitted = no home rules (pure tests); ProjectStore always passes one (os.homedir() unless overridden).
   */
  home?: string
}

/** Why an allowed-directory entry is refused on syntax alone, or null. */
function allowedDirectoryProblem(text: string, p: PlatformPath): string | null {
  if (!text) return 'empty'
  if (text.length > PROJECT_ALLOWED_DIRECTORY_MAX_CHARS) return 'too long'
  if (text.includes('\0')) return 'NUL character'
  // UNC and device paths (\\server\share, \\?\, \\.\, //host), on every platform.
  if (/^[\\/]{2}/.test(text)) return 'network share or device path'
  if (p === win32 ?!/^[a-zA-Z]:[\\/]/.test(text) : !p.isAbsolute(text)) return 'not an absolute path'
  const resolved = p.resolve(text)
  // A bare root (C:\, /, or C:\a\.. which resolves to one) would mean "everything".
  if (p.parse(resolved).root === resolved) return 'a drive or file-system root'
  return null
}

/**
 * Normalize `Project.allowedDirectories` (see its doc in shared/types.ts): strings only, trimmed, at most
 * PROJECT_ALLOWED_DIRECTORY_MAX_CHARS, absolute (win32: a drive-letter path), never a root, never UNC or device,
 * never OrgAI's data folder, a folder inside it or a folder that contains it, no duplicates (first spelling kept), at
 * most PROJECT_ALLOWED_DIRECTORIES_MAX. Each kept entry is `path.normalize`d with its trailing separator dropped.
 * Rejected entries are dropped silently (logged at debug). A non-array gives undefined. Existence is not required.
 */
export function cleanAllowedDirectories(raw: unknown, dataDir: string, opts: AllowedDirectoryOpts = {}): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const p = opts.path ?? (process.platform === 'win32' ? win32 : posix)
  const platform: NodeJS.Platform = p === win32 ? 'win32' : process.platform === 'win32' ? 'linux' : process.platform
  const touchesData =
    opts.touchesData ??
    ((dir: string): boolean => {
      try {
        return isInsideEither(dataDir, dir) || isInsideEither(dir, dataDir)
      } catch {
        return true
      }
    })
  const same =
    opts.same ??
    ((a: string, b: string): boolean => {
      if (pathKey(a) === pathKey(b)) return true
      try {
        return samePath(a, b)
      } catch {
        return false
      }
    })
  const out: string[] = []
  for (const entry of raw.slice(0, ALLOWED_DIRECTORIES_SCAN_MAX)) {
    if (out.length >= PROJECT_ALLOWED_DIRECTORIES_MAX) {
      console.debug('allowedDirectories: over the limit, dropping the rest')
      break
    }
    if (typeof entry !== 'string') {
      console.debug('allowedDirectories: dropped a non-string entry')
      continue
    }
    const text = entry.trim()
    const problem = allowedDirectoryProblem(text, p)
    if (problem) {
      console.debug(`allowedDirectories: dropped an entry (${problem})`)
      continue
    }
    let dir = p.normalize(text)
    if (dir.length > p.parse(dir).root.length) dir = dir.replace(/[\\/]+$/, '')
    if (touchesData(dir)) {
      console.debug("allowedDirectories: dropped an entry (OrgAI's data folder)")
      continue
    }
    const risk = allowedDirectoryRisk(dir, { platform, home: opts.home ?? '', ...(opts.projectPath ? { projectPath: opts.projectPath } : {}) })
    if (risk) {
      console.debug(`allowedDirectories: dropped an entry (${risk === 'project' ? 'the project folder or inside it' : 'too broad or sensitive'})`)
      continue
    }
    if (out.some((d) => same(d, dir))) continue
    out.push(dir)
  }
  return out
}

/** The project with allowedDirectories normalized (removed when it is not an array); `changed` when it differs. */
function withCleanAllowedDirectories(project: Project, dataDir: string, home: string): { project: Project; changed: boolean } {
  if (!project || typeof project !== 'object' || !('allowedDirectories' in project)) return { project, changed: false }
  const projectPath = typeof project.path === 'string' && project.path ? project.path : undefined
  const clean = cleanAllowedDirectories(project.allowedDirectories, dataDir, { home, ...(projectPath ? { projectPath } : {}) })
  const next = { ...project }
  if (clean === undefined) delete next.allowedDirectories
  else next.allowedDirectories = clean
  return { project: next, changed: JSON.stringify(clean) !== JSON.stringify(project.allowedDirectories) }
}

/** Simple JSON-file store. Projects are small and few, so a database is overkill for now. */
export class ProjectStore {
  private file: string
  private projects: Project[] = []
  private tierContext?: TierContextFor
  private dataDir: string
  private home: string

  /**
   * `opts.tierContext` gives a connection's tier mapping for the invalid-model fallback (sanitizeRoleModels).
   * `opts.home` overrides os.homedir() for the allowed-directory rules (tests).
   */
  constructor(dataDir: string, opts: { tierContext?: TierContextFor; home?: string } = {}) {
    this.tierContext = opts.tierContext
    this.dataDir = dataDir
    this.home = opts.home ?? homedir()
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
      const clean = sanitizeRoleModels(m.project, this.tierContext)
      const dirs = withCleanAllowedDirectories(clean.project, this.dataDir, this.home)
      if (m.changed || clean.changed || dirs.changed) changed++
      return dirs.project
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
  create(
    input: ProjectCreateInput,
    settings?: AppSettings,
    opts: { mockAvailable?: boolean; fs?: PathFs; prepare?: (p: Project) => Project; importRoles?: (p: Project, sources: unknown) => Project } = {}
  ): Project {
    const error = createPathError(input, checkProjectPath(input.path, opts.fs))
    if (error) throw new Error(error)
    if (input.mock && !opts.mockAvailable) throw new Error('The mock adapter is not available. Start OrgAI with ORGAI_MOCK=1 to use it.')
    let project = newProject({ name: input.name, path: cleanProjectPath(input.path), brief: input.brief, setupKind: input.setupKind }, settings)
    // Mock projects stay on the anthropic defaults and the mock adapter; others take the default connection.
    if (input.mock) project.provider = { ...project.provider, id: 'mock' }
    else if (opts.prepare) project = opts.prepare(project)
    // Imported agents replace the default chart after the connection is chosen, so their models map to it.
    if (Array.isArray(input.importAgents) && input.importAgents.length && opts.importRoles) project = opts.importRoles(project, input.importAgents)
    project = sanitizeRoleModels(project, this.tierContext).project
    this.projects.push(project)
    this.persist()
    return project
  }

  /**
   * Every save (saveFromRenderer, update) passes Role.model through sanitizeRoleModels and allowedDirectories through
   * cleanAllowedDirectories.
   */
  save(project: Project): Project {
    if (isVirtualProjectId(project?.id)) throw new Error('An assistant project (Chat, Skill assistant, harness) cannot be stored.')
    const updated = { ...withCleanAllowedDirectories(sanitizeRoleModels(project, this.tierContext).project, this.dataDir, this.home).project, updatedAt: new Date().toISOString() }
    const idx = this.projects.findIndex((p) => p.id === project.id)
    if (idx === -1) this.projects.push(updated)
    else this.projects[idx] = updated
    this.persist()
    return updated
  }

  /**
   * Save a project the renderer sent. mcpServers and plugins change only through mcp:* / plugins:*, so a stale
   * renderer copy must not wipe them: the stored values win. Unknown, unsafe and harness ids are refused:
   * projects are created through create() (projects:create) so renderer-supplied servers never land unvalidated.
   */
  saveFromRenderer(project: Project): Project {
    if (!isSafeId(project?.id)) throw new Error('Invalid project id')
    if (isVirtualProjectId(project.id)) throw new Error(project.id === HARNESS_PROJECT_ID ? 'The harness project cannot be saved' : 'An assistant project (Chat, Skill assistant) cannot be saved')
    const stored = this.get(project.id)
    if (!stored) throw new Error('Project not found')
    const next: Project = reconcileNearLimitProject(stored, { ...project })
    if (stored.mcpServers !== undefined) next.mcpServers = stored.mcpServers
    else delete next.mcpServers
    if (stored.plugins !== undefined) next.plugins = stored.plugins
    else delete next.plugins
    // Skills change only through skills:*: the stored list wins, and a role keeps only grants that exist there.
    if (stored.skills !== undefined) next.skills = stored.skills
    else delete next.skills
    const known = new Set((stored.skills ?? []).map((s) => s.id))
    if (Array.isArray(next.roles)) {
      next.roles = next.roles.map((r) => {
        if (!r || r.skills === undefined) return r
        const kept = Array.isArray(r.skills) ? [...new Set(r.skills.filter((id) => typeof id === 'string' && known.has(id)))] : []
        return { ...r, skills: kept }
      })
    }
    if (next.skillEvaluation !== undefined) next.skillEvaluation = skillEvaluationOf(next)
    if (next.teamReview !== undefined) next.teamReview = teamReviewOf(next)
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
