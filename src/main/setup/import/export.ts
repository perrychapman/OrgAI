import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Effort, ModelRef, ModelTier, Project, ToolName } from '@shared/types'

export const ORG_EXPORT_FORMAT = 'orgai.org/1'
export const ORG_EXPORT_PATH = '.orgai/org.json'

/** One role in `.orgai/org.json`. References are slugs; ids, positions and MCP grants are not exported. */
export interface OrgExportRole {
  slug: string
  name: string
  description: string
  responsibilities: string[]
  prompt: string
  tools: ToolName[]
  model: ModelRef
  tier?: ModelTier
  effort?: Effort
  canSpawn: boolean
  spawnable: string[]
  reportsTo: string | null
  color: string
}

/** The `.orgai/org.json` document (format 'orgai.org/1'). No secrets, MCP specs, ids or positions. */
export interface OrgExportFile {
  format: typeof ORG_EXPORT_FORMAT
  exportedAt: string
  project: { name: string }
  roles: OrgExportRole[]
}

/** Build the export document of a project's org chart. Pure. */
export function buildOrgExport(project: Pick<Project, 'name' | 'roles'>, now = new Date()): OrgExportFile {
  const slugOf = new Map(project.roles.map((r) => [r.id, r.slug]))
  return {
    format: ORG_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    project: { name: project.name },
    roles: project.roles.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      responsibilities: [...r.responsibilities],
      prompt: r.prompt,
      tools: [...r.tools],
      model: r.model,
      ...(r.tier ? { tier: r.tier } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      canSpawn: r.canSpawn,
      spawnable: r.spawnable.map((id) => slugOf.get(id)).filter((s): s is string => !!s),
      reportsTo: r.reportsTo === null ? null : slugOf.get(r.reportsTo) ?? null,
      color: r.color
    }))
  }
}

/**
 * Write `<project.path>/.orgai/org.json` and return its path. Refuses to write through a symlinked `.orgai`
 * folder or `org.json` file (the repo is untrusted: a link could point anywhere). Writes a temp file and renames.
 */
export function writeOrgExport(project: Pick<Project, 'name' | 'roles' | 'path'>, now = new Date()): string {
  if (!project.path || !existsSync(project.path) || !lstatSync(project.path).isDirectory()) {
    throw new Error(`The project folder ${project.path} does not exist.`)
  }
  const dir = join(project.path, '.orgai')
  if (existsSync(dir) || isLink(dir)) {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('.orgai in the project folder is not a plain folder, so the org chart was not exported.')
  } else mkdirSync(dir)
  const file = join(dir, 'org.json')
  if (isLink(file) || (existsSync(file) && !lstatSync(file).isFile())) throw new Error('.orgai/org.json is not a plain file, so the org chart was not exported.')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(buildOrgExport(project, now), null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
