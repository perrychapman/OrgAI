import { isAbsolute } from 'node:path'
import { AGENT_IMPORT_SOURCE_LABELS, isAgentImportSource, isVirtualProjectId } from '@shared/types'
import type {
  AgentImportApplyInput,
  AgentImportApplyResult,
  AgentImportInput,
  AgentImportPreview,
  AgentImportScan,
  AgentImportSource,
  AgentImportSourceSummary,
  ConnectionId,
  OrgExportResult,
  Project,
  ProjectPathCheck
} from '@shared/types'
import { isSafeId, projectConnection } from '@shared/defaults'
import { pathKey } from '../../runtime/worktrees'
import { cleanProjectPath } from '../../store/projects'
import { convertImport } from './convert'
import { buildOrgExport, writeOrgExport } from './export'
import type { ModelContext } from './model'
import { parseOrgExport } from './parsers'
import { scanAgentSources } from './scan'
import { IMPORT_LIMITS, type ImportScanResult } from './types'

/** What the importer needs from the rest of the main process (index.ts wires the real services). */
export interface AgentImportDeps {
  projects: {
    get(id: string): Project | null
    list(): Project[]
    save(project: Project): Project
  }
  /** The project's connection catalog and tier mapping (ConnectionService.importModelContext). */
  modelContext(connection: ConnectionId): ModelContext
  /** Put a project on the adapter its models need (ConnectionService.withAdapter). Identity when absent. */
  withAdapter?(project: Project): Project
  /** A saved import reaches every window (index.ts broadcasts a project.updated RunEvent). */
  onProjectChanged?(project: Project): void
}

/**
 * Who is asking, for AgentImportInput.sourcePath / fromProjectId. Both are honoured only on the desktop surface, and a
 * folder only when the calling window picked exactly that path (agentFolderPicks). Absent = neither is honoured.
 */
export interface AgentImportAccess {
  surface: 'desktop' | 'socket' | 'inproc'
  isPickedFolder?(path: string): boolean
}

const PICK_FIRST = 'Choose the folder with the folder picker first.'

type ImportSource = { kind: 'target' } | { kind: 'folder'; path: string } | { kind: 'project'; project: Project }

/** Only known sources, deduped; undefined (= every source) when none is given. */
function cleanSources(sources: unknown): AgentImportSource[] | undefined {
  if (!Array.isArray(sources)) return undefined
  return [...new Set(sources.filter(isAgentImportSource))]
}

/** An absolute folder path (a relative one would resolve against the app's cwd). */
function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)
}

/**
 * Agent import (projects:scanAgents / previewImport / applyImport / exportOrg and ProjectCreateInput.importAgents).
 * Read-only on the repo except exportOrg. The renderer never supplies roles: preview and apply always re-scan the
 * stored project's folder and recompute, and only AgentImportChoice values are taken from the input.
 */
export class AgentImportService {
  constructor(private deps: AgentImportDeps) {}

