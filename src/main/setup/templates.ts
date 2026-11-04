import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORG_TEMPLATES_MAX,
  ORG_TEMPLATE_DESCRIPTION_MAX_CHARS,
  ORG_TEMPLATE_NAME_MAX_CHARS,
  isProjectKind,
  isVirtualProjectId
} from '@shared/types'
import type { AgentImportApplyResult, ConnectionId, OrgTemplateApplyInput, OrgTemplateInfo, OrgTemplateSaveInput, Project, Role } from '@shared/types'
import { isSafeId, newId, projectConnection, projectKindOf } from '@shared/defaults'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { convertImport } from './import/convert'
import { buildOrgExport } from './import/export'
import type { ModelContext } from './import/model'
import { parseOrgExport } from './import/parsers'

/** Largest template file or index read (an org chart is well under this). */
const TEMPLATE_READ_MAX_BYTES = 2 * 1024 * 1024

/** What the template service needs from the rest of the main process (index.ts wires the real services). */
export interface TemplateDeps {
  dataDir: string
  projects: {
    get(id: string): Project | null
    save(project: Project): Project
  }
  /** The project's connection catalog and tier mapping (ConnectionService.importModelContext). */
  modelContext(connection: ConnectionId): ModelContext
  /** Put a project on the adapter its models need (ConnectionService.withAdapter). Identity when absent. */
  withAdapter?(project: Project): Project
  /** A saved apply reaches every window (index.ts broadcasts a project.updated RunEvent). */
  onProjectChanged?(project: Project): void
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The text of a regular, non-linked file of at most TEMPLATE_READ_MAX_BYTES, or null. */
function readPlain(file: string): string | null {
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > TEMPLATE_READ_MAX_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function atomicWrite(file: string, text: string): void {
  if (isLink(file) || (existsSync(file) && !lstatSync(file).isFile())) throw new Error('A template file is not a plain file.')
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Create `dir` when missing; refuse an existing link or non-folder. */
function ensurePlainDir(dir: string): void {
  if (existsSync(dir) || isLink(dir)) {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('OrgAI\'s templates folder is not a plain folder.')
  } else mkdirSync(dir, { recursive: true })
}

/** A name: 1..80 characters after trimming, no control or hidden characters. Throws a readable message. */
export function cleanTemplateName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Give the template a name.')
  const t = name.trim()
  if (!t) throw new Error('Give the template a name.')
  if (t.length > ORG_TEMPLATE_NAME_MAX_CHARS) throw new Error(`The template name is longer than ${ORG_TEMPLATE_NAME_MAX_CHARS} characters.`)
  const problem = hiddenCharProblem('The template name', t)
  if (problem) throw new Error(problem)
  return t
}

/** A description: at most 500 characters, tab and line breaks allowed, other hidden characters refused. */
export function cleanTemplateDescription(description: unknown): string {
  if (description === undefined || description === null) return ''
  if (typeof description !== 'string') throw new Error('The template description must be text.')
  const t = description.trim()
  if (t.length > ORG_TEMPLATE_DESCRIPTION_MAX_CHARS) throw new Error(`The template description is longer than ${ORG_TEMPLATE_DESCRIPTION_MAX_CHARS} characters.`)
  const problem = hiddenCharProblem('The template description', t, { prose: true })
  if (problem) throw new Error(problem)
  return t
}

/** One index entry rebuilt field by field, or null for junk. */
function cleanEntry(raw: unknown): OrgTemplateInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (!isSafeId(e.id) || !e.id.startsWith('tpl_')) return null
  try {
    const name = cleanTemplateName(e.name)
    const description = cleanTemplateDescription(e.description)
    if (!isProjectKind(e.kind)) return null
    const roleCount = typeof e.roleCount === 'number' && Number.isFinite(e.roleCount) ? Math.max(0, Math.floor(e.roleCount)) : 0
    const createdAt = typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0
    const updatedAt = typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : createdAt
    return { id: e.id, name, description, kind: e.kind, roleCount, createdAt, updatedAt }
  } catch {
    return null
  }
}

/**
 * Saved team templates (`<data>/org-templates/templates.json` plus `<data>/org-templates/<id>/org.json`, format
 * 'orgai.org/1': no ids, positions, secrets, MCP or skill grants). Applying goes through the agent-import convert path
 * so models map to the target project's connection.
 */
export class TemplateService {
  constructor(private deps: TemplateDeps) {}

  private root(): string {
    return join(this.deps.dataDir, 'org-templates')
  }

  private indexFile(): string {
    return join(this.root(), 'templates.json')
  }

  private orgFile(id: string): string {
    return join(this.root(), id, 'org.json')
  }

