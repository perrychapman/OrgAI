import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpLibraryEntry, Project, ProjectCreateInput, TeamFilesStatus } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SkillService } from '../skills/service'
import { TeamFilesService, type TeamFilesDeps } from './service'

/** Test scaffolding for the team files service: a "computer" is a data dir, a store, a skill service and the service. */

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, ...args) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Tester')
  git(dir, 'config', 'user.email', 'tester@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

export interface Computer {
  name: string
  repo: string
  data: string
  projects: ProjectStore
  skills: SkillService
  svc: TeamFilesService
  library: McpLibraryEntry[]
  secrets: Map<string, string>
  statuses: TeamFilesStatus[]
  updated: Project[]
}

export function makeComputer(root: string, name: string, repo: string, extra: Partial<TeamFilesDeps> = {}): Computer {
  const data = join(root, `data-${name}`)
  mkdirSync(data, { recursive: true })
  const projects = new ProjectStore(data, { home: join(root, 'home') })
  const skills = new SkillService({ dataDir: data, projects })
  const library: McpLibraryEntry[] = []
  const secrets = new Map<string, string>()
  const statuses: TeamFilesStatus[] = []
  const updated: Project[] = []
  const svc = new TeamFilesService({
    dataDir: data,
    projects,
    skills: {
      readFiles: (pid, spec) => skills.teamReadFiles(pid, spec),
      storeFiles: (pid, sid, files) => skills.teamStoreFiles(pid, sid, files),
      removeFiles: (pid, sid) => skills.teamRemoveFiles(pid, sid)
    },
    mcp: {
      libraryEntries: () => library,
      connectorEntry: (id, variant) => library.find((e) => e.connectorId === id && (variant === undefined || e.connectorVariant === variant)),
      removeServerSecrets: (pid, sid) => {
        for (const k of [...secrets.keys()]) if (k.startsWith(`mcp:${pid}:${sid}:`)) secrets.delete(k)
      }
    },
    broadcastStatus: (s) => void statuses.push(s),
    broadcastProject: (p) => void updated.push(p),
    warn: () => undefined,
    ...extra
  })
  projects.setTeamFilesHook(svc)
  return { name, repo, data, projects, skills, svc, library, secrets, statuses, updated }
}

export function createProject(c: Computer, over: Partial<ProjectCreateInput> = {}): Project {
  return c.projects.create({ name: `Demo ${c.name}`, path: c.repo, brief: 'A demo project', ...over }, undefined, { mockAvailable: true })
}

/** Create a project from the team found in the folder, the way the New project form does. */
export function createFromFolder(c: Computer, over: Partial<ProjectCreateInput> = {}): Project {
  const found = c.svc.found(c.repo, { isDirectory: true })
  if (!found?.digest) throw new Error('no team found')
  const digest = found.digest
  return c.projects.create({ name: `Demo ${c.name}`, path: c.repo, brief: '', teamFiles: { digest }, ...over }, undefined, {
    teamFiles: { build: (p) => c.svc.createFromFolder(p, digest), adopted: (p) => c.svc.adopted(p.id) }
  })
}

export function setRole(c: Computer, projectId: string, slug: string, patch: (r: Project['roles'][number]) => Partial<Project['roles'][number]>): Project {
  return c.projects.update(projectId, (p) => ({ ...p, roles: p.roles.map((r) => (r.slug === slug ? { ...r, ...patch(r) } : r)) }))
}

export function rolePath(c: Computer, slug: string): string {
  return join(c.repo, '.orgai', 'agents', `${slug}.md`)
}

export function readOrgai(c: Computer, rel: string): string {
  return readFileSync(join(c.repo, '.orgai', ...rel.split('/')), 'utf8')
}

/** Every file under .orgai (relative, '/'), sorted. */
export function listOrgai(repo: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      if (readdirSyncSafe(abs)) walk(abs, r)
      else out.push(r)
    }
  }
  walk(join(repo, '.orgai'), '')
  return out
}

function readdirSyncSafe(p: string): boolean {
  try {
    readdirSync(p)
    return true
  } catch {
    return false
  }
}

export function writeText(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}