  /** projects:scanAgents. Never throws. */
  scan(path: unknown): AgentImportScan {
    try {
      const root = cleanProjectPath(path)
      if (!root || !isAbsolutePath(root)) return { sources: [], instructionFiles: [], warnings: [] }
      return scanAgentSources(root).scan
    } catch (e) {
      return { sources: [], instructionFiles: [], warnings: [`The folder could not be scanned: ${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  /** The extra projects:checkPath fields: agent sources, instruction files and an existing project at the same folder. */
  pathCheckExtras(path: unknown, check: ProjectPathCheck): Partial<ProjectPathCheck> {
    const out: Partial<ProjectPathCheck> = {}
    try {
      const root = cleanProjectPath(path)
      if (!root || !isAbsolutePath(root) || !check.isDirectory) return out
      const key = pathKey(root)
      const same = this.deps.projects.list().find((p) => !isVirtualProjectId(p.id) && !!p.path && pathKey(p.path) === key)
      if (same) {
        out.existingProjectId = same.id
        out.existingProjectName = same.name
      }
      const scan = this.scan(root)
      if (scan.sources.length) out.agentSources = scan.sources.map(({ source, label, agentCount }) => ({ source, label, agentCount }))
      if (scan.instructionFiles.length) out.instructionFiles = scan.instructionFiles
    } catch {
      /* checkPath never rejects */
    }
    return out
  }

  private stored(projectId: unknown, needFolder = true): Project {
    if (!isSafeId(projectId) || isVirtualProjectId(projectId)) throw new Error('Project not found')
    const project = this.deps.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    if (needFolder) this.requireFolder(project)
    return project
  }

  /** A relative or empty path would resolve against the app's cwd. */
  private requireFolder(project: Project): void {
    if (!project.path || !isAbsolutePath(project.path)) throw new Error('The project has no folder to scan.')
  }

  /** The target project and where its import comes from; only a scan of the project's own folder needs that folder. */
  private target(input: Partial<AgentImportInput> | undefined, access?: AgentImportAccess): { project: Project; source: ImportSource } {
    const project = this.stored(input?.projectId, false)
    const source = this.resolveSource(project, input ?? {}, access)
    if (source.kind === 'target') this.requireFolder(project)
    return { project, source }
  }

  /**
   * Where the agent definitions come from: the project's own folder (no sourcePath / fromProjectId), a folder this
   * window picked (sourcePath), or another stored project's roles (fromProjectId). Both fields, or either one
   * without desktop access, are refused; fail closed when `access` is absent.
   */
  private resolveSource(target: Project, input: Partial<AgentImportInput>, access?: AgentImportAccess): ImportSource {
    const hasPath = input.sourcePath !== undefined && input.sourcePath !== null
    const hasProject = input.fromProjectId !== undefined && input.fromProjectId !== null
    if (!hasPath && !hasProject) return { kind: 'target' }
    if (hasPath && hasProject) throw new Error('Choose either a folder or a project to import from, not both.')
    if (access?.surface !== 'desktop') throw new Error('Importing from another folder or project is available in the desktop app only.')
    if (hasPath) {
      const path = input.sourcePath
      if (typeof path !== 'string' || !path || !access.isPickedFolder?.(path)) throw new Error(PICK_FIRST)
      if (!isAbsolutePath(path)) throw new Error(PICK_FIRST)
      return { kind: 'folder', path }
    }
    const id = input.fromProjectId
    if (!isSafeId(id) || isVirtualProjectId(id)) throw new Error('Project not found')
    if (id === target.id) throw new Error('Choose a different project to import from.')
    const from = this.deps.projects.get(id)
    if (!from) throw new Error('Project not found')
    return { kind: 'project', project: from }
  }

  /**
   * The roles of another project as import agents (source 'orgai'), through the same export document and parser a
   * `.orgai/org.json` file goes through: MCP grants, skills, secrets, ids and positions never travel.
   */
  private agentsFromProject(from: Project): ImportScanResult {
    // Shown where a file name would be; the name is the user's own project name, bounded and free of control characters.
    const file = `project ${from.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60)}`
    const text = JSON.stringify(buildOrgExport({ name: from.name, roles: from.roles }))
    const parsed = parseOrgExport(text, file)
    const agents = parsed.agents.slice(0, IMPORT_LIMITS.maxAgents)
    const sources: AgentImportSourceSummary[] = agents.length ? [{ source: 'orgai', label: AGENT_IMPORT_SOURCE_LABELS.orgai, files: [file], agentCount: agents.length }] : []
    return { scan: { sources, instructionFiles: [], warnings: parsed.warnings }, agents }
  }

  private compute(project: Project, input: Pick<AgentImportInput, 'sources' | 'mode' | 'choices'>, source: ImportSource = { kind: 'target' }): AgentImportPreview {
    const mode = input.mode === 'replace' ? 'replace' : 'merge'
    const sources = cleanSources(input.sources)
    const { scan, agents } =
      source.kind === 'project'
        ? this.agentsFromProject(source.project)
        : scanAgentSources(source.kind === 'folder' ? source.path : project.path, sources ? { sources } : undefined)
    return convertImport({
      existing: project.roles,
      agents,
      mode,
      choices: Array.isArray(input.choices) ? input.choices : undefined,
      model: this.deps.modelContext(projectConnection(project)),
      provider: project.provider,
      instructionFiles: scan.instructionFiles,
      scanWarnings: scan.warnings
    })
  }

  /** projects:previewImport. Saves nothing. */
  preview(input: AgentImportInput, access?: AgentImportAccess): AgentImportPreview {
    const { project, source } = this.target(input, access)
    return this.compute(project, input ?? { mode: 'merge' }, source)
  }

  /** projects:applyImport: recompute from disk, apply the choices, save. Undo = save previousRoles. */
  apply(input: AgentImportApplyInput, access?: AgentImportAccess, check?: (stored: Project, next: Project) => void): AgentImportApplyResult {
    const { project, source } = this.target(input, access)
    // The digest is required: apply only what the user reviewed in a preview.
    if (typeof input.digest !== 'string' || !input.digest) throw new Error('Preview the import before applying it.')
    const preview = this.compute(project, input, source)
    if (input.digest !== preview.digest) {
      throw new Error('The agent definitions in the folder changed since the preview. Review the import again.')
    }
    if (!preview.items.some((i) => i.action !== 'skip')) throw new Error('There is nothing to import.')
    const next = this.adapt({ ...project, roles: preview.roles })
    // The caller's refusal (a surface that may not shed a role's limit), before anything is saved.
    check?.(project, next)
    const saved = this.deps.projects.save(next)
    this.deps.onProjectChanged?.(saved)
    return { project: saved, previousRoles: project.roles }
  }

  /**
   * ProjectCreateInput.importAgents: replace a freshly built project's roles with the imported ones, mapped to the
   * connection the project was put on (call it after prepareNewProject). Returns the project unchanged when nothing
   * importable is found or the import fails. Nothing is saved.
   */
  rolesForNewProject(project: Project, sources: unknown): Project {
    const wanted = cleanSources(sources)
    if (!wanted?.length) return project
    try {
      const preview = this.compute(project, { sources: wanted, mode: 'replace' })
      if (!preview.items.some((i) => i.action !== 'skip')) return project
      return this.adapt({ ...project, roles: preview.roles })
    } catch (e) {
      console.warn('Agent import at project creation failed; keeping the default org chart:', e instanceof Error ? e.message : e)
      return project
    }
  }

  /** projects:exportOrg. */
  exportOrg(projectId: unknown): OrgExportResult {
    const project = this.stored(projectId)
    return { path: writeOrgExport(project) }
  }

  private adapt(project: Project): Project {
    return this.deps.withAdapter ? this.deps.withAdapter(project) : project
  }
}