  private readIndex(): OrgTemplateInfo[] {
    const text = readPlain(this.indexFile())
    if (!text) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    const list = (parsed as { templates?: unknown } | null)?.templates
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    const out: OrgTemplateInfo[] = []
    for (const raw of list) {
      const e = cleanEntry(raw)
      if (!e || seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
      if (out.length >= ORG_TEMPLATES_MAX) break
    }
    return out
  }

  private writeIndex(templates: OrgTemplateInfo[]): void {
    ensurePlainDir(this.root())
    atomicWrite(this.indexFile(), `${JSON.stringify({ version: 1, templates }, null, 2)}\n`)
  }

  /** Saved templates, newest first. Never throws. */
  list(): OrgTemplateInfo[] {
    try {
      return this.readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  /** Save a stored project's chart as a new template. Refuses at ORG_TEMPLATES_MAX and for an empty chart. */
  saveFromProject(input: OrgTemplateSaveInput): OrgTemplateInfo {
    const name = cleanTemplateName(input?.name)
    const description = cleanTemplateDescription(input?.description)
    const project = this.stored(input?.projectId)
    if (!project.roles.length) throw new Error('This project has no roles to save as a template.')
    const templates = this.readIndex()
    if (templates.length >= ORG_TEMPLATES_MAX) throw new Error(`OrgAI keeps at most ${ORG_TEMPLATES_MAX} templates. Remove one first.`)
    let id: string
    do id = newId('tpl')
    while (!isSafeId(id) || templates.some((t) => t.id === id))
    const now = Date.now()
    const info: OrgTemplateInfo = { id, name, description, kind: projectKindOf(project), roleCount: project.roles.length, createdAt: now, updatedAt: now }
    ensurePlainDir(this.root())
    const dir = join(this.root(), id)
    ensurePlainDir(dir)
    try {
      atomicWrite(this.orgFile(id), `${JSON.stringify(buildOrgExport(project, new Date(now)), null, 2)}\n`)
      this.writeIndex([...templates, info])
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    return info
  }

  /** Delete a template; resolves to the remaining list. An unknown id throws "Template not found". */
  remove(templateId: string): OrgTemplateInfo[] {
    const templates = this.readIndex()
    if (!isSafeId(templateId) || !templates.some((t) => t.id === templateId)) throw new Error('Template not found')
    this.writeIndex(templates.filter((t) => t.id !== templateId))
    try {
      rmSync(join(this.root(), templateId), { recursive: true, force: true })
    } catch {
      /* the index no longer lists it; a leftover folder is harmless */
    }
    return this.list()
  }

  /** templates:apply. Result: the saved project and the roles before (Undo = save previousRoles). */
  apply(input: OrgTemplateApplyInput): AgentImportApplyResult {
    if (input?.mode !== 'replace' && input?.mode !== 'merge') throw new Error('Choose whether the template replaces the org chart or is added to it.')
    const project = this.stored(input.projectId)
    const roles = this.rolesOf(input.templateId, project, input.mode)
    if (!roles) throw new Error('Template not found')
    const next = this.adapt({ ...project, roles })
    const saved = this.deps.projects.save(next)
    this.deps.onProjectChanged?.(saved)
    return { project: saved, previousRoles: project.roles }
  }

  /**
   * ProjectCreateInput.templateId: the project with the template's chart ('replace'), mapped to the connection the
   * project was put on (call it after prepareNewProject). Nothing is saved. An unknown id or any failure keeps the
   * project unchanged with a console warning.
   */
  rolesForNewProject(project: Project, templateId: unknown): Project {
    try {
      const roles = this.rolesOf(templateId, project, 'replace')
      if (!roles) {
        console.warn('Team template not found at project creation; keeping the default org chart.')
        return project
      }
      return this.adapt({ ...project, roles })
    } catch (e) {
      console.warn('Applying a team template at project creation failed; keeping the default org chart:', e instanceof Error ? e.message : e)
      return project
    }
  }

  /**
   * RunManagerOptions.orgTemplate (propose_org_chart fromTemplate): the template's name and its roles converted for
   * `project` ('replace', no MCP or skill grants), or null when unknown or unreadable. Saves nothing.
   */
  forRun(templateId: string, project: Project): { name: string; roles: Role[] } | null {
    try {
      const info = this.readIndex().find((t) => t.id === templateId)
      const roles = this.rolesOf(templateId, project, 'replace')
      if (!info || !roles) return null
      return {
        name: info.name,
        roles: roles.map((r) => {
          const { mcpServers: _m, skills: _s, ...rest } = r
          void _m
          void _s
          return rest
        })
      }
    } catch (e) {
      console.warn('Reading a team template failed:', e instanceof Error ? e.message : e)
      return null
    }
  }

  /** The template's chart converted for `project`, or null for an unknown template. Throws on a bad template file. */
  private rolesOf(templateId: unknown, project: Project, mode: 'replace' | 'merge'): Role[] | null {
    if (!isSafeId(templateId) || !this.readIndex().some((t) => t.id === templateId)) return null
    const dir = join(this.root(), templateId)
    if (isLink(this.root()) || isLink(dir)) throw new Error('The template folder is not a plain folder.')
    const text = readPlain(this.orgFile(templateId))
    if (text === null) throw new Error('The template file could not be read.')
    const parsed = parseOrgExport(text, 'org.json')
    if (!parsed.agents.length) throw new Error(parsed.warnings[0] ?? 'The template has no roles.')
    const preview = convertImport({
      existing: project.roles,
      agents: parsed.agents,
      mode,
      model: this.deps.modelContext(projectConnection(project)),
      provider: project.provider,
      instructionFiles: [],
      scanWarnings: []
    })
    return preview.roles
  }

  private stored(projectId: unknown): Project {
    if (!isSafeId(projectId) || isVirtualProjectId(projectId)) throw new Error('Project not found')
    const project = this.deps.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return project
  }

  private adapt(project: Project): Project {
    return this.deps.withAdapter ? this.deps.withAdapter(project) : project
  }
}
