import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, TEAM_FILES_IPC } from '@shared/types'
import type { Project, ProjectPathCheck } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ logRunEvent: () => {}, logPermission: () => {}, logPath: () => '', logsDir: () => '', log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const { registerIpc, teamFilesArgs, teamFilesCreateArg, pathCheckWithTeamFiles } = await import('./ipc')
const { createProject, makeComputer, listOrgai, setRole } = await import('./teamFiles/service.fixture')

/** A service object whose every method is a no-op: only the handlers under test are driven. */
const inert = (): never => new Proxy({}, { get: () => () => undefined }) as never

let root: string
let repo: string
let lastSources: unknown

beforeEach(() => {
  handlers.clear()
  root = mkdtempSync(join(tmpdir(), 'orgai-ipc-team-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('teamFilesArgs', () => {
  it('rebuilds the project id and a 64-hex digest and drops everything else', () => {
    const digest = 'ab'.repeat(32)
    expect(teamFilesArgs({ projectId: 'proj_1', digest, extra: 1, __proto__: { x: 1 } }, true)).toEqual({ projectId: 'proj_1', digest })
    expect(teamFilesArgs({ projectId: 'proj_1', digest, other: true })).toEqual({ projectId: 'proj_1' })
  })

  it('refuses a wrong shape, an unsafe or virtual id and a digest that is not 64 hex', () => {
    for (const bad of [null, undefined, 'x', [], {}, { projectId: 5 }, { projectId: '../x' }, { projectId: 'quick' }, { projectId: 'harness' }, { projectId: 'skills' }]) {
      expect(() => teamFilesArgs(bad), JSON.stringify(bad)).toThrow('Project not found')
    }
    for (const d of [undefined, null, 5, '', 'zz'.repeat(32), 'ab'.repeat(31), 'AB'.repeat(32), ['ab'.repeat(32)]]) {
      expect(() => teamFilesArgs({ projectId: 'proj_1', digest: d }, true), String(d)).toThrow(/Review them again/)
    }
  })
})

describe('teamFilesCreateArg', () => {
  it('keeps only a 64-hex digest', () => {
    const digest = 'cd'.repeat(32)
    expect(teamFilesCreateArg({ digest, x: 1 })).toEqual({ digest })
    for (const bad of [null, undefined, 'x', [], {}, { digest: 'short' }, { digest: 5 }]) expect(teamFilesCreateArg(bad)).toBeUndefined()
  })
})

describe('pathCheckWithTeamFiles', () => {
  const base: ProjectPathCheck = { exists: true, isDirectory: true, isGitRepo: false, suggestedName: 'x', empty: false }
  const found = { roleCount: 1, roles: [], skills: [], mcpServers: [], changes: [], problems: [], warnings: [] }

  it('filters agent source orgai out while a team is found, and drops the list when nothing else is left', () => {
    const extras = { agentSources: [{ source: 'orgai' as const, label: 'OrgAI export', agentCount: 3 }, { source: 'claude' as const, label: 'Claude Code', agentCount: 2 }] }
    const out = pathCheckWithTeamFiles(base, extras, found)
    expect(out.teamFiles).toBe(found)
    expect(out.agentSources?.map((s) => s.source)).toEqual(['claude'])
    const only = pathCheckWithTeamFiles(base, { agentSources: [extras.agentSources[0]] }, found)
    expect(only.agentSources).toBeUndefined()
  })

  it('leaves agent sources alone when no team is found', () => {
    const extras = { agentSources: [{ source: 'orgai' as const, label: 'OrgAI export', agentCount: 3 }] }
    const out = pathCheckWithTeamFiles(base, extras, undefined)
    expect(out.agentSources?.length).toBe(1)
    expect(out.teamFiles).toBeUndefined()
  })
})

describe('the registered handlers', () => {
  function setup(): { c: ReturnType<typeof makeComputer>; call: (channel: string, ...a: unknown[]) => unknown } {
    const c = makeComputer(root, 'a', repo)
    const importer = {
      pathCheckExtras: () => ({ agentSources: [{ source: 'orgai', label: 'OrgAI export', agentCount: 2 }] }),
      rolesForNewProject: (p: Project, sources?: unknown) => {
        lastSources = sources
        return p
      }
    }
    registerIpc({
      projects: c.projects,
      runs: inert(),
      setup: inert(),
      maintenance: inert(),
      settings: { get: () => DEFAULT_APP_SETTINGS, dataDir: c.data } as never,
      connections: { prepareNewProject: (p: Project) => p } as never,
      mcp: inert(),
      adapterIds: ['mock'],
      harnessProject: inert(),
      openRunWindow: () => undefined,
      importer: importer as never,
      skills: inert(),
      skillEvaluation: inert(),
      capabilities: inert(),
      quick: inert(),
      templates: { rolesForNewProject: (p: Project) => p } as never,
      teamFiles: c.svc
    })
    return { c, call: (channel, ...a) => handlers.get(channel)!({}, ...a) }
  }

  it('registers every teamFiles channel', () => {
    setup()
    for (const ch of Object.values(TEAM_FILES_IPC)) if (ch !== TEAM_FILES_IPC.teamFilesChanged) expect(handlers.has(ch), ch).toBe(true)
  })

  it('projects:checkPath adds the found team and leaves source orgai out of the agent sources', () => {
    const { c, call } = setup()
    const p = createProject(c)
    c.svc.status(p.id)
    const out = call(IPC.projectsCheckPath, repo) as ProjectPathCheck
    expect(out.teamFiles?.roleCount).toBe(p.roles.length)
    expect(out.agentSources).toBeUndefined()
    const other = join(root, 'empty')
    mkdirSync(other)
    const plain = call(IPC.projectsCheckPath, other) as ProjectPathCheck
    expect(plain.teamFiles).toBeUndefined()
    expect(plain.agentSources?.length).toBe(1)
  })

  it('projects:create with teamFiles starts from the folder; a stale digest rejects; extra fields are dropped', () => {
    const { c, call } = setup()
    const first = createProject(c)
    c.svc.status(first.id)
    setRole(c, first.id, 'reviewer', () => ({ prompt: 'The folder\'s reviewer.' }))
    const found = (call(IPC.projectsCheckPath, repo) as ProjectPathCheck).teamFiles!
    // A second computer's view: another store reading the same folder.
    const other = makeComputer(root, 'b', repo)
    void other
    const stale = 'f'.repeat(64)
    expect(() => call(IPC.projectsCreate, { name: 'Second', path: repo, brief: '', teamFiles: { digest: stale } })).toThrow(/Review them again/)
    const created = call(IPC.projectsCreate, { name: 'Second', path: repo, brief: '', teamFiles: { digest: found.digest, bogus: 1 }, importAgents: [{ source: 'claude' }] }) as Project
    expect(created.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('The folder\'s reviewer.')
    expect(created.roles.length).toBe(found.roleCount)
    expect(listOrgai(repo).length).toBeGreaterThan(0)
  })

  it('projects:create drops source orgai from importAgents while the folder has team files, and keeps the others', () => {
    const { c, call } = setup()
    const first = createProject(c)
    c.svc.status(first.id)
    lastSources = undefined
    call(IPC.projectsCreate, { name: 'Imp', path: repo, brief: '', importAgents: ['orgai', 'claude'] })
    expect(lastSources).toEqual(['claude'])
    // A folder without team files is not touched by this.
    const plainDir = join(root, 'plain')
    mkdirSync(plainDir)
    lastSources = undefined
    call(IPC.projectsCreate, { name: 'Imp2', path: plainDir, brief: '', importAgents: ['orgai', 'claude'] })
    expect(lastSources).toEqual(['orgai', 'claude'])
  })

  it('projects:create refuses team files for an engagement and ignores a junk teamFiles value', () => {
    const { call } = setup()
    expect(() => call(IPC.projectsCreate, { name: 'E', path: repo, brief: '', kind: 'engagement', teamFiles: { digest: 'ab'.repeat(32) } })).toThrow(/code projects only/)
    const p = call(IPC.projectsCreate, { name: 'Plain', path: repo, brief: '', teamFiles: 'nope' }) as Project
    expect(p.roles.length).toBeGreaterThan(1)
  })

  it('teamFiles:status refuses a virtual id and an unknown project', async () => {
    const { call } = setup()
    await expect(call(TEAM_FILES_IPC.teamFilesStatus, { projectId: 'quick' })).rejects.toThrow('Project not found')
    await expect(call(TEAM_FILES_IPC.teamFilesStatus, { projectId: 'proj_nope' })).rejects.toThrow('Project not found')
    await expect(call(TEAM_FILES_IPC.teamFilesApprove, { projectId: 'proj_nope', digest: 'x' })).rejects.toThrow()
  })
})
