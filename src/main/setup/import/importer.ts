import { isAbsolute } from 'node:path'
import { HARNESS_PROJECT_ID, isAgentImportSource } from '@shared/types'
import type {
  AgentImportApplyInput,
  AgentImportApplyResult,
  AgentImportInput,
  AgentImportPreview,
  AgentImportScan,
  AgentImportSource,
  ConnectionId,
  OrgExportResult,
  Project,
  ProjectPathCheck
} from '@shared/types'
import { isSafeId, projectConnection } from '@shared/defaults'
import { pathKey } from '../../runtime/worktrees'
import { cleanProjectPath } from '../../store/projects'
import { convertImport } from './convert'
import { writeOrgExport } from './export'
import type { ModelContext } from './model'
import { scanAgentSources } from './scan'

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
      const same = this.deps.projects.list().find((p) => p.id !== HARNESS_PROJECT_ID && !!p.path && pathKey(p.path) === key)
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

  private stored(projectId: unknown): Project {
    if (!isSafeId(projectId) || projectId === HARNESS_PROJECT_ID) throw new Error('Project not found')
    const project = this.deps.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    // A relative or empty path would resolve against the app's cwd.
    if (!project.path || !isAbsolutePath(project.path)) throw new Error('The project has no folder to scan.')
    return project
  }

  private compute(project: Project, input: Pick<AgentImportInput, 'sources' | 'mode' | 'choices'>): AgentImportPreview {
    const mode = input.mode === 'replace' ? 'replace' : 'merge'
    const sources = cleanSources(input.sources)
    const { scan, agents } = scanAgentSources(project.path, sources ? { sources } : undefined)
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
  preview(input: AgentImportInput): AgentImportPreview {
    return this.compute(this.stored(input?.projectId), input ?? { mode: 'merge' })
  }

  /** projects:applyImport: recompute from disk, apply the choices, save. Undo = save previousRoles. */
  apply(input: AgentImportApplyInput): AgentImportApplyResult {
    const project = this.stored(input?.projectId)
    // The digest is required: apply only what the user reviewed in a preview.
    if (typeof input.digest !== 'string' || !input.digest) throw new Error('Preview the import before applying it.')
    const preview = this.compute(project, input)
    if (input.digest !== preview.digest) {
      throw new Error('The agent definitions in the folder changed since the preview. Review the import again.')
    }
    if (!preview.items.some((i) => i.action !== 'skip')) throw new Error('There is nothing to import.')
    const next = this.adapt({ ...project, roles: preview.roles })
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
